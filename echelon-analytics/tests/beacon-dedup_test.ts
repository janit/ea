import { assertEquals } from "@std/assert";
import {
  _beaconDedupSize,
  _resetBeaconDedup,
  seenBefore,
} from "@/lib/beacon-dedup.ts";
import { flushRemainingViews, handleBeacon } from "@/lib/beacon.ts";
import { getBurstCount, hashIp } from "@/lib/bot-score.ts";
import { getClientIp } from "@/lib/ip.ts";
import { createTestDb, solvePow } from "./_helpers.ts";

Deno.test("seenBefore — first sight false, repeat true, expiry after 10 minutes", () => {
  _resetBeaconDedup();
  const t0 = 5_000_000;
  assertEquals(seenBefore("k", t0), false);
  assertEquals(seenBefore("k", t0 + 1), true);
  assertEquals(seenBefore("k", t0 + 599_999), true);
  assertEquals(
    seenBefore("k", t0 + 600_001),
    false,
    "window measured from first sight",
  );
  assertEquals(seenBefore("other", t0), false);
});

Deno.test("seenBefore — stays bounded under a flood of distinct keys", () => {
  _resetBeaconDedup();
  for (let i = 0; i < 210_000; i++) seenBefore(`flood-${i}`, 1000);
  // The oldest keys were evicted to make room; the newest are still known.
  assertEquals(seenBefore("flood-0", 1000), false);
  assertEquals(seenBefore("flood-209999", 1000), true);
});

const N1 = "0123456789abcdef";
const N2 = "fedcba9876543210";

const HEADERS = {
  "user-agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/120.0.0.0",
  "accept-language": "en-US",
  "sec-ch-ua": '"Chrome"',
  "sec-fetch-site": "cross-site",
};

function req(
  site: string,
  sid: string,
  tok: string,
  v: string,
  nonce?: string,
): Request {
  return new Request(
    `https://a.example.com/b.gif?p=${
      btoa("/page")
    }&_v=${v}&sw=1440&sh=900&s=${site}&sid=${sid}&tok=${tok}${
      nonce === undefined ? "" : `&_n=${nonce}`
    }`,
    { headers: HEADERS },
  );
}

async function count(
  db: Awaited<ReturnType<typeof createTestDb>>,
  site: string,
) {
  const row = await db.queryOne<{ n: number }>(
    "SELECT COUNT(*) AS n FROM visitor_views WHERE site_id = ?",
    site,
  );
  return row?.n ?? 0;
}

Deno.test("beacon dedup — redelivery of the same beacon is stored once", async () => {
  const db = createTestDb();
  const site = "dedup-redelivery";
  const sid = "d1d1d1d1-d1d1-4d1d-8d1d-d1d1d1d1d1d1";
  const tok = await solvePow(site, sid);
  const first = await handleBeacon(req(site, sid, tok, "2000", N1), db);
  const second = await handleBeacon(req(site, sid, tok, "2000", N1), db);
  await flushRemainingViews(db);
  assertEquals(await count(db, site), 1);
  // The retry still gets a normal pixel response.
  assertEquals(second.status, 200);
  assertEquals(second.headers.get("Content-Type"), "image/gif");
  await first.body?.cancel();
  await second.body?.cancel();
  await db.close();
});

Deno.test("beacon dedup — a reload with the same interaction time but a new nonce is counted", async () => {
  const db = createTestDb();
  const site = "dedup-reload";
  const sid = "d2d2d2d2-d2d2-4d2d-8d2d-d2d2d2d2d2d2";
  const tok = await solvePow(site, sid);
  // Both pageviews send at ~800 ms (a gesture before 800 ms is deferred to
  // 800 ms), so only the nonce tells them apart.
  await handleBeacon(req(site, sid, tok, "800", N1), db);
  await handleBeacon(req(site, sid, tok, "800", N2), db);
  await flushRemainingViews(db);
  assertEquals(await count(db, site), 2);
  await db.close();
});

Deno.test("beacon dedup — SPA navigations back to the same path are all counted", async () => {
  const db = createTestDb();
  const site = "dedup-spa";
  const sid = "d3d3d3d3-d3d3-4d3d-8d3d-d3d3d3d3d3d3";
  const tok = await solvePow(site, sid);
  await handleBeacon(req(site, sid, tok, "spa", N1), db);
  await handleBeacon(req(site, sid, tok, "spa", N1), db);
  await flushRemainingViews(db);
  assertEquals(await count(db, site), 2);
  await db.close();
});

Deno.test("beacon dedup — a beacon with no session id is never deduplicated", async () => {
  const db = createTestDb();
  const site = "dedup-nosid";
  const mk = () =>
    new Request(
      `https://a.example.com/b.gif?p=${
        btoa("/page")
      }&_v=2000&sw=1440&sh=900&s=${site}&_n=${N1}`,
      { headers: HEADERS },
    );
  await handleBeacon(mk(), db);
  await handleBeacon(mk(), db);
  await flushRemainingViews(db);
  assertEquals(await count(db, site), 2);
  await db.close();
});

Deno.test("beacon dedup — a beacon without a nonce is never deduplicated", async () => {
  _resetBeaconDedup();
  const db = createTestDb();
  const site = "dedup-nononce";
  const sid = "d4d4d4d4-d4d4-4d4d-8d4d-d4d4d4d4d4d4";
  const tok = await solvePow(site, sid);
  await handleBeacon(req(site, sid, tok, "2000"), db);
  await handleBeacon(req(site, sid, tok, "2000"), db);
  await flushRemainingViews(db);
  assertEquals(await count(db, site), 2);
  assertEquals(_beaconDedupSize(), 0);
  await db.close();
});

Deno.test("beacon dedup — a malformed nonce is never deduplicated nor stored", async () => {
  _resetBeaconDedup();
  const db = createTestDb();
  const site = "dedup-badnonce";
  const sid = "d6d6d6d6-d6d6-4d6d-8d6d-d6d6d6d6d6d6";
  const tok = await solvePow(site, sid);
  const bad = [
    "0123456789abcdef0", // too long
    "0123456789abcde", // too short
    "0123456789ABCDEF", // uppercase
    "0123456789abcdeg", // non-hex
    "a".repeat(2000),
  ];
  for (const n of bad) {
    await handleBeacon(req(site, sid, tok, "2000", n), db);
    await handleBeacon(req(site, sid, tok, "2000", n), db);
  }
  await flushRemainingViews(db);
  assertEquals(await count(db, site), bad.length * 2);
  assertEquals(_beaconDedupSize(), 0);
  await db.close();
});

Deno.test("beacon dedup — a redelivery does not feed the burst counter", async () => {
  const db = createTestDb();
  const site = "dedup-burst";
  const sid = "d5d5d5d5-d5d5-4d5d-8d5d-d5d5d5d5d5d5";
  const tok = await solvePow(site, sid);
  const mk = () => req(site, sid, tok, "2000", N1);
  const ipHash = await hashIp(getClientIp(mk()));
  const before = getBurstCount(ipHash);
  for (let i = 0; i < 10; i++) await handleBeacon(mk(), db);
  await flushRemainingViews(db);
  assertEquals(await count(db, site), 1);
  assertEquals(getBurstCount(ipHash) - before, 1);
  await db.close();
});

Deno.test("beacon dedup — a cookie-mode redelivery that arrives without the cookie is stored once", async () => {
  // In cookie mode a request with no _ev cookie is given a new random
  // visitor id, so the copy of a first pageview has a different visitor.
  const db = createTestDb();
  const site = "dedup-cookie";
  const sid = "d7d7d7d7-d7d7-4d7d-8d7d-d7d7d7d7d7d7";
  const tok = await solvePow(site, sid);
  const mk = () => {
    const r = req(site, sid, tok, "2000", N1);
    return new Request(`${r.url}&ck=1`, { headers: HEADERS });
  };
  const first = await handleBeacon(mk(), db);
  const second = await handleBeacon(mk(), db);
  await flushRemainingViews(db);
  assertEquals(await count(db, site), 1);
  await first.body?.cancel();
  await second.body?.cancel();
  await db.close();
});

Deno.test("beacon dedup — the same session and nonce on another site is another pageview", async () => {
  const db = createTestDb();
  const sid = "d8d8d8d8-d8d8-4d8d-8d8d-d8d8d8d8d8d8";
  for (const site of ["dedup-site-a", "dedup-site-b"]) {
    const tok = await solvePow(site, sid);
    await handleBeacon(req(site, sid, tok, "2000", N1), db);
  }
  // Site ids match without regard to case.
  const tok = await solvePow("DEDUP-site-a", sid);
  await handleBeacon(req("DEDUP-site-a", sid, tok, "2000", N1), db);
  await flushRemainingViews(db);
  assertEquals(await count(db, "dedup-site-a"), 1);
  assertEquals(await count(db, "dedup-site-b"), 1);
  assertEquals(await count(db, "DEDUP-site-a"), 0);
  await db.close();
});
