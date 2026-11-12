// Regression tests for the November 2026 security audit. Each one is an
// attack that worked before its fix; the comment says what it did.

import { assert, assertEquals } from "@std/assert";
import { createTestDb, probeApiAuth, solvePow } from "./_helpers.ts";
import {
  forwardedClient,
  networkKey,
  resolveClientAddr,
  setPeerAddr,
} from "@/lib/ip.ts";
import { createFastPath } from "@/lib/fast-path.ts";
import { flushRemainingViews, startViewWriter } from "@/lib/beacon.ts";
import {
  flushRemainingEvents,
  handleEvents,
  startEventWriter,
} from "@/lib/events-endpoint.ts";
import { _sweep, stopBotCorrelator } from "@/lib/bot-correlator.ts";
import { _resetAuthAttempts, isAuthLimited } from "@/lib/auth-limit.ts";
import { _resetEventBudget, spendEventBytes } from "@/lib/rate-limit.ts";
import { readFormCapped } from "@/lib/request.ts";
import {
  nameMatchesBrowsers,
  patternMatchesBrowsers,
} from "@/lib/threat-feeds.ts";
import { handler as loginHandler } from "@/routes/admin/login.tsx";

const info = (hostname: string) =>
  ({
    remoteAddr: { transport: "tcp", hostname, port: 4444 },
    completed: Promise.resolve(),
  }) as unknown as Deno.ServeHandlerInfo;

// ── Client address ──────────────────────────────────────────────────────────

Deno.test("xff — the entry our proxy appended wins, not the client's", () => {
  // nginx's $proxy_add_x_forwarded_for appends the peer to what the client
  // sent. Taking the leftmost entry let one header pick any address.
  assertEquals(forwardedClient("8.8.8.8, 203.0.113.50"), "203.0.113.50");
  assertEquals(forwardedClient("203.0.113.50"), "203.0.113.50");
  // Two trusted hops (CDN, then nginx): the CDN's entry is the client.
  assertEquals(
    forwardedClient("8.8.8.8, 203.0.113.50, 198.51.100.1", 2),
    "203.0.113.50",
  );
  // Fewer entries than hops: the leftmost, never out of range.
  assertEquals(forwardedClient("203.0.113.50", 2), "203.0.113.50");

  const req = new Request("https://ea.example/b.gif", {
    headers: { "x-forwarded-for": "8.8.8.8, 203.0.113.50" },
  });
  const r = resolveClientAddr(
    req,
    { behindCloudflare: false, trustProxy: true },
    "127.0.0.1",
  );
  assertEquals(r.ip, "203.0.113.50");
});

Deno.test("networkKey — an IPv6 /64 is one network, IPv4 is itself", () => {
  assertEquals(networkKey("203.0.113.7"), "203.0.113.7");
  assertEquals(networkKey("unknown"), "unknown");
  assertEquals(networkKey("::ffff:203.0.113.7"), "203.0.113.7");
  const a = networkKey("2001:db8:1:2::1");
  assertEquals(a, "2001:db8:1:2::/64");
  assertEquals(networkKey("2001:0db8:0001:0002:ffff:ffff:ffff:ffff"), a);
  assertEquals(networkKey("2001:DB8:1:2:a:b:c:d"), a);
  assert(networkKey("2001:db8:1:3::1") !== a);
  assertEquals(networkKey("::1"), "0:0:0:0::/64");
  assertEquals(networkKey("fe80::1%eth0"), "fe80:0:0:0::/64");
  // Not an address: returned as it came, never thrown on.
  assertEquals(networkKey("1:2:3"), "1:2:3");
  assertEquals(networkKey("zz::1"), "zz::1");
});

// ── Correlator ──────────────────────────────────────────────────────────────

const IPHONE =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Mobile/15E148 Safari/604.1";

function beacon(site: string, sid: string, tok: string | null): Request {
  const q = new URLSearchParams({
    p: btoa("/pricing"),
    _v: "1500",
    sw: "393",
    sh: "852",
    sid,
    s: site,
  });
  if (tok) q.set("tok", tok);
  return new Request(`https://ea.example/b.gif?${q}`, {
    headers: {
      "user-agent": IPHONE,
      "accept-language": "en-US,en;q=0.9",
      "sec-fetch-site": "cross-site",
      referer: "https://shop.example/",
    },
  });
}

const SCORE_SQL = "SELECT bot_score FROM visitor_views WHERE session_id = ?";

/** A real reader plus `attackers` copying their fingerprint without a token. */
async function clusterAround(site: string, attackers: string[]) {
  stopBotCorrelator();
  const db = createTestDb();
  startViewWriter(db);
  const fast = createFastPath(db);
  const victimIp = "198.51.100.23";
  const sid = crypto.randomUUID();
  await fast(beacon(site, sid, await solvePow(site, sid)), info(victimIp));
  for (const ip of attackers) {
    await fast(beacon(site, crypto.randomUUID(), null), info(ip));
  }
  await flushRemainingViews(db);
  startViewWriter(db);
  await _sweep(db, Date.now() + 13 * 60_000);

  const first = await db.queryOne<{ bot_score: number }>(SCORE_SQL, sid);
  // A second person behind the reader's address, after the sweep.
  const sid2 = crypto.randomUUID();
  await fast(beacon(site, sid2, await solvePow(site, sid2)), info(victimIp));
  await flushRemainingViews(db);
  const second = await db.queryOne<{ bot_score: number }>(SCORE_SQL, sid2);
  stopBotCorrelator();
  return { first: first!.bot_score, secondStored: second !== undefined };
}

Deno.test({
  name: "correlator — addresses from one IPv6 /64 are one member of a cluster",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    // Eight addresses out of one /64 used to be eight members: enough for a
    // large cluster around every visitor with the copied fingerprint.
    const r = await clusterAround(
      "v6.shop.example",
      Array.from({ length: 8 }, (_, i) => `2001:db8:1:2::${i + 1}`),
    );
    assert(r.first < 50, `reader still counted, score ${r.first}`);
    assertEquals(r.secondStored, true);
  },
});

Deno.test({
  name:
    "correlator — a cluster does not ban the address of a browser that proved work",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    // Eight separate networks do form the cluster, and the reader's unproven
    // view is penalised with it. Their address used to be banned for an hour
    // as well, dropping everyone behind it at ingest.
    const r = await clusterAround(
      "v4.shop.example",
      Array.from({ length: 8 }, (_, i) => `192.0.2.${i + 1}`),
    );
    assert(r.first >= 50, "the cluster itself still forms");
    assertEquals(r.secondStored, true, "the address is not banned");
  },
});

// ── Events endpoint ─────────────────────────────────────────────────────────

Deno.test({
  name: "events — the session id is cut to 64 characters before PoW",
  sanitizeOps: false,
  sanitizeResources: false,
  async fn() {
    // An uncut session id went into the replay cache key: 100 000 entries of
    // up to 16 KB. Cut, the token that verifies is the one for the prefix.
    const db = createTestDb();
    startEventWriter(db);
    const site = "sid.shop.example";
    const longSid = "a".repeat(12_000);
    const req = new Request("https://ea.example/e", {
      method: "POST",
      headers: {
        "user-agent": IPHONE,
        "accept-language": "en-US",
        "sec-fetch-site": "cross-site",
      },
      body: JSON.stringify({
        siteId: site,
        tok: await solvePow(site, longSid.slice(0, 64)),
        events: [{ type: "scroll_depth", data: {}, sessionId: longSid }],
      }),
    });
    await handleEvents(req, db);
    await flushRemainingEvents(db);
    const row = await db.queryOne<{ bot_score_detail: string }>(
      "SELECT bot_score_detail FROM semantic_events WHERE site_id = ?",
      site,
    );
    assert(row, "event stored");
    assert(!row.bot_score_detail.includes('"pow"'), row.bot_score_detail);
  },
});

Deno.test("events — an address has a byte budget per minute", () => {
  // 100 requests x 20 events x 2 KB a minute was allowed: about 5 GB a day
  // from one address.
  _resetEventBudget();
  const t = 1_000_000;
  assertEquals(spendEventBytes("net-a", 600, t, 1000), true);
  assertEquals(spendEventBytes("net-a", 600, t, 1000), false);
  assertEquals(spendEventBytes("net-a", 400, t, 1000), true);
  assertEquals(spendEventBytes("net-b", 600, t, 1000), true, "per address");
  assertEquals(spendEventBytes("net-a", 600, t + 61_000, 1000), true, "resets");
  assertEquals(spendEventBytes("net-c", 5000, t, 0), true, "0 disables");
  _resetEventBudget();
});

// ── Login ───────────────────────────────────────────────────────────────────

function loginRequest(body: BodyInit, peer = "203.0.113.9"): Request {
  const req = new Request("https://analytics.example.com/admin/login", {
    method: "POST",
    headers: {
      host: "analytics.example.com",
      origin: "https://analytics.example.com",
      "content-type": "application/x-www-form-urlencoded",
    },
    body,
  });
  setPeerAddr(req, info(peer));
  return req;
}

const postLogin = (req: Request) =>
  (loginHandler as unknown as { POST(ctx: unknown): Promise<unknown> }).POST({
    req,
  });

Deno.test("login — a body over the cap is refused unread", async () => {
  // formData() buffered anything, and the username went into the limiter's
  // key: 300 posts with a 1 MB username held 300 MB.
  const big = `username=${"A".repeat(20_000)}&password=x`;
  const res = await postLogin(loginRequest(big));
  assert(res instanceof Response);
  assertEquals(res.status, 413);

  // The same with no Content-Length to check: cut off while streaming.
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      for (let i = 0; i < 10; i++) c.enqueue(new Uint8Array(4096).fill(65));
      c.close();
    },
  });
  const streamed = new Request("https://analytics.example.com/admin/login", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: stream,
  });
  assertEquals(await readFormCapped(streamed, 8192), "too_large");
});

Deno.test("login — an address is limited across usernames", async () => {
  // Keyed on address + username alone, a new username each time was never
  // limited, and each attempt ran a full PBKDF2.
  _resetAuthAttempts();
  for (let i = 0; i < 30; i++) {
    await postLogin(loginRequest(`username=user${i}&password=x`));
  }
  assertEquals(isAuthLimited("login|203.0.113.9", 30), true);
  const res = await postLogin(loginRequest("username=fresh&password=x")) as {
    data: { rateLimited: boolean };
  };
  assertEquals(res.data.rateLimited, true);

  // An over-long username is a failed login that leaves nothing behind.
  _resetAuthAttempts();
  const long = "u".repeat(300);
  await postLogin(loginRequest(`username=${long}&password=x`, "203.0.113.10"));
  assertEquals(isAuthLimited(`203.0.113.10|${long}`, 1), false);
  _resetAuthAttempts();
});

// ── Bearer token ────────────────────────────────────────────────────────────

Deno.test("bearer — wrong guesses do not lock the right token out", async () => {
  // The limiter was consulted before the token: five wrong guesses from an
  // address refused the real client behind it for 15 minutes.
  const wrong = {
    method: "GET",
    path: "/api/stats/overview",
    headers: { authorization: "Bearer nope" },
  };
  const right = {
    ...wrong,
    headers: { authorization: "Bearer a-long-secret-for-this-test-only" },
  };
  const res = await probeApiAuth(
    { ECHELON_SECRET: "a-long-secret-for-this-test-only" },
    [wrong, wrong, wrong, wrong, wrong, wrong, right, wrong],
  );
  assertEquals(res.map((r) => r.status), [
    401,
    401,
    401,
    401,
    401,
    429,
    200,
    429,
  ]);
});

// ── Threat feeds ────────────────────────────────────────────────────────────

Deno.test("threat feeds — an entry that matches ordinary browsers is refused", () => {
  // The feeds come from public repositories and apply to every visitor: one
  // match-all entry would have scored all traffic as crawlers.
  for (
    const p of [".", ".*", "Mozilla", "Safari", "^", "(?:)", "Chrome/\\d+"]
  ) {
    assertEquals(patternMatchesBrowsers(p), true, p);
  }
  for (const p of ["Googlebot", "bingbot", "AhrefsBot", "HeadlessChrome"]) {
    assertEquals(patternMatchesBrowsers(p), false, p);
  }
  for (const n of ["", "x", "Mozilla", "safari", "like Gecko", "Chrome"]) {
    assertEquals(nameMatchesBrowsers(n), true, n);
  }
  for (const n of ["GPTBot", "ClaudeBot", "CCBot", "Bytespider"]) {
    assertEquals(nameMatchesBrowsers(n), false, n);
  }
});
