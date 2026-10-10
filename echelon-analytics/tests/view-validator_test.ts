import { assertEquals } from "@std/assert";
import { validateViews, validatorSql } from "@/lib/view-validator.ts";
import { createTestDb, insertEvent, insertView } from "./_helpers.ts";
import type { DbAdapter } from "@/lib/db/adapter.ts";

const NOW = Date.parse("2026-10-09T12:00:00.000Z");
const at = (secAgo: number) => new Date(NOW - secAgo * 1000).toISOString();
const SITE = "vv-site";

async function validated(db: DbAdapter, visitor: string): Promise<number> {
  const row = await db.queryOne<{ validated: number }>(
    "SELECT validated FROM visitor_views WHERE visitor_id = ?",
    visitor,
  );
  return row?.validated ?? -1;
}

Deno.test("validator — engage plus a real dwell validates the view", async () => {
  const db = createTestDb();
  await insertView(db, {
    visitor_id: "v1",
    site_id: SITE,
    session_id: "s1",
    created_at: at(120),
  });
  await insertEvent(db, {
    event_type: "engage",
    site_id: SITE,
    session_id: "s1",
    visitor_id: "v1",
    created_at: at(121),
  });
  await insertEvent(db, {
    event_type: "session_end",
    site_id: SITE,
    session_id: "s1",
    visitor_id: "v1",
    data: '{"dwell_s":14,"path":"/"}',
    created_at: at(100),
  });
  assertEquals(await validateViews(db, NOW), 1);
  assertEquals(await validated(db, "v1"), 1);
  await db.close();
});

Deno.test("validator — passive events alone validate nothing", async () => {
  const db = createTestDb();
  await insertView(db, {
    visitor_id: "v2",
    site_id: SITE,
    session_id: "s2",
    created_at: at(120),
  });
  for (const t of ["bounce", "web_vital", "scroll_depth", "custom"]) {
    await insertEvent(db, {
      event_type: t,
      site_id: SITE,
      session_id: "s2",
      visitor_id: "v2",
      created_at: at(110),
    });
  }
  await insertEvent(db, {
    event_type: "session_end",
    site_id: SITE,
    session_id: "s2",
    visitor_id: "v2",
    data: '{"dwell_s":60}',
    created_at: at(60),
  });
  assertEquals(await validateViews(db, NOW), 0);
  assertEquals(await validated(db, "v2"), 0);
  await db.close();
});

Deno.test("validator — an interaction with no liveness evidence does not validate", async () => {
  const db = createTestDb();
  await insertView(db, {
    visitor_id: "v3",
    site_id: SITE,
    session_id: "s3",
    created_at: at(120),
  });
  // One gesture at load time, then the page is killed: no session_end.
  await insertEvent(db, {
    event_type: "engage",
    site_id: SITE,
    session_id: "s3",
    visitor_id: "v3",
    created_at: at(120),
  });
  assertEquals(await validateViews(db, NOW), 0);
  await db.close();
});

Deno.test("validator — a dwell under 2 seconds is not liveness", async () => {
  const db = createTestDb();
  await insertView(db, {
    visitor_id: "v4",
    site_id: SITE,
    session_id: "s4",
    created_at: at(120),
  });
  await insertEvent(db, {
    event_type: "engage",
    site_id: SITE,
    session_id: "s4",
    visitor_id: "v4",
    created_at: at(120),
  });
  await insertEvent(db, {
    event_type: "session_end",
    site_id: SITE,
    session_id: "s4",
    visitor_id: "v4",
    data: '{"dwell_s":1}',
    created_at: at(119),
  });
  assertEquals(await validateViews(db, NOW), 0);
  await db.close();
});

Deno.test("validator — a late interaction plus a second interaction type validates without dwell", async () => {
  const db = createTestDb();
  await insertView(db, {
    visitor_id: "v5",
    site_id: SITE,
    session_id: "s5",
    created_at: at(120),
  });
  await insertEvent(db, {
    event_type: "engage",
    site_id: SITE,
    session_id: "s5",
    visitor_id: "v5",
    created_at: at(120),
  });
  await insertEvent(db, {
    event_type: "outbound",
    site_id: SITE,
    session_id: "s5",
    visitor_id: "v5",
    created_at: at(90), // 30 s after the view
  });
  assertEquals(await validateViews(db, NOW), 1);
  await db.close();
});

Deno.test("validator — one late interaction of a single type is not enough", async () => {
  const db = createTestDb();
  await insertView(db, {
    visitor_id: "v6",
    site_id: SITE,
    session_id: "s6",
    created_at: at(120),
  });
  await insertEvent(db, {
    event_type: "click",
    site_id: SITE,
    session_id: "s6",
    visitor_id: "v6",
    created_at: at(90),
  });
  assertEquals(await validateViews(db, NOW), 0);
  await db.close();
});

Deno.test("validator — a view scored as a bot is never validated", async () => {
  const db = createTestDb();
  await insertView(db, {
    visitor_id: "v7",
    site_id: SITE,
    session_id: "s7",
    bot_score: 50,
    created_at: at(120),
  });
  await insertEvent(db, {
    event_type: "engage",
    site_id: SITE,
    session_id: "s7",
    visitor_id: "v7",
    created_at: at(120),
  });
  await insertEvent(db, {
    event_type: "session_end",
    site_id: SITE,
    session_id: "s7",
    visitor_id: "v7",
    data: '{"dwell_s":20}',
    created_at: at(100),
  });
  assertEquals(await validateViews(db, NOW), 0);
  await db.close();
});

Deno.test("validator — a forged engage from a bot-scored request validates nothing", async () => {
  const db = createTestDb();
  await insertView(db, {
    visitor_id: "v8",
    site_id: SITE,
    session_id: "s8",
    created_at: at(120),
  });
  await insertEvent(db, {
    event_type: "engage",
    site_id: SITE,
    session_id: "s8",
    visitor_id: "v8",
    bot_score: 65,
    created_at: at(120),
  });
  await insertEvent(db, {
    event_type: "session_end",
    site_id: SITE,
    session_id: "s8",
    visitor_id: "v8",
    data: '{"dwell_s":20}',
    created_at: at(100),
  });
  assertEquals(await validateViews(db, NOW), 0);
  await db.close();
});

Deno.test("validator — events on another site do not validate", async () => {
  const db = createTestDb();
  await insertView(db, {
    visitor_id: "v9",
    site_id: SITE,
    session_id: "s9",
    created_at: at(120),
  });
  await insertEvent(db, {
    event_type: "engage",
    site_id: "other-site",
    session_id: "s9",
    visitor_id: "v9",
    created_at: at(120),
  });
  await insertEvent(db, {
    event_type: "session_end",
    site_id: "other-site",
    session_id: "s9",
    visitor_id: "v9",
    data: '{"dwell_s":20}',
    created_at: at(100),
  });
  assertEquals(await validateViews(db, NOW), 0);
  await db.close();
});

Deno.test("validator — no session id: falls back to the visitor id", async () => {
  const db = createTestDb();
  await insertView(db, {
    visitor_id: "v10",
    site_id: SITE,
    session_id: null,
    created_at: at(120),
  });
  await insertEvent(db, {
    event_type: "engage",
    site_id: SITE,
    session_id: null,
    visitor_id: "v10",
    created_at: at(120),
  });
  await insertEvent(db, {
    event_type: "session_end",
    site_id: SITE,
    session_id: null,
    visitor_id: "v10",
    data: '{"dwell_s":9}',
    created_at: at(100),
  });
  assertEquals(await validateViews(db, NOW), 1);
  await db.close();
});

Deno.test("validator — no session id: events that belong to a session do not match", async () => {
  const db = createTestDb();
  await insertView(db, {
    visitor_id: "v11",
    site_id: SITE,
    session_id: null,
    created_at: at(120),
  });
  await insertEvent(db, {
    event_type: "engage",
    site_id: SITE,
    session_id: "someone-else",
    visitor_id: "v11",
    created_at: at(120),
  });
  await insertEvent(db, {
    event_type: "session_end",
    site_id: SITE,
    session_id: "someone-else",
    visitor_id: "v11",
    data: '{"dwell_s":9}',
    created_at: at(100),
  });
  assertEquals(await validateViews(db, NOW), 0);
  await db.close();
});

Deno.test("validator — views older than the 15 minute lookback are left alone", async () => {
  const db = createTestDb();
  await insertView(db, {
    visitor_id: "v12",
    site_id: SITE,
    session_id: "s12",
    created_at: at(16 * 60),
  });
  await insertEvent(db, {
    event_type: "engage",
    site_id: SITE,
    session_id: "s12",
    visitor_id: "v12",
    created_at: at(60),
  });
  await insertEvent(db, {
    event_type: "session_end",
    site_id: SITE,
    session_id: "s12",
    visitor_id: "v12",
    data: '{"dwell_s":20}',
    created_at: at(50),
  });
  assertEquals(await validateViews(db, NOW), 0);
  await db.close();
});

Deno.test("validator — malformed event data is skipped, not thrown on", async () => {
  const db = createTestDb();
  await insertView(db, {
    visitor_id: "v13",
    site_id: SITE,
    session_id: "s13",
    created_at: at(120),
  });
  await insertEvent(db, {
    event_type: "engage",
    site_id: SITE,
    session_id: "s13",
    visitor_id: "v13",
    created_at: at(120),
  });
  for (const data of [null, "", "not json", '{"dwell_s":"soon"}', "[]"]) {
    await insertEvent(db, {
      event_type: "session_end",
      site_id: SITE,
      session_id: "s13",
      visitor_id: "v13",
      data,
      created_at: at(100),
    });
  }
  assertEquals(await validateViews(db, NOW), 0);
  await db.close();
});

Deno.test("validator — idempotent: a second run changes nothing", async () => {
  const db = createTestDb();
  await insertView(db, {
    visitor_id: "v14",
    site_id: SITE,
    session_id: "s14",
    created_at: at(120),
  });
  await insertEvent(db, {
    event_type: "engage",
    site_id: SITE,
    session_id: "s14",
    visitor_id: "v14",
    created_at: at(120),
  });
  await insertEvent(db, {
    event_type: "session_end",
    site_id: SITE,
    session_id: "s14",
    visitor_id: "v14",
    data: '{"dwell_s":20}',
    created_at: at(100),
  });
  assertEquals(await validateViews(db, NOW), 1);
  assertEquals(await validateViews(db, NOW), 0);
  await db.close();
});

// ── Cost ────────────────────────────────────────────────────────────────────
//
// node:sqlite is synchronous and this runs every minute, so a run may read
// each event inside the lookback once and each fresh view once, and nothing
// else: never "the other rows with this view's key", which one client can
// make as long as it likes and which keeps 90 days of history.

const CUTOFF = "'2026-10-09T11:45:00.000Z'";

async function planOf(db: DbAdapter, sql: string): Promise<string[]> {
  return (await db.query<{ detail: string }>(`EXPLAIN QUERY PLAN ${sql}`))
    .map((r) => r.detail);
}

Deno.test("validator — events are read once, by time, and views are matched to the summary by its key", async () => {
  const db = createTestDb();
  const sql = validatorSql(CUTOFF);
  await db.exec(sql.create);

  const collect = await planOf(db, sql.collect);
  assertEquals(
    collect.filter((d) => /^(SEARCH|SCAN)/.test(d)),
    [
      "SEARCH semantic_events USING INDEX idx_se_created_bot (created_at>?)",
    ],
    collect.join("\n"),
  );

  const validate = await planOf(db, sql.validate);
  assertEquals(
    validate.filter((d) => /^(SEARCH|SCAN)/.test(d)),
    [
      "SEARCH visitor_views USING INDEX idx_vv_created_bot (created_at>?)",
      "SEARCH p USING PRIMARY KEY (id=? AND pass=? AND site_id=?)",
    ],
    validate.join("\n"),
  );
  await db.close();
});

Deno.test("validator — no statement looks events up per view", () => {
  // The hot-key guarantee: semantic_events appears in exactly one statement,
  // once, bounded by the cutoff, and that statement never reads views. A
  // per-view lookup of events would have to appear in `validate`.
  const sql = validatorSql(CUTOFF);
  const count = (text: string, word: string) => text.split(word).length - 1;
  assertEquals(count(sql.collect, "FROM semantic_events"), 1);
  assertEquals(count(sql.collect, "visitor_views"), 0);
  assertEquals(sql.collect.includes(`created_at >= ${CUTOFF}`), true);
  assertEquals(count(sql.validate, "semantic_events"), 0);
  assertEquals(count(sql.clear, "semantic_events"), 0);
});

Deno.test("validator — a hot session with a long history is judged view by view", async () => {
  const db = createTestDb();
  const HOT = 150;
  // History outside the lookback: gestures of two types and real dwells.
  // None of it may count, however much there is.
  for (let i = 0; i < HOT; i++) {
    await insertEvent(db, {
      event_type: i % 2 ? "click" : "ad_click",
      site_id: SITE,
      session_id: "hot",
      visitor_id: "hv",
      created_at: at(16 * 60 + i),
    });
    await insertEvent(db, {
      event_type: "session_end",
      site_id: SITE,
      session_id: "hot",
      visitor_id: "hv",
      data: '{"dwell_s":30}',
      created_at: at(16 * 60 + i),
    });
  }
  // Inside the lookback: many short dwells, bot-scored gestures, and one
  // clean gesture type. Views every 5 s from 700 s ago to 5 s ago.
  for (let i = 0; i < HOT; i++) {
    await insertEvent(db, {
      event_type: "session_end",
      site_id: SITE,
      session_id: "hot",
      visitor_id: "hv",
      data: '{"dwell_s":1}',
      created_at: at(i * 5),
    });
    await insertEvent(db, {
      event_type: "outbound",
      site_id: SITE,
      session_id: "hot",
      visitor_id: "hv",
      bot_score: 60,
      created_at: at(i * 5),
    });
  }
  for (let i = 1; i <= 140; i++) {
    await insertView(db, {
      visitor_id: `hv${i}`,
      site_id: SITE,
      session_id: "hot",
      created_at: at(i * 5),
    });
  }
  await insertEvent(db, {
    event_type: "engage",
    site_id: SITE,
    session_id: "hot",
    visitor_id: "hv",
    created_at: at(600),
  });
  // One clean type, no real dwell: nothing validates.
  assertEquals(await validateViews(db, NOW), 0);

  // A second clean type 300 s ago: views at least 10 s older than it
  // validate (310 s .. 700 s ago = 79 views), newer ones do not.
  await insertEvent(db, {
    event_type: "click",
    site_id: SITE,
    session_id: "hot",
    visitor_id: "hv",
    created_at: at(300),
  });
  assertEquals(await validateViews(db, NOW), 79);
  assertEquals(await validated(db, "hv62"), 1); // 310 s ago
  assertEquals(await validated(db, "hv61"), 0); // 305 s ago

  // A real dwell validates the rest.
  await insertEvent(db, {
    event_type: "session_end",
    site_id: SITE,
    session_id: "hot",
    visitor_id: "hv",
    data: '{"dwell_s":2}',
    created_at: at(1),
  });
  assertEquals(await validateViews(db, NOW), 61);
  await db.close();
});

Deno.test("validator — an interaction before the lookback does not count toward the two types", async () => {
  const db = createTestDb();
  await insertView(db, {
    visitor_id: "v15",
    site_id: SITE,
    session_id: "s15",
    created_at: at(14 * 60),
  });
  await insertEvent(db, {
    event_type: "click",
    site_id: SITE,
    session_id: "s15",
    visitor_id: "v15",
    created_at: at(15 * 60 + 5),
  });
  await insertEvent(db, {
    event_type: "engage",
    site_id: SITE,
    session_id: "s15",
    visitor_id: "v15",
    created_at: at(60),
  });
  assertEquals(await validateViews(db, NOW), 0);
  await db.close();
});
