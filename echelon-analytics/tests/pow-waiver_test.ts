// A session that has presented a valid PoW token is not penalised when a
// later request arrives without one. The waiver is recorded as `pow_ok` and
// never crosses sites.

import { assert, assertEquals } from "@std/assert";
import { flushRemainingViews, handleBeacon } from "@/lib/beacon.ts";
import { flushRemainingEvents, handleEvents } from "@/lib/events-endpoint.ts";
import { isProven } from "@/lib/proven-sessions.ts";
import { createTestDb, solvePow } from "./_helpers.ts";

const HEADERS = {
  "user-agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/120.0.0.0",
  "accept-language": "en-US",
  "sec-ch-ua": '"Chrome"',
  "sec-fetch-site": "cross-site",
};

function beaconReq(
  site: string,
  sid: string,
  path: string,
  tok?: string,
): Request {
  return new Request(
    `https://a.example.com/b.gif?p=${
      btoa(path)
    }&_v=2000&sw=1440&sh=900&s=${site}&sid=${sid}${tok ? "&tok=" + tok : ""}`,
    { headers: HEADERS },
  );
}

function eventsReq(site: string, sid: string, tok?: string): Request {
  const body = JSON.stringify({
    siteId: site,
    tok,
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

Deno.test("pow waiver — tokenless beacon after a valid one is waived", async () => {
  const db = createTestDb();
  const site = "waiver-beacon";
  const sid = "44444444-4444-4444-8444-444444444444";
  const tok = await solvePow(site, sid);

  await handleBeacon(beaconReq(site, sid, "/first", tok), db);
  await handleBeacon(beaconReq(site, sid, "/second"), db);
  await flushRemainingViews(db);

  const second = await db.queryOne<
    { bot_score: number; bot_score_detail: string }
  >(
    "SELECT bot_score, bot_score_detail FROM visitor_views WHERE site_id = ? AND path = ?",
    site,
    "/second",
  );
  assert(second, "second view stored");
  assertEquals(second.bot_score, 0);
  const detail = JSON.parse(second.bot_score_detail);
  assertEquals(detail.pow_ok, 30);
  assertEquals(detail.pow, undefined);
  assertEquals(detail.pow_result, undefined);
  await db.close();
});

Deno.test("pow waiver — stale token on /e after a valid beacon is waived", async () => {
  const db = createTestDb();
  const site = "waiver-events";
  const sid = "55555555-5555-4555-8555-555555555555";
  const tok = await solvePow(site, sid);

  await handleBeacon(beaconReq(site, sid, "/page", tok), db);
  await handleEvents(eventsReq(site, sid, "0".repeat(32)), db);
  await flushRemainingViews(db);
  await flushRemainingEvents(db);

  const ev = await db.queryOne<{ bot_score: number; bot_score_detail: string }>(
    "SELECT bot_score, bot_score_detail FROM semantic_events WHERE site_id = ?",
    site,
  );
  assert(ev, "event stored");
  assertEquals(ev.bot_score, 0);
  assertEquals(JSON.parse(ev.bot_score_detail).pow_ok, 40);
  await db.close();
});

Deno.test("pow waiver — site isolation: proof on one site does not waive another", async () => {
  const db = createTestDb();
  const sid = "66666666-6666-4666-8666-666666666666";
  const tok = await solvePow("waiver-site-a", sid);

  await handleBeacon(beaconReq("waiver-site-a", sid, "/a", tok), db);
  await handleBeacon(beaconReq("waiver-site-b", sid, "/b"), db);
  await flushRemainingViews(db);

  const b = await db.queryOne<{ bot_score: number; bot_score_detail: string }>(
    "SELECT bot_score, bot_score_detail FROM visitor_views WHERE site_id = ?",
    "waiver-site-b",
  );
  assert(b, "view on site b stored");
  assertEquals(b.bot_score, 30);
  assertEquals(JSON.parse(b.bot_score_detail).pow, 30);
  await db.close();
});

Deno.test("pow waiver — never granted without a prior valid token", async () => {
  const db = createTestDb();
  const site = "waiver-none";
  const sid = "77777777-7777-4777-8777-777777777777";

  await handleBeacon(beaconReq(site, sid, "/one"), db);
  await handleBeacon(beaconReq(site, sid, "/two"), db);
  await flushRemainingViews(db);

  const rows = await db.query<{ bot_score: number }>(
    "SELECT bot_score FROM visitor_views WHERE site_id = ?",
    site,
  );
  assertEquals(rows.map((r) => r.bot_score), [30, 30]);
  await db.close();
});

Deno.test("pow waiver — non-UUID session id on /e is scored normally", async () => {
  const db = createTestDb();
  const site = "waiver-badsid";
  // Tracker fallback when sessionStorage is blocked: not a UUID.
  await handleEvents(eventsReq(site, "k3j2h1g0f9"), db);
  await flushRemainingEvents(db);
  const ev = await db.queryOne<
    { bot_score: number; session_id: string | null }
  >(
    "SELECT bot_score, session_id FROM semantic_events WHERE site_id = ?",
    site,
  );
  assert(ev, "event stored");
  assertEquals(ev.bot_score, 30);
  assertEquals(ev.session_id, null);
  await db.close();
});

// ── Which key granted the waiver (pow_ok_by) ────────────────────────────────
// "s": the session itself proved work. "v": only the visitor did, which in
// cookieless mode is everyone behind one IP + user agent.

type Scored = { bot_score: number; bot_score_detail: string };

Deno.test("pow waiver — same session proves then omits the token: pow_ok_by is s", async () => {
  const db = createTestDb();
  const site = "waiver-by-s";
  const sid = "88888888-8888-4888-8888-888888888888";
  const tok = await solvePow(site, sid);

  await handleBeacon(beaconReq(site, sid, "/first", tok), db);
  await handleBeacon(beaconReq(site, sid, "/second"), db);
  await handleEvents(eventsReq(site, sid), db);
  await flushRemainingViews(db);
  await flushRemainingEvents(db);

  const first = await db.queryOne<Scored>(
    "SELECT bot_score, bot_score_detail FROM visitor_views WHERE site_id = ? AND path = ?",
    site,
    "/first",
  );
  assert(first, "first view stored");
  assertEquals(
    JSON.parse(first.bot_score_detail).pow_ok_by,
    undefined,
    "a valid token is not a waiver",
  );

  const view = await db.queryOne<Scored>(
    "SELECT bot_score, bot_score_detail FROM visitor_views WHERE site_id = ? AND path = ?",
    site,
    "/second",
  );
  assert(view, "second view stored");
  assertEquals(view.bot_score, 0);
  assertEquals(JSON.parse(view.bot_score_detail).pow_ok, 30);
  assertEquals(JSON.parse(view.bot_score_detail).pow_ok_by, "s");
  assert(
    view.bot_score_detail.includes('"pow_ok_by":"s"'),
    `raw detail must contain "pow_ok_by":"s" exactly: ${view.bot_score_detail}`,
  );

  const ev = await db.queryOne<Scored>(
    "SELECT bot_score, bot_score_detail FROM semantic_events WHERE site_id = ?",
    site,
  );
  assert(ev, "event stored");
  assertEquals(ev.bot_score, 0);
  assertEquals(JSON.parse(ev.bot_score_detail).pow_ok, 30);
  assert(
    ev.bot_score_detail.includes('"pow_ok_by":"s"'),
    `raw detail must contain "pow_ok_by":"s" exactly: ${ev.bot_score_detail}`,
  );
  await db.close();
});

Deno.test("pow waiver — another session of a proven visitor is waived with pow_ok_by v", async () => {
  const db = createTestDb();
  const site = "waiver-by-v";
  const sidA = "99999999-9999-4999-8999-99999999999a";
  const sidB = "99999999-9999-4999-8999-99999999999b";
  const tok = await solvePow(site, sidA);

  // Same IP and user agent: one cookieless visitor id, two sessions.
  await handleBeacon(beaconReq(site, sidA, "/a", tok), db);
  await handleBeacon(beaconReq(site, sidB, "/b"), db);
  await handleEvents(eventsReq(site, sidB, "0".repeat(32)), db);
  await flushRemainingViews(db);
  await flushRemainingEvents(db);

  const views = await db.query<{ path: string; visitor_id: string }>(
    "SELECT path, visitor_id FROM visitor_views WHERE site_id = ? ORDER BY path",
    site,
  );
  assertEquals(views.map((v) => v.path), ["/a", "/b"]);
  assertEquals(views[0].visitor_id, views[1].visitor_id, "same visitor");

  const view = await db.queryOne<Scored>(
    "SELECT bot_score, bot_score_detail FROM visitor_views WHERE site_id = ? AND path = ?",
    site,
    "/b",
  );
  assert(view, "session B view stored");
  assertEquals(view.bot_score, 0);
  const detail = JSON.parse(view.bot_score_detail);
  assertEquals(detail.pow_ok, 30);
  assertEquals(detail.pow, undefined);
  assertEquals(detail.pow_ok_by, "v");
  assert(
    view.bot_score_detail.includes('"pow_ok_by":"v"'),
    `raw detail must contain "pow_ok_by":"v" exactly: ${view.bot_score_detail}`,
  );
  // The SQL a later phase will run.
  const liked = await db.query<{ path: string }>(
    `SELECT path FROM visitor_views
      WHERE site_id = ? AND bot_score_detail LIKE '%"pow_ok_by":"v"%'`,
    site,
  );
  assertEquals(liked.map((r) => r.path), ["/b"]);

  const ev = await db.queryOne<Scored>(
    "SELECT bot_score, bot_score_detail FROM semantic_events WHERE site_id = ?",
    site,
  );
  assert(ev, "session B event stored");
  assertEquals(ev.bot_score, 0);
  assertEquals(JSON.parse(ev.bot_score_detail).pow_ok, 40);
  assert(
    ev.bot_score_detail.includes('"pow_ok_by":"v"'),
    `raw detail must contain "pow_ok_by":"v" exactly: ${ev.bot_score_detail}`,
  );
  await db.close();
});

Deno.test("pow waiver — proof presented on /e waives a later tokenless beacon of that session", async () => {
  const db = createTestDb();
  const site = "waiver-from-events";
  const sid = "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa";
  const tok = await solvePow(site, sid);

  await handleEvents(eventsReq(site, sid, tok), db);
  await handleBeacon(beaconReq(site, sid, "/later"), db);
  await flushRemainingEvents(db);
  await flushRemainingViews(db);

  const view = await db.queryOne<Scored>(
    "SELECT bot_score, bot_score_detail FROM visitor_views WHERE site_id = ?",
    site,
  );
  assert(view, "view stored");
  assertEquals(view.bot_score, 0);
  const detail = JSON.parse(view.bot_score_detail);
  assertEquals(detail.pow_ok, 30);
  assertEquals(detail.pow, undefined);
  assertEquals(detail.pow_ok_by, "s");
  await db.close();
});

Deno.test("pow waiver — non-UUID session id on /e with a valid token marks only the visitor key", async () => {
  const db = createTestDb();
  const site = "waiver-badsid-valid";
  const sid = "k3j2h1g0f9";
  const tok = await solvePow(site, sid);

  await handleEvents(eventsReq(site, sid, tok), db);
  await handleEvents(eventsReq(site, sid), db);
  await flushRemainingEvents(db);

  const rows = await db.query<
    {
      bot_score: number;
      bot_score_detail: string;
      visitor_id: string;
      session_id: string | null;
    }
  >(
    "SELECT bot_score, bot_score_detail, visitor_id, session_id FROM semantic_events WHERE site_id = ? ORDER BY id",
    site,
  );
  assertEquals(rows.length, 2);
  assertEquals(rows.map((r) => r.bot_score), [0, 0]);
  assertEquals(rows.map((r) => r.session_id), [null, null]);
  assertEquals(JSON.parse(rows[0].bot_score_detail).pow_ok_by, undefined);
  assertEquals(JSON.parse(rows[1].bot_score_detail).pow_ok, 30);
  assertEquals(JSON.parse(rows[1].bot_score_detail).pow_ok_by, "v");

  assertEquals(isProven([`v:${site}:${rows[0].visitor_id}`]), true);
  assertEquals(isProven([`s:${site}:${sid}`]), false, "no session key");
  await db.close();
});
