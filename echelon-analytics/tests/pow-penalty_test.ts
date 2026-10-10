// The PoW penalty as it lands in stored rows. A missing token must leave the
// row stored (30 < 50); an invalid token on /e must leave the event stored
// (40 < 50) so interaction evidence from a stale-token session survives.

import { assert, assertEquals } from "@std/assert";
import { flushRemainingViews, handleBeacon } from "@/lib/beacon.ts";
import { flushRemainingEvents, handleEvents } from "@/lib/events-endpoint.ts";
import { createTestDb, solvePow } from "./_helpers.ts";

const HEADERS = {
  "user-agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/120.0.0.0",
  "accept-language": "en-US",
  "sec-ch-ua": '"Chrome"',
  "sec-fetch-site": "cross-site",
};

function beaconReq(site: string, sid: string, tok?: string): Request {
  return new Request(
    `https://a.example.com/b.gif?p=${
      btoa("/page")
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

Deno.test("pow penalty — beacon with no token is stored at 30", async () => {
  const db = createTestDb();
  const site = "pow-pen-missing";
  await handleBeacon(
    beaconReq(site, "11111111-1111-4111-8111-111111111111"),
    db,
  );
  await flushRemainingViews(db);
  const row = await db.queryOne<
    { bot_score: number; bot_score_detail: string }
  >(
    "SELECT bot_score, bot_score_detail FROM visitor_views WHERE site_id = ?",
    site,
  );
  assert(row, "view must be stored, not discarded");
  assertEquals(row.bot_score, 30);
  const detail = JSON.parse(row.bot_score_detail);
  assertEquals(detail.pow, 30);
  assertEquals(detail.pow_result, "missing");
  await db.close();
});

Deno.test("pow penalty — beacon with an invalid token is discarded", async () => {
  const db = createTestDb();
  const site = "pow-pen-invalid-beacon";
  await handleBeacon(
    beaconReq(site, "22222222-2222-4222-8222-222222222222", "0".repeat(32)),
    db,
  );
  await flushRemainingViews(db);
  const row = await db.queryOne(
    "SELECT 1 AS x FROM visitor_views WHERE site_id = ?",
    site,
  );
  assertEquals(row, undefined);
  await db.close();
});

Deno.test("pow penalty — events with an invalid token are stored at 40", async () => {
  const db = createTestDb();
  const site = "pow-pen-invalid-events";
  await handleEvents(
    eventsReq(site, "33333333-3333-4333-8333-333333333333", "0".repeat(32)),
    db,
  );
  await flushRemainingEvents(db);
  const row = await db.queryOne<
    { bot_score: number; bot_score_detail: string }
  >(
    "SELECT bot_score, bot_score_detail FROM semantic_events WHERE site_id = ?",
    site,
  );
  assert(row, "event must be stored, not discarded");
  assertEquals(row.bot_score, 40);
  assertEquals(JSON.parse(row.bot_score_detail).pow_result, "invalid");
  await db.close();
});

// The tracker falls back to a non-UUID session id when sessionStorage is
// blocked and solves the PoW over that id. Both endpoints verify against the
// id as sent; only storage and the proven-session key require a UUID.
const FALLBACK_SID = "k3j2h1g0f9";

Deno.test("pow penalty — beacon with a non-UUID sid and a token solved over it is stored clean", async () => {
  const db = createTestDb();
  const site = "pow-pen-fallback-sid";
  const tok = await solvePow(site, FALLBACK_SID);
  await handleBeacon(beaconReq(site, FALLBACK_SID, tok), db);
  await flushRemainingViews(db);
  const row = await db.queryOne<
    {
      bot_score: number;
      bot_score_detail: string;
      session_id: string | null;
    }
  >(
    "SELECT bot_score, bot_score_detail, session_id FROM visitor_views WHERE site_id = ?",
    site,
  );
  assert(row, "view must be stored, not discarded");
  assertEquals(row.bot_score, 0);
  const detail = JSON.parse(row.bot_score_detail);
  assertEquals(detail.pow, undefined);
  assertEquals(detail.pow_result, undefined);
  assertEquals(row.session_id, null);
  await db.close();
});

Deno.test("pow penalty — beacon with a non-UUID sid and a wrong token is still invalid", async () => {
  const db = createTestDb();
  const site = "pow-pen-fallback-sid-bad";
  await handleBeacon(beaconReq(site, FALLBACK_SID, "0".repeat(32)), db);
  // A token solved for a different session id is just as wrong.
  await handleBeacon(
    beaconReq(site, FALLBACK_SID, await solvePow(site, "z9y8x7w6v5")),
    db,
  );
  await flushRemainingViews(db);
  const row = await db.queryOne(
    "SELECT 1 AS x FROM visitor_views WHERE site_id = ?",
    site,
  );
  assertEquals(row, undefined, "invalid on /b.gif is discarded");
  await db.close();
});

Deno.test("pow penalty — beacon verifies against at most 64 chars of the sid", async () => {
  const db = createTestDb();
  const site = "pow-pen-long-sid";
  const longSid = "a".repeat(70);
  // Solved over all 70 chars: the server only looks at the first 64.
  await handleBeacon(
    beaconReq(site, longSid, await solvePow(site, longSid)),
    db,
  );
  await flushRemainingViews(db);
  assertEquals(
    await db.queryOne(
      "SELECT 1 AS x FROM visitor_views WHERE site_id = ?",
      site,
    ),
    undefined,
  );
  await db.close();
});
