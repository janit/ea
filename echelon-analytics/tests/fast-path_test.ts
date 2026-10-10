// The four tracking endpoints are answered before Fresh's router. The fast
// path must take exactly the requests those routes take, answer them as the
// routes do, and do the work the middleware around them did.

import { assert, assertEquals, assertNotEquals } from "@std/assert";
import { createFastPath } from "@/lib/fast-path.ts";
import { flushRemainingViews } from "@/lib/beacon.ts";
import { flushRemainingEvents } from "@/lib/events-endpoint.ts";
import { getBotIpPenalty, hashIp } from "@/lib/bot-score.ts";
import { getRequestStats } from "@/lib/request-stats.ts";
import { handler as beaconRoute } from "@/routes/b.gif.ts";
import { handler as challengeRoute } from "@/routes/c.ts";
import { handler as eventsRoute } from "@/routes/e.ts";
import { handler as trackerRoute } from "@/routes/ea.js.ts";
import { createTestDb, mockFreshCtx } from "./_helpers.ts";

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/141.0.0.0 Safari/537.36";
const HEADERS = {
  "user-agent": UA,
  "accept-language": "en-US",
  "sec-ch-ua": '"Chrome"',
  "sec-fetch-site": "cross-site",
  "origin": "https://shop.example.com",
  "host": "a.example.com",
};
const SECURITY = {
  "x-frame-options": "DENY",
  "x-content-type-options": "nosniff",
  "referrer-policy": "strict-origin-when-cross-origin",
};

function info(ip = "203.0.113.9"): Deno.ServeHandlerInfo {
  return {
    remoteAddr: { transport: "tcp", hostname: ip, port: 40000 },
    completed: Promise.resolve(),
  } as Deno.ServeHandlerInfo;
}

function get(path: string, headers: Record<string, string> = HEADERS) {
  return new Request(`https://a.example.com${path}`, { headers });
}

function beaconPath(site: string, sid: string, path = "/page"): string {
  return `/b.gif?p=${btoa(path)}&_v=2000&sw=1440&sh=900&s=${site}&sid=${sid}`;
}

function eventsReq(site: string, sid: string): Request {
  const body = JSON.stringify({
    siteId: site,
    events: [{ type: "click", sessionId: sid, data: { tag: "A" } }],
  });
  return new Request("https://a.example.com/e", {
    method: "POST",
    headers: {
      ...HEADERS,
      "content-type": "application/json",
      "content-length": String(body.length),
    },
    body,
  });
}

const sid = (n: number) =>
  `${String(n).padStart(8, "0")}-5555-4555-8555-555555555555`;

function headersOf(resp: Response): Record<string, string> {
  return Object.fromEntries([...resp.headers].sort());
}

// ── Which requests it takes ─────────────────────────────────────────────────

Deno.test("fast path — leaves everything but the four routes to Fresh", () => {
  const fast = createFastPath(createTestDb());
  const left: [string, string][] = [
    ["GET", "/"],
    ["GET", "/admin"],
    ["GET", "/api/stats/overview"],
    ["GET", "/c/"],
    ["GET", "//c"],
    ["GET", "/c2"],
    ["GET", "/ea.js/x"],
    ["GET", "/b.gif.png"],
    ["GET", "/e"],
    ["POST", "/c"],
    ["POST", "/b.gif"],
    ["POST", "/ea.js"],
    ["HEAD", "/c"],
    ["PUT", "/e"],
    ["DELETE", "/b.gif"],
    ["OPTIONS", "/admin"],
    ["OPTIONS", "/api/sites"],
  ];
  for (const [method, path] of left) {
    const req = new Request(`https://a.example.com${path}`, {
      method,
      headers: HEADERS,
    });
    assertEquals(fast(req, info()), null, `${method} ${path}`);
  }
});

Deno.test("fast path — takes a route whatever its query string", async () => {
  const fast = createFastPath(createTestDb());
  for (const path of ["/c", "/c?", "/c?x=1&y=/b.gif", "/c#frag", "/c?x#y"]) {
    const resp = await fast(get(path), info());
    assert(resp, path);
    assertEquals(resp.status, 200, path);
    assertEquals((await resp.text()).length, 32, path);
  }
});

// ── Same answers as the routes ──────────────────────────────────────────────

Deno.test("fast path — /c answers as the route does, plus the security headers", async () => {
  const db = createTestDb();
  const fast = createFastPath(db);
  // deno-lint-ignore no-explicit-any
  const viaRoute: Response = await (challengeRoute as any).GET(
    mockFreshCtx(get("/c"), { db }),
  );
  const viaFast = await fast(get("/c"), info());
  assert(viaFast);
  assertEquals(viaFast.status, viaRoute.status);
  assertEquals(await viaFast.text(), await viaRoute.text());
  assertEquals(headersOf(viaFast), {
    ...headersOf(viaRoute),
    ...SECURITY,
  });
});

Deno.test("fast path — /ea.js answers as the route does, plus the security headers", async () => {
  const db = createTestDb();
  const fast = createFastPath(db);
  // deno-lint-ignore no-explicit-any
  const viaRoute: Response = await (trackerRoute as any).GET(
    mockFreshCtx(get("/ea.js?s=fp-site"), { db }),
  );
  const viaFast = await fast(get("/ea.js?s=fp-site"), info());
  assert(viaFast);
  assertEquals(viaFast.status, viaRoute.status);
  const body = await viaFast.text();
  assertEquals(body, await viaRoute.text());
  assert(body.includes("https://a.example.com"));
  assertEquals(headersOf(viaFast), { ...headersOf(viaRoute), ...SECURITY });
});

Deno.test("fast path — /b.gif answers as the route does, plus the security headers", async () => {
  const db = createTestDb();
  const fast = createFastPath(db);
  // deno-lint-ignore no-explicit-any
  const viaRoute: Response = await (beaconRoute as any).GET(
    mockFreshCtx(get(beaconPath("fp-beacon", sid(1))), { db }),
  );
  const viaFast = await fast(get(beaconPath("fp-beacon", sid(2))), info());
  assert(viaFast);
  assertEquals(viaFast.status, viaRoute.status);
  assertEquals(
    new Uint8Array(await viaFast.arrayBuffer()),
    new Uint8Array(await viaRoute.arrayBuffer()),
  );
  assertEquals(headersOf(viaFast), { ...headersOf(viaRoute), ...SECURITY });
  await flushRemainingViews(db);
});

Deno.test("fast path — /b.gif in cookie mode sets the visitor cookie", async () => {
  const db = createTestDb();
  const fast = createFastPath(db);
  const resp = await fast(
    get(beaconPath("fp-cookie", sid(3)) + "&ck=1"),
    info(),
  );
  assert(resp);
  assert(/^_ev=[0-9a-f]{16}; /.test(resp.headers.get("set-cookie") ?? ""));
  await resp.arrayBuffer();
  await flushRemainingViews(db);
});

Deno.test("fast path — /e answers as the route does, plus the security headers", async () => {
  const db = createTestDb();
  const fast = createFastPath(db);
  // deno-lint-ignore no-explicit-any
  const viaRoute: Response = await (eventsRoute as any).POST(
    mockFreshCtx(eventsReq("fp-events", sid(4)), { db }),
  );
  const viaFast = await fast(eventsReq("fp-events", sid(5)), info());
  assert(viaFast);
  assertEquals(viaFast.status, viaRoute.status);
  assertEquals(await viaFast.text(), await viaRoute.text());
  assertEquals(headersOf(viaFast), { ...headersOf(viaRoute), ...SECURITY });
  await flushRemainingEvents(db);
});

Deno.test("fast path — a request without an Origin gets the wildcard, as before", async () => {
  const fast = createFastPath(createTestDb());
  const { origin: _origin, ...noOrigin } = HEADERS;
  const resp = await fast(get("/c", noOrigin), info());
  assert(resp);
  assertEquals(resp.headers.get("access-control-allow-origin"), "*");
  assertEquals(resp.headers.get("access-control-allow-credentials"), null);
  await resp.text();
});

// ── The work the middleware did ─────────────────────────────────────────────

Deno.test("fast path — a preflight is answered 204 with the CORS headers", async () => {
  const fast = createFastPath(createTestDb());
  for (const path of ["/e", "/b.gif", "/c", "/ea.js"]) {
    const resp = await fast(
      new Request(`https://a.example.com${path}`, {
        method: "OPTIONS",
        headers: HEADERS,
      }),
      info(),
    );
    assert(resp, path);
    assertEquals(resp.status, 204);
    assertEquals(resp.body, null);
    assertEquals(headersOf(resp), {
      "access-control-allow-credentials": "true",
      "access-control-allow-headers": "Content-Type, Authorization",
      "access-control-allow-methods": "GET, POST, PATCH, DELETE, OPTIONS",
      "access-control-allow-origin": "https://shop.example.com",
      "access-control-max-age": "86400",
      ...SECURITY,
    });
  }
});

Deno.test("fast path — pageviews and events are stored, under the connection's address", async () => {
  const db = createTestDb();
  const fast = createFastPath(db);
  for (const ip of ["198.51.100.1", "198.51.100.2"]) {
    await (await fast(get(beaconPath("fp-store", sid(6))), info(ip)))!
      .arrayBuffer();
  }
  await (await fast(eventsReq("fp-store", sid(6)), info("198.51.100.1")))!
    .text();
  await flushRemainingViews(db);
  await flushRemainingEvents(db);

  const views = await db.query<{ visitor_id: string }>(
    "SELECT visitor_id FROM visitor_views WHERE site_id = 'fp-store'",
  );
  assertEquals(views.length, 2);
  // Cookieless: the visitor id is a hash of the address, so two peers differ.
  assertNotEquals(views[0].visitor_id, views[1].visitor_id);
  const events = await db.query(
    "SELECT 1 FROM semantic_events WHERE site_id = 'fp-store'",
  );
  assertEquals(events.length, 1);
});

Deno.test("fast path — an address that sends a known-bot user agent is marked suspected", async () => {
  const fast = createFastPath(createTestDb());
  const ip = "198.51.100.77";
  assertEquals(getBotIpPenalty(await hashIp(ip)), 0);
  const resp = await fast(
    get("/c", { ...HEADERS, "user-agent": "HeadlessChrome/120.0" }),
    info(ip),
  );
  await resp!.text();
  assertEquals(getBotIpPenalty(await hashIp(ip)), 20);
});

Deno.test("fast path — every request is counted in the request statistics", async () => {
  const fast = createFastPath(createTestDb());
  const before = getRequestStats().totalRequests;
  await (await fast(get("/c"), info()))!.text();
  await fast(
    new Request("https://a.example.com/e", {
      method: "OPTIONS",
      headers: HEADERS,
    }),
    info(),
  );
  assertEquals(getRequestStats().totalRequests, before + 2);
});

Deno.test("fast path — a handler that throws answers 500, not an unhandled rejection", async () => {
  const broken = {} as ReturnType<typeof createTestDb>;
  const fast = createFastPath(broken);
  const errors = getRequestStats().totalErrors;
  const realError = console.error;
  console.error = () => {};
  try {
    // refreshExcluded() queries the database on a fresh site's first beacon.
    const resp = await fast(
      get(beaconPath("fp-broken", sid(7))),
      info("198.51.100.200"),
    );
    assert(resp);
    if (resp.status === 500) {
      assertEquals(getRequestStats().totalErrors, errors + 1);
      assertEquals(headersOf(resp)["x-content-type-options"], "nosniff");
    } else {
      // The exclusion cache was fresh, so the database was never touched.
      assertEquals(resp.status, 200);
    }
    await resp.arrayBuffer();
  } finally {
    console.error = realError;
  }
});

Deno.test("routes — a path the router normalised keeps the restrictive CORS answer", async () => {
  // Fresh also routes "/c/" to routes/c.ts. Such a request was never given
  // the tracking endpoints' permissive headers, and still is not.
  const db = createTestDb();
  const { origin: _origin, ...noOrigin } = HEADERS;
  // deno-lint-ignore no-explicit-any
  const resp: Response = await (challengeRoute as any).GET(
    mockFreshCtx(get("/c/", noOrigin), { db }),
  );
  assertEquals(resp.headers.get("access-control-allow-origin"), "null");
  await resp.text();
});
