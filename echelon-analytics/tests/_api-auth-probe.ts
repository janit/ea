// Runs the real /api/* auth middleware against a list of requests and prints
// the resulting statuses as JSON. Config is read from the environment once at
// import time, so tests spawn this with the environment they need.
//
// argv[0]: JSON array of { method, path, headers?, session? }

import { handler } from "@/routes/api/_middleware.ts";
import { createSession } from "@/lib/session.ts";

interface Case {
  method: string;
  path: string;
  headers?: Record<string, string>;
  session?: boolean;
}

const cases = JSON.parse(Deno.args[0]) as Case[];
const middleware = (handler as unknown as ((ctx: unknown) => unknown)[])[0];
const results: { status: number; authenticated: boolean }[] = [];

for (const c of cases) {
  const headers = new Headers(c.headers);
  headers.set("host", "analytics.example.com");
  if (c.session) {
    const { token } = createSession("admin");
    headers.set("cookie", `echelon_session=${token}`);
  }
  const req = new Request(`https://analytics.example.com${c.path}`, {
    method: c.method,
    headers,
  });
  const state = { isAuthenticated: false };
  const res = await middleware({
    req,
    state,
    url: new URL(req.url),
    next: () => Promise.resolve(new Response(null, { status: 200 })),
  }) as Response;
  results.push({ status: res.status, authenticated: state.isAuthenticated });
}

console.log(JSON.stringify(results));
// Imported modules start intervals (session/limiter pruning); do not wait.
Deno.exit(0);
