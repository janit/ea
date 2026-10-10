import { define } from "../utils.ts";
import { handleChallenge } from "../lib/tracker.ts";
import { corsHeaders } from "./_middleware.ts";
import { isRateLimited } from "../lib/rate-limit.ts";

export const handler = define.handlers({
  async GET(ctx) {
    if (isRateLimited(ctx.req)) {
      return new Response(null, {
        status: 429,
        headers: { "Cache-Control": "no-store" },
      });
    }
    const resp = await handleChallenge();
    const headers = corsHeaders(ctx.req);
    for (const [k, v] of resp.headers) headers.set(k, v);
    return new Response(resp.body, { status: 200, headers });
  },
});
