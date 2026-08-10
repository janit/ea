// Echelon Analytics — Pixel Beacon Endpoint (GET /b.gif)
//
// Returns a 43-byte 1x1 transparent GIF and records the pageview.
// Visitor identity managed via HttpOnly cookie (_ev).

import type { DbAdapter } from "./db/adapter.ts";
import type { ViewRecord } from "../types.ts";
import { getClientIp } from "./ip.ts";
import {
  classifyDevice,
  classifyReferrer,
  computeBotScoreWithDetail,
  extractCloudflareSignals,
  getBotIpPenalty,
  getVisitorCountry,
  hashIp,
  hashVisitor,
  isKnownBot,
  parseBrowser,
  parseOS,
  recordBurst,
} from "./bot-score.ts";
import {
  ALLOWED_SITES,
  BOT_DISCARD_THRESHOLD,
  IGNORED_SITES,
  validateSiteId,
  VIEW_FLUSH_MS,
} from "./config.ts";
import { anonymizeView, shouldAnonymize } from "./anonymize.ts";
import { tokenPenalty, verifyToken } from "./challenge.ts";
import { recordPrint } from "./bot-correlator.ts";
import {
  isDatacenterIp,
  matchesAiCrawlerFeed,
  matchesCrawlerFeed,
} from "./threat-feeds.ts";
import { BufferedWriter } from "./buffered-writer.ts";
import { isUtmCampaignActive, refreshUtmCampaigns } from "./utm.ts";
import { refreshConsentCss } from "./consent-css.ts";
import { debug } from "./debug.ts";

// 1x1 transparent GIF (43 bytes)
export const PIXEL = new Uint8Array([
  0x47,
  0x49,
  0x46,
  0x38,
  0x39,
  0x61,
  0x01,
  0x00,
  0x01,
  0x00,
  0x80,
  0x00,
  0x00,
  0xff,
  0xff,
  0xff,
  0x00,
  0x00,
  0x00,
  0x21,
  0xf9,
  0x04,
  0x01,
  0x00,
  0x00,
  0x00,
  0x00,
  0x2c,
  0x00,
  0x00,
  0x00,
  0x00,
  0x01,
  0x00,
  0x01,
  0x00,
  0x00,
  0x02,
  0x02,
  0x44,
  0x01,
  0x00,
  0x3b,
]);

const GIF_HEADERS = {
  "Content-Type": "image/gif",
  "Cache-Control": "no-store",
  "Content-Length": String(PIXEL.length),
};

const COOKIE_RE = /^[0-9a-f]{16}$/;
const SESSION_RE = /^[0-9a-f-]{36}$/;

import { getRequestCookie as getCookie } from "./cookie.ts";

// ── Buffered writer ─────────────────────────────────────────────────────────

import type { SQLParam } from "./db/adapter.ts";

const VIEW_COLS = `(visitor_id, path, site_id, session_id, interaction_ms,
   screen_width, screen_height, device_type, os_name, browser_name, browser_version,
   country_code,
   is_returning, referrer, referrer_type, bot_score, bot_score_detail, is_pwa,
   utm_source, utm_medium, utm_campaign, utm_content, utm_term)`;
const VIEW_COL_COUNT = 23;
const CHUNK_SIZE = 50;
const ONE_ROW = `(${Array(VIEW_COL_COUNT).fill("?").join(",")})`;

function viewParams(v: ViewRecord): SQLParam[] {
  return [
    v.visitor_id,
    v.path,
    v.site_id,
    v.session_id,
    v.interaction_ms,
    v.screen_width,
    v.screen_height,
    v.device_type,
    v.os_name,
    v.browser_name,
    v.browser_version,
    v.country_code,
    v.is_returning,
    v.referrer,
    v.referrer_type,
    v.bot_score,
    v.bot_score_detail ?? null,
    v.is_pwa,
    v.utm_source ?? null,
    v.utm_medium ?? null,
    v.utm_campaign ?? null,
    v.utm_content ?? null,
    v.utm_term ?? null,
  ];
}

const viewWriter = new BufferedWriter<ViewRecord>(
  async (db, batch) => {
    await db.transaction(async (tx) => {
      for (let i = 0; i < batch.length; i += CHUNK_SIZE) {
        const chunk = batch.slice(i, i + CHUNK_SIZE);
        const values = chunk.map(() => ONE_ROW).join(",");
        const sql = `INSERT INTO visitor_views ${VIEW_COLS} VALUES ${values}`;
        const params: SQLParam[] = [];
        for (const v of chunk) params.push(...viewParams(v));
        await tx.run(sql, ...params);
      }
    });
  },
  50_000,
  VIEW_FLUSH_MS,
  "View",
);

// ── Excluded visitors cache (refreshed every 60s, capped at 100K) ───────────
const MAX_EXCLUDED_CACHE = 100_000;
const excludedSet = new Set<string>();
let excludedRefreshedAt = 0;

export async function refreshExcluded(db: DbAdapter): Promise<void> {
  if (Date.now() - excludedRefreshedAt < 60_000) return;
  excludedSet.clear();
  const rows = await db.query<{ visitor_id: string }>(
    `SELECT visitor_id FROM excluded_visitors LIMIT ${MAX_EXCLUDED_CACHE}`,
  );
  for (const r of rows) excludedSet.add(r.visitor_id);
  excludedRefreshedAt = Date.now();
}

export function isExcluded(visitorId: string): boolean {
  return excludedSet.has(visitorId);
}

export function startViewWriter(db: DbAdapter): void {
  viewWriter.start(db);
}

export async function flushRemainingViews(db: DbAdapter): Promise<void> {
  await viewWriter.stop(db);
}

/** Writer health for the health endpoint. Healthy = nothing failed or dropped. */
export function getViewWriterHealth(): {
  failedCycles: number;
  dropped: number;
} {
  return {
    failedCycles: viewWriter.failedCycles,
    dropped: viewWriter.droppedCount,
  };
}

export function getViewBufferSize(): number {
  return viewWriter.size;
}

// ── Request handler ─────────────────────────────────────────────────────────

export async function handleBeacon(
  req: Request,
  db: DbAdapter,
): Promise<Response> {
  // Drop known bots immediately — no tracking, no scoring
  const ua = req.headers.get("user-agent") ?? "";
  if (isKnownBot(ua)) {
    return new Response(PIXEL, { headers: GIF_HEADERS });
  }

  const url = new URL(req.url);

  // Decode path (base64-encoded)
  const pB64 = url.searchParams.get("p");
  let path: string | null = null;
  if (pB64) {
    try {
      path = decodeURIComponent(atob(pB64));
    } catch { /* malformed base64 */ }
  }
  if (path && path.length > 2048) path = path.slice(0, 2048);

  // Require interaction proof: _v param with plausible timing (800ms-1h) or "spa" for SPA navigations
  const vRaw = url.searchParams.get("_v");
  const isSpaNav = vRaw === "spa";
  const interactionMs = isSpaNav
    ? 0
    : (vRaw !== null ? parseInt(vRaw, 10) : NaN);
  const validInteraction = isSpaNav || (!isNaN(interactionMs) &&
    interactionMs >= 800 &&
    interactionMs <= 3_600_000);

  // Parse external referrer (base64-encoded, origin only)
  const refB64 = url.searchParams.get("ref");
  let referrer = "direct_or_unknown";
  if (refB64) {
    try {
      const decoded = atob(refB64);
      const refUrl = new URL(decoded);
      referrer = refUrl.origin;
    } catch { /* malformed */ }
  }

  // Parse screen dimensions
  const swRaw = url.searchParams.get("sw");
  const shRaw = url.searchParams.get("sh");
  const screenWidth = swRaw !== null ? parseInt(swRaw, 10) : undefined;
  const screenHeight = shRaw !== null ? parseInt(shRaw, 10) : undefined;
  const validScreen = screenWidth !== undefined && screenWidth > 0 &&
    screenWidth <= 10000;

  // Parse session ID (UUID from sessionStorage)
  const sidRaw = url.searchParams.get("sid");
  const sessionId = sidRaw && SESSION_RE.test(sidRaw) ? sidRaw : null;

  // Site ID from data-site attribute
  const siteId = validateSiteId(url.searchParams.get("s") ?? "default");

  // Silently drop ignored or non-allowed sites
  const siteLower = siteId.toLowerCase();
  if (IGNORED_SITES.has(siteLower)) {
    return new Response(PIXEL, { headers: GIF_HEADERS });
  }
  if (ALLOWED_SITES.size > 0 && !ALLOWED_SITES.has(siteLower)) {
    return new Response(PIXEL, { headers: GIF_HEADERS });
  }

  // Cookie mode: opt-in via ck=1 query param
  const useCookie = url.searchParams.get("ck") === "1";

  // Visitor identity
  const existingEv = getCookie(req, "_ev");
  const validEv = existingEv !== null && COOKIE_RE.test(existingEv)
    ? existingEv
    : null;

  let visitorId: string;
  let isReturning: boolean;

  if (useCookie) {
    isReturning = validEv !== null;
    visitorId = validEv ??
      Array.from(crypto.getRandomValues(new Uint8Array(8)))
        .map((b) => b.toString(16).padStart(2, "0")).join("");
  } else {
    const ip = getClientIp(req);
    const day = new Date().toISOString().slice(0, 10);
    visitorId = await hashVisitor(ip, ua, siteId, day);
    isReturning = false;
  }

  // Refresh exclusion cache + UTM campaign cache + consent CSS cache
  await refreshExcluded(db);
  await refreshUtmCampaigns(db);
  await refreshConsentCss(db);

  // Drop excluded visitors at ingest, as the events endpoint already does.
  // This path refreshed the cache but never consulted it, so an excluded
  // visitor's pageviews were still written to visitor_views — filtered out of
  // the daily rollup, but present in every raw-sourced figure.
  if (isExcluded(visitorId)) {
    return new Response(PIXEL, { headers: GIF_HEADERS });
  }

  // Parse UTM params (base64-encoded from tracker)
  const decodeB64Param = (key: string): string | null => {
    const v = url.searchParams.get(key);
    if (!v) return null;
    try {
      return decodeURIComponent(atob(v)).slice(0, 256);
    } catch {
      return null;
    }
  };

  let utmCampaign = decodeB64Param("uc");
  let utmSource: string | null = null;
  let utmMedium: string | null = null;
  let utmContent: string | null = null;
  let utmTerm: string | null = null;

  if (utmCampaign && isUtmCampaignActive(siteId, utmCampaign)) {
    utmSource = decodeB64Param("us");
    utmMedium = decodeB64Param("um");
    utmContent = decodeB64Param("uct");
    utmTerm = decodeB64Param("ut");
  } else {
    utmCampaign = null;
  }

  // Record if valid and not excluded
  if (
    validInteraction && path && path.startsWith("/") &&
    !excludedSet.has(visitorId)
  ) {
    const ip = getClientIp(req);
    const ipHash = await hashIp(ip);
    const burstCount = recordBurst(ipHash);
    const visitorCountry = getVisitorCountry(req);

    const cfSignals = extractCloudflareSignals(req);
    const scoreResult = computeBotScoreWithDetail({
      interactionMs,
      isSpaNav,
      burstCount,
      hasAcceptLanguage: req.headers.has("accept-language"),
      hasSecChUa: req.headers.has("sec-ch-ua"),
      hasSecFetchSite: req.headers.has("sec-fetch-site"),
      screenWidth,
      screenHeight,
      referrer,
      path,
      visitorCountry,
      siteId,
      crawlerFeedMatch: matchesCrawlerFeed(ua),
      aiCrawlerFeedMatch: matchesAiCrawlerFeed(ua),
      datacenterIp: isDatacenterIp(ip),
      ...cfSignals,
    });

    // PoW token verification
    const tok = url.searchParams.get("tok");
    const tokenResult = await verifyToken(tok, siteId, sessionId ?? "");
    const powPenalty = tokenPenalty(tokenResult);
    if (powPenalty > 0) {
      scoreResult.detail.pow = powPenalty;
      scoreResult.detail.pow_result = tokenResult;
    }

    // Two-tier bot IP detection: suspected (+20) from UA leaks,
    // confirmed (+50) from correlator clusters.
    const botIpPenalty = getBotIpPenalty(ipHash);
    if (botIpPenalty > 0) {
      scoreResult.detail.bot_ip = botIpPenalty;
    }

    const botScore = Math.min(
      scoreResult.score + powPenalty + botIpPenalty,
      100,
    );

    debug("beacon", "pageview", {
      path,
      siteId,
      sid: sessionId?.slice(0, 8) + "...",
      tok: tok ? tok.slice(0, 8) + "..." : "(none)",
      powResult: tokenResult,
      botScore,
      detail: scoreResult.detail,
    });

    const isPwa = url.searchParams.get("pwa") === "1";
    const osName = parseOS(ua || undefined);
    const browser = parseBrowser(ua || undefined);
    const deviceType = validScreen ? classifyDevice(screenWidth) : undefined;

    // Feed the bot correlator — ephemeral fingerprint for async clustering
    recordPrint({
      ipHash,
      visitorId,
      siteId,
      fingerprint: {
        osName: osName ?? "unknown",
        browserName: browser?.name ?? "unknown",
        browserVersion: browser?.version ?? "unknown",
        screenWidth: validScreen ? screenWidth! : 0,
        screenHeight: validScreen ? screenHeight! : 0,
        countryCode: visitorCountry ?? "unknown",
        // Bounded like every other fingerprint field. The raw header is
        // attacker-controlled and up to 32 KB, is held in `prints` for 20
        // minutes, and is serialized verbatim into bot_score_detail for every
        // row a cluster touches.
        acceptLanguage: (req.headers.get("accept-language") ?? "unknown").slice(
          0,
          64,
        ),
      },
      // `>= 50` matched only the confirmed map, which the correlator alone
      // writes — so reaching the tainted tier required already having been
      // confirmed, and the 4-IP threshold it gates was unreachable. The
      // suspected map (+20), fed by headless-UA leaks in the root middleware,
      // is what this tier was meant to consume. A 4-IP identical-fingerprint
      // cluster is already statistical evidence, so the shared-NAT caution
      // behind the low suspected penalty does not apply once clustering passed.
      headlessTainted: botIpPenalty > 0,
      timestamp: Date.now(),
    });

    // Discard if bot score exceeds threshold (when configured)
    const discard = BOT_DISCARD_THRESHOLD > 0 &&
      botScore >= BOT_DISCARD_THRESHOLD;

    if (!discard) {
      let view: ViewRecord = {
        visitor_id: visitorId,
        path,
        site_id: siteId,
        session_id: sessionId,
        interaction_ms: interactionMs,
        screen_width: validScreen ? screenWidth! : null,
        screen_height: validScreen ? screenHeight! : null,
        device_type: deviceType ?? null,
        os_name: osName ?? null,
        browser_name: browser?.name ?? null,
        browser_version: browser?.version ?? null,
        country_code: visitorCountry ?? null,
        is_returning: isReturning ? 1 : 0,
        referrer,
        referrer_type: classifyReferrer(referrer),
        bot_score: botScore,
        bot_score_detail: JSON.stringify(scoreResult.detail),
        is_pwa: isPwa ? 1 : 0,
        utm_source: utmSource,
        utm_medium: utmMedium,
        utm_campaign: utmCampaign,
        utm_content: utmContent,
        utm_term: utmTerm,
      };
      if (shouldAnonymize(siteId)) {
        view = await anonymizeView(view);
      }
      viewWriter.push(view);
    }
  }

  // Return the pixel — only set cookie in cookie mode
  const responseHeaders = new Headers(GIF_HEADERS);
  if (useCookie) {
    responseHeaders.set(
      "Set-Cookie",
      `_ev=${visitorId}; Path=/; HttpOnly; SameSite=None; Secure; Partitioned; Max-Age=2592000`,
    );
  }
  return new Response(PIXEL, { headers: responseHeaders });
}
