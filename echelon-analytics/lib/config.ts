// Echelon Analytics — Centralized Configuration

export const DEBUG = Deno.env.get("ECHELON_DEBUG") === "true";
export const VERSION = Deno.env.get("VERSION") ?? "dev";
export const DB_PATH = Deno.env.get("ECHELON_DB_PATH") ?? "./echelon.db";
// Empty string = no bearer auth configured. Middleware guards with `if (SECRET)`.
export const SECRET = Deno.env.get("ECHELON_SECRET") ?? "";
export const RETENTION_DAYS = parseInt(
  Deno.env.get("ECHELON_RETENTION_DAYS") ?? "90",
) || 90;

// Bot data retention — how long to keep views/events with bot_score >= 50.
// Defaults to RETENTION_DAYS (same as clean data). Set lower to reclaim disk sooner.
export const BOT_RETENTION_DAYS = parseInt(
  Deno.env.get("ECHELON_BOT_RETENTION_DAYS") ?? "",
) || RETENTION_DAYS;

export const SUSPECT_COUNTRIES = new Set(
  (Deno.env.get("ECHELON_SUSPECT_COUNTRIES") ?? "CN")
    .split(",")
    .map((s) => s.trim().toUpperCase())
    .filter(Boolean),
);

export const SUSPECT_POINTS =
  parseInt(Deno.env.get("ECHELON_SUSPECT_POINTS") ?? "", 10) || 30;

// Per-signal bot score weight overrides — "key:points,key:points".
// Keys and defaults: DEFAULT_WEIGHTS in bot-score.ts. Parsed there.
export const BOT_SCORE_WEIGHTS_RAW =
  Deno.env.get("ECHELON_BOT_SCORE_WEIGHTS") ??
    "";

// Bot score threshold — views/events with score >= this are discarded entirely (not stored).
// Default 50 = drop definitive bots. Set to 0 to store everything (filter in rollups only).
export const BOT_DISCARD_THRESHOLD = parseInt(
  Deno.env.get("ECHELON_BOT_DISCARD_THRESHOLD") ?? "50",
  10,
);

// Strict engagement: a session that never produces an interaction event stops
// counting as human (its score is moved to the threshold 30 minutes in).
// Off by default — on a content site, people who read and leave are real
// visitors, and that is a product decision for the operator to make.
export const REQUIRE_ENGAGEMENT =
  Deno.env.get("ECHELON_REQUIRE_ENGAGEMENT") === "true";

// Challenge PoW — how many past minutes of challenges to accept as valid.
// With max-age=300 (5 min) on /ea.js, 10 min covers cache TTL + clock skew.
export const CHALLENGE_WINDOW_MINUTES = parseInt(
  Deno.env.get("ECHELON_CHALLENGE_WINDOW_MINUTES") ?? "10",
);

// Buffered writer intervals (milliseconds)
export const VIEW_FLUSH_MS = Math.max(
  1000,
  parseInt(
    Deno.env.get("ECHELON_VIEW_FLUSH_MS") ?? "15000",
  ) || 15000,
); // default 15s
export const EVENT_FLUSH_MS = Math.max(
  1000,
  parseInt(
    Deno.env.get("ECHELON_EVENT_FLUSH_MS") ?? "10000",
  ) || 10000,
); // default 10s

// Allowed origins/sites for tracking — comma-separated list of domains
// e.g. "islets.app,www.islets.app,afroute.com,zambia.afroute.com,maroc.afroute.com"
// Empty = accept all (open mode). When set, only these domains can send tracking data.
export const ALLOWED_ORIGINS: Set<string> = (() => {
  const raw = Deno.env.get("ECHELON_ALLOWED_ORIGINS") ?? "";
  const domains = raw.split(",").map((s) => s.trim().toLowerCase()).filter(
    Boolean,
  );
  return new Set(domains);
})();

// Rate limiting — max requests per IP per window (tracking endpoints only)
// Set to 0 to disable. Default: 100 requests per 60 seconds.
export const RATE_LIMIT_MAX =
  parseInt(Deno.env.get("ECHELON_RATE_LIMIT_MAX") ?? "", 10) || 100;
export const RATE_LIMIT_WINDOW_MS =
  parseInt(Deno.env.get("ECHELON_RATE_LIMIT_WINDOW_MS") ?? "", 10) || 60_000;

// Known bot User-Agent substrings — requests matching these are dropped (not tracked at all).
// Comma-separated. Matching is case-insensitive.
export const BOT_UA_PATTERNS: string[] = (() => {
  const defaults =
    "Googlebot,Bingbot,bingbot,Slurp,DuckDuckBot,Baiduspider,YandexBot," +
    "Sogou,Exabot,facebot,facebookexternalhit,ia_archiver," +
    "Applebot,AdsBot-Google,Mediapartners-Google,APIs-Google," +
    "AhrefsBot,SemrushBot,MJ12bot,DotBot,PetalBot,BLEXBot," +
    "GPTBot,ChatGPT-User,OAI-SearchBot,ClaudeBot,Claude-Web," +
    "Bytespider,CCBot,DataForSeoBot,Amazonbot,anthropic-ai," +
    "PerplexityBot,YouBot,Scrapy,curl,wget,python-requests,Go-http-client,HeadlessChrome," +
    "Amzn-SearchBot";
  const raw = Deno.env.get("ECHELON_BOT_UA_PATTERNS") ?? defaults;
  return raw.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
})();

// Per-site suspect country overrides — format: "site_id:CC,CC;site_id:CC"
// e.g. "maroc.afroute.com:CN,RU;zambia.afroute.com:CN"
// These add extra bot score points (SUSPECT_POINTS) for the specified countries
// ON TOP of the global SUSPECT_COUNTRIES list.
export const SITE_SUSPECT_COUNTRIES: Map<string, Set<string>> = (() => {
  const raw = Deno.env.get("ECHELON_SITE_SUSPECT_COUNTRIES") ?? "";
  const map = new Map<string, Set<string>>();
  if (!raw) return map;
  for (const entry of raw.split(";")) {
    const [site, countries] = entry.split(":");
    if (!site || !countries) continue;
    const set = new Set(
      countries.split(",").map((s) => s.trim().toUpperCase()).filter(Boolean),
    );
    if (set.size > 0) map.set(site.trim().toLowerCase(), set);
  }
  return map;
})();

// Auth — username + PBKDF2 password hash
// Generate: deno eval "import{hashPassword}from'./lib/auth.ts';console.log(await hashPassword('yourpassword'))"
export const AUTH_USERNAME = Deno.env.get("ECHELON_USERNAME") ?? "";
export const AUTH_PASSWORD_HASH = Deno.env.get("ECHELON_PASSWORD_HASH") ?? "";

/** Constant-time string comparison to prevent timing attacks.
 *  Returns false immediately for different lengths (length is not
 *  secret for API tokens). Uses Deno's native timingSafeEqual
 *  for byte-level comparison, with a manual XOR fallback. */
export function constantTimeEquals(a: string, b: string): boolean {
  const enc = new TextEncoder();
  const bufA = enc.encode(a);
  const bufB = enc.encode(b);

  if (bufA.byteLength !== bufB.byteLength) return false;

  // Prefer Deno's native timingSafeEqual when available
  const subtle = crypto.subtle as unknown as {
    timingSafeEqual?(a: BufferSource, b: BufferSource): boolean;
  };
  if (typeof subtle.timingSafeEqual === "function") {
    return subtle.timingSafeEqual(bufA, bufB);
  }

  // Fallback: constant-time byte-by-byte XOR
  let diff = 0;
  for (let i = 0; i < bufA.byteLength; i++) {
    diff |= bufA[i] ^ bufB[i];
  }
  return diff === 0;
}

/** Validate a site ID: max 64 chars, alphanumeric + ._-  Defaults to "default". */
export function validateSiteId(raw: string): string {
  return raw.length <= 64 && /^[a-zA-Z0-9._-]+$/.test(raw) ? raw : "default";
}

/** Strict site ID validation for API routes — returns null for invalid IDs. */
export function validateSiteIdStrict(raw: string): string | null {
  return raw.length > 0 && raw.length <= 64 && /^[a-zA-Z0-9._-]+$/.test(raw)
    ? raw
    : null;
}

// Allowed site IDs — comma-separated allowlist.
// When set, only these site IDs can send tracking data. Empty = accept all.
export const ALLOWED_SITES: Set<string> = (() => {
  const raw = Deno.env.get("ECHELON_ALLOWED_SITES") ?? "";
  const sites = raw.split(",").map((s) => s.trim().toLowerCase()).filter(
    Boolean,
  );
  return new Set(sites);
})();

// Site IDs to silently ignore (never store views/events).
// Comma-separated. Always includes "smoke-test" to filter deploy smoke tests.
export const IGNORED_SITES: Set<string> = (() => {
  const raw = Deno.env.get("ECHELON_IGNORED_SITES") ?? "";
  const sites = raw.split(",").map((s) => s.trim().toLowerCase()).filter(
    Boolean,
  );
  sites.push("smoke-test");
  return new Set(sites);
})();

// Trust proxy headers (X-Forwarded-For, X-Real-IP) for real client IP.
// Set to "true" when behind a trusted reverse proxy (Nginx, Caddy, etc.)
export const TRUST_PROXY = Deno.env.get("ECHELON_TRUST_PROXY") === "true";

// Live stats window — how many minutes the admin nav stats bar covers (default: 10).
export const LIVE_STATS_MINUTES = parseInt(
  Deno.env.get("ECHELON_LIVE_STATS_MINUTES") ?? "10",
);

// Graceful shutdown timeout (milliseconds). Increase for large databases.
// A NaN here would make the force-exit timer fire at once, abandoning the
// buffered records the shutdown exists to flush.
export const SHUTDOWN_TIMEOUT_MS = parseInt(
  Deno.env.get("ECHELON_SHUTDOWN_TIMEOUT_MS") ?? "60000",
) || 60000;

// Display timezone for admin UI timestamps (IANA timezone, e.g. "Europe/Oslo").
// Data is always stored in UTC. This only affects how times render in the admin panel.
// Default: "UTC"
export const DISPLAY_TIMEZONE = Deno.env.get("ECHELON_DISPLAY_TIMEZONE") ??
  "UTC";

// Cookie consent banner — when true and data-cookie is set on the script tag,
// a small consent banner is shown before setting the visitor cookie.
// Set to "true" to enable. When false, data-cookie sets the cookie without asking.
export const COOKIE_CONSENT = Deno.env.get("ECHELON_COOKIE_CONSENT") === "true";

// Telemetry — opt-in anonymous admin usage data sent to the Echelon project.
// "true" = force on, "false" = force off, unset = respect per-instance DB setting.
export const TELEMETRY_OVERRIDE: "on" | "off" | null = (() => {
  const raw = Deno.env.get("ECHELON_TELEMETRY");
  if (raw === "true") return "on";
  if (raw === "false") return "off";
  return null;
})();
export const TELEMETRY_SITE_ID = "ea";
export const TELEMETRY_ENDPOINT = "https://ea.islets.app";

// Sites to anonymize before storage — comma-separated site IDs.
// Records for these sites get HMAC-hashed visitor IDs, fictional countries, etc.
export const ANONYMIZE_SITES: Set<string> = (() => {
  const raw = Deno.env.get("ECHELON_ANONYMIZE_SITES") ?? "";
  const sites = raw.split(",").map((s) => s.trim().toLowerCase()).filter(
    Boolean,
  );
  return new Set(sites);
})();

// Public mode — disables admin auth requirement for public dashboards.
export const PUBLIC_MODE = Deno.env.get("ECHELON_PUBLIC_MODE") === "true";

// Explicit Cloudflare mode — only trust CF headers when enabled.
// When false, cf-ray/cf-connecting-ip/cf-ipcountry/cf-bot-score headers are ignored.
export const BEHIND_CLOUDFLARE =
  Deno.env.get("ECHELON_BEHIND_CLOUDFLARE") === "true";

// Trust generic geo headers (cloudfront-viewer-country, x-country-code).
// Set to "true" when behind CloudFront or a proxy that sets these headers.
// When false, only cf-ipcountry is used (requires BEHIND_CLOUDFLARE).
export const TRUST_GEO_HEADERS =
  Deno.env.get("ECHELON_TRUST_GEO_HEADERS") === "true";
