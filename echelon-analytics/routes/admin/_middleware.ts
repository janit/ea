import { define } from "../../utils.ts";
import {
  AUTH_USERNAME,
  constantTimeEquals,
  PUBLIC_MODE,
  SECRET,
  TRUST_PROXY,
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

    // Login/logout pages are always accessible
    if (
      url.pathname === "/admin/login" ||
      url.pathname === "/admin/logout"
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

    // Check Bearer header (API token)
    if (SECRET) {
      const auth = ctx.req.headers.get("authorization");
      if (
        auth && auth.startsWith("Bearer ") &&
        constantTimeEquals(auth.slice(7), SECRET)
      ) {
        ctx.state.isAuthenticated = true;
        return ctx.next();
      }
    }

    // Check echelon_session cookie (login form auth — random session token)
    if (AUTH_USERNAME) {
      const session = getCookie(cookie, "echelon_session");
      if (session && getSession(session) !== undefined) {
        ctx.state.isAuthenticated = true;

        // CSRF protection for mutating requests.
        // Compare origin *host* against the request Host header — works
        // behind any reverse proxy without needing x-forwarded-proto.
        const method = ctx.req.method;
        if (method === "POST" || method === "PATCH" || method === "DELETE") {
          const origin = ctx.req.headers.get("origin");
          const referer = ctx.req.headers.get("referer");
          const requestHost =
            (TRUST_PROXY && ctx.req.headers.get("x-forwarded-host")) ||
            ctx.req.headers.get("host") || url.host;

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
    const cookie = ctx.req.headers.get("cookie");
    const paramSite = url.searchParams.get("site_id");
    const cookieSite = getCookie(cookie, "echelon_site");

    // Query param wins, then cookie, then "default"
    const siteId = validateSiteId(paramSite ?? cookieSite ?? "default");
    ctx.state.siteId = siteId;

    // Days — query param > cookie > 30
    const paramDays = url.searchParams.get("days");
    const cookieDays = getCookie(cookie, "echelon_days");
    const days = Math.min(
      Math.max(1, parseInt(paramDays ?? cookieDays ?? "30")),
      365,
    );
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
