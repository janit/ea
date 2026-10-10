import { assertEquals, assertRejects, assertThrows } from "@std/assert";
import { computeBotScoreWithDetail } from "@/lib/bot-score.ts";
import { provenHumanIds, provenHumanSql } from "@/lib/proven-human.ts";
import { createTestDb, insertView } from "./_helpers.ts";

const SITE = "ph-site";

Deno.test("provenHumanIds — returns only ids that own a validated view", async () => {
  const db = createTestDb();
  await insertView(db, { visitor_id: "human", site_id: SITE, validated: 1 });
  await insertView(db, { visitor_id: "unknown", site_id: SITE, validated: 0 });
  const got = await provenHumanIds(db, SITE, "visitor_id", [
    "human",
    "unknown",
    "absent",
  ]);
  assertEquals([...got], ["human"]);
  await db.close();
});

Deno.test("provenHumanIds — a validated view from a datacenter IP proves nothing", async () => {
  const db = createTestDb();
  await insertView(db, {
    visitor_id: "cloudbot",
    site_id: SITE,
    validated: 1,
    bot_score: 25,
    bot_score_detail: '{"datacenter_ip":25}',
  });
  const got = await provenHumanIds(db, SITE, "visitor_id", ["cloudbot"]);
  assertEquals(got.size, 0);
  await db.close();
});

Deno.test("provenHumanIds — scoped to the site", async () => {
  const db = createTestDb();
  await insertView(db, {
    visitor_id: "human",
    site_id: "elsewhere",
    validated: 1,
  });
  const got = await provenHumanIds(db, SITE, "visitor_id", ["human"]);
  assertEquals(got.size, 0);
  await db.close();
});

Deno.test("provenHumanIds — works by session id", async () => {
  const db = createTestDb();
  await insertView(db, {
    visitor_id: "v",
    site_id: SITE,
    session_id: "sess-a",
    validated: 1,
  });
  const got = await provenHumanIds(db, SITE, "session_id", [
    "sess-a",
    "sess-b",
  ]);
  assertEquals([...got], ["sess-a"]);
  await db.close();
});

Deno.test("provenHumanIds — empty input and large input", async () => {
  const db = createTestDb();
  assertEquals((await provenHumanIds(db, SITE, "visitor_id", [])).size, 0);
  await insertView(db, { visitor_id: "id1200", site_id: SITE, validated: 1 });
  const many = Array.from({ length: 1500 }, (_, i) => `id${i}`);
  const got = await provenHumanIds(db, SITE, "visitor_id", many);
  assertEquals([...got], ["id1200"]);
  await db.close();
});

Deno.test("provenHumanIds — the datacenter exclusion matches the key the scorer writes", async () => {
  const db = createTestDb();
  // A datacenter request scored the way the beacon scores it, and its
  // detail stored the way the beacon stores it.
  const scored = computeBotScoreWithDetail({
    burstCount: 0,
    hasAcceptLanguage: true,
    hasSecChUa: true,
    hasSecFetchSite: true,
    datacenterIp: true,
  });
  await insertView(db, {
    visitor_id: "cloud",
    site_id: SITE,
    session_id: "cloud-s",
    validated: 1,
    bot_score: scored.score,
    bot_score_detail: JSON.stringify(scored.detail),
  });
  const home = computeBotScoreWithDetail({
    burstCount: 0,
    hasAcceptLanguage: true,
    hasSecChUa: true,
    hasSecFetchSite: true,
  });
  await insertView(db, {
    visitor_id: "home",
    site_id: SITE,
    session_id: "home-s",
    validated: 1,
    bot_score: home.score,
    bot_score_detail: JSON.stringify(home.detail),
  });
  assertEquals(
    [...await provenHumanIds(db, SITE, "visitor_id", ["cloud", "home"])],
    ["home"],
  );
  assertEquals(
    [...await provenHumanIds(db, SITE, "session_id", ["cloud-s", "home-s"])],
    ["home-s"],
  );
  await db.close();
});

Deno.test("provenHumanIds — any other column is refused", async () => {
  const db = createTestDb();
  for (const column of ["path", "visitor_id OR 1=1", "", "VISITOR_ID"]) {
    await assertRejects(
      () => provenHumanIds(db, SITE, column as "visitor_id", ["x"]),
      Error,
      "provenHumanIds: unsupported column",
    );
    assertThrows(
      () => provenHumanSql(column as "visitor_id", 1),
      Error,
      "provenHumanIds: unsupported column",
    );
  }
  await db.close();
});

Deno.test("provenHumanIds — each column is one search of the validated rows for that key", async () => {
  const db = createTestDb();
  const plan = async (column: "visitor_id" | "session_id") =>
    (await db.query<{ detail: string }>(
      `EXPLAIN QUERY PLAN ${provenHumanSql(column, 3)}`,
      SITE,
      "a",
      "b",
      "c",
    )).map((r) => r.detail).filter((d) => /^(SEARCH|SCAN)/.test(d));
  assertEquals(await plan("visitor_id"), [
    "SEARCH visitor_views USING INDEX idx_vv_validated_visitor (site_id=? AND visitor_id=?)",
  ]);
  assertEquals(await plan("session_id"), [
    "SEARCH visitor_views USING INDEX idx_vv_validated (site_id=? AND session_id=?)",
  ]);
  await db.close();
});

Deno.test("provenHumanIds — a visitor with many unvalidated views and a session shared by many", async () => {
  const db = createTestDb();
  for (let i = 0; i < 150; i++) {
    await insertView(db, {
      visitor_id: "busy",
      site_id: SITE,
      session_id: `busy-${i}`,
      validated: 0,
    });
    await insertView(db, {
      visitor_id: `guest-${i}`,
      site_id: SITE,
      session_id: "shared",
      validated: i === 149 ? 1 : 0,
    });
  }
  assertEquals(
    [...await provenHumanIds(db, SITE, "visitor_id", ["busy", "guest-149"])],
    ["guest-149"],
  );
  assertEquals(
    [...await provenHumanIds(db, SITE, "session_id", ["busy-3", "shared"])],
    ["shared"],
  );
  // The same ids on another site prove nothing here.
  assertEquals(
    (await provenHumanIds(db, "other", "session_id", ["shared"])).size,
    0,
  );
  await db.close();
});
