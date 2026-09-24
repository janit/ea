import { define } from "../utils.ts";
import { handleTracker } from "../lib/tracker.ts";
import { corsHeaders, isAllowedReferer } from "./_middleware.ts";
import { ALLOWED_ORIGINS, TELEMETRY_SITE_ID } from "../lib/config.ts";
import { isRateLimited } from "../lib/rate-limit.ts";

export const handler = define.handlers({
  async GET(ctx) {
    if (isRateLimited(ctx.req)) {
      return new Response("// rate limited", {
        status: 429,
        headers: {
          "Content-Type": "application/javascript",
          "Cache-Control": "no-store",
        },
      });
    }

    // Optionally restrict which sites can load the tracker script — exempt telemetry
    if (ALLOWED_ORIGINS.size > 0) {
      const siteParam = new URL(ctx.req.url).searchParams.get("s");
      if (siteParam !== TELEMETRY_SITE_ID) {
        const referer = ctx.req.headers.get("referer");
        if (referer && !isAllowedReferer(referer)) {
          return new Response("// blocked", {
            status: 403,
            headers: { "Content-Type": "application/javascript" },
          });
        }
      }
    }

    const resp = await handleTracker(ctx.req, ctx.state.db);
    const headers = corsHeaders(ctx.req);
    for (const [k, v] of resp.headers) headers.set(k, v);
    return new Response(resp.body, { status: 200, headers });
  },
});
