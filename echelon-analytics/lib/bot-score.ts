// Echelon Analytics — Bot Scoring, Referrer Classification, UA Parsing
//
// Heuristic-based bot detection (0-100 score at write time).
// Entries with score >= 50 are excluded from daily rollups.
// No IP addresses are stored — only ephemeral HMAC hashes.

import {
  BEHIND_CLOUDFLARE,
  BOT_UA_PATTERNS,
  SITE_SUSPECT_COUNTRIES,
  SUSPECT_COUNTRIES,
  SUSPECT_POINTS,
  TRUST_GEO_HEADERS,
} from "./config.ts";
import type { BotScoreSignals } from "../types.ts";

/** Returns true if the UA matches a known bot pattern. These should not be tracked at all. */
export function isKnownBot(ua: string | undefined): boolean {
  if (!ua) return false;
  const lower = ua.toLowerCase();
  return BOT_UA_PATTERNS.some((pattern) => lower.includes(pattern));
}

// ── Ephemeral HMAC key (daily rotation) ─────────────────────────────────────

let hmacKey: CryptoKey;
let keyCreatedAt = 0;
const KEY_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

async function getHmacKey(): Promise<CryptoKey> {
  const now = Date.now();
  if (!hmacKey || now - keyCreatedAt > KEY_TTL_MS) {
    const raw = crypto.getRandomValues(new Uint8Array(32));
    hmacKey = await crypto.subtle.importKey(
      "raw",
      raw,
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    keyCreatedAt = now;
    burstMap.clear();
  }
  return hmacKey;
}

/** Hash an IP address to a hex string using the daily-rotating HMAC key. */
export async function hashIp(ip: string): Promise<string> {
  const key = await getHmacKey();
  const data = new TextEncoder().encode(ip);
  const sig = await crypto.subtle.sign("HMAC", key, data);
  return Array.from(new Uint8Array(sig))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Hash IP + User-Agent + site + date into a 16-char hex visitor ID.
 * Same visitor on same day = same ID. Resets daily — no cross-day tracking.
 */
export async function hashVisitor(
  ip: string,
  ua: string,
  siteId: string,
  date: string,
): Promise<string> {
  const key = await getHmacKey();
  const data = new TextEncoder().encode(`${ip}|${ua}|${siteId}|${date}`);
  const sig = await crypto.subtle.sign("HMAC", key, data);
  return Array.from(new Uint8Array(sig).slice(0, 8))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

// ── Two-tier bot IP tracking ────────────────────────────────────────────────
// Suspected: single request with bot UA (middleware detection). Low penalty
// (+20) because a single spoofed request from a shared NAT/VPN IP should not
// independently exclude legitimate users behind the same IP.
// Confirmed: statistical evidence from the correlator (cluster of identical
// fingerprints across many IPs). High penalty (+50) — definitive signal.

const SUSPECTED_TTL_MS = 30 * 60 * 1000; // 30 minutes
const CONFIRMED_TTL_MS = 60 * 60 * 1000; // 1 hour
const MAX_BOT_IP_MAP_SIZE = 50_000;

const suspectedBotIps = new Map<string, number>(); // ipHash → timestamp
const confirmedBotIps = new Map<string, number>(); // ipHash → timestamp

function pruneMap(map: Map<string, number>, ttl: number): void {
  const now = Date.now();
  for (const [k, ts] of map) {
    if (now - ts > ttl) map.delete(k);
  }
}

// When the cap is hit, evict down to this watermark (not just to the cap) so
// the O(n) prune/eviction scan runs once per ~5k inserts rather than on every
// insert — keeping the amortized cost of recording an IP O(1).
const BOT_IP_MAP_WATERMARK = Math.floor(MAX_BOT_IP_MAP_SIZE * 0.9);

/**
 * Keep `map` at or below MAX_BOT_IP_MAP_SIZE. Prune TTL-expired entries first;
 * if a flood of fresh entries still leaves it over the cap, evict the oldest
 * entries (Map preserves insertion order) down to the watermark so the map can
 * never grow unbounded.
 */
function enforceCap(map: Map<string, number>, ttl: number): void {
  if (map.size <= MAX_BOT_IP_MAP_SIZE) return;
  pruneMap(map, ttl);
  if (map.size <= MAX_BOT_IP_MAP_SIZE) return;
  let toRemove = map.size - BOT_IP_MAP_WATERMARK;
  for (const k of map.keys()) {
    if (toRemove-- <= 0) break;
    map.delete(k);
  }
}

/** Record an IP as suspected bot (e.g., bot UA leak on a non-tracking request). */
export function recordSuspectedBotIp(ipHash: string): void {
  // Refresh ordering so re-seen IPs aren't treated as oldest on eviction.
  suspectedBotIps.delete(ipHash);
  suspectedBotIps.set(ipHash, Date.now());
  enforceCap(suspectedBotIps, SUSPECTED_TTL_MS);
}

/** Record an IP as confirmed bot (correlator cluster evidence). */
export function recordConfirmedBotIp(ipHash: string): void {
  confirmedBotIps.delete(ipHash);
  confirmedBotIps.set(ipHash, Date.now());
  enforceCap(confirmedBotIps, CONFIRMED_TTL_MS);
}

/** Get bot IP penalty: 50 for confirmed, 20 for suspected, 0 for unknown. */
export function getBotIpPenalty(ipHash: string): number {
  const now = Date.now();

  const confirmedTs = confirmedBotIps.get(ipHash);
  if (confirmedTs !== undefined) {
    if (now - confirmedTs <= CONFIRMED_TTL_MS) return 50;
    confirmedBotIps.delete(ipHash);
  }

  const suspectedTs = suspectedBotIps.get(ipHash);
  if (suspectedTs !== undefined) {
    if (now - suspectedTs <= SUSPECTED_TTL_MS) return 20;
    suspectedBotIps.delete(ipHash);
  }

  return 0;
}

// ── Burst detection ─────────────────────────────────────────────────────────

interface BurstEntry {
  count: number;
  windowStart: number;
}

const BURST_WINDOW_MS = 5 * 60 * 1000; // 5 minutes
const MAX_BURST_MAP_SIZE = 100_000;
const burstMap = new Map<string, BurstEntry>();

/** Record a request from ipHash and return the current burst count. */
export function recordBurst(ipHash: string): number {
  const now = Date.now();
  if (burstMap.size > MAX_BURST_MAP_SIZE) {
    pruneBurstMap();
    if (burstMap.size > MAX_BURST_MAP_SIZE) {
      return 1; // Degrade gracefully
    }
  }
  const entry = burstMap.get(ipHash);
  if (!entry || now - entry.windowStart > BURST_WINDOW_MS) {
    burstMap.set(ipHash, { count: 1, windowStart: now });
    return 1;
  }
  entry.count++;
  return entry.count;
}

/** Read current burst count without incrementing. */
export function getBurstCount(ipHash: string): number {
  const entry = burstMap.get(ipHash);
  if (!entry) return 0;
  if (Date.now() - entry.windowStart > BURST_WINDOW_MS) return 0;
  return entry.count;
}

function pruneBurstMap(): void {
  const now = Date.now();
  for (const [key, entry] of burstMap) {
    if (now - entry.windowStart > BURST_WINDOW_MS) {
      burstMap.delete(key);
    }
  }
}

// ── Cloudflare integration ───────────────────────────────────────────────────

/**
 * Extract Cloudflare bot management signals from request headers.
 * Auto-detects whether the app is behind Cloudflare.
 *
 * Headers (require Cloudflare Bot Management or Transform Rules):
 * - cf-bot-score: 1-99 (1=bot, 99=human)
 * - cf-verified-bot: "true"/"false"
 *
 * Free-tier headers always present behind Cloudflare:
 * - cf-connecting-ip: real client IP
 * - cf-ipcountry: 2-letter country code
 * - cf-ray: request ID (used to detect Cloudflare presence)
 */
export function extractCloudflareSignals(
  req: Request,
): { cfBotScore?: number; cfVerifiedBot?: boolean } {
  // Only process if explicitly configured as behind Cloudflare
  if (!BEHIND_CLOUDFLARE) return {};

  const result: { cfBotScore?: number; cfVerifiedBot?: boolean } = {};

  const botScore = req.headers.get("cf-bot-score");
  if (botScore) {
    const parsed = parseInt(botScore, 10);
    if (parsed >= 1 && parsed <= 99) {
      result.cfBotScore = parsed;
    }
  }

  const verifiedBot = req.headers.get("cf-verified-bot");
  if (verifiedBot === "true") {
    result.cfVerifiedBot = true;
  }

  return result;
}

// ── Score computation ───────────────────────────────────────────────────────

const BURST_THRESHOLD = 15;

/** Detailed bot score result with per-factor breakdown. */
export interface BotScoreResult {
  score: number;
  detail: Record<string, number | string>;
}

/** Compute a bot score with per-factor breakdown. */
export function computeBotScoreWithDetail(
  signals: BotScoreSignals,
): BotScoreResult {
  const detail: Record<string, number> = {};

  // Cloudflare Bot Management integration (when available)
  // CF scale: 1=bot, 99=human → invert to our scale: 0=human, 100=bot
  if (signals.cfBotScore !== undefined) {
    let cfPenalty = 0;
    if (signals.cfVerifiedBot) {
      cfPenalty = 15;
    } else if (signals.cfBotScore <= 2) {
      cfPenalty = 50;
    } else if (signals.cfBotScore <= 29) {
      cfPenalty = 30;
    } else if (signals.cfBotScore <= 50) {
      cfPenalty = 10;
    }
    if (cfPenalty > 0) detail.cf = cfPenalty;
  }

  // Low interaction time — beacon gate is 800ms (skip for SPA navigations)
  if (signals.interactionMs !== undefined && !signals.isSpaNav) {
    if (signals.interactionMs < 850) {
      detail.timing = 20;
    } else if (signals.interactionMs < 1000) {
      detail.timing = 8;
    }
  }

  // High-suspicion country (global list)
  if (
    signals.visitorCountry &&
    SUSPECT_COUNTRIES.has(signals.visitorCountry.toUpperCase())
  ) {
    detail.geo = SUSPECT_POINTS;
  }

  // Per-site suspect countries (additive — stacks with global)
  if (signals.visitorCountry && signals.siteId) {
    const siteSuspect = SITE_SUSPECT_COUNTRIES.get(
      signals.siteId.toLowerCase(),
    );
    if (siteSuspect?.has(signals.visitorCountry.toUpperCase())) {
      detail.geo_site = SUSPECT_POINTS;
    }
  }

  // Burst detection
  if (signals.burstCount > BURST_THRESHOLD) {
    detail.burst = 25;
  }

  // Missing Accept-Language or missing both Sec-CH-UA AND Sec-Fetch-Site
  let headerPenalty = 0;
  if (!signals.hasAcceptLanguage) {
    headerPenalty += 10;
  }
  if (!signals.hasSecChUa && !signals.hasSecFetchSite) {
    headerPenalty += 10;
  }
  if (headerPenalty > 0) detail.headers = headerPenalty;

  // Unrealistic screen dimensions
  if (
    signals.screenWidth !== undefined || signals.screenHeight !== undefined
  ) {
    const w = signals.screenWidth ?? 0;
    const h = signals.screenHeight ?? 0;
    if (w <= 0 || w > 10000 || h <= 0 || h > 10000) {
      detail.screen = 10;
    }
  }

  // No referrer + deep page path (>=2 segments)
  if (
    (!signals.referrer || signals.referrer === "direct_or_unknown") &&
    signals.path
  ) {
    const segments = signals.path.split("/").filter(Boolean);
    if (segments.length >= 2) {
      detail.referrer = 5;
    }
  }

  // Threat feed matches (async-refreshed, checked synchronously)
  if (signals.crawlerFeedMatch) detail.crawler_feed = 30;
  if (signals.aiCrawlerFeedMatch) detail.ai_crawler_feed = 40;
  if (signals.datacenterIp) detail.datacenter_ip = 15;

  const score = Math.min(
    Object.values(detail).reduce((sum, v) => sum + v, 0),
    100,
  );
  return { score, detail };
}

/** Compute a bot score from 0 (definitely human) to 100 (definitely bot). */
export function computeBotScore(signals: BotScoreSignals): number {
  return computeBotScoreWithDetail(signals).score;
}

// ── Referrer classification ─────────────────────────────────────────────────

const AI_DOMAINS = new Set([
  "perplexity.ai",
  "chat.openai.com",
  "chatgpt.com",
  "claude.ai",
  "you.com",
  "phind.com",
  "copilot.microsoft.com",
  "gemini.google.com",
  "poe.com",
]);

const SEARCH_DOMAINS = new Set([
  "google.com",
  "google.co.uk",
  "google.de",
  "google.fr",
  "google.fi",
  "google.nl",
  "google.pl",
  "google.se",
  "google.no",
  "google.it",
  "google.pt",
  "google.es",
  "google.hu",
  "google.cz",
  "google.ro",
  "google.sk",
  "google.rs",
  "bing.com",
  "yahoo.com",
  "duckduckgo.com",
  "yandex.com",
  "yandex.ru",
  "ecosia.org",
]);

const SOCIAL_DOMAINS = new Set([
  "facebook.com",
  "twitter.com",
  "x.com",
  "reddit.com",
  "linkedin.com",
  "instagram.com",
  "t.co",
]);

/** Classify a referrer string into a traffic source category. */
export function classifyReferrer(
  referrer: string,
): "ai" | "search" | "social" | "direct_or_unknown" {
  if (!referrer || referrer === "direct_or_unknown") {
    return "direct_or_unknown";
  }

  let host: string;
  try {
    host = new URL(referrer).hostname.replace(/^www\./, "");
  } catch {
    return "direct_or_unknown";
  }

  for (const domain of AI_DOMAINS) {
    if (host === domain || host.endsWith(`.${domain}`)) return "ai";
  }
  for (const domain of SEARCH_DOMAINS) {
    if (host === domain || host.endsWith(`.${domain}`)) return "search";
  }
  for (const domain of SOCIAL_DOMAINS) {
    if (host === domain || host.endsWith(`.${domain}`)) return "social";
  }

  return "direct_or_unknown";
}

// ── Device classification + OS parsing ──────────────────────────────────────

/** Classify device type from screen width. */
export function classifyDevice(
  screenWidth: number | undefined,
): string | undefined {
  if (screenWidth === undefined) return undefined;
  if (screenWidth < 768) return "mobile";
  if (screenWidth <= 1024) return "tablet";
  return "desktop";
}

/** Parse OS name + version from User-Agent string. */
export function parseOS(ua: string | undefined): string | undefined {
  if (!ua) return undefined;

  const ios = ua.match(/CPU (?:iPhone )?OS (\d+[_\.]\d+(?:[_\.]\d+)?)/);
  if (ios) return `iOS ${ios[1].replace(/_/g, ".")}`;

  const android = ua.match(/Android (\d+(?:\.\d+)?)/);
  if (android) return `Android ${android[1]}`;

  const winNT = ua.match(/Windows NT (\d+\.\d+)/);
  if (winNT) {
    const ver = winNT[1];
    // Windows 10 and Windows 11 both report NT 10.0 in the UA string — the
    // browser only distinguishes them via Sec-CH-UA-Platform-Version, which
    // we don't receive in this path. Label accordingly.
    const winMap: Record<string, string> = {
      "10.0": "Windows 10/11",
      "6.3": "Windows 8.1",
      "6.1": "Windows 7",
    };
    return winMap[ver] ?? `Windows NT ${ver}`;
  }

  const mac = ua.match(/Mac OS X (\d+[_\.]\d+(?:[_\.]\d+)?)/);
  if (mac) {
    const ver = mac[1].replace(/_/g, ".");
    const major = parseInt(ver);
    if (major >= 11) return `macOS ${major}`;
    return `macOS ${ver}`;
  }

  if (/CrOS/.test(ua)) return "ChromeOS";
  if (/Linux/.test(ua) && !/Android/.test(ua)) return "Linux";

  return undefined;
}

/** Parse browser name + version from User-Agent string. */
export function parseBrowser(
  ua: string | undefined,
): { name: string; version: string } | undefined {
  if (!ua) return undefined;

  // Order matters: check specific browsers before generic ones
  const edge = ua.match(/Edg(?:e|A|iOS)?\/(\d+(?:\.\d+)*)/);
  if (edge) return { name: "Edge", version: edge[1] };

  const opera = ua.match(/(?:OPR|Opera)\/(\d+(?:\.\d+)*)/);
  if (opera) return { name: "Opera", version: opera[1] };

  const samsung = ua.match(/SamsungBrowser\/(\d+(?:\.\d+)*)/);
  if (samsung) return { name: "Samsung Browser", version: samsung[1] };

  const uc = ua.match(/UCBrowser\/(\d+(?:\.\d+)*)/);
  if (uc) return { name: "UC Browser", version: uc[1] };

  // Chrome (must come after Edge, Opera, Samsung, UC which also contain "Chrome")
  const chrome = ua.match(/(?:Chrome|CriOS)\/(\d+(?:\.\d+)*)/);
  if (chrome && !/Edg/.test(ua) && !/OPR/.test(ua)) {
    return { name: "Chrome", version: chrome[1] };
  }

  const firefox = ua.match(/(?:Firefox|FxiOS)\/(\d+(?:\.\d+)*)/);
  if (firefox) return { name: "Firefox", version: firefox[1] };

  // Safari (must come after Chrome and Firefox which also contain "Safari")
  const safari = ua.match(/Version\/(\d+(?:\.\d+)*)\s.*Safari/);
  if (safari) return { name: "Safari", version: safari[1] };

  return undefined;
}

// ── Geo headers ─────────────────────────────────────────────────────────────

/** Extract visitor country from CDN geo headers. */
export function getVisitorCountry(req: Request): string | undefined {
  if (BEHIND_CLOUDFLARE) {
    const cf = req.headers.get("cf-ipcountry");
    if (cf && cf !== "XX" && cf !== "T1") return cf.toUpperCase();
  }

  if (TRUST_GEO_HEADERS) {
    const aws = req.headers.get("cloudfront-viewer-country");
    if (aws) return aws.toUpperCase();

    const generic = req.headers.get("x-country-code");
    if (generic) return generic.toUpperCase();
  }

  return undefined;
}
