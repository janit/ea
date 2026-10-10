// On an anonymised site the stored session id is one of 50 names, so
// unrelated visits share it. The validator and the engagement gate must
// therefore judge such a site's rows by the stored visitor id, which the
// views and events of one visitor do share, and never by session id.

import { assert, assertEquals } from "@std/assert";
import { DatabaseSync } from "node:sqlite";
import {
  anonymizedSiteSql,
  anonymizeView,
  shouldAnonymize,
  storedVisitorId,
} from "@/lib/anonymize.ts";
import { ANONYMIZE_SITES } from "@/lib/config.ts";
import {
  CLEAN_INTERACTION_VISITOR_INDEX_SQL,
  SCHEMA_SQL,
  VALIDATED_VISITOR_INDEX_SQL,
} from "@/lib/db/schema.ts";
import { SqliteAdapter } from "@/lib/db/sqlite-adapter.ts";
import {
  anonymisedPassSql,
  applyEngagementGate,
  sessionPassSql,
} from "@/lib/engagement-gate.ts";
import { validateViews, validatorSql } from "@/lib/view-validator.ts";
import { insertEvent, insertView } from "./_helpers.ts";
import type { DbAdapter } from "@/lib/db/adapter.ts";
import type { ViewRecord } from "@/types.ts";

const NOW = Date.parse("2026-10-09T12:00:00.000Z");
const at = (minAgo: number) => new Date(NOW - minAgo * 60_000).toISOString();
const ANON = "anon-proof-site";
const PLAIN = "plain-proof-site";

/** An in-memory DB with every index a started instance has. */
function createTestDb(): DbAdapter {
  const raw = new DatabaseSync(":memory:");
  raw.exec(SCHEMA_SQL);
  raw.exec(
    "CREATE INDEX idx_vv_validated ON visitor_views(site_id, session_id, visitor_id) WHERE validated = 1",
  );
  raw.exec(VALIDATED_VISITOR_INDEX_SQL);
  return new SqliteAdapter(raw);
}

/** What the real anonymisation path stores for this visitor and session. */
async function stored(visitor: string, sid: string | null) {
  const v = await anonymizeView(
    { visitor_id: visitor, session_id: sid, path: "/" } as ViewRecord,
  );
  assertEquals(v.visitor_id, await storedVisitorId(ANON, visitor));
  return { visitor_id: v.visitor_id, session_id: v.session_id ?? null };
}

interface Cast {
  /** Gestures. */
  a: { visitor_id: string; session_id: string | null };
  /** Shares A's session name, never gestures. */
  b: { visitor_id: string; session_id: string | null };
  /** Shares A's session name, never gestures, has no token. */
  c: { visitor_id: string; session_id: string | null };
}

/**
 * Three visitors whose different raw session ids are stored under the same
 * name, found by trying ids until the real name table collides.
 */
async function cast(): Promise<Cast> {
  const byName = new Map<string, string[]>();
  for (let i = 0; i < 2000; i++) {
    const sid = `raw-session-${i}`;
    const name = (await stored("probe", sid)).session_id!;
    const sids = byName.get(name) ?? [];
    sids.push(sid);
    byName.set(name, sids);
    if (sids.length === 3) {
      const [a, b, c] = await Promise.all(
        sids.map((s, n) => stored(`visitor-${"abc"[n]}`, s)),
      );
      assertEquals(new Set([a.session_id, b.session_id, c.session_id]).size, 1);
      assertEquals(
        new Set([a.visitor_id, b.visitor_id, c.visitor_id]).size,
        3,
      );
      return { a, b, c };
    }
  }
  throw new Error("no three session ids share a stored name");
}

/** A's view with a gesture and a real dwell; B's and C's with a dwell only. */
async function seed(db: DbAdapter, site: string, who: Cast, minAgo: number) {
  for (const [key, p] of Object.entries(who)) {
    await insertView(db, {
      ...p,
      site_id: site,
      created_at: at(minAgo),
      bot_score: key === "c" ? 30 : 0,
      bot_score_detail: key === "c" ? '{"pow":30}' : null,
    });
    await insertEvent(db, {
      ...p,
      event_type: "session_end",
      site_id: site,
      data: '{"dwell_s":14}',
      created_at: at(minAgo - 1),
    });
  }
  await insertEvent(db, {
    ...who.a,
    event_type: "engage",
    site_id: site,
    created_at: at(minAgo),
  });
}

async function views(db: DbAdapter, site: string, who: Cast) {
  const out: Record<string, [number, number, string | null]> = {};
  for (const [key, p] of Object.entries(who)) {
    const r = await db.queryOne<
      { bot_score: number; validated: number; bot_score_detail: string | null }
    >(
      "SELECT bot_score, validated, bot_score_detail FROM visitor_views WHERE site_id = ? AND visitor_id = ?",
      site,
      p.visitor_id,
    );
    out[key] = [r!.bot_score, r!.validated, r!.bot_score_detail];
  }
  return out;
}

async function eventScores(db: DbAdapter, site: string, who: Cast) {
  const out: Record<string, number[]> = {};
  for (const [key, p] of Object.entries(who)) {
    out[key] = (await db.query<{ bot_score: number }>(
      "SELECT bot_score FROM semantic_events WHERE site_id = ? AND visitor_id = ? ORDER BY id",
      site,
      p.visitor_id,
    )).map((r) => r.bot_score);
  }
  return out;
}

/** Run `fn` with ANON anonymised, as ECHELON_ANONYMIZE_SITES would. */
async function withAnonSite(fn: (db: DbAdapter, who: Cast) => Promise<void>) {
  ANONYMIZE_SITES.add(ANON);
  const db = createTestDb();
  try {
    await fn(db, await cast());
  } finally {
    ANONYMIZE_SITES.delete(ANON);
    await db.close();
  }
}

Deno.test("anonymised — the SQL site test follows shouldAnonymize", () => {
  assertEquals(anonymizedSiteSql("site_id"), null);
  ANONYMIZE_SITES.add("b.site");
  ANONYMIZE_SITES.add("a-site_1");
  // Never a site id (validateSiteId), so never stored and never emitted.
  ANONYMIZE_SITES.add("x') OR 1=1 --");
  ANONYMIZE_SITES.add("ä");
  try {
    assertEquals(
      anonymizedSiteSql("t.site_id"),
      "lower(t.site_id) IN ('a-site_1', 'b.site')",
    );
    const raw = new DatabaseSync(":memory:");
    for (const id of ["a-site_1", "A-Site_1", "B.SITE", "other", "a-site_10"]) {
      const row = raw.prepare(
        `SELECT ${anonymizedSiteSql("?1")} AS anon`,
      ).get(id) as { anon: number };
      assertEquals(row.anon === 1, shouldAnonymize(id), id);
    }
    raw.close();
  } finally {
    ANONYMIZE_SITES.clear();
  }
});

Deno.test("anonymised — validator: only the visitor who gestured is validated", async () => {
  await withAnonSite(async (db, who) => {
    await seed(db, ANON, who, 3);
    await seed(db, PLAIN, who, 3);
    assertEquals(await validateViews(db, NOW), 4);
    const anon = await views(db, ANON, who);
    assertEquals([anon.a[1], anon.b[1], anon.c[1]], [1, 0, 0]);
    // Not anonymised: the same rows are one session, and it gestured.
    const plain = await views(db, PLAIN, who);
    assertEquals([plain.a[1], plain.b[1], plain.c[1]], [1, 1, 1]);
  });
});

Deno.test("anonymised — validator: a visitor's gesture counts across session names and without one", async () => {
  await withAnonSite(async (db, who) => {
    // View under one session name, gesture under another, dwell under none.
    await insertView(db, { ...who.a, site_id: ANON, created_at: at(3) });
    await insertEvent(db, {
      visitor_id: who.a.visitor_id,
      session_id: "Some Other Name",
      event_type: "engage",
      site_id: ANON,
      created_at: at(3),
    });
    await insertEvent(db, {
      visitor_id: who.a.visitor_id,
      session_id: null,
      event_type: "session_end",
      site_id: ANON,
      data: '{"dwell_s":5}',
      created_at: at(2),
    });
    // A sessionless view of the same visitor is proved by the same events.
    await insertView(db, {
      visitor_id: who.a.visitor_id,
      session_id: null,
      site_id: ANON,
      path: "/two",
      created_at: at(3),
    });
    assertEquals(await validateViews(db, NOW), 2);
  });
});

Deno.test("anonymised — gate: a shared session name shields nobody else", async () => {
  await withAnonSite(async (db, who) => {
    await seed(db, ANON, who, 10);
    await seed(db, PLAIN, who, 10);
    const r = await applyEngagementGate(db, { now: NOW, strict: false });
    assertEquals([r.unproven, r.noEvents], [1, 1]);
    const anon = await views(db, ANON, who);
    assertEquals(anon.a, [0, 0, null]);
    assertEquals(anon.b, [15, 0, '{"no_events":15}']);
    assertEquals(anon.c, [50, 0, '{"pow":30,"unproven":20}']);
    // Not anonymised: the session gestured, so its three views are shielded.
    const plain = await views(db, PLAIN, who);
    assertEquals(plain.a, [0, 0, null]);
    assertEquals(plain.b, [0, 0, null]);
    assertEquals(plain.c, [30, 0, '{"pow":30}']);

    // A late gesture forgives the visitor who made it and nobody who only
    // shares the session name.
    await insertEvent(db, {
      ...who.c,
      event_type: "click",
      site_id: ANON,
      created_at: at(-1),
    });
    const next = await applyEngagementGate(db, {
      now: NOW + 2 * 60_000,
      strict: false,
    });
    assertEquals([next.forgiven, next.unproven, next.noEvents], [1, 0, 0]);
    const after = await views(db, ANON, who);
    assertEquals(after.b, [15, 0, '{"no_events":15}']);
    assertEquals(after.c, [30, 0, '{"pow":30}']);
  });
});

Deno.test("anonymised — gate: a visitor's gesture counts only within 30 minutes of the row, under any session name", async () => {
  await withAnonSite(async (db, who) => {
    // B: gesture 29 minutes before the view, under another session name.
    await insertView(db, { ...who.b, site_id: ANON, created_at: at(10) });
    await insertEvent(db, {
      visitor_id: who.b.visitor_id,
      session_id: "Some Other Name",
      event_type: "click",
      site_id: ANON,
      created_at: at(39),
    });
    // C: gesture 31 minutes before the view, under the view's own name.
    await insertView(db, { ...who.c, site_id: ANON, created_at: at(10) });
    await insertEvent(db, {
      ...who.c,
      event_type: "click",
      site_id: ANON,
      created_at: at(41),
    });
    // A: a view with no session id, gesture with one.
    await insertView(db, {
      visitor_id: who.a.visitor_id,
      session_id: null,
      site_id: ANON,
      created_at: at(10),
    });
    await insertEvent(db, {
      ...who.a,
      event_type: "click",
      site_id: ANON,
      created_at: at(9),
    });
    const r = await applyEngagementGate(db, { now: NOW, strict: false });
    assertEquals([r.unproven, r.noEvents], [0, 1]);
    const v = await views(db, ANON, who);
    assertEquals([v.a[0], v.b[0], v.c[0]], [0, 0, 15]);
  });
});

Deno.test("anonymised — strict gate: only the visitor who never gestured is raised", async () => {
  await withAnonSite(async (db, who) => {
    await seed(db, ANON, who, 60);
    await seed(db, PLAIN, who, 60);
    const r = await applyEngagementGate(db, { now: NOW, strict: true });
    // B and C: one view and one event each.
    assertEquals([r.strictViews, r.strictEvents], [2, 2]);
    const anon = await views(db, ANON, who);
    assertEquals([anon.a[0], anon.b[0], anon.c[0]], [0, 50, 50]);
    assertEquals(await eventScores(db, ANON, who), {
      a: [0, 0],
      b: [50],
      c: [50],
    });
    const plain = await views(db, PLAIN, who);
    assertEquals([plain.a[0], plain.b[0], plain.c[0]], [0, 0, 30]);
    assertEquals(await eventScores(db, PLAIN, who), {
      a: [0, 0],
      b: [0],
      c: [0],
    });
  });
});

Deno.test("anonymised — strict gate: events of a visitor with a validated view are never rescored", async () => {
  await withAnonSite(async (db, who) => {
    // Validated under one session name; passive events under another.
    await insertView(db, {
      ...who.a,
      site_id: ANON,
      created_at: at(170),
      validated: 1,
    });
    await insertEvent(db, {
      visitor_id: who.a.visitor_id,
      session_id: "Some Other Name",
      event_type: "web_vital",
      site_id: ANON,
      created_at: at(60),
    });
    // B shares A's session name and proves nothing by it.
    await insertEvent(db, {
      ...who.b,
      event_type: "web_vital",
      site_id: ANON,
      created_at: at(60),
    });
    const r = await applyEngagementGate(db, { now: NOW, strict: true });
    assertEquals([r.strictViews, r.strictEvents], [0, 1]);
    assertEquals(await eventScores(db, ANON, who), { a: [0], b: [50], c: [] });
  });
});

// ── Cost ────────────────────────────────────────────────────────────────────

async function planOf(db: DbAdapter, sql: string): Promise<string[]> {
  return (await db.query<{ detail: string }>(`EXPLAIN QUERY PLAN ${sql}`))
    .map((r) => r.detail.replace("USING COVERING INDEX", "USING INDEX"));
}

Deno.test("anonymised — every gate lookup is one search on the whole visitor key", async () => {
  await withAnonSite(async (db) => {
    const sql = anonymisedPassSql(NOW)!;
    for (const [name, text] of Object.entries(sql)) {
      const plan = await planOf(db, text);
      const shown = `${name}:\n${plan.join("\n")}`;
      for (const step of plan) {
        assertEquals(step.startsWith("SCAN"), false, shown);
      }
      assertEquals(
        plan.filter((d) => d.startsWith("SEARCH si ")),
        [
          "SEARCH si USING INDEX idx_se_clean_interaction_visitor " +
          "(site_id=? AND visitor_id=? AND created_at>? AND created_at<?)",
        ],
        shown,
      );
      assertEquals(
        plan.filter((d) => d.startsWith("SEARCH vv ")),
        name === "strictEvents"
          ? [
            "SEARCH vv USING INDEX idx_vv_validated_visitor " +
            "(site_id=? AND visitor_id=?)",
          ]
          : [],
        shown,
      );
      assertEquals(
        plan.filter((d) => d.includes("excluded_visitors") || / ex /.test(d)),
        name === "forgive"
          ? [
            "SEARCH ex USING INDEX sqlite_autoindex_excluded_visitors_1 (visitor_id=?)",
          ]
          : [],
        shown,
      );
      assertEquals(plan[0].includes("_created_bot (created_at>?"), true, shown);
    }
  });
});

Deno.test("anonymised — the indexes hold only rows that answer the question", async () => {
  const db = createTestDb();
  const ddl = async (name: string) =>
    (await db.queryOne<{ sql: string }>(
      "SELECT sql FROM sqlite_master WHERE type = 'index' AND name = ?",
      name,
    ))?.sql.replace(/\s+/g, " ").replace("IF NOT EXISTS ", "");
  assertEquals(
    await ddl("idx_se_clean_interaction_visitor"),
    CLEAN_INTERACTION_VISITOR_INDEX_SQL.replace(/\s+/g, " ").replace(
      "IF NOT EXISTS ",
      "",
    ),
  );
  assert(
    (await ddl("idx_se_clean_interaction_visitor"))!.startsWith(
      "CREATE INDEX idx_se_clean_interaction_visitor ON semantic_events(site_id, visitor_id, created_at) WHERE bot_score BETWEEN 0 AND 49 AND event_type IN (",
    ),
  );
  assertEquals(
    await ddl("idx_vv_validated_visitor"),
    "CREATE INDEX idx_vv_validated_visitor ON visitor_views(site_id, visitor_id) WHERE validated = 1",
  );
  await db.close();
});

Deno.test("anonymised — with no anonymised site the other passes are today's statements", () => {
  assertEquals(anonymisedPassSql(NOW), null);
  const before = sessionPassSql(NOW);
  ANONYMIZE_SITES.add(ANON);
  try {
    const during = sessionPassSql(NOW);
    assert(during.noEvents !== before.noEvents);
    assert(during.noEvents.includes(`'${ANON}'`));
    assert(validatorSql("'x'").collect.includes(`'${ANON}'`));
  } finally {
    ANONYMIZE_SITES.delete(ANON);
  }
  assertEquals(sessionPassSql(NOW), before);
  assertEquals(validatorSql("'x'").collect.includes("lower("), false);
});
