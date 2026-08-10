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
import { validateSiteId } from "../../lib/config.ts";
import { getTelemetryState } from "../../lib/telemetry.ts";

import { getCookie } from "../../lib/cookie.ts";

/** Auth for admin pages — Bearer token or echelon_session cookie. */
export const handler = define.handlers([
  (ctx) => {
    // Public mode — skip all auth, dashboard is openly accessible
    if (PUBLIC_MODE) {
      ctx.state.isAuthenticated = true;
      return ctx.next();
    }

    const url = new URL(ctx.req.url);

    // Login page is always accessible
    if (
      url.pathname === "/admin/login"
    ) {
      return ctx.next();
    }

    // No auth configured — redirect to login with configuration message
    if (!SECRET && !AUTH_USERNAME) {
      return new Response(null, {
        status: 303,
        headers: {
          location: "/admin/login?error=auth_not_configured",
        },
      });
    }

    const cookie = ctx.req.headers.get("cookie");

    // Check Bearer header (API token). Failures are throttled like failed
    // logins; a valid token is never limited.
    if (SECRET) {
      const auth = ctx.req.headers.get("authorization");
      if (auth && auth.startsWith("Bearer ")) {
        const limitKey = `bearer|${getClientIp(ctx.req)}`;
        if (isAuthLimited(limitKey)) {
          return new Response("Too many failed attempts", { status: 429 });
        }
        if (constantTimeEquals(auth.slice(7), SECRET)) {
          ctx.state.isAuthenticated = true;
          return ctx.next();
        }
        recordAuthFailure(limitKey);
      }
    }

    // Check echelon_session cookie (login form auth — random session token)
    if (AUTH_USERNAME) {
      const session = getCookie(cookie, "echelon_session");
      if (session && getSession(session) !== undefined) {
        ctx.state.isAuthenticated = true;

        // CSRF protection for mutating requests.
        if (!checkCsrf(ctx.req, url.host)) {
          return Response.json(
            { error: "CSRF validation failed — origin mismatch" },
            { status: 403 },
          );
        }

        return ctx.next();
      }
    }

    // Redirect to login page
    return new Response(null, {
      status: 303,
      headers: { location: "/admin/login" },
    });
  },
  // Sticky site selector + days — persist in cookies
  async (ctx) => {
    ctx.state.url = ctx.req.url;
    const url = new URL(ctx.req.url);

    // The login page renders none of this, and it is reachable unauthenticated
    // — so without this guard every anonymous GET /admin/login ran a full
    // covering-index scan of visitor_views plus a telemetry read, on the single
    // worker, with nothing rate-limiting it.
    if (url.pathname === "/admin/login") return ctx.next();

    const cookie = ctx.req.headers.get("cookie");
    const paramSite = url.searchParams.get("site_id");
    const cookieSite = getCookie(cookie, "echelon_site");

    // Query param wins, then cookie, then "default"
    const siteId = validateSiteId(paramSite ?? cookieSite ?? "default");
    ctx.state.siteId = siteId;

    // Days — query param > cookie > 30
    const paramDays = url.searchParams.get("days");
    const cookieDays = getCookie(cookie, "echelon_days");
    // parseInt("x") is NaN, and Math.min/max propagate it — the NaN then
    // reached daysAgoUTC() and threw RangeError (500), *and* was written into
    // a one-year cookie below, so every later visit re-read "NaN" and 500'd
    // again. The cookie is HttpOnly, so page JS could not clear it either.
    const parsedDays = parseInt(paramDays ?? cookieDays ?? "30", 10);
    const days = Number.isFinite(parsedDays)
      ? Math.min(Math.max(1, parsedDays), 365)
      : 30;
    ctx.state.days = days;

    // Known sites — single query for the nav dropdown
    const sites = await ctx.state.db.query<{ site_id: string }>(
      `SELECT DISTINCT site_id FROM visitor_views ORDER BY site_id`,
    );
    const knownSites = sites.map((s: { site_id: string }) => s.site_id);
    if (!knownSites.includes(siteId)) knownSites.unshift(siteId);
    ctx.state.knownSites = knownSites;

    // Telemetry opt-in state for AdminNav indicator
    ctx.state.telemetryState = await getTelemetryState(ctx.state.db);

    const resp = await ctx.next();

    // Set/update cookies when explicitly chosen via query param
    if (paramSite && paramSite !== cookieSite) {
      resp.headers.append(
        "Set-Cookie",
        `echelon_site=${
          encodeURIComponent(siteId)
        }; Path=/admin; HttpOnly; SameSite=Lax; Secure; Max-Age=31536000`,
      );
    }
    if (paramDays && paramDays !== cookieDays) {
      resp.headers.append(
        "Set-Cookie",
        `echelon_days=${days}; Path=/admin; HttpOnly; SameSite=Lax; Secure; Max-Age=31536000`,
      );
    }

    return resp;
  },
]);
