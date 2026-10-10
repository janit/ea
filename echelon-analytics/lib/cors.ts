// Echelon Analytics — CORS and origin gating
//
// Shared by the Fresh middleware and routes and by the tracking fast path
// (lib/fast-path.ts), which answers the tracking endpoints without them.

import { ALLOWED_ORIGINS } from "./config.ts";

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

/** Paths that require permissive CORS (cross-origin tracking beacons). */
const TRACKING_PATHS = new Set(["/b.gif", "/e", "/ea.js", "/c"]);

export function corsHeaders(req: Request): Headers {
  const headers = new Headers();
  setCorsHeaders(headers, req, isTrackingPath(req));
  return headers;
}

/** True when the request's path is exactly a cross-origin tracking endpoint. */
export function isTrackingPath(req: Request): boolean {
  return TRACKING_PATHS.has(new URL(req.url).pathname);
}

/**
 * Set the CORS headers for `req` on `headers`. `isTracking` says whether the
 * request is for one of the cross-origin tracking endpoints; a caller that
 * already knows (the fast path) is spared parsing the URL.
 */
export function setCorsHeaders(
  headers: Headers,
  req: Request,
  isTracking: boolean,
): void {
  const origin = req.headers.get("origin");

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
}
