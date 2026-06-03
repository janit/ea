import { assertEquals, assertGreater } from "@std/assert";
import { purgeExpiredData, rollupDay } from "@/lib/maintenance.ts";
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

Deno.test("purgeExpiredData — empty DB returns all zeros", async () => {
  const db = createTestDb();
  const result = await purgeExpiredData(db);
  assertEquals(result.views_deleted, 0);
  assertEquals(result.events_deleted, 0);
  assertEquals(result.daily_deleted, 0);
  assertEquals(result.perf_deleted, 0);
  await db.close();
});
