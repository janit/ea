import { define } from "../utils.ts";
import { serveBeacon } from "../lib/fast-path.ts";

// In production lib/fast-path.ts answers this before the router is reached.
export const handler = define.handlers({
  GET: (ctx) => serveBeacon(ctx.req, ctx.state.db),
});
