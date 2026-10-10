import { assertEquals, assertGreater } from "@std/assert";
import {
  purgeAutoExclusions,
  purgeExpiredData,
  rollupDay,
} from "@/lib/maintenance.ts";
import {
  createTestDb,
  insertEvent,
  insertView,
  YESTERDAY,
} from "./_helpers.ts";

// ── rollupDay ───────────────────────────────────────────────────────────────

Deno.test("rollupDay — aggregates views into daily rollup", async () => {
  const db = createTestDb();
  // Insert views for yesterday
  const ts = `${YESTERDAY}T12:00:00.000Z`;
  await insertView(db, {
    visitor_id: "v1",
    created_at: ts,
    device_type: "desktop",
    country_code: "NO",
  });
  await insertView(db, {
    visitor_id: "v2",
    created_at: ts,
    device_type: "desktop",
    country_code: "NO",
  });
  await insertView(db, {
    visitor_id: "v3",
    created_at: ts,
    device_type: "mobile",
    country_code: "US",
  });

  const rows = await rollupDay(db, YESTERDAY);
  assertGreater(rows, 0);

  // Check daily rollup was created
  const daily = await db.query<{
    site_id: string;
    visits: number;
    unique_visitors: number;
  }>(
    "SELECT site_id, SUM(visits) AS visits, SUM(unique_visitors) AS unique_visitors FROM visitor_views_daily WHERE date = ? GROUP BY site_id",
    YESTERDAY,
  );
  assertEquals(daily.length, 1);
  assertEquals(daily[0].visits, 3);
  assertEquals(daily[0].unique_visitors, 3);
  await db.close();
});

Deno.test("rollupDay — excludes bot views (score >= 50)", async () => {
  const db = createTestDb();
  const ts = `${YESTERDAY}T12:00:00.000Z`;
  await insertView(db, { visitor_id: "human", bot_score: 10, created_at: ts });
  await insertView(db, { visitor_id: "bot", bot_score: 80, created_at: ts });

  await rollupDay(db, YESTERDAY);

  const daily = await db.queryOne<{ visits: number }>(
    "SELECT SUM(visits) AS visits FROM visitor_views_daily WHERE date = ?",
    YESTERDAY,
  );
  assertEquals(daily?.visits, 1);
  await db.close();
});

Deno.test("rollupDay — excludes excluded_visitors", async () => {
  const db = createTestDb();
  const ts = `${YESTERDAY}T12:00:00.000Z`;
  await insertView(db, { visitor_id: "normal", created_at: ts });
  await insertView(db, { visitor_id: "excluded-one", created_at: ts });
  await db.run(
    "INSERT INTO excluded_visitors (visitor_id) VALUES (?)",
    "excluded-one",
  );

  await rollupDay(db, YESTERDAY);

  const daily = await db.queryOne<{ visits: number }>(
    "SELECT SUM(visits) AS visits FROM visitor_views_daily WHERE date = ?",
    YESTERDAY,
  );
  assertEquals(daily?.visits, 1);
  await db.close();
});

Deno.test("rollupDay — idempotent (INSERT OR REPLACE)", async () => {
  const db = createTestDb();
  const ts = `${YESTERDAY}T12:00:00.000Z`;
  await insertView(db, { visitor_id: "v1", created_at: ts });

  await rollupDay(db, YESTERDAY);
  const first = await db.queryOne<{ visits: number }>(
    "SELECT SUM(visits) AS visits FROM visitor_views_daily WHERE date = ?",
    YESTERDAY,
  );

  // Run again — should produce same result
  await rollupDay(db, YESTERDAY);
  const second = await db.queryOne<{ visits: number }>(
    "SELECT SUM(visits) AS visits FROM visitor_views_daily WHERE date = ?",
    YESTERDAY,
  );

  assertEquals(first?.visits, second?.visits);
  await db.close();
});

Deno.test("rollupDay — re-rollup clears aggregates when a whole group turns to bots", async () => {
  // Regression: bot correlator retroactively flags an entire group as bots
  // after the first rollup. A re-rollup must DELETE the now-empty daily row,
  // not leave the stale clean-visit aggregate behind. INSERT OR REPLACE alone
  // cannot do this because the group vanishes from the SELECT.
  const db = createTestDb();
  const ts = `${YESTERDAY}T12:00:00.000Z`;
  for (const id of ["v1", "v2", "v3"]) {
    await insertView(db, {
      visitor_id: id,
      device_type: "desktop",
      country_code: "NO",
      created_at: ts,
    });
  }

  await rollupDay(db, YESTERDAY);
  const before = await db.queryOne<{ visits: number }>(
    "SELECT COALESCE(SUM(visits), 0) AS visits FROM visitor_views_daily WHERE date = ?",
    YESTERDAY,
  );
  assertEquals(before?.visits, 3);

  // Correlator flags every view as a bot after the fact.
  await db.run(
    "UPDATE visitor_views SET bot_score = 70 WHERE date(created_at) = ?",
    YESTERDAY,
  );

  await rollupDay(db, YESTERDAY);
  const after = await db.queryOne<{ visits: number }>(
    "SELECT COALESCE(SUM(visits), 0) AS visits FROM visitor_views_daily WHERE date = ?",
    YESTERDAY,
  );
  assertEquals(after?.visits, 0);
  await db.close();
});

Deno.test("rollupDay — re-rollup of one date leaves other dates untouched", async () => {
  const db = createTestDb();
  const otherDate = "2024-01-01";
  await insertView(db, {
    visitor_id: "keep",
    created_at: `${otherDate}T10:00:00.000Z`,
  });
  await insertView(db, {
    visitor_id: "v1",
    created_at: `${YESTERDAY}T12:00:00.000Z`,
  });

  await rollupDay(db, otherDate);
  await rollupDay(db, YESTERDAY);
  // Re-rollup YESTERDAY only; otherDate's row must survive.
  await rollupDay(db, YESTERDAY);

  const other = await db.queryOne<{ visits: number }>(
    "SELECT COALESCE(SUM(visits), 0) AS visits FROM visitor_views_daily WHERE date = ?",
    otherDate,
  );
  assertEquals(other?.visits, 1);
  await db.close();
});

Deno.test("rollupDay — groups by device_type and country_code", async () => {
  const db = createTestDb();
  const ts = `${YESTERDAY}T12:00:00.000Z`;
  await insertView(db, {
    visitor_id: "v1",
    device_type: "desktop",
    country_code: "NO",
    created_at: ts,
  });
  await insertView(db, {
    visitor_id: "v2",
    device_type: "mobile",
    country_code: "US",
    created_at: ts,
  });

  await rollupDay(db, YESTERDAY);

  const rows = await db.query(
    "SELECT * FROM visitor_views_daily WHERE date = ?",
    YESTERDAY,
  );
  assertEquals(rows.length, 2);
  await db.close();
});

// ── purgeExpiredData ────────────────────────────────────────────────────────

Deno.test("purgeExpiredData — removes old views and events", async () => {
  const db = createTestDb();
  const oldDate = "2020-01-01T00:00:00.000Z";
  const recentDate = new Date().toISOString();

  await insertView(db, { visitor_id: "old", created_at: oldDate });
  await insertView(db, { visitor_id: "recent", created_at: recentDate });
  await insertEvent(db, { visitor_id: "old-event", created_at: oldDate });
  await insertEvent(db, { visitor_id: "recent-event", created_at: recentDate });

  const result = await purgeExpiredData(db, 90);
  assertEquals(result.views_deleted, 1);
  assertEquals(result.events_deleted, 1);

  // Recent data should still exist
  const views = await db.query("SELECT * FROM visitor_views");
  assertEquals(views.length, 1);
  const events = await db.query("SELECT * FROM semantic_events");
  assertEquals(events.length, 1);
  await db.close();
});

Deno.test("purgeExpiredData — respects custom retention days", async () => {
  const db = createTestDb();
  // 10 days ago
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - 10);
  const tenDaysAgo = d.toISOString();

  await insertView(db, { visitor_id: "10-days", created_at: tenDaysAgo });

  // With 30-day retention, should NOT delete
  const r1 = await purgeExpiredData(db, 30);
  assertEquals(r1.views_deleted, 0);

  // With 5-day retention, should delete
  const r2 = await purgeExpiredData(db, 5);
  assertEquals(r2.views_deleted, 1);
  await db.close();
});

Deno.test("purgeExpiredData — purges old daily rollups", async () => {
  const db = createTestDb();
  // Insert a very old rollup (> 2 years)
  await db.run(
    `INSERT INTO visitor_views_daily (site_id, date, visits, unique_visitors)
     VALUES (?, ?, ?, ?)`,
    "test",
    "2020-01-01",
    100,
    80,
  );
  // Insert a recent rollup
  await db.run(
    `INSERT INTO visitor_views_daily (site_id, date, visits, unique_visitors)
     VALUES (?, ?, ?, ?)`,
    "test",
    YESTERDAY,
    50,
    40,
  );

  const result = await purgeExpiredData(db);
  assertEquals(result.daily_deleted, 1);

  const remaining = await db.query("SELECT * FROM visitor_views_daily");
  assertEquals(remaining.length, 1);
  await db.close();
});

Deno.test("purgeExpiredData — re-rolls a date from corrected raw rows before purging it", async () => {
  const db = createTestDb();
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - 100);
  const date = d.toISOString().slice(0, 10);

  await insertView(db, {
    visitor_id: "human-1",
    created_at: `${date}T10:00:00.000Z`,
  });
  await insertView(db, {
    visitor_id: "later-bot",
    created_at: `${date}T11:00:00.000Z`,
  });
  await rollupDay(db, date);

  // After the nightly rollup, the correlator reclassifies one visitor — the
  // stored aggregate is now stale.
  await db.run(
    `UPDATE visitor_views SET bot_score = 80 WHERE visitor_id = 'later-bot'`,
  );

  await purgeExpiredData(db, 90);

  const agg = await db.queryOne<{ visits: number }>(
    `SELECT SUM(visits) AS visits FROM visitor_views_daily WHERE date = ?`,
    date,
  );
  assertEquals(agg?.visits, 1);
  const raw = await db.queryOne<{ n: number }>(
    `SELECT COUNT(*) AS n FROM visitor_views WHERE bot_score BETWEEN 0 AND 49`,
  );
  assertEquals(raw?.n, 0);
  await db.close();
});

Deno.test("purgeExpiredData — lingering bot rows do not wipe a finalized aggregate", async () => {
  const db = createTestDb();
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - 100);
  const date = d.toISOString().slice(0, 10);

  await insertView(db, {
    visitor_id: "human-1",
    created_at: `${date}T10:00:00.000Z`,
  });
  await insertView(db, {
    visitor_id: "bot-1",
    bot_score: 80,
    created_at: `${date}T10:30:00.000Z`,
  });
  // Clean rows purged at 90 days, bot rows kept for 365.
  await purgeExpiredData(db, 90, 365);
  await purgeExpiredData(db, 90, 365);

  const agg = await db.queryOne<{ visits: number }>(
    `SELECT SUM(visits) AS visits FROM visitor_views_daily WHERE date = ?`,
    date,
  );
  assertEquals(agg?.visits, 1);
  await db.close();
});

Deno.test("purgeExpiredData — empty DB returns all zeros", async () => {
  const db = createTestDb();
  const result = await purgeExpiredData(db);
  assertEquals(result.views_deleted, 0);
  assertEquals(result.events_deleted, 0);
  assertEquals(result.daily_deleted, 0);
  assertEquals(result.perf_deleted, 0);
  await db.close();
});

Deno.test("purgeExpiredData — deletes more rows than one purge batch", async () => {
  const db = createTestDb();
  await db.exec(`
    WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 12001)
    INSERT INTO visitor_views (visitor_id, path, site_id, is_returning, referrer_type, bot_score, is_pwa, created_at)
    SELECT 'v' || i, '/', 's', 0, 'direct', 0, 0, '2020-01-01T00:00:00.000Z' FROM n;
  `);
  const result = await purgeExpiredData(db, 90);
  assertEquals(result.views_deleted, 12001);
  await db.close();
});

Deno.test("purgeAutoExclusions — removes old automatic exclusions only", async () => {
  const db = createTestDb();
  const now = Date.parse("2026-10-09T03:00:00.000Z");
  const old = new Date(now - 31 * 86_400_000).toISOString();
  const recent = new Date(now - 5 * 86_400_000).toISOString();
  await db.run(
    "INSERT INTO excluded_visitors (visitor_id, label, created_at) VALUES (?,?,?),(?,?,?),(?,?,?),(?,?,?)",
    "auto-old",
    "auto:burst_cohort",
    old,
    "auto-recent",
    "auto:session_velocity",
    recent,
    "manual-old",
    "office",
    old,
    "null-old",
    null,
    old,
  );
  assertEquals(await purgeAutoExclusions(db, now), 1);
  const left = await db.query<{ visitor_id: string }>(
    "SELECT visitor_id FROM excluded_visitors ORDER BY visitor_id",
  );
  assertEquals(left.map((r) => r.visitor_id), [
    "auto-recent",
    "manual-old",
    "null-old",
  ]);
  await db.close();
});
