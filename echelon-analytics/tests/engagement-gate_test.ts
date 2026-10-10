import { assertEquals } from "@std/assert";
import { DatabaseSync } from "node:sqlite";
import {
  applyEngagementGate,
  type GateStatements,
  sessionPassSql,
  visitorPassSql,
} from "@/lib/engagement-gate.ts";
import { SCHEMA_SQL } from "@/lib/db/schema.ts";
import { SqliteAdapter } from "@/lib/db/sqlite-adapter.ts";
import { INTERACTION_SQL_LIST } from "@/lib/event-classes.ts";
import { validateViews } from "@/lib/view-validator.ts";
import { insertEvent, insertView } from "./_helpers.ts";
import type { DbAdapter } from "@/lib/db/adapter.ts";

// Exact DDL from migrate() in lib/db/database.ts. `validated` is a column
// migrate() adds, so this index cannot live in SCHEMA_SQL; the startup test
// at the end of this file checks that a real start produces the same text.
const VALIDATED_INDEX_SQL =
  "CREATE INDEX idx_vv_validated ON visitor_views(site_id, session_id, visitor_id) WHERE validated = 1";
// What SCHEMA_SQL and migrate() must both produce for the gesture index.
const GESTURE_INDEX_SQL =
  "CREATE INDEX idx_se_clean_interaction ON semantic_events(site_id, session_id, visitor_id, created_at) " +
  `WHERE bot_score BETWEEN 0 AND 49 AND event_type IN (${INTERACTION_SQL_LIST})`;

/** An in-memory DB with every index a started instance has for the gate. */
function createTestDb(): DbAdapter {
  const raw = new DatabaseSync(":memory:");
  raw.exec(SCHEMA_SQL);
  raw.exec(VALIDATED_INDEX_SQL);
  return new SqliteAdapter(raw);
}

const NOW = Date.parse("2026-10-09T12:00:00.000Z");
const at = (minAgo: number) => new Date(NOW - minAgo * 60_000).toISOString();
const SITE = "gate-site";

async function view(db: DbAdapter, visitor: string) {
  return await db.queryOne<
    { bot_score: number; bot_score_detail: string | null }
  >(
    "SELECT bot_score, bot_score_detail FROM visitor_views WHERE visitor_id = ?",
    visitor,
  );
}

// ── Default mode ────────────────────────────────────────────────────────────

Deno.test("gate — default mode keeps a passive reader: +15 only", async () => {
  const db = createTestDb();
  await insertView(db, {
    visitor_id: "reader",
    site_id: SITE,
    session_id: "s-reader",
    created_at: at(10),
  });
  // Everything a real read-and-leave visit produces, none of it a gesture.
  for (
    const t of ["scroll_depth", "web_vital", "bounce", "session_end", "custom"]
  ) {
    await insertEvent(db, {
      event_type: t,
      site_id: SITE,
      session_id: "s-reader",
      visitor_id: "reader",
      created_at: at(9),
    });
  }
  const r = await applyEngagementGate(db, { now: NOW, strict: false });
  assertEquals(r.noEvents, 1);
  const row = await view(db, "reader");
  assertEquals(row?.bot_score, 15);
  assertEquals(JSON.parse(row!.bot_score_detail!).no_events, 15);
  await db.close();
});

Deno.test("gate — an interaction event spares the view", async () => {
  const db = createTestDb();
  await insertView(db, {
    visitor_id: "clicker",
    site_id: SITE,
    session_id: "s-click",
    created_at: at(10),
  });
  await insertEvent(db, {
    event_type: "engage",
    site_id: SITE,
    session_id: "s-click",
    visitor_id: "clicker",
    created_at: at(10),
  });
  await applyEngagementGate(db, { now: NOW, strict: false });
  assertEquals((await view(db, "clicker"))?.bot_score, 0);
  await db.close();
});

Deno.test("gate — an interaction event from a bot-scored request spares nothing", async () => {
  const db = createTestDb();
  await insertView(db, {
    visitor_id: "faker",
    site_id: SITE,
    session_id: "s-fake",
    created_at: at(10),
  });
  await insertEvent(db, {
    event_type: "engage",
    site_id: SITE,
    session_id: "s-fake",
    visitor_id: "faker",
    bot_score: 70,
    created_at: at(10),
  });
  await applyEngagementGate(db, { now: NOW, strict: false });
  assertEquals((await view(db, "faker"))?.bot_score, 15);
  await db.close();
});

Deno.test("gate — a view that never proved work and never interacted is raised to the threshold", async () => {
  const db = createTestDb();
  await insertView(db, {
    visitor_id: "tokenless",
    site_id: SITE,
    session_id: "s-tokenless",
    bot_score: 30,
    bot_score_detail: '{"pow":30,"pow_result":"missing"}',
    created_at: at(10),
  });
  const r = await applyEngagementGate(db, { now: NOW, strict: false });
  assertEquals(r.unproven, 1);
  assertEquals(r.noEvents, 0, "raised once, not also +15");
  const row = await view(db, "tokenless");
  assertEquals(row?.bot_score, 50);
  const detail = JSON.parse(row!.bot_score_detail!);
  assertEquals(detail.unproven, 20, "what it added: 50 - 30");
  assertEquals(detail.pow, 30, "the original evidence is kept");
  await db.close();
});

Deno.test("gate — a tokenless view that then interacts is forgiven", async () => {
  const db = createTestDb();
  await insertView(db, {
    visitor_id: "lockdown",
    site_id: SITE,
    session_id: "s-lockdown",
    bot_score: 30,
    bot_score_detail: '{"pow":30,"pow_result":"missing"}',
    created_at: at(10),
  });
  await insertEvent(db, {
    event_type: "engage",
    site_id: SITE,
    session_id: "s-lockdown",
    visitor_id: "lockdown",
    bot_score: 30,
    created_at: at(10),
  });
  await applyEngagementGate(db, { now: NOW, strict: false });
  assertEquals((await view(db, "lockdown"))?.bot_score, 30);
  await db.close();
});

Deno.test("gate — a waived token (pow_ok) is not treated as unproven", async () => {
  const db = createTestDb();
  await insertView(db, {
    visitor_id: "waived",
    site_id: SITE,
    session_id: "s-waived",
    bot_score: 0,
    bot_score_detail: '{"pow_ok":30}',
    created_at: at(10),
  });
  const r = await applyEngagementGate(db, { now: NOW, strict: false });
  assertEquals(r.unproven, 0);
  assertEquals((await view(db, "waived"))?.bot_score, 15);
  await db.close();
});

Deno.test("gate — only views aged 5 to 30 minutes are judged", async () => {
  const db = createTestDb();
  await insertView(db, {
    visitor_id: "tooyoung",
    site_id: SITE,
    session_id: "s-young",
    created_at: at(3),
  });
  await insertView(db, {
    visitor_id: "tooold",
    site_id: SITE,
    session_id: "s-old",
    created_at: at(40),
  });
  await applyEngagementGate(db, { now: NOW, strict: false });
  assertEquals((await view(db, "tooyoung"))?.bot_score, 0);
  assertEquals((await view(db, "tooold"))?.bot_score, 0);
  await db.close();
});

Deno.test("gate — validated views are never touched", async () => {
  const db = createTestDb();
  await insertView(db, {
    visitor_id: "proven",
    site_id: SITE,
    session_id: "s-proven",
    validated: 1,
    created_at: at(10),
  });
  await applyEngagementGate(db, { now: NOW, strict: true });
  assertEquals((await view(db, "proven"))?.bot_score, 0);
  await db.close();
});

Deno.test("gate — idempotent: a second run does not add another 15", async () => {
  const db = createTestDb();
  await insertView(db, {
    visitor_id: "twice",
    site_id: SITE,
    session_id: "s-twice",
    created_at: at(10),
  });
  await applyEngagementGate(db, { now: NOW, strict: false });
  await applyEngagementGate(db, { now: NOW, strict: false });
  assertEquals((await view(db, "twice"))?.bot_score, 15);
  await db.close();
});

Deno.test("gate — sessionless: a view with no session id matches events by visitor", async () => {
  const db = createTestDb();
  await insertView(db, {
    visitor_id: "nosid-a",
    site_id: SITE,
    session_id: null,
    created_at: at(10),
  });
  await insertEvent(db, {
    event_type: "click",
    site_id: SITE,
    session_id: null,
    visitor_id: "nosid-a",
    created_at: at(9),
  });
  await insertView(db, {
    visitor_id: "nosid-b",
    site_id: SITE,
    session_id: null,
    created_at: at(10),
  });
  await applyEngagementGate(db, { now: NOW, strict: false });
  assertEquals((await view(db, "nosid-a"))?.bot_score, 0);
  assertEquals((await view(db, "nosid-b"))?.bot_score, 15);
  await db.close();
});

// ── Strict mode ─────────────────────────────────────────────────────────────

Deno.test("gate — strict off: a 60 minute old passive session is left alone", async () => {
  const db = createTestDb();
  await insertView(db, {
    visitor_id: "old-passive",
    site_id: SITE,
    session_id: "s-op",
    created_at: at(60),
  });
  const r = await applyEngagementGate(db, { now: NOW, strict: false });
  assertEquals(r.strictViews, 0);
  assertEquals((await view(db, "old-passive"))?.bot_score, 0);
  await db.close();
});

Deno.test("gate — strict on: a zero-interaction session is moved to the threshold, with its events", async () => {
  const db = createTestDb();
  await insertView(db, {
    visitor_id: "idle",
    site_id: SITE,
    session_id: "s-idle",
    bot_score: 15,
    bot_score_detail: '{"no_events":true}',
    created_at: at(60),
  });
  await insertEvent(db, {
    event_type: "session_end",
    site_id: SITE,
    session_id: "s-idle",
    visitor_id: "idle",
    created_at: at(59),
  });
  const r = await applyEngagementGate(db, { now: NOW, strict: true });
  assertEquals(r.strictViews, 1);
  assertEquals(r.strictEvents, 1);
  const row = await view(db, "idle");
  assertEquals(row?.bot_score, 50);
  assertEquals(JSON.parse(row!.bot_score_detail!).no_engagement, 50);
  const ev = await db.queryOne<{ bot_score: number }>(
    "SELECT bot_score FROM semantic_events WHERE session_id = ?",
    "s-idle",
  );
  assertEquals(ev?.bot_score, 50);
  await db.close();
});

Deno.test("gate — strict on: a session that interacted keeps its views and events", async () => {
  const db = createTestDb();
  await insertView(db, {
    visitor_id: "active",
    site_id: SITE,
    session_id: "s-active",
    created_at: at(60),
  });
  await insertEvent(db, {
    event_type: "engage",
    site_id: SITE,
    session_id: "s-active",
    visitor_id: "active",
    created_at: at(60),
  });
  await insertEvent(db, {
    event_type: "web_vital",
    site_id: SITE,
    session_id: "s-active",
    visitor_id: "active",
    created_at: at(60),
  });
  const r = await applyEngagementGate(db, { now: NOW, strict: true });
  assertEquals(r.strictViews, 0);
  assertEquals(r.strictEvents, 0);
  await db.close();
});

Deno.test("gate — strict on: events of a session with a validated view are never rescored", async () => {
  const db = createTestDb();
  await insertView(db, {
    visitor_id: "val",
    site_id: SITE,
    session_id: "s-val",
    validated: 1,
    created_at: at(60),
  });
  await insertEvent(db, {
    event_type: "session_end",
    site_id: SITE,
    session_id: "s-val",
    visitor_id: "val",
    created_at: at(59),
  });
  const r = await applyEngagementGate(db, { now: NOW, strict: true });
  assertEquals(r.strictEvents, 0);
  await db.close();
});

Deno.test("gate — strict on: only sessions aged 30 to 180 minutes", async () => {
  const db = createTestDb();
  await insertView(db, {
    visitor_id: "s20",
    site_id: SITE,
    session_id: "s-20",
    created_at: at(20),
  });
  await insertView(db, {
    visitor_id: "s200",
    site_id: SITE,
    session_id: "s-200",
    created_at: at(200),
  });
  const r = await applyEngagementGate(db, { now: NOW, strict: true });
  assertEquals(r.strictViews, 0);
  await db.close();
});

// ── Finding 3: which key waived the PoW penalty ─────────────────────────────

Deno.test("gate — a waiver granted only by the visitor key stays subject to unproven", async () => {
  const db = createTestDb();
  await insertView(db, {
    visitor_id: "waived-v",
    site_id: SITE,
    session_id: "s-waived-v",
    bot_score: 0,
    bot_score_detail: '{"pow_ok":30,"pow_ok_by":"v"}',
    created_at: at(10),
  });
  const r = await applyEngagementGate(db, { now: NOW, strict: false });
  assertEquals(r.unproven, 1);
  assertEquals(r.noEvents, 0, "raised once, not also +15");
  const row = await view(db, "waived-v");
  assertEquals(row?.bot_score, 50);
  const detail = JSON.parse(row!.bot_score_detail!);
  assertEquals(detail.unproven, 50, "what it added: 50 - 0");
  assertEquals(detail.pow_ok_by, "v", "the original evidence is kept");
  await db.close();
});

Deno.test("gate — a visitor-key waiver that then interacts is forgiven", async () => {
  const db = createTestDb();
  await insertView(db, {
    visitor_id: "waived-v2",
    site_id: SITE,
    session_id: "s-waived-v2",
    bot_score: 0,
    bot_score_detail: '{"pow_ok":30,"pow_ok_by":"v"}',
    created_at: at(10),
  });
  await insertEvent(db, {
    event_type: "engage",
    site_id: SITE,
    session_id: "s-waived-v2",
    visitor_id: "waived-v2",
    created_at: at(10),
  });
  const r = await applyEngagementGate(db, { now: NOW, strict: false });
  assertEquals(r.unproven, 0);
  assertEquals((await view(db, "waived-v2"))?.bot_score, 0);
  await db.close();
});

Deno.test("gate — a waiver granted by the session key gets the ordinary +15", async () => {
  const db = createTestDb();
  await insertView(db, {
    visitor_id: "waived-s",
    site_id: SITE,
    session_id: "s-waived-s",
    bot_score: 0,
    bot_score_detail: '{"pow_ok":30,"pow_ok_by":"s"}',
    created_at: at(10),
  });
  const r = await applyEngagementGate(db, { now: NOW, strict: false });
  assertEquals(r.unproven, 0);
  assertEquals(r.noEvents, 1);
  const row = await view(db, "waived-s");
  assertEquals(row?.bot_score, 15);
  assertEquals(JSON.parse(row!.bot_score_detail!).no_events, 15);
  await db.close();
});

// ── Finding 2: the verdict on a row must not flip as the row ages ───────────

Deno.test("gate — an engaged session's tokenless view stays shielded as it ages", async () => {
  // Same session: a gesture, then a tokenless second view 3 minutes later.
  // Judged at 20 minutes old and again at 29: the verdict must not change.
  for (const viewAge of [20, 29]) {
    const db = createTestDb();
    await insertEvent(db, {
      event_type: "engage",
      site_id: SITE,
      session_id: "s-aging",
      visitor_id: "aging",
      created_at: at(viewAge + 3),
    });
    await insertView(db, {
      visitor_id: "aging",
      site_id: SITE,
      session_id: "s-aging",
      bot_score: 30,
      bot_score_detail: '{"pow":30,"pow_result":"missing"}',
      created_at: at(viewAge),
    });
    const r = await applyEngagementGate(db, { now: NOW, strict: false });
    assertEquals(r.unproven, 0, `view aged ${viewAge} min`);
    assertEquals(r.noEvents, 0, `view aged ${viewAge} min`);
    const row = await view(db, "aging");
    assertEquals(row?.bot_score, 30, `view aged ${viewAge} min`);
    assertEquals(row?.bot_score_detail, '{"pow":30,"pow_result":"missing"}');
    await db.close();
  }
});

Deno.test("gate — strict on: an engaged session keeps its later view and events as they age", async () => {
  // A clean gesture, then a view and a session_end 20 minutes later. Judged
  // with the tail 150 minutes old and again at 165 (gesture 185 minutes old).
  for (const tailAge of [150, 165]) {
    const db = createTestDb();
    await insertView(db, {
      visitor_id: "long",
      path: "/first",
      site_id: SITE,
      session_id: "s-long",
      created_at: at(tailAge + 20),
    });
    await insertEvent(db, {
      event_type: "engage",
      site_id: SITE,
      session_id: "s-long",
      visitor_id: "long",
      created_at: at(tailAge + 20),
    });
    await insertView(db, {
      visitor_id: "long",
      path: "/second",
      site_id: SITE,
      session_id: "s-long",
      created_at: at(tailAge),
    });
    await insertEvent(db, {
      event_type: "session_end",
      site_id: SITE,
      session_id: "s-long",
      visitor_id: "long",
      created_at: at(tailAge),
    });
    const r = await applyEngagementGate(db, { now: NOW, strict: true });
    assertEquals(r.strictViews, 0, `tail aged ${tailAge} min`);
    assertEquals(r.strictEvents, 0, `tail aged ${tailAge} min`);
    const touched = await db.queryOne<{ n: number }>(
      `SELECT (SELECT COUNT(*) FROM visitor_views WHERE bot_score <> 0)
            + (SELECT COUNT(*) FROM semantic_events WHERE bot_score <> 0) AS n`,
    );
    assertEquals(touched?.n, 0, `tail aged ${tailAge} min`);
    await db.close();
  }
});

Deno.test("gate — sessionless: an interaction up to 30 minutes before the view shields it, an older one does not", async () => {
  const db = createTestDb();
  await insertView(db, {
    visitor_id: "near",
    site_id: SITE,
    session_id: null,
    created_at: at(10),
  });
  await insertEvent(db, {
    event_type: "click",
    site_id: SITE,
    session_id: null,
    visitor_id: "near",
    created_at: at(39),
  });
  await insertView(db, {
    visitor_id: "far",
    site_id: SITE,
    session_id: null,
    created_at: at(10),
  });
  await insertEvent(db, {
    event_type: "click",
    site_id: SITE,
    session_id: null,
    visitor_id: "far",
    created_at: at(41),
  });
  const r = await applyEngagementGate(db, { now: NOW, strict: false });
  assertEquals(r.noEvents, 1);
  assertEquals((await view(db, "near"))?.bot_score, 0);
  assertEquals((await view(db, "far"))?.bot_score, 15);
  await db.close();
});

Deno.test("gate — strict on, sessionless: an interaction up to 30 minutes after the row shields it, a later one does not", async () => {
  const db = createTestDb();
  for (const [visitor, gestureAge] of [["soon", 71], ["late", 69]] as const) {
    await insertView(db, {
      visitor_id: visitor,
      site_id: SITE,
      session_id: null,
      created_at: at(100),
    });
    await insertEvent(db, {
      event_type: "web_vital",
      site_id: SITE,
      session_id: null,
      visitor_id: visitor,
      created_at: at(100),
    });
    await insertEvent(db, {
      event_type: "click",
      site_id: SITE,
      session_id: null,
      visitor_id: visitor,
      created_at: at(gestureAge),
    });
  }
  const r = await applyEngagementGate(db, { now: NOW, strict: true });
  assertEquals(r.strictViews, 1);
  assertEquals(r.strictEvents, 1);
  assertEquals((await view(db, "soon"))?.bot_score, 0);
  assertEquals((await view(db, "late"))?.bot_score, 50);
  const events = await db.query<
    { visitor_id: string; event_type: string; bot_score: number }
  >(
    `SELECT visitor_id, event_type, bot_score FROM semantic_events
      ORDER BY visitor_id, event_type`,
  );
  assertEquals(events, [
    // The gesture shields itself; the passive event 31 minutes before it
    // is on its own.
    { visitor_id: "late", event_type: "click", bot_score: 0 },
    { visitor_id: "late", event_type: "web_vital", bot_score: 50 },
    { visitor_id: "soon", event_type: "click", bot_score: 0 },
    { visitor_id: "soon", event_type: "web_vital", bot_score: 0 },
  ]);
  await db.close();
});

// ── Matching rules and odd rows ─────────────────────────────────────────────

Deno.test("gate — a view with no session id is not shielded by an event that has one", async () => {
  const db = createTestDb();
  await insertView(db, {
    visitor_id: "mixed",
    site_id: SITE,
    session_id: null,
    created_at: at(10),
  });
  await insertEvent(db, {
    event_type: "click",
    site_id: SITE,
    session_id: "s-other-tab",
    visitor_id: "mixed",
    created_at: at(10),
  });
  await applyEngagementGate(db, { now: NOW, strict: false });
  assertEquals((await view(db, "mixed"))?.bot_score, 15);
  await db.close();
});

Deno.test("gate — a view with a session id is not shielded by an event that has none", async () => {
  const db = createTestDb();
  await insertView(db, {
    visitor_id: "mixed2",
    site_id: SITE,
    session_id: "s-mixed2",
    created_at: at(10),
  });
  await insertEvent(db, {
    event_type: "click",
    site_id: SITE,
    session_id: null,
    visitor_id: "mixed2",
    created_at: at(10),
  });
  await applyEngagementGate(db, { now: NOW, strict: false });
  assertEquals((await view(db, "mixed2"))?.bot_score, 15);
  await db.close();
});

Deno.test("gate — an interaction on another site spares nothing", async () => {
  const db = createTestDb();
  await insertView(db, {
    visitor_id: "xsite",
    site_id: SITE,
    session_id: "s-xsite",
    created_at: at(10),
  });
  await insertView(db, {
    visitor_id: "xsite-nosid",
    site_id: SITE,
    session_id: null,
    created_at: at(10),
  });
  await insertEvent(db, {
    event_type: "click",
    site_id: "other-site",
    session_id: "s-xsite",
    visitor_id: "xsite",
    created_at: at(10),
  });
  await insertEvent(db, {
    event_type: "click",
    site_id: "other-site",
    session_id: null,
    visitor_id: "xsite-nosid",
    created_at: at(10),
  });
  await applyEngagementGate(db, { now: NOW, strict: false });
  assertEquals((await view(db, "xsite"))?.bot_score, 15);
  assertEquals((await view(db, "xsite-nosid"))?.bot_score, 15);
  await db.close();
});

Deno.test("gate — a detail that is empty or not JSON is replaced, not thrown on", async () => {
  const db = createTestDb();
  await insertView(db, {
    visitor_id: "empty-detail",
    site_id: SITE,
    session_id: "s-empty",
    bot_score_detail: "",
    created_at: at(10),
  });
  await insertView(db, {
    visitor_id: "bad-detail",
    site_id: SITE,
    session_id: null,
    bot_score_detail: "{not json",
    created_at: at(10),
  });
  await insertView(db, {
    visitor_id: "bad-detail-strict",
    site_id: SITE,
    session_id: "s-bad-strict",
    bot_score_detail: "{not json",
    created_at: at(60),
  });
  await insertEvent(db, {
    event_type: "session_end",
    site_id: SITE,
    session_id: "s-bad-strict",
    visitor_id: "bad-detail-strict",
    bot_score_detail: "",
    created_at: at(60),
  });
  const r = await applyEngagementGate(db, { now: NOW, strict: true });
  assertEquals(r.noEvents, 2);
  assertEquals(r.strictViews, 1);
  assertEquals(r.strictEvents, 1);
  for (const visitor of ["empty-detail", "bad-detail"]) {
    const row = await view(db, visitor);
    assertEquals(row?.bot_score, 15, visitor);
    assertEquals(row?.bot_score_detail, '{"no_events":15}', visitor);
  }
  const strictRow = await view(db, "bad-detail-strict");
  assertEquals(strictRow?.bot_score, 50);
  assertEquals(strictRow?.bot_score_detail, '{"no_engagement":50}');
  const ev = await db.queryOne<{ bot_score_detail: string }>(
    "SELECT bot_score_detail FROM semantic_events WHERE session_id = ?",
    "s-bad-strict",
  );
  assertEquals(ev?.bot_score_detail, '{"no_engagement":50}');
  // And a second run leaves the replaced detail alone.
  const again = await applyEngagementGate(db, { now: NOW, strict: true });
  assertEquals(again.noEvents, 0);
  await db.close();
});

Deno.test("gate — strict on: a validated view inside the strict window is untouched", async () => {
  const db = createTestDb();
  await insertView(db, {
    visitor_id: "proven-old",
    site_id: SITE,
    session_id: "s-proven-old",
    validated: 1,
    created_at: at(60),
  });
  await insertView(db, {
    visitor_id: "proven-old-nosid",
    site_id: SITE,
    session_id: null,
    validated: 1,
    created_at: at(60),
  });
  const r = await applyEngagementGate(db, { now: NOW, strict: true });
  assertEquals(r.strictViews, 0);
  for (const visitor of ["proven-old", "proven-old-nosid"]) {
    const row = await view(db, visitor);
    assertEquals(row?.bot_score, 0, visitor);
    assertEquals(row?.bot_score_detail, null, visitor);
  }
  await db.close();
});

Deno.test("gate — strict on, sessionless: events of a visitor with a validated view are never rescored", async () => {
  const db = createTestDb();
  await insertView(db, {
    visitor_id: "val-nosid",
    site_id: SITE,
    session_id: null,
    validated: 1,
    created_at: at(60),
  });
  await insertEvent(db, {
    event_type: "session_end",
    site_id: SITE,
    session_id: null,
    visitor_id: "val-nosid",
    created_at: at(59),
  });
  // Same visitor id, but the validated view belongs to a session: it does
  // not cover events that have none.
  await insertView(db, {
    visitor_id: "val-sid",
    site_id: SITE,
    session_id: "s-val-sid",
    validated: 1,
    created_at: at(60),
  });
  await insertEvent(db, {
    event_type: "session_end",
    site_id: SITE,
    session_id: null,
    visitor_id: "val-sid",
    created_at: at(59),
  });
  const r = await applyEngagementGate(db, { now: NOW, strict: true });
  assertEquals(r.strictEvents, 1);
  const rows = await db.query<{ visitor_id: string; bot_score: number }>(
    "SELECT visitor_id, bot_score FROM semantic_events ORDER BY visitor_id",
  );
  assertEquals(rows, [
    { visitor_id: "val-nosid", bot_score: 0 },
    { visitor_id: "val-sid", bot_score: 50 },
  ]);
  await db.close();
});

// ── Query plans ─────────────────────────────────────────────────────────────
//
// node:sqlite is synchronous and the gate runs on a live instance every two
// minutes: a statement that walks many rows for each row it judges blocks
// every request while it runs. One client can put thousands of rows on one
// session id or visitor id (POST /e takes 20 events a request), so "walks the
// rows of this row's own session or visitor" is already too many.
//
// The gate's subqueries therefore have no residual filter. Each is a search
// of a partial index whose WHERE clause holds the part of the predicate that
// is not a key (clean score + interaction type, or validated = 1), on a key
// that covers the rest. Every entry such a search reaches is an answer, so
// EXISTS stops at the first one, however many rows share the key. These
// tests pin both halves: the index definitions and the search keys.

const STATEMENTS: (keyof GateStatements)[] = [
  "forgive",
  "unproven",
  "noEvents",
  "strictEvents",
  "strictViews",
];

/** The forgive pass's lookup of the view's visitor in excluded_visitors. */
const EXCLUDED_LOOKUP_STEP =
  "SEARCH ex USING COVERING INDEX sqlite_autoindex_excluded_visitors_1 (visitor_id=?)";

/** The plan steps of one statement. */
async function planOf(db: DbAdapter, sql: string): Promise<string[]> {
  return (await db.query<{ detail: string }>(`EXPLAIN QUERY PLAN ${sql}`))
    .map((r) => r.detail);
}

/**
 * Check one statement's plan. Subqueries alias semantic_events as `si` and
 * visitor_views as `vv`; `key` is the exact search key each must use.
 */
async function assertPlan(
  db: DbAdapter,
  name: string,
  sql: string,
  key: { si: string; vv: string },
) {
  const plan = await planOf(db, sql);
  const shown = `${name}:\n${plan.join("\n")}`;
  for (const step of plan) {
    assertEquals(step.startsWith("SCAN"), false, shown);
    assertEquals(step.includes("idx_se_site_type_created"), false, shown);
  }
  const index = { si: "idx_se_clean_interaction", vv: "idx_vv_validated" };
  const steps = (alias: "si" | "vv") =>
    plan.filter((d) => d.startsWith(`SEARCH ${alias} `))
      .map((d) => d.replace("USING COVERING INDEX", "USING INDEX"));
  // Every statement has exactly one interaction lookup; only the strict
  // events statement asks about validated views.
  assertEquals(
    steps("si"),
    [`SEARCH si USING INDEX ${index.si} (${key.si})`],
    shown,
  );
  assertEquals(
    steps("vv"),
    name.endsWith("strictEvents")
      ? [`SEARCH vv USING INDEX ${index.vv} (${key.vv})`]
      : [],
    shown,
  );
  // Only forgiving asks whether the visitor is excluded, by primary key.
  assertEquals(
    plan.filter((d) => d.includes("excluded_visitors") || / ex /.test(d)),
    name.endsWith("forgive") ? [EXCLUDED_LOOKUP_STEP] : [],
    shown,
  );
  // The row being judged is found by its age, on an index.
  assertEquals(
    plan[0].includes("_created_bot (created_at>? AND created_at<?)"),
    true,
    shown,
  );
}

Deno.test("gate — every session-pass subquery is one search on the whole session key", async () => {
  const db = createTestDb();
  const sql = sessionPassSql(NOW);
  for (const name of STATEMENTS) {
    await assertPlan(db, `session ${name}`, sql[name], {
      si: "site_id=? AND session_id=?",
      vv: "site_id=? AND session_id=?",
    });
  }
  await db.close();
});

Deno.test("gate — every visitor-pass subquery is one search on the whole visitor key and time range", async () => {
  const db = createTestDb();
  const sql = visitorPassSql(NOW);
  for (const name of STATEMENTS) {
    await assertPlan(db, `visitor ${name}`, sql[name], {
      si:
        "site_id=? AND session_id=? AND visitor_id=? AND created_at>? AND created_at<?",
      vv: "site_id=? AND session_id=? AND visitor_id=?",
    });
  }
  await db.close();
});

Deno.test("gate — the indexes it searches hold only rows that answer the question", async () => {
  const db = createTestDb();
  const ddl = async (name: string) =>
    (await db.queryOne<{ sql: string }>(
      "SELECT sql FROM sqlite_master WHERE type = 'index' AND name = ?",
      name,
    ))?.sql.replace(/\s+/g, " ").replace("IF NOT EXISTS ", "");
  assertEquals(await ddl("idx_se_clean_interaction"), GESTURE_INDEX_SQL);
  assertEquals(await ddl("idx_vv_validated"), VALIDATED_INDEX_SQL);
  await db.close();
});

Deno.test("gate — without its indexes a statement fails instead of walking the table", async () => {
  const raw = new DatabaseSync(":memory:");
  raw.exec(SCHEMA_SQL);
  raw.exec("DROP INDEX idx_se_clean_interaction");
  const db = new SqliteAdapter(raw);
  let message = "";
  try {
    await applyEngagementGate(db, { now: NOW, strict: false });
  } catch (e) {
    message = (e as Error).message;
  }
  assertEquals(message.includes("idx_se_clean_interaction"), true, message);
  await db.close();
});

Deno.test("gate — the passes are the statements the gate runs", async () => {
  const ran: string[] = [];
  const spy = {
    run(sql: string) {
      ran.push(sql);
      return Promise.resolve({ changes: 0 });
    },
    transaction(fn: (tx: unknown) => unknown) {
      return fn(spy);
    },
  } as unknown as DbAdapter;
  await applyEngagementGate(spy, { now: NOW, strict: true });
  const s = sessionPassSql(NOW);
  const v = visitorPassSql(NOW);
  assertEquals(ran, [
    s.forgive,
    v.forgive,
    s.unproven,
    v.unproven,
    s.noEvents,
    v.noEvents,
    s.strictEvents,
    s.strictViews,
    v.strictEvents,
    v.strictViews,
  ]);
});

// ── Forgiving ───────────────────────────────────────────────────────────────
//
// The first gesture of someone who reads with a wheel or trackpad can come
// after the gate has judged the view. Default-mode marks record what they
// added so that a later sweep can take exactly that back.

/** A view judged idle at 6 minutes old; `later` is how far to move the clock. */
async function judgedIdle(
  db: DbAdapter,
  visitor: string,
  over: { session_id?: string | null; bot_score?: number; detail?: string },
) {
  await insertView(db, {
    visitor_id: visitor,
    site_id: SITE,
    session_id: over.session_id === undefined
      ? `s-${visitor}`
      : over.session_id,
    bot_score: over.bot_score ?? 0,
    bot_score_detail: over.detail ?? null,
    created_at: at(6),
  });
}
const later = (min: number) => NOW + min * 60_000;

Deno.test("gate — a gesture after no_events gives the 15 back and removes the mark", async () => {
  const db = createTestDb();
  await judgedIdle(db, "late", { bot_score: 40, detail: '{"burst":40}' });
  await judgedIdle(db, "late-bare", {});
  await judgedIdle(db, "never", {});
  const first = await applyEngagementGate(db, { now: NOW, strict: false });
  assertEquals([first.forgiven, first.noEvents], [0, 3]);
  // 40 + 15: over the threshold, so the validator would now refuse it.
  assertEquals(await view(db, "late"), {
    bot_score: 55,
    bot_score_detail: '{"burst":40,"no_events":15}',
  });
  for (const visitor of ["late", "late-bare"]) {
    await insertEvent(db, {
      event_type: "click",
      site_id: SITE,
      session_id: `s-${visitor}`,
      visitor_id: visitor,
      created_at: at(-1),
    });
  }
  const second = await applyEngagementGate(db, {
    now: later(2),
    strict: false,
  });
  assertEquals([second.forgiven, second.noEvents, second.unproven], [2, 0, 0]);
  assertEquals(await view(db, "late"), {
    bot_score: 40,
    bot_score_detail: '{"burst":40}',
  });
  assertEquals(await view(db, "late-bare"), {
    bot_score: 0,
    bot_score_detail: null,
  });
  assertEquals((await view(db, "never"))?.bot_score, 15);
  await db.close();
});

Deno.test("gate — a gesture after unproven puts a tokenless view back at 30 with its pow evidence", async () => {
  const db = createTestDb();
  await judgedIdle(db, "tokenless-late", {
    bot_score: 30,
    detail: '{"pow":30,"pow_result":"missing"}',
  });
  // No session id: forgiven by the visitor rule that judged it.
  await judgedIdle(db, "waived-late", {
    session_id: null,
    bot_score: 0,
    detail: '{"pow_ok":30,"pow_ok_by":"v"}',
  });
  const first = await applyEngagementGate(db, { now: NOW, strict: false });
  assertEquals(first.unproven, 2);
  assertEquals(await view(db, "tokenless-late"), {
    bot_score: 50,
    bot_score_detail: '{"pow":30,"pow_result":"missing","unproven":20}',
  });
  await insertEvent(db, {
    event_type: "engage",
    site_id: SITE,
    session_id: "s-tokenless-late",
    visitor_id: "tokenless-late",
    bot_score: 30,
    created_at: at(-1),
  });
  await insertEvent(db, {
    event_type: "engage",
    site_id: SITE,
    session_id: null,
    visitor_id: "waived-late",
    created_at: at(-1),
  });
  const second = await applyEngagementGate(db, {
    now: later(2),
    strict: false,
  });
  assertEquals([second.forgiven, second.noEvents, second.unproven], [2, 0, 0]);
  assertEquals(await view(db, "tokenless-late"), {
    bot_score: 30,
    bot_score_detail: '{"pow":30,"pow_result":"missing"}',
  });
  assertEquals(await view(db, "waived-late"), {
    bot_score: 0,
    bot_score_detail: '{"pow_ok":30,"pow_ok_by":"v"}',
  });
  // Forgiving twice changes nothing, in either mode.
  for (const strict of [false, true]) {
    const again = await applyEngagementGate(db, { now: later(4), strict });
    assertEquals(again, {
      forgiven: 0,
      unproven: 0,
      noEvents: 0,
      strictViews: 0,
      strictEvents: 0,
    });
  }
  assertEquals((await view(db, "tokenless-late"))?.bot_score, 30);
  await db.close();
});

Deno.test("gate — strict mode forgives too, before it judges", async () => {
  const db = createTestDb();
  await judgedIdle(db, "strict-late", {
    bot_score: 40,
    detail: '{"burst":40}',
  });
  await applyEngagementGate(db, { now: NOW, strict: true });
  assertEquals((await view(db, "strict-late"))?.bot_score, 55);
  await insertEvent(db, {
    event_type: "click",
    site_id: SITE,
    session_id: "s-strict-late",
    visitor_id: "strict-late",
    created_at: at(-20),
  });
  // 46 minutes old: inside the strict window, and a clean view again.
  const r = await applyEngagementGate(db, { now: later(40), strict: true });
  assertEquals([r.forgiven, r.strictViews], [1, 0]);
  assertEquals(await view(db, "strict-late"), {
    bot_score: 40,
    bot_score_detail: '{"burst":40}',
  });
  await db.close();
});

Deno.test("gate — a view of an excluded visitor is never forgiven", async () => {
  const db = createTestDb();
  // Two visitors in the same position: marked, then a gesture. One has been
  // excluded since (by an operator, or by the classifier on other rows).
  for (const visitor of ["excluded-one", "ordinary-one"]) {
    await insertView(db, {
      visitor_id: visitor,
      site_id: SITE,
      session_id: `s-${visitor}`,
      bot_score: 50,
      bot_score_detail: '{"pow":30,"pow_result":"missing","unproven":20}',
      created_at: at(20),
    });
    await insertView(db, {
      visitor_id: visitor,
      site_id: SITE,
      session_id: null,
      bot_score: 15,
      bot_score_detail: '{"no_events":15}',
      created_at: at(20),
    });
    for (const session_id of [`s-${visitor}`, null]) {
      await insertEvent(db, {
        event_type: "click",
        site_id: SITE,
        session_id,
        visitor_id: visitor,
        created_at: at(1),
      });
    }
  }
  await db.run(
    "INSERT INTO excluded_visitors (visitor_id, label) VALUES (?, ?)",
    "excluded-one",
    "auto:os_family_flip",
  );
  const r = await applyEngagementGate(db, { now: NOW, strict: false });
  assertEquals(r.forgiven, 2);
  const rows = await db.query<{ visitor_id: string; bot_score: number }>(
    "SELECT visitor_id, bot_score FROM visitor_views ORDER BY id",
  );
  assertEquals(rows, [
    { visitor_id: "excluded-one", bot_score: 50 },
    { visitor_id: "excluded-one", bot_score: 15 },
    { visitor_id: "ordinary-one", bot_score: 30 },
    { visitor_id: "ordinary-one", bot_score: 0 },
  ]);
  await db.close();
});

Deno.test("gate — a view another job has judged since is not forgiven", async () => {
  const db = createTestDb();
  const marked: Record<string, [number, string]> = {
    correlated: [
      45,
      '{"no_events":15,"correlated":{"reason":"correlated","penalty":30}}',
    ],
    classifier: [60, '{"pow":30,"unproven":20,"classifier":"velocity"}'],
    no_engagement: [50, '{"no_events":15,"no_engagement":50}'],
  };
  for (const [visitor, [bot_score, detail]] of Object.entries(marked)) {
    await insertView(db, {
      visitor_id: visitor,
      site_id: SITE,
      session_id: `s-${visitor}`,
      bot_score,
      bot_score_detail: detail,
      created_at: at(20),
    });
    await insertEvent(db, {
      event_type: "click",
      site_id: SITE,
      session_id: `s-${visitor}`,
      visitor_id: visitor,
      created_at: at(1),
    });
  }
  const r = await applyEngagementGate(db, { now: NOW, strict: true });
  assertEquals(r.forgiven, 0);
  for (const [visitor, [bot_score, detail]] of Object.entries(marked)) {
    assertEquals(await view(db, visitor), {
      bot_score,
      bot_score_detail: detail,
    });
  }
  await db.close();
});

Deno.test("gate — a mark is forgiven up to 180 minutes after the view, not later", async () => {
  const db = createTestDb();
  for (const [visitor, age] of [["old-179", 179], ["old-181", 181]] as const) {
    await insertView(db, {
      visitor_id: visitor,
      site_id: SITE,
      session_id: `s-${visitor}`,
      bot_score: 15,
      bot_score_detail: '{"no_events":15}',
      created_at: at(age),
    });
    await insertEvent(db, {
      event_type: "click",
      site_id: SITE,
      session_id: `s-${visitor}`,
      visitor_id: visitor,
      created_at: at(1),
    });
  }
  const r = await applyEngagementGate(db, { now: NOW, strict: false });
  assertEquals(r.forgiven, 1);
  assertEquals((await view(db, "old-179"))?.bot_score, 0);
  assertEquals(await view(db, "old-181"), {
    bot_score: 15,
    bot_score_detail: '{"no_events":15}',
  });
  await db.close();
});

Deno.test("gate — a mark written before amounts were recorded is still undone", async () => {
  const db = createTestDb();
  await insertView(db, {
    visitor_id: "legacy",
    site_id: SITE,
    session_id: "s-legacy",
    bot_score: 25,
    bot_score_detail: '{"burst":10,"no_events":true}',
    created_at: at(20),
  });
  // A detail that only looks marked is left alone, and nothing throws.
  await insertView(db, {
    visitor_id: "not-json",
    site_id: SITE,
    session_id: "s-legacy",
    bot_score: 25,
    bot_score_detail: '{"no_events":15',
    created_at: at(20),
  });
  await insertEvent(db, {
    event_type: "click",
    site_id: SITE,
    session_id: "s-legacy",
    visitor_id: "legacy",
    created_at: at(1),
  });
  const r = await applyEngagementGate(db, { now: NOW, strict: false });
  assertEquals(r.forgiven, 1);
  assertEquals(await view(db, "legacy"), {
    bot_score: 10,
    bot_score_detail: '{"burst":10}',
  });
  assertEquals((await view(db, "not-json"))?.bot_score, 25);
  await db.close();
});

Deno.test("gate — a view forgiven by a late gesture can then be validated", async () => {
  const db = createTestDb();
  await judgedIdle(db, "reader", { bot_score: 40, detail: '{"burst":40}' });
  await applyEngagementGate(db, { now: NOW, strict: false });
  for (
    const [event_type, data] of [["engage", null], [
      "session_end",
      '{"dwell_s":400}',
    ]] as const
  ) {
    await insertEvent(db, {
      event_type,
      site_id: SITE,
      session_id: "s-reader",
      visitor_id: "reader",
      data,
      created_at: at(-1),
    });
  }
  // Over the threshold the validator refuses it; forgiven, it does not.
  assertEquals(await validateViews(db, later(2)), 0);
  await applyEngagementGate(db, { now: later(2), strict: false });
  assertEquals(await validateViews(db, later(2)), 1);
  await db.close();
});

Deno.test("gate — strict on: a view the gate had already raised is judged too, and a late gesture does not undo it", async () => {
  const db = createTestDb();
  // Tokenless and idle; a twin with a token; one that scored 40 at ingest.
  await judgedIdle(db, "strict-tokenless", {
    bot_score: 30,
    detail: '{"pow":30}',
  });
  await judgedIdle(db, "strict-token", {});
  await judgedIdle(db, "strict-busy", {
    bot_score: 40,
    detail: '{"burst":40}',
  });
  // Tokenless, idle, but strict mode will find its session did interact.
  await judgedIdle(db, "strict-engaged", {
    bot_score: 30,
    detail: '{"pow":30}',
  });
  for (const visitor of ["strict-tokenless", "strict-token", "strict-busy"]) {
    await insertEvent(db, {
      event_type: "bounce",
      site_id: SITE,
      session_id: `s-${visitor}`,
      visitor_id: visitor,
      created_at: at(6),
    });
  }
  await applyEngagementGate(db, { now: NOW, strict: true });
  assertEquals((await view(db, "strict-tokenless"))?.bot_score, 50);
  assertEquals((await view(db, "strict-busy"))?.bot_score, 55);
  await insertEvent(db, {
    event_type: "click",
    site_id: SITE,
    session_id: "s-strict-engaged",
    visitor_id: "strict-engaged",
    created_at: at(-20),
  });

  // 40 minutes old: inside the strict window.
  const r = await applyEngagementGate(db, { now: later(34), strict: true });
  assertEquals([r.forgiven, r.strictViews, r.strictEvents], [1, 3, 3]);
  const judged = {
    "strict-tokenless": {
      bot_score: 50,
      bot_score_detail: '{"pow":30,"unproven":20,"no_engagement":50}',
    },
    "strict-token": {
      bot_score: 50,
      bot_score_detail: '{"no_events":15,"no_engagement":50}',
    },
    // Never lowered: it stays where the gate put it.
    "strict-busy": {
      bot_score: 55,
      bot_score_detail: '{"burst":40,"no_events":15,"no_engagement":50}',
    },
  };
  for (const [visitor, want] of Object.entries(judged)) {
    assertEquals(await view(db, visitor), want, visitor);
  }
  assertEquals(await view(db, "strict-engaged"), {
    bot_score: 30,
    bot_score_detail: '{"pow":30}',
  });

  // A second sweep stamps nothing twice.
  const again = await applyEngagementGate(db, { now: later(34), strict: true });
  assertEquals(again, {
    forgiven: 0,
    unproven: 0,
    noEvents: 0,
    strictViews: 0,
    strictEvents: 0,
  });

  // A gesture at 100 minutes: strict mode's verdict is not undone.
  for (const visitor of Object.keys(judged)) {
    await insertEvent(db, {
      event_type: "click",
      site_id: SITE,
      session_id: `s-${visitor}`,
      visitor_id: visitor,
      created_at: at(-94),
    });
  }
  const late = await applyEngagementGate(db, { now: later(96), strict: true });
  assertEquals(late.forgiven, 0);
  for (const [visitor, want] of Object.entries(judged)) {
    assertEquals(await view(db, visitor), want, visitor);
  }
  await db.close();
});

Deno.test("gate — strict on: a view over the threshold for its own reasons is still left alone", async () => {
  const db = createTestDb();
  const own: [string, number, string | null][] = [
    ["own-high", 70, '{"burst":25,"geo":30,"no_events":15}'],
    [
      "own-correlated",
      80,
      '{"pow":30,"unproven":20,"correlated":{"penalty":30}}',
    ],
    ["own-classifier", 60, '{"no_events":15,"classifier":"velocity"}'],
    ["own-pow", 50, '{"pow":50}'],
    ["own-null", 60, null],
    ["own-not-json", 50, '{"unproven":20'],
  ];
  for (const [visitor, bot_score, detail] of own) {
    await insertView(db, {
      visitor_id: visitor,
      site_id: SITE,
      session_id: `s-${visitor}`,
      bot_score,
      bot_score_detail: detail,
      created_at: at(60),
    });
  }
  const r = await applyEngagementGate(db, { now: NOW, strict: true });
  assertEquals(r.strictViews, 0);
  for (const [visitor, bot_score, bot_score_detail] of own) {
    assertEquals(await view(db, visitor), { bot_score, bot_score_detail });
  }
  await db.close();
});

// ── Hot keys ────────────────────────────────────────────────────────────────
//
// Thousands of rows on one session id or one visitor id. The plan tests above
// are what keep these linear; these check the verdicts stay right when the
// index holds none, some or all of a key's rows.

const HOT = 150;

Deno.test("gate — a session of clean views, passive events and bot-scored gestures is judged row by row", async () => {
  const db = createTestDb();
  await db.exec("BEGIN");
  for (let i = 0; i < HOT; i++) {
    const created_at = at(31 + i * (148 / HOT));
    const row = { site_id: SITE, session_id: "hot-s", visitor_id: "hs" };
    await insertView(db, { ...row, created_at });
    await insertEvent(db, { ...row, event_type: "web_vital", created_at });
    await insertEvent(db, {
      ...row,
      event_type: "click",
      bot_score: 60,
      created_at,
    });
  }
  await db.exec("COMMIT");
  // None of the session's 150 gestures is clean, so none is in the index.
  const indexed = await db.queryOne<{ n: number }>(
    `SELECT COUNT(*) AS n FROM semantic_events INDEXED BY idx_se_clean_interaction
      WHERE bot_score BETWEEN 0 AND 49 AND event_type IN (${INTERACTION_SQL_LIST})`,
  );
  assertEquals(indexed?.n, 0);
  const r = await applyEngagementGate(db, { now: NOW, strict: true });
  assertEquals(r.strictViews, HOT);
  assertEquals(r.strictEvents, HOT, "the bot-scored gestures are left as is");
  const again = await applyEngagementGate(db, { now: NOW, strict: true });
  assertEquals(again.strictViews + again.strictEvents, 0);
  await db.close();
});

Deno.test("gate — a busy sessionless visitor is shielded only around its gestures", async () => {
  const db = createTestDb();
  await db.exec("BEGIN");
  const row = { site_id: SITE, session_id: null, visitor_id: "hot-v" };
  // One view and one passive event a minute, 31 to 179 minutes ago.
  for (let age = 31; age <= 179; age++) {
    await insertView(db, { ...row, created_at: at(age) });
    await insertEvent(db, {
      ...row,
      event_type: "web_vital",
      created_at: at(age),
    });
  }
  // One clean gesture 100 minutes ago, and bot-scored ones every minute.
  await insertEvent(db, { ...row, event_type: "click", created_at: at(100) });
  for (let age = 31; age <= 179; age++) {
    await insertEvent(db, {
      ...row,
      event_type: "click",
      bot_score: 60,
      created_at: at(age),
    });
  }
  await db.exec("COMMIT");
  const r = await applyEngagementGate(db, { now: NOW, strict: true });
  // Rows aged 70 to 130 inclusive are within 30 minutes of the gesture.
  const shielded = 130 - 70 + 1;
  assertEquals(r.strictViews, 149 - shielded);
  assertEquals(r.strictEvents, 149 - shielded);
  const kept = await db.queryOne<{ lo: string; hi: string; n: number }>(
    `SELECT MIN(created_at) AS lo, MAX(created_at) AS hi, COUNT(*) AS n
       FROM visitor_views WHERE bot_score = 0`,
  );
  assertEquals(kept, { lo: at(130), hi: at(70), n: shielded });
  await db.close();
});

// ── Startup ─────────────────────────────────────────────────────────────────

Deno.test("gate — startup builds its indexes on an existing database, and twice is safe", async () => {
  const dir = await Deno.makeTempDir();
  const path = `${dir}/existing.db`;
  const raw = new DatabaseSync(path);
  raw.exec(SCHEMA_SQL);
  // A database from before this phase: no validated column, no gesture
  // index built for today's event list, and the index an earlier build of
  // this branch created.
  raw.exec("ALTER TABLE visitor_views DROP COLUMN validated");
  raw.exec("DROP INDEX idx_se_clean_interaction");
  raw.exec(
    `CREATE INDEX idx_se_clean_interaction
     ON semantic_events(site_id, session_id, visitor_id, created_at)
     WHERE bot_score BETWEEN 0 AND 49 AND event_type IN ('click')`,
  );
  raw.exec("CREATE INDEX idx_vv_session ON visitor_views(site_id, session_id)");
  // And the events-by-session index every release up to this one created;
  // nothing reads it any more, so startup drops it.
  raw.exec(
    "CREATE INDEX idx_se_session ON semantic_events(site_id, session_id, event_type)",
  );
  raw.exec(
    `INSERT INTO visitor_views (visitor_id, path, site_id, session_id)
     VALUES ('v1', '/', 'site', 's1'), ('v2', '/', 'site', NULL)`,
  );
  raw.exec(
    `INSERT INTO semantic_events (event_type, site_id, session_id, visitor_id)
     VALUES ('engage', 'site', 's1', 'v1'), ('web_vital', 'site', 's1', 'v1')`,
  );
  raw.close();

  const code = `
    import { initDb } from "@/lib/db/database.ts";
    import { applyEngagementGate } from "@/lib/engagement-gate.ts";
    const db = await initDb();
    const rows = await db.query("SELECT name, sql FROM sqlite_master WHERE type = 'index' AND name IN ('idx_se_clean_interaction', 'idx_vv_validated', 'idx_vv_session', 'idx_se_session') ORDER BY name");
    const n = await db.queryOne("SELECT (SELECT COUNT(*) FROM visitor_views) + (SELECT COUNT(*) FROM semantic_events) AS n");
    await applyEngagementGate(db, { strict: true });
    console.log(JSON.stringify({ indexes: rows.map((r) => r.sql.replace(/\\s+/g, " ").replace("IF NOT EXISTS ", "")), rows: n.n }));
    Deno.exit(0);`;
  const config = new URL("../deno.json", import.meta.url).pathname;
  for (const start of ["first", "second"]) {
    const out = await new Deno.Command(Deno.execPath(), {
      args: ["eval", "--config", config, code],
      env: { ECHELON_DB_PATH: path },
      stdout: "piped",
      stderr: "piped",
    }).output();
    const stderr = new TextDecoder().decode(out.stderr);
    assertEquals(out.success, true, `${start} start: ${stderr}`);
    const lines = new TextDecoder().decode(out.stdout).trim().split("\n");
    assertEquals(JSON.parse(lines[lines.length - 1]), {
      indexes: [GESTURE_INDEX_SQL, VALIDATED_INDEX_SQL],
      rows: 4,
    }, `${start} start`);
  }
  await Deno.remove(dir, { recursive: true });
});
