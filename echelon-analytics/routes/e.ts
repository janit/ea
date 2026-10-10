import { define } from "../utils.ts";
import { serveEvents } from "../lib/fast-path.ts";

// In production lib/fast-path.ts answers this before the router is reached.
export const handler = define.handlers({
  POST: (ctx) => serveEvents(ctx.req, ctx.state.db),
});
