import { define } from "../utils.ts";
import { serveChallenge } from "../lib/fast-path.ts";

// In production lib/fast-path.ts answers this before the router is reached.
export const handler = define.handlers({
  GET: (ctx) => serveChallenge(ctx.req),
});
