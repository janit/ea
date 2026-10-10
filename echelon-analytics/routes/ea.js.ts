import { define } from "../utils.ts";
import { serveTracker } from "../lib/fast-path.ts";

// In production lib/fast-path.ts answers this before the router is reached.
export const handler = define.handlers({
  GET: (ctx) => serveTracker(ctx.req, ctx.state.db),
});
