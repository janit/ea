import { define } from "../utils.ts";
import { TELEMETRY_ENDPOINT } from "../lib/config.ts";
import { setPeerAddr } from "../lib/ip.ts";
import { corsHeaders } from "../lib/cors.ts";
import { recordBotUaLeak } from "../lib/fast-path.ts";

// Kept here for the routes and tests that import them from this module.
export { corsHeaders, isAllowedOrigin, isAllowedReferer } from "../lib/cors.ts";

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
  "object-src 'none'",
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self'",
].join("; ");

/** CORS preflight + security headers. */
export const handler = define.middleware([
  async (ctx) => {
    setPeerAddr(ctx.req, ctx.info);

    await recordBotUaLeak(ctx.req);

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
