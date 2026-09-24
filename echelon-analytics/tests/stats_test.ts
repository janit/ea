import { assertEquals } from "@std/assert";
import {
  getCampaignDetail,
  getCampaignStats,
  getDashboardLive,
  getExperimentStats,
  getOverview,
  getRealtime,
} from "@/lib/stats.ts";
import { rollupDay } from "@/lib/maintenance.ts";
import {
  createTestDb,
  insertDailyRollup,
  insertEvent,
  insertView,
  TODAY,
  YESTERDAY,
} from "./_helpers.ts";

// ── getOverview ─────────────────────────────────────────────────────────────

// NOTE: getOverview serves windows inside raw retention (<= RETENTION_DAYS,
// default 90) from visitor_views directly — that is the only source where
// yesterday is visible before the 03:00 UTC rollup runs, and the only one
// where distinct visitor counts are exact. The rollup table is used for
// windows that reach past retention, so the rollup-path tests below ask for
// 365 days.
const BEYOND_RETENTION = 365;

// Dates whose raw rows would already be purged — the only dates the rollup
// path reads from visitor_views_daily.
function purgedDate(daysAgo: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - daysAgo);
  return d.toISOString().slice(0, 10);
}
const OLD = purgedDate(200);
const OLDER = purgedDate(201);

Deno.test("getOverview — empty DB returns zeros", async () => {
  const db = createTestDb();
  const result = await getOverview(db, "test-site", 30);
  assertEquals(result.site_id, "test-site");
  assertEquals(result.visits, 0);
  assertEquals(result.unique_visitors, 0);
  assertEquals(result.top_paths.length, 0);
  assertEquals(result.devices.length, 0);
  assertEquals(result.countries.length, 0);
  await db.close();
});

Deno.test("getOverview — rollup for purged dates + raw for retained dates", async () => {
  const db = createTestDb();
  await insertDailyRollup(db, {
    site_id: "test-site",
    date: OLD,
    visits: 50,
    unique_visitors: 40,
  });
  // Raw views today and yesterday — yesterday has no rollup yet.
  await insertView(db, { site_id: "test-site", visitor_id: "today-1" });
  await insertView(db, {
    site_id: "test-site",
    visitor_id: "yday-1",
    created_at: `${YESTERDAY}T12:00:00.000Z`,
  });

  const result = await getOverview(db, "test-site", BEYOND_RETENTION);
  assertEquals(result.visits, 52);
  assertEquals(result.daily_trend.map((d) => d.date), [OLD, YESTERDAY, TODAY]);
  await db.close();
});

Deno.test("getOverview — filters by site_id", async () => {
  const db = createTestDb();
  await insertDailyRollup(db, { site_id: "site-a", date: OLD, visits: 100 });
  await insertDailyRollup(db, { site_id: "site-b", date: OLD, visits: 200 });

  const result = await getOverview(db, "site-a", BEYOND_RETENTION);
  assertEquals(result.visits, 100);
  assertEquals(result.site_id, "site-a");
  await db.close();
});

Deno.test("getOverview — devices breakdown merges rollup and raw", async () => {
  const db = createTestDb();
  await insertDailyRollup(db, {
    date: OLD,
    device_type: "desktop",
    visits: 60,
  });
  await insertDailyRollup(db, { date: OLD, device_type: "mobile", visits: 40 });
  await insertView(db, { visitor_id: "raw-1", device_type: "mobile" });

  const result = await getOverview(db, "test-site", BEYOND_RETENTION);
  assertEquals(result.devices, [
    { device_type: "desktop", visits: 60 },
    { device_type: "mobile", visits: 41 },
  ]);
  await db.close();
});

Deno.test("getOverview — excludes bot views from today's count", async () => {
  const db = createTestDb();
  await insertView(db, { bot_score: 0, visitor_id: "human" });
  await insertView(db, { bot_score: 80, visitor_id: "bot" });

  const result = await getOverview(db, "test-site", 30);
  // Bot views (score >= 50) should be excluded from today count
  assertEquals(result.visits, 1);
  await db.close();
});

Deno.test("getOverview — rollup rows for dates still in raw retention are ignored", async () => {
  // Raw rows are authoritative while they exist: a rollup computed before a
  // later correlator/exclusion correction (or a stray today row from a
  // manual re-roll) must not be served alongside or instead of them.
  const db = createTestDb();
  await insertDailyRollup(db, { date: OLD, visits: 5, unique_visitors: 5 });
  await insertDailyRollup(db, { date: YESTERDAY, visits: 999 });
  await insertDailyRollup(db, { date: TODAY, visits: 999 });
  await insertView(db, { visitor_id: "today-1" });

  const result = await getOverview(db, "test-site", BEYOND_RETENTION);
  assertEquals(result.visits, 6);
  assertEquals(result.devices.reduce((n, d) => n + d.visits, 0), 6);
  assertEquals(result.daily_trend.map((d) => [d.date, d.visits]), [
    [OLD, 5],
    [TODAY, 1],
  ]);
  await db.close();
});

Deno.test("getOverview — beyond retention, excluded visitors are not counted in raw days", async () => {
  const db = createTestDb();
  await insertView(db, { visitor_id: "excluded-1" });
  await insertView(db, { visitor_id: "kept-1" });
  await db.run(
    `INSERT INTO excluded_visitors (visitor_id) VALUES ('excluded-1')`,
  );

  const result = await getOverview(db, "test-site", BEYOND_RETENTION);
  assertEquals(result.visits, 1);
  assertEquals(result.unique_visitors, 1);
  await db.close();
});

Deno.test("getOverview — beyond retention agrees with the raw window for retained days", async () => {
  const db = createTestDb();
  for (let i = 0; i < 5; i++) {
    await insertView(db, {
      visitor_id: `yday-${i}`,
      created_at: `${YESTERDAY}T12:00:0${i}.000Z`,
    });
  }
  const long = await getOverview(db, "test-site", BEYOND_RETENTION);
  const short = await getOverview(db, "test-site", 30);
  assertEquals(long.visits, short.visits);
  assertEquals(long.visits, 5);
  await db.close();
});

Deno.test("getOverview — avg_interaction_ms is visit-weighted, not mean-of-means", async () => {
  const db = createTestDb();
  // 1 visit @ 1000ms and 99 visits @ 100ms → weighted mean = 109, not 550.
  await insertDailyRollup(db, {
    date: OLD,
    device_type: "desktop",
    visits: 1,
    avg_interaction_ms: 1000,
  });
  await insertDailyRollup(db, {
    date: OLDER,
    device_type: "mobile",
    visits: 99,
    avg_interaction_ms: 100,
  });

  const result = await getOverview(db, "test-site", BEYOND_RETENTION);
  assertEquals(result.avg_interaction_ms, 109);
  await db.close();
});

Deno.test("getOverview — unique_visitors dedups a visitor active across multiple days", async () => {
  const db = createTestDb();
  // alice visits yesterday (rolled up) and again today (raw). She is ONE person.
  await insertView(db, {
    visitor_id: "alice",
    created_at: `${YESTERDAY}T10:00:00.000Z`,
  });
  await rollupDay(db, YESTERDAY);
  await insertView(db, {
    visitor_id: "alice",
    created_at: new Date().toISOString(),
  });

  const result = await getOverview(db, "test-site", 30);
  assertEquals(result.unique_visitors, 1);
  await db.close();
});

Deno.test("getOverview — unique_visitors counts a visitor split across device buckets once", async () => {
  const db = createTestDb();
  // bob has views in two device buckets the same day → still ONE unique visitor.
  await insertView(db, {
    visitor_id: "bob",
    device_type: "desktop",
    created_at: `${YESTERDAY}T09:00:00.000Z`,
  });
  await insertView(db, {
    visitor_id: "bob",
    device_type: "mobile",
    created_at: `${YESTERDAY}T11:00:00.000Z`,
  });
  await rollupDay(db, YESTERDAY);

  const result = await getOverview(db, "test-site", 30);
  assertEquals(result.unique_visitors, 1);
  await db.close();
});

// ── getRealtime ─────────────────────────────────────────────────────────────

Deno.test("getRealtime — empty DB returns zeros", async () => {
  const db = createTestDb();
  const result = await getRealtime(db, "test-site");
  assertEquals(result.active_visitors, 0);
  assertEquals(result.pageviews, 0);
  assertEquals(result.active_paths.length, 0);
  await db.close();
});

Deno.test("getRealtime — counts recent views", async () => {
  const db = createTestDb();
  const now = new Date().toISOString();
  await insertView(db, { visitor_id: "rt-1", created_at: now });
  await insertView(db, { visitor_id: "rt-2", created_at: now });

  const result = await getRealtime(db, "test-site");
  assertEquals(result.active_visitors, 2);
  assertEquals(result.pageviews, 2);
  await db.close();
});

Deno.test("getRealtime — excludes bots", async () => {
  const db = createTestDb();
  const now = new Date().toISOString();
  await insertView(db, { visitor_id: "human", bot_score: 0, created_at: now });
  await insertView(db, { visitor_id: "bot", bot_score: 60, created_at: now });

  const result = await getRealtime(db, "test-site");
  assertEquals(result.active_visitors, 1);
  await db.close();
});

// ── getCampaignStats ────────────────────────────────────────────────────────

Deno.test("getCampaignStats — empty DB returns empty array", async () => {
  const db = createTestDb();
  const result = await getCampaignStats(db);
  assertEquals(result.length, 0);
  await db.close();
});

Deno.test("getCampaignStats — returns campaign with view counts", async () => {
  const db = createTestDb();
  await db.run(
    `INSERT INTO utm_campaigns (id, name, utm_campaign, site_id) VALUES (?, ?, ?, ?)`,
    "camp-1",
    "Spring Sale",
    "spring-sale",
    "test-site",
  );
  await insertView(db, { utm_campaign: "spring-sale" });
  await insertView(db, { utm_campaign: "spring-sale" });

  const result = await getCampaignStats(db);
  assertEquals(result.length, 1);
  assertEquals(result[0].name, "Spring Sale");
  assertEquals(result[0].views, 2);
  await db.close();
});

// ── getCampaignDetail ───────────────────────────────────────────────────────

Deno.test("getCampaignDetail — returns breakdowns", async () => {
  const db = createTestDb();
  await insertView(db, {
    utm_campaign: "test-camp",
    utm_source: "google",
    utm_medium: "cpc",
  });

  const result = await getCampaignDetail(db, "test-camp", "test-site", 30);
  assertEquals(typeof result.bySource, "object");
  assertEquals(typeof result.byMedium, "object");
  assertEquals(typeof result.dailyTrend, "object");
  assertEquals(typeof result.topPaths, "object");
  await db.close();
});

// ── getExperimentStats ──────────────────────────────────────────────────────

Deno.test("getExperimentStats — empty DB returns empty array", async () => {
  const db = createTestDb();
  const result = await getExperimentStats(db);
  assertEquals(result.length, 0);
  await db.close();
});

Deno.test("getExperimentStats — returns experiment with variants", async () => {
  const db = createTestDb();
  await db.run(
    `INSERT INTO experiments (experiment_id, name, status, metric_event_type)
     VALUES (?, ?, ?, ?)`,
    "exp-1",
    "Button Color Test",
    "active",
    "click",
  );
  await db.run(
    `INSERT INTO experiment_variants (experiment_id, variant_id, name, weight, is_control)
     VALUES (?, ?, ?, ?, ?)`,
    "exp-1",
    "control",
    "Blue Button",
    50,
    1,
  );
  await db.run(
    `INSERT INTO experiment_variants (experiment_id, variant_id, name, weight, is_control)
     VALUES (?, ?, ?, ?, ?)`,
    "exp-1",
    "variant-a",
    "Red Button",
    50,
    0,
  );

  const result = await getExperimentStats(db);
  assertEquals(result.length, 1);
  assertEquals(result[0].name, "Button Color Test");
  assertEquals(result[0].variants.length, 2);
  await db.close();
});

Deno.test("getExperimentStats — computes conversion rates", async () => {
  const db = createTestDb();
  await db.run(
    `INSERT INTO experiments (experiment_id, name, status, metric_event_type)
     VALUES (?, ?, ?, ?)`,
    "exp-2",
    "CTA Test",
    "active",
    "form_submit",
  );
  await db.run(
    `INSERT INTO experiment_variants (experiment_id, variant_id, name, weight, is_control)
     VALUES (?, ?, ?, ?, ?)`,
    "exp-2",
    "control",
    "Original",
    50,
    1,
  );
  await db.run(
    `INSERT INTO experiment_variants (experiment_id, variant_id, name, weight, is_control)
     VALUES (?, ?, ?, ?, ?)`,
    "exp-2",
    "variant-b",
    "New CTA",
    50,
    0,
  );

  // Insert some events for the experiment
  for (let i = 0; i < 5; i++) {
    await insertEvent(db, {
      event_type: "click",
      experiment_id: "exp-2",
      variant_id: "control",
      session_id: `session-ctrl-${i}`,
    });
  }
  await insertEvent(db, {
    event_type: "form_submit",
    experiment_id: "exp-2",
    variant_id: "control",
    session_id: "session-ctrl-0",
  });

  const result = await getExperimentStats(db);
  assertEquals(result.length, 1);
  const control = result[0].variants.find((v) => v.is_control);
  assertEquals(control !== undefined, true);
  assertEquals(control!.impressions, 5);
  assertEquals(control!.conversions, 1);
  await db.close();
});

// ── getDashboardLive ────────────────────────────────────────────────────────

Deno.test("getDashboardLive — empty DB returns zeros", async () => {
  const db = createTestDb();
  const result = await getDashboardLive(db, "test-site");
  assertEquals(result.now.activeVisitors, 0);
  assertEquals(result.now.estimatedBots, 0);
  assertEquals(result.now.pageviews, 0);
  assertEquals(result.recentVisitors.length, 0);
  assertEquals(result.recentEvents.length, 0);
  await db.close();
});

Deno.test("getDashboardLive — counts recent visitors and bots", async () => {
  const db = createTestDb();
  const now = new Date().toISOString();
  await insertView(db, {
    visitor_id: "human-1",
    bot_score: 0,
    created_at: now,
  });
  await insertView(db, {
    visitor_id: "human-2",
    bot_score: 10,
    created_at: now,
  });
  await insertView(db, { visitor_id: "bot-1", bot_score: 70, created_at: now });

  const result = await getDashboardLive(db, "test-site");
  assertEquals(result.now.activeVisitors, 2);
  assertEquals(result.now.estimatedBots, 1);
  assertEquals(result.now.pageviews, 2);
  await db.close();
});

// ── getOverview: raw-path correctness (adversarial regressions) ─────────────

Deno.test("getOverview — yesterday is visible before the rollup runs", async () => {
  // Regression: the headline was rollup(date < today) + today's raw, so
  // yesterday belonged to neither source until 03:00 UTC — a full day of
  // traffic reported as zero every night, and all day if the rollup failed.
  const db = createTestDb();
  for (let i = 0; i < 10; i++) {
    await insertView(db, {
      site_id: "test-site",
      visitor_id: `y${i}`.padEnd(16, "0"),
      created_at: `${YESTERDAY}T12:00:00.000Z`,
    });
  }
  // Deliberately no rollup row for YESTERDAY.
  const result = await getOverview(db, "test-site", 30);
  assertEquals(result.visits, 10);
  assertEquals(result.unique_visitors, 10);
  await db.close();
});

Deno.test("getOverview — country/daily visitor counts are not double-counted", async () => {
  // Regression: breakdowns summed unique_visitors across rollup buckets.
  // beacon.ts sets is_returning=0 on a visitor's first view of the day and 1
  // on every later one, so anyone viewing two pages landed in two buckets and
  // was counted twice — contradicting the headline, which was already exact.
  const db = createTestDb();
  for (const path of ["/a", "/b", "/c"]) {
    await insertView(db, {
      site_id: "test-site",
      visitor_id: "onevisitor00001",
      country_code: "FI",
      path,
      created_at: `${YESTERDAY}T12:00:00.000Z`,
    });
  }

  const result = await getOverview(db, "test-site", 30);
  assertEquals(result.unique_visitors, 1);
  assertEquals(result.countries[0].country_code, "FI");
  assertEquals(result.countries[0].visitors, 1, "one person, counted once");
  assertEquals(result.countries[0].visits, 3);
  const day = result.daily_trend.find((d) => d.date === YESTERDAY);
  assertEquals(day?.visitors, 1, "one person, counted once");
  await db.close();
});

Deno.test("getOverview — excluded visitors are filtered from raw figures", async () => {
  // Regression: rollupDay() applies NOT EXISTS (excluded_visitors) but the raw
  // queries did not, so excluding a visitor removed them from history while
  // they kept appearing in every live figure.
  const db = createTestDb();
  await insertView(db, {
    site_id: "test-site",
    visitor_id: "keepme000000001",
    country_code: "FI",
    created_at: `${YESTERDAY}T12:00:00.000Z`,
  });
  await insertView(db, {
    site_id: "test-site",
    visitor_id: "excluded0000001",
    country_code: "FI",
    created_at: `${YESTERDAY}T12:00:00.000Z`,
  });
  await db.run(
    "INSERT INTO excluded_visitors (visitor_id) VALUES (?)",
    "excluded0000001",
  );

  const result = await getOverview(db, "test-site", 30);
  assertEquals(result.visits, 1);
  assertEquals(result.unique_visitors, 1);
  assertEquals(result.countries[0].visitors, 1);
  await db.close();
});
