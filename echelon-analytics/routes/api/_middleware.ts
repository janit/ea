import { define } from "../../utils.ts";
import {
  AUTH_USERNAME,
  constantTimeEquals,
  PUBLIC_MODE,
  SECRET,
} from "../../lib/config.ts";
import { getSession } from "../../lib/session.ts";
import { getCookie } from "../../lib/cookie.ts";

/** Auth for /api/* routes — Bearer token or session cookie. */
export const handler = define.handlers([
  (ctx) => {
    const url = new URL(ctx.req.url);

    // Health endpoint is public (used for monitoring)
    if (url.pathname === "/api/health") {
      return ctx.next();
    }

    // Public mode — read-only: only allow safe methods
    // (telemetry opt-in is exempt — it's instance self-configuration, not data)
    if (PUBLIC_MODE) {
      const method = ctx.req.method;
      if (method !== "GET" && method !== "HEAD" && method !== "OPTIONS") {
        if (url.pathname !== "/api/telemetry") {
          return Response.json({
            error: "read_only",
            message:
              "This is a public read-only instance. Data cannot be modified. " +
              "To run your own instance, see https://ea.js.org/installation.html",
          }, { status: 403 });
        }
      }
      ctx.state.isAuthenticated = true;
      return ctx.next();
    }

    // Check Bearer header (constant-time comparison)
    if (SECRET) {
      const auth = ctx.req.headers.get("authorization");
      if (auth && auth.startsWith("Bearer ")) {
        const token = auth.slice(7);
        if (constantTimeEquals(token, SECRET)) {
          ctx.state.isAuthenticated = true;
          return ctx.next();
        }
      }
    }

    // Check echelon_session cookie (allows islands to call API routes)
    if (AUTH_USERNAME) {
      const session = getCookie(
        ctx.req.headers.get("cookie"),
        "echelon_session",
      );
      if (session && getSession(session) !== undefined) {
        ctx.state.isAuthenticated = true;

        // CSRF protection for cookie-based auth on mutating requests.
        // Compare origin *host* against the request Host header — this works
        // behind any reverse proxy without needing x-forwarded-proto, since
        // protocol mismatches (http internal vs https external) don't affect
        // the host comparison. This assumes the proxy preserves the external
        // Host header (Caddy/nginx defaults do); a proxy that rewrites Host to
        // an internal name would reject legitimate same-origin POSTs, not open
        // a bypass.
        const method = ctx.req.method;
        if (
          method === "POST" || method === "PUT" || method === "PATCH" ||
          method === "DELETE"
        ) {
          const origin = ctx.req.headers.get("origin");
          const referer = ctx.req.headers.get("referer");
          const requestHost = ctx.req.headers.get("host") || url.host;

          let originMatch = false;
          if (origin) {
            try {
              originMatch = new URL(origin).host === requestHost;
            } catch {
              originMatch = false;
            }
          } else if (referer) {
            try {
              originMatch = new URL(referer).host === requestHost;
            } catch {
              originMatch = false;
            }
          }

          if (!originMatch) {
            return Response.json(
              { error: "CSRF validation failed — origin mismatch" },
              { status: 403 },
            );
          }
        }

        return ctx.next();
      }
    }

    if (!SECRET && !AUTH_USERNAME) {
      return Response.json(
        { error: "unauthorized", message: "Auth must be configured" },
        { status: 401 },
      );
    }

    return Response.json({ error: "unauthorized" }, { status: 401 });
  },
]);
