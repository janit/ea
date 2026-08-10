// Echelon Analytics — Semantic Events Endpoint (POST /e)
//
// Accepts behavioral events via sendBeacon (bounce, scroll_depth,
// session_end, session_resume, clicks, custom events).
// Uses buffered writes (like routemap4 pattern) for SQLite performance.

import type { DbAdapter } from "./db/adapter.ts";
import type { SemanticEvent } from "../types.ts";
import { getClientIp } from "./ip.ts";
import {
  computeBotScoreWithDetail,
  extractCloudflareSignals,
  getBotIpPenalty,
  getBurstCount,
  getVisitorCountry,
  hashIp,
  hashVisitor,
  isKnownBot,
} from "./bot-score.ts";
import { isExcluded, refreshExcluded } from "./beacon.ts";
import {
  ALLOWED_SITES,
  BOT_DISCARD_THRESHOLD,
  EVENT_FLUSH_MS,
  IGNORED_SITES,
  validateSiteId,
} from "./config.ts";
import { anonymizeEvent, shouldAnonymize } from "./anonymize.ts";
import { tokenPenalty, verifyToken } from "./challenge.ts";
import {
  isDatacenterIp,
  matchesAiCrawlerFeed,
  matchesCrawlerFeed,
} from "./threat-feeds.ts";
import { BufferedWriter } from "./buffered-writer.ts";
import { isUtmCampaignActive } from "./utm.ts";
import { debug } from "./debug.ts";

interface ClientEvent {
  type: string;
  data?: Record<string, unknown>;
  sessionId?: string;
  utmCampaign?: string;
}

const MAX_EVENTS_PER_REQUEST = 20;
const MAX_BODY_BYTES = 16_384; // 16 KB
const MAX_EVENT_DATA_BYTES = 2_048; // 2 KB per event data

class BodyTooLargeError extends Error {}

/**
 * Stream-read a request body with a hard byte cap. Aborts the reader as
 * soon as the cap is exceeded so attackers can't force buffering of an
 * oversized payload by spoofing Content-Length: 0.
 */
async function readBodyCapped(req: Request, maxBytes: number): Promise<string> {
  if (!req.body) return "";
  const reader = req.body.getReader();
  const decoder = new TextDecoder();
  let total = 0;
  let out = "";
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw new BodyTooLargeError();
      }
      out += decoder.decode(value, { stream: true });
    }
    out += decoder.decode();
  } finally {
    reader.releaseLock();
  }
  return out;
}

const ALLOWED_EVENT_TYPES = new Set([
  "bounce",
  "session_end",
  "session_resume",
  "scroll_depth",
  "click",
  "ad_click",
  "form_focus",
  "form_blur",
  "form_submit",
  "hover",
  "outbound",
  "download",
  "web_vital",
  "custom",
]);

import { getRequestCookie as getCookie } from "./cookie.ts";

import type { SQLParam } from "./db/adapter.ts";

// ── Buffered event writer ───────────────────────────────────────────────────

const EVENT_COLS = `(event_type, site_id, session_id, visitor_id, data,
   experiment_id, variant_id, utm_campaign,
   device_type, referrer, hour, month, day_of_week,
   is_returning, bot_score, bot_score_detail)`;
const EVENT_COL_COUNT = 16;
const CHUNK_SIZE = 50;
const ONE_ROW = `(${Array(EVENT_COL_COUNT).fill("?").join(",")})`;

function eventParams(ev: SemanticEvent): SQLParam[] {
  return [
    ev.event_type,
    ev.site_id,
    ev.session_id,
    ev.visitor_id,
    ev.data,
    ev.experiment_id ?? null,
    ev.variant_id ?? null,
    ev.utm_campaign ?? null,
    ev.device_type,
    ev.referrer,
    ev.hour,
    ev.month,
    ev.day_of_week,
    ev.is_returning,
    ev.bot_score,
    ev.bot_score_detail ?? null,
  ];
}

const eventWriter = new BufferedWriter<SemanticEvent>(
  async (db, batch) => {
    await db.transaction(async (tx) => {
      for (let i = 0; i < batch.length; i += CHUNK_SIZE) {
        const chunk = batch.slice(i, i + CHUNK_SIZE);
        const values = chunk.map(() => ONE_ROW).join(",");
        const sql =
          `INSERT INTO semantic_events ${EVENT_COLS} VALUES ${values}`;
        const params: SQLParam[] = [];
        for (const ev of chunk) params.push(...eventParams(ev));
        await tx.run(sql, ...params);
      }
    });
  },
  50_000,
  EVENT_FLUSH_MS,
  "Event",
);

export function startEventWriter(db: DbAdapter): void {
  eventWriter.start(db);
}

export async function flushRemainingEvents(db: DbAdapter): Promise<void> {
  await eventWriter.stop(db);
}

/** Writer health for the health endpoint. Healthy = nothing failed or dropped. */
export function getEventWriterHealth(): {
  failedCycles: number;
  dropped: number;
} {
  return {
    failedCycles: eventWriter.failedCycles,
    dropped: eventWriter.droppedCount,
  };
}

export function getEventBufferSize(): number {
  return eventWriter.size;
}

// ── Request handler ─────────────────────────────────────────────────────────

export async function handleEvents(
  req: Request,
  db: DbAdapter,
): Promise<Response> {
  // Drop known bots immediately
  if (isKnownBot(req.headers.get("user-agent") ?? undefined)) {
    return new Response(null, { status: 204 });
  }

  // Reject oversized payloads up-front on the declared Content-Length.
  // Attackers can lie with Content-Length: 0 and send a huge body, so we
  // also stream-cap the read below.
  const contentLength = parseInt(req.headers.get("content-length") ?? "0");
  if (contentLength > MAX_BODY_BYTES) {
    return new Response(null, { status: 413 });
  }
  let rawBody: string;
  try {
    rawBody = await readBodyCapped(req, MAX_BODY_BYTES);
  } catch (e) {
    if (e instanceof BodyTooLargeError) {
      return new Response(null, { status: 413 });
    }
    return new Response(null, { status: 400 });
  }
  if (rawBody.length === 0) {
    return new Response(null, { status: 400 });
  }

  let body: { events?: ClientEvent[]; siteId?: string; tok?: string };
  try {
    body = JSON.parse(rawBody);
  } catch {
    return new Response(null, { status: 400 });
  }

  const events = body.events;
  if (!Array.isArray(events) || events.length === 0) {
    return new Response(null, { status: 204 });
  }

  const siteId = validateSiteId(
    typeof body.siteId === "string" ? body.siteId : "default",
  );

  // Silently drop ignored or non-allowed sites
  const siteLower = siteId.toLowerCase();
  if (IGNORED_SITES.has(siteLower)) {
    return new Response(null, { status: 204 });
  }
  if (ALLOWED_SITES.size > 0 && !ALLOWED_SITES.has(siteLower)) {
    return new Response(null, { status: 204 });
  }

  // Server-side context enrichment
  const now = new Date();
  const hour = now.getUTCHours();
  const month = now.getUTCMonth() + 1;
  const dayOfWeek = now.getUTCDay();

  // Device type from Sec-CH-UA-Mobile or UA heuristic
  const chMobile = req.headers.get("sec-ch-ua-mobile");
  let deviceType: string;
  if (chMobile === "?1") {
    deviceType = "mobile";
  } else if (chMobile === "?0") {
    deviceType = "desktop";
  } else {
    const ua = req.headers.get("user-agent") ?? "";
    deviceType = /mobile|android|iphone|ipad/i.test(ua) ? "mobile" : "desktop";
  }

  // Referrer (origin only)
  const refHeader = req.headers.get("referer");
  let referrer: string | null = null;
  if (refHeader) {
    try {
      referrer = new URL(refHeader).origin;
    } catch { /* ignore malformed */ }
  }

  // Visitor identity: cookie if present and valid hex, otherwise cookieless hash
  const COOKIE_RE = /^[0-9a-f]{16}$/;
  const rawCookie = getCookie(req, "_ev") ?? undefined;
  const cookieVid = rawCookie && COOKIE_RE.test(rawCookie)
    ? rawCookie
    : undefined;
  let visitorId: string | undefined = cookieVid;
  const isReturning = cookieVid !== undefined;

  if (!visitorId) {
    const ip = getClientIp(req);
    const ua = req.headers.get("user-agent") ?? "";
    const day = new Date().toISOString().slice(0, 10);
    visitorId = await hashVisitor(ip, ua, siteId, day);
  }

  // Keep the exclusion cache warm on the event-only path — cookieless
  // sendBeacon traffic can reach /e without ever hitting /b.gif, and on
  // cold boot the cache is empty until refreshExcluded runs. 60s TTL
  // enforced inside refreshExcluded — cheap no-op when still fresh.
  await refreshExcluded(db);

  // Skip excluded visitors
  if (isExcluded(visitorId)) {
    return new Response(null, { status: 204 });
  }

  // Bot scoring
  const ip = getClientIp(req);
  const ipHash = await hashIp(ip);
  const burstCount = getBurstCount(ipHash); // Read-only — beacon increments
  const visitorCountry = getVisitorCountry(req);

  const ua = req.headers.get("user-agent") ?? "";
  const cfSignals = extractCloudflareSignals(req);
  const scoreResult = computeBotScoreWithDetail({
    burstCount,
    hasAcceptLanguage: req.headers.has("accept-language"),
    hasSecChUa: req.headers.has("sec-ch-ua"),
    hasSecFetchSite: req.headers.has("sec-fetch-site"),
    visitorCountry,
    siteId,
    crawlerFeedMatch: matchesCrawlerFeed(ua),
    aiCrawlerFeedMatch: matchesAiCrawlerFeed(ua),
    datacenterIp: isDatacenterIp(ip),
    ...cfSignals,
  });

  // PoW token verification
  const tok = typeof body.tok === "string" ? body.tok : null;
  const firstSession = events[0]?.sessionId;
  const sessionIdForPow = typeof firstSession === "string" ? firstSession : "";
  const tokenResult = await verifyToken(tok, siteId, sessionIdForPow);
  const powPenalty = tokenPenalty(tokenResult);
  if (powPenalty > 0) {
    scoreResult.detail.pow = powPenalty;
    scoreResult.detail.pow_result = tokenResult;
  }

  // Two-tier bot IP detection (see beacon.ts for explanation)
  const botIpPenalty = getBotIpPenalty(ipHash);
  if (botIpPenalty > 0) {
    scoreResult.detail.bot_ip = botIpPenalty;
  }

  const botScore = Math.min(
    scoreResult.score + powPenalty + botIpPenalty,
    100,
  );
  const botScoreDetail = JSON.stringify(scoreResult.detail);

  const limit = Math.min(events.length, MAX_EVENTS_PER_REQUEST);

  debug("events", "batch", {
    siteId,
    sid: sessionIdForPow.slice(0, 8) + "...",
    tok: tok ? tok.slice(0, 8) + "..." : "(none)",
    powResult: tokenResult,
    botScore,
    eventTypes: events.slice(0, limit).map((e) => e.type),
    visitorId: visitorId?.slice(0, 8) + "...",
  });

  // Discard if bot score exceeds threshold (when configured)
  if (BOT_DISCARD_THRESHOLD > 0 && botScore >= BOT_DISCARD_THRESHOLD) {
    return new Response(null, { status: 204 });
  }

  for (let i = 0; i < limit; i++) {
    const ev = events[i];
    if (!ev.type || !ALLOWED_EVENT_TYPES.has(ev.type)) continue;

    const data = ev.data ?? {};
    const dataStr = JSON.stringify(data);
    if (dataStr.length > MAX_EVENT_DATA_BYTES) continue;

    const SESSION_RE = /^[0-9a-f-]{36}$/;
    const rawSid = typeof ev.sessionId === "string" ? ev.sessionId : null;
    const sessionId = rawSid && SESSION_RE.test(rawSid) ? rawSid : null;

    // Extract experiment attribution from event data (if present)
    const experimentId = typeof data.experiment_id === "string"
      ? data.experiment_id.slice(0, 128)
      : null;
    const variantId = typeof data.variant_id === "string"
      ? data.variant_id.slice(0, 128)
      : null;

    // UTM campaign attribution (validated against active campaigns)
    const rawUtmCampaign = typeof ev.utmCampaign === "string"
      ? ev.utmCampaign.slice(0, 256)
      : null;
    const utmCampaign =
      rawUtmCampaign && isUtmCampaignActive(siteId, rawUtmCampaign)
        ? rawUtmCampaign
        : null;

    let eventRecord: SemanticEvent = {
      event_type: ev.type,
      site_id: siteId,
      session_id: sessionId,
      visitor_id: visitorId ?? null,
      data: dataStr,
      experiment_id: experimentId,
      variant_id: variantId,
      utm_campaign: utmCampaign,
      device_type: deviceType,
      referrer,
      hour,
      month,
      day_of_week: dayOfWeek,
      is_returning: isReturning ? 1 : 0,
      bot_score: botScore,
      bot_score_detail: botScoreDetail,
    };
    if (shouldAnonymize(siteId)) {
      eventRecord = await anonymizeEvent(eventRecord);
    }
    eventWriter.push(eventRecord);
  }

  return new Response(null, { status: 204 });
}
