import { define } from "../../utils.ts";
import { checkCsrf } from "../../lib/csrf.ts";
import { isAuthLimited, recordAuthFailure } from "../../lib/auth-limit.ts";
import { getClientIp } from "../../lib/ip.ts";
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

    // Public mode — read-only: only allow safe methods.
    //
    // /api/telemetry used to be exempt here as "instance self-configuration,
    // not data". But this branch returns before any authentication, so the
    // exemption let any anonymous caller flip a public instance's telemetry
    // opt-in — shipping the operator's usage data, or silently suppressing it.
    // Self-configuration is exactly what should require the operator.
    if (PUBLIC_MODE) {
      const method = ctx.req.method;
      if (method !== "GET" && method !== "HEAD" && method !== "OPTIONS") {
        return Response.json({
          error: "read_only",
          message:
            "This is a public read-only instance. Data cannot be modified. " +
            "To run your own instance, see https://ea.js.org/installation.html",
        }, { status: 403 });
      }
      ctx.state.isAuthenticated = true;
      return ctx.next();
    }

    // Check Bearer header (constant-time comparison).
    // Failures are throttled like failed logins — only failures, so a valid
    // token is never rate-limited no matter how many calls it makes.
    if (SECRET) {
      const auth = ctx.req.headers.get("authorization");
      if (auth && auth.startsWith("Bearer ")) {
        const limitKey = `bearer|${getClientIp(ctx.req)}`;
        if (isAuthLimited(limitKey)) {
          return Response.json(
            { error: "rate_limited", message: "Too many failed attempts" },
            { status: 429 },
          );
        }
        const token = auth.slice(7);
        if (constantTimeEquals(token, SECRET)) {
          ctx.state.isAuthenticated = true;
          return ctx.next();
        }
        recordAuthFailure(limitKey);
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
        if (!checkCsrf(ctx.req, url.host)) {
          return Response.json(
            { error: "CSRF validation failed — origin mismatch" },
            { status: 403 },
          );
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
