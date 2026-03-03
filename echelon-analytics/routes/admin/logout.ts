import { define } from "../../utils.ts";
import { deleteSession } from "../../lib/session.ts";
import { getCookie } from "../../lib/cookie.ts";

export const handler = define.handlers({
  // POST-only to prevent CSRF logout via GET (prefetch, link, img src, etc.)
  POST(ctx) {
    const session = getCookie(ctx.req.headers.get("cookie"), "echelon_session");
    if (session) deleteSession(session);

    const headers = new Headers({ location: "/admin/login" });
    headers.append(
      "set-cookie",
      "echelon_session=; Path=/; HttpOnly; SameSite=Strict; Secure; Max-Age=0",
    );
    return new Response(null, { status: 303, headers });
  },
});
