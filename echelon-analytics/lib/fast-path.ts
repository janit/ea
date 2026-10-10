// Echelon Analytics — Tracking Endpoints and Their Fast Path
//
// /ea.js, /b.gif, /e and /c take nearly all of an instance's traffic, and a
// request for one of them spent more time in the framework (URL parsing,
// router, context, three layers of middleware, static file lookup) than in
// its handler. createFastPath() answers them before any of that runs.
//
// The route files (routes/ea.js.ts, b.gif.ts, e.ts, c.ts) still exist and call
// the same serve* functions, so the two cannot drift: the fast path adds only
// what the middleware around the routes did (the connection's address, the
// known-bot address mark, preflights, the security headers and the request
// statistics). Anything it does not recognise exactly is left to Fresh.

import type { DbAdapter } from "./db/adapter.ts";
import { hashIp, isKnownBot, recordSuspectedBotIp } from "./bot-score.ts";
import { handleBeacon, PIXEL } from "./beacon.ts";
import { ALLOWED_ORIGINS, TELEMETRY_SITE_ID } from "./config.ts";
import {
  isAllowedOrigin,
  isAllowedReferer,
  isTrackingPath,
  setCorsHeaders,
} from "./cors.ts";
import { handleEvents } from "./events-endpoint.ts";
import { getClientIp, setPeerAddr } from "./ip.ts";
import { isRateLimited } from "./rate-limit.ts";
import { recordRequest } from "./request-stats.ts";
import { handleChallenge, handleTracker } from "./tracker.ts";

/**
 * Add the CORS headers to a response of ours. None of the handlers sets an
 * Access-Control header, so nothing is overwritten.
 *
 * `exact` is true when the caller matched the path itself (the fast path).
 * A route reached through the router may have been matched on a path the
 * router normalised ("/c/", "//c"), and such a request has never been given
 * the tracking endpoints' permissive headers: the path decides, as before.
 */
function withCors(req: Request, resp: Response, exact: boolean): Response {
  setCorsHeaders(resp.headers, req, exact || isTrackingPath(req));
  return resp;
}

/** The `s` query parameter, read only when origins are restricted. */
function siteParam(req: Request): string | null {
  return new URL(req.url).searchParams.get("s");
}

// ── The endpoints ───────────────────────────────────────────────────────────
//
// A request that is refused (rate limited, or from an origin that is not
// allowed) is answered without CORS headers, as it always was.

/** GET /ea.js — the tracker script. */
export async function serveTracker(
  req: Request,
  db: DbAdapter,
  exact = false,
): Promise<Response> {
  if (isRateLimited(req)) {
    return new Response("// rate limited", {
      status: 429,
      headers: {
        "Content-Type": "application/javascript",
        "Cache-Control": "no-store",
      },
    });
  }

  // Optionally restrict which sites can load the tracker script — exempt telemetry
  if (ALLOWED_ORIGINS.size > 0 && siteParam(req) !== TELEMETRY_SITE_ID) {
    const referer = req.headers.get("referer");
    if (referer && !isAllowedReferer(referer)) {
      return new Response("// blocked", {
        status: 403,
        headers: { "Content-Type": "application/javascript" },
      });
    }
  }

  return withCors(req, await handleTracker(req, db), exact);
}

function pixel(): Response {
  return new Response(PIXEL, {
    headers: { "Content-Type": "image/gif", "Cache-Control": "no-store" },
  });
}

/** GET /b.gif — the pageview beacon. */
export async function serveBeacon(
  req: Request,
  db: DbAdapter,
  exact = false,
): Promise<Response> {
  // Rate limit check — drop early
  if (isRateLimited(req)) return pixel();

  // Image requests use Referer, not Origin — exempt telemetry site_id
  if (ALLOWED_ORIGINS.size > 0 && siteParam(req) !== TELEMETRY_SITE_ID) {
    const referer = req.headers.get("referer");
    const origin = req.headers.get("origin");
    if (!isAllowedOrigin(origin) && !isAllowedReferer(referer)) {
      return pixel();
    }
  }

  return withCors(req, await handleBeacon(req, db), exact);
}

/** POST /e — behavioural events. */
export async function serveEvents(
  req: Request,
  db: DbAdapter,
  exact = false,
): Promise<Response> {
  if (isRateLimited(req)) return new Response(null, { status: 429 });

  // Origin check is intentionally omitted here:
  // - ea.js script endpoint already gates loading by origin
  // - PoW token validates the request came from a real browser
  // - sendBeacon may not always include an Origin header
  return withCors(req, await handleEvents(req, db), exact);
}

/** GET /c — the current challenge. */
export async function serveChallenge(
  req: Request,
  exact = false,
): Promise<Response> {
  if (isRateLimited(req)) {
    return new Response(null, {
      status: 429,
      headers: { "Cache-Control": "no-store" },
    });
  }
  return withCors(req, await handleChallenge(), exact);
}

// ── What the middleware did ─────────────────────────────────────────────────

/**
 * Record IPs that leak known-bot UAs (e.g. HeadlessChrome on /sw.js). This
 * flags the IP so beacon requests from the same source get penalised, even
 * if the bot spoofs its UA on tracking requests.
 */
export async function recordBotUaLeak(req: Request): Promise<void> {
  const ua = req.headers.get("user-agent") ?? "";
  if (ua && isKnownBot(ua)) {
    const ip = getClientIp(req);
    if (ip !== "unknown") recordSuspectedBotIp(await hashIp(ip));
  }
}

type Endpoint = "/ea.js" | "/b.gif" | "/e" | "/c";

/** The method each endpoint's route file handles. */
const METHOD: Record<Endpoint, string> = {
  "/ea.js": "GET",
  "/b.gif": "GET",
  "/e": "POST",
  "/c": "GET",
};

/**
 * The request's path if it is exactly one of the four endpoints, else null.
 * Read from the URL text: `new URL()` is one of the costs being avoided. A
 * path the router would have had to normalise (a doubled or trailing slash)
 * does not match, and goes to the router.
 */
function endpointOf(url: string): Endpoint | null {
  const scheme = url.indexOf("://");
  const start = url.indexOf("/", scheme < 0 ? 0 : scheme + 3);
  if (start < 0) return null;
  let end = url.length;
  for (let i = start; i < end; i++) {
    const c = url.charCodeAt(i);
    if (c === 63 /* ? */ || c === 35 /* # */) end = i;
  }
  switch (end - start) {
    case 2:
      if (url.startsWith("/e", start)) return "/e";
      if (url.startsWith("/c", start)) return "/c";
      return null;
    case 6:
      if (url.startsWith("/b.gif", start)) return "/b.gif";
      if (url.startsWith("/ea.js", start)) return "/ea.js";
      return null;
    default:
      return null;
  }
}

async function respond(
  endpoint: Endpoint,
  preflight: boolean,
  req: Request,
  info: Deno.ServeHandlerInfo,
  db: DbAdapter,
): Promise<Response> {
  const start = performance.now();
  let resp: Response;
  try {
    setPeerAddr(req, info);
    await recordBotUaLeak(req);
    if (preflight) {
      resp = withCors(req, new Response(null, { status: 204 }), true);
    } else if (endpoint === "/b.gif") {
      resp = await serveBeacon(req, db, true);
    } else if (endpoint === "/e") {
      resp = await serveEvents(req, db, true);
    } else if (endpoint === "/c") {
      resp = await serveChallenge(req, true);
    } else {
      resp = await serveTracker(req, db, true);
    }
  } catch (e) {
    console.error(`[echelon] ${req.method} ${endpoint} failed:`, e);
    resp = new Response("Internal Server Error", { status: 500 });
  }
  resp.headers.set("X-Frame-Options", "DENY");
  resp.headers.set("X-Content-Type-Options", "nosniff");
  resp.headers.set("Referrer-Policy", "strict-origin-when-cross-origin");
  recordRequest(endpoint, performance.now() - start, resp.status);
  return resp;
}

/**
 * Returns a function that answers a tracking request, or returns null for
 * any other request (which the caller hands to Fresh, unchanged).
 */
export function createFastPath(
  db: DbAdapter,
): (req: Request, info: Deno.ServeHandlerInfo) => Promise<Response> | null {
  return (req, info) => {
    const method = req.method;
    if (method !== "GET" && method !== "POST" && method !== "OPTIONS") {
      return null;
    }
    const endpoint = endpointOf(req.url);
    if (endpoint === null) return null;
    const preflight = method === "OPTIONS";
    if (!preflight && method !== METHOD[endpoint]) return null;
    return respond(endpoint, preflight, req, info, db);
  };
}
