import { define } from "../utils.ts";
import { ALLOWED_ORIGINS, TELEMETRY_ENDPOINT } from "../lib/config.ts";

/**
 * Check whether a request origin is allowed.
 * If ALLOWED_ORIGINS is empty, all origins are accepted (open mode).
 */
export function isAllowedOrigin(origin: string | null): boolean {
  if (ALLOWED_ORIGINS.size === 0) return true;
  if (!origin) return false;
  try {
    const hostname = new URL(origin).hostname.toLowerCase();
    return ALLOWED_ORIGINS.has(hostname);
  } catch {
    return false;
  }
}

/** Check whether a request's Referer header matches an allowed origin. */
export function isAllowedReferer(referer: string | null): boolean {
  if (!referer) return false;
  try {
    const hostname = new URL(referer).hostname.toLowerCase();
    return ALLOWED_ORIGINS.has(hostname);
  } catch {
    return false;
  }
}

/** Content-Security-Policy for admin pages (defense-in-depth).
 *  Telemetry endpoint is allowed so the inline self-tracking script can
 *  fetch the PoW challenge and send beacons. Harmless when telemetry is off.
 *
 *  SECURITY NOTE: 'unsafe-inline' is required for script-src (Fresh island
 *  hydration bootstrap + synchronous theme detection) and style-src (Tailwind
 *  inline styles). This is an accepted trade-off — nonce-based CSP would be
 *  preferable but requires Fresh framework changes. XSS is mitigated via
 *  input validation, Preact SSR escaping, and authentication on admin pages. */
const CSP = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline'", // Required: Fresh islands + theme FOUC prevention
  "style-src 'self' 'unsafe-inline'", // Required: Tailwind + inline styles
  `img-src 'self' data: ${TELEMETRY_ENDPOINT}`,
  `connect-src 'self' ${TELEMETRY_ENDPOINT}`,
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self'",
].join("; ");

/** CORS preflight + security headers. */
export const handler = define.handlers([
  async (ctx) => {
    if (ctx.req.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: corsHeaders(ctx.req),
      });
    }
    const resp = await ctx.next();
    const ct = resp.headers.get("content-type") ?? "";
    if (ct.includes("text/html")) {
      resp.headers.set("Content-Security-Policy", CSP);
      resp.headers.set("X-Content-Type-Options", "nosniff");
      resp.headers.set("X-Frame-Options", "DENY");
    }
    return resp;
  },
]);

/** Paths that require permissive CORS (cross-origin tracking beacons). */
const TRACKING_PATHS = new Set(["/b.gif", "/e", "/ea.js"]);

export function corsHeaders(req: Request): Headers {
  const origin = req.headers.get("origin");
  const headers = new Headers();
  const pathname = new URL(req.url).pathname;
  const isTracking = TRACKING_PATHS.has(pathname);

  if (!isTracking) {
    // Non-tracking routes: same-origin only — do not reflect arbitrary origins
    headers.set("Access-Control-Allow-Origin", "null");
  } else if (ALLOWED_ORIGINS.size > 0) {
    // Restricted mode: only reflect allowed origins, enable credentials
    if (isAllowedOrigin(origin)) {
      headers.set("Access-Control-Allow-Origin", origin!);
      headers.set("Access-Control-Allow-Credentials", "true");
    } else {
      headers.set("Access-Control-Allow-Origin", "null");
    }
  } else {
    // Open mode on tracking endpoints: reflect origin (sendBeacon sends
    // credentials, which requires a specific origin — wildcard '*' is
    // rejected by browsers)
    if (origin) {
      headers.set("Access-Control-Allow-Origin", origin);
      headers.set("Access-Control-Allow-Credentials", "true");
    } else {
      headers.set("Access-Control-Allow-Origin", "*");
    }
  }

  headers.set(
    "Access-Control-Allow-Methods",
    "GET, POST, PATCH, DELETE, OPTIONS",
  );
  headers.set("Access-Control-Allow-Headers", "Content-Type, Authorization");
  headers.set("Access-Control-Max-Age", "86400");
  return headers;
}
