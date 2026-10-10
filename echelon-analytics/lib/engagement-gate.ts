// Echelon Analytics — Engagement Gate
//
// The negative counterpart of the view validator. The validator marks views
// whose session interacted; this judges views whose session had time to
// interact and did not.
//
// Default mode (always on), views aged 5–30 minutes with no interaction:
//   - +15, marked `no_events` (the mark's value is the 15 added). Not
//     decisive alone. Passive events (bounce, session_end, web vitals) used
//     to shield a view from this; a headless page load emits all of them, so
//     they no longer do.
//   - if the view also never proved work, it is raised to the threshold
//     instead, marked `unproven` (the mark's value is what that added: the
//     threshold minus the score before). "Never proved work" is a `pow` penalty, or
//     a penalty waived only because the visitor key had proved work
//     (`pow_ok_by` = "v"): in cookieless mode that key is shared by everyone
//     behind one IP and user agent, so it says nothing about this client. A
//     missing token is only 30 at write time because a browser that cannot
//     run WebAssembly looks the same as a bot; this is where that
//     forgiveness is withdrawn from clients that also never behaved like a
//     person.
//
// Both default-mode marks are provisional. A reader who scrolls with a wheel
// or trackpad makes no gesture the tracker counts until their first click or
// key press, which can come after the view was judged. So every sweep, in
// either mode and before it penalises anything, first forgives: a view up to
// 180 minutes old that carries `no_events` or `unproven`, and for which an
// interaction now exists under the same rule that judged it, gets exactly
// what the mark added subtracted and the mark removed. It is then clean
// again and the view validator can validate it. A view some other job has
// judged since (`correlated`, `classifier`, `no_engagement` in its detail) is
// left as it is, and so is any view of a visitor in excluded_visitors.
// Strict-mode marks are not undone.
//
// That last rule only works if those jobs can mark the view. The correlator
// and strict mode judge clean rows, and a view this gate has raised to the
// threshold is no longer clean, so they would pass over it, leave no mark,
// and a later gesture would hand back a row they meant to condemn. Both
// therefore also judge a view that is over the threshold only because of
// this gate's provisional marks (GATE_RAISED_ONLY_SQL): they keep the marks,
// add their own on top, and the view is then never forgiven.
//
// Strict mode (ECHELON_REQUIRE_ENGAGEMENT=true), sessions aged 30–180 minutes
// with no interaction: views and events are moved to NO_ENGAGEMENT_SCORE,
// marked `no_engagement`. Nothing is written to excluded_visitors: someone
// who bounces today must be able to count tomorrow.
//
// Validated views, and the events of a session that owns one, are never
// touched: those events are the evidence the validation rests on.
//
// "Interaction" is a clean INTERACTION event (event-classes.ts) on the same
// site, found in one of two ways, each a separate statement:
//   - by session, for rows that have a session id: any such event in the
//     session, whenever it happened. The age windows above select which rows
//     are judged; they never limit which gestures count, so a row's verdict
//     does not change because the row or the gesture aged. It changes only
//     when a gesture arrives that was not there before, which is what the
//     forgive step is for.
//   - by visitor, for rows with no session id (sessionStorage blocked): such
//     an event by the same visitor, also with no session id, within 30
//     minutes either side of the row itself. A visitor id outlives a visit,
//     so the match is bounded, and bounded by the row's own time for the
//     same reason as above.
//   - on anonymised sites (ECHELON_ANONYMIZE_SITES), for every row: such an
//     event by the same stored visitor id within 30 minutes either side of
//     the row, whatever session id either carries. There the stored session
//     id is one of 50 names that unrelated visits share, so it identifies
//     nobody and is never used; the stored visitor id is what one visitor's
//     views and events have in common. Rows of these sites are judged by
//     this rule only, and "owns a validated view" is asked of the visitor.
//
// Cost. node:sqlite is synchronous, and one client can put thousands of rows
// on a single session id or visitor id, so a lookup may not walk "the other
// rows with this key": that is quadratic in a number a stranger controls.
// Every lookup here is a search of a partial index that holds only the rows
// that answer it (idx_se_clean_interaction and idx_vv_validated, and their
// visitor-keyed twins idx_se_clean_interaction_visitor and
// idx_vv_validated_visitor for anonymised sites; see lib/db/schema.ts and
// migrate()), on a key that covers every other term, so
// the first entry it reaches decides and a sweep costs one search per row in
// the window. The statements name their index: if one is missing or was
// built for a different predicate they fail, loudly, instead of falling back
// to a plan that stalls the process. tests/engagement-gate_test.ts pins the
// plans. Adding a term to a lookup that is neither in its index key nor in
// the index's WHERE clause breaks this without changing the plan text.

import { anonymizedSiteSql } from "./anonymize.ts";
import type { DbAdapter } from "./db/adapter.ts";
import {
  BOT_SQL,
  BOT_THRESHOLD,
  CLEAN_SQL,
  cleanSql,
  NO_ENGAGEMENT_SCORE,
} from "./bot-threshold.ts";
import { REQUIRE_ENGAGEMENT } from "./config.ts";
import { INTERACTION_SQL_LIST } from "./event-classes.ts";

const SETTLE_MS = 5 * 60_000;
const DEFAULT_MAX_AGE_MS = 30 * 60_000;
const NO_EVENTS_PENALTY = 15;

const STRICT_GRACE_MS = 30 * 60_000;
const STRICT_MAX_AGE_MS = 180 * 60_000;

/** How long a default-mode mark can still be undone by a late gesture. */
const FORGIVE_MAX_AGE_MS = 180 * 60_000;
/** Marks of jobs that have judged a view since; such a view is not forgiven. */
const JUDGED_SINCE = ["correlated", "classifier", "no_engagement"];

/** How far either side of a sessionless row its visitor's gestures count. */
const VISITOR_MATCH_MINUTES = 30;

/**
 * The view's stored detail shows it never proved work itself: it carries a
 * PoW penalty, or the penalty was waived by the visitor key alone. The
 * patterns match the JSON exactly as lib/beacon.ts serialises it.
 */
const UNPROVEN_SQL = `(bot_score_detail LIKE '%"pow":%'
             OR bot_score_detail LIKE '%"pow_ok_by":"v"%')`;

/** What the provisional marks added to a row's score; needs valid JSON. */
const PROVISIONAL_SQL = `(${markAmount("unproven")})
                 + (${markAmount("no_events", NO_EVENTS_PENALTY)})`;

/**
 * The view's visitor is not in excluded_visitors (an operator's exclusion or
 * the session classifier's). A gesture recorded before the exclusion must
 * not release that visitor's views. Looked up by the table's primary key,
 * named so the statement fails rather than scan if it is ever gone.
 */
const NOT_EXCLUDED_SQL = `NOT EXISTS (
      SELECT 1 FROM excluded_visitors ex
          INDEXED BY sqlite_autoindex_excluded_visitors_1
       WHERE ex.visitor_id = visitor_views.visitor_id)`;

const NOT_JUDGED_SINCE_SQL = JUDGED_SINCE.map((key) =>
  `bot_score_detail NOT LIKE '%"${key}"%'`
).join("\n       AND ");

/**
 * A visitor_views row that is at or over the threshold only because of this
 * gate's provisional marks: without what `unproven` and `no_events` added it
 * would be clean, and no other job has judged it. Such a row is still open
 * to a verdict (see the header). The CASE keeps the JSON functions away from
 * a detail that is not JSON, whatever order the terms are evaluated in.
 */
export const GATE_RAISED_ONLY_SQL = `(${BOT_SQL}
       AND ${NOT_JUDGED_SINCE_SQL}
       AND ${
  cleanSql(`(CASE WHEN json_valid(bot_score_detail)
                  THEN bot_score - (${PROVISIONAL_SQL})
                  ELSE -1 END)`)
})`;

export interface GateResult {
  /** Views whose `no_events` or `unproven` mark a later gesture undid. */
  forgiven: number;
  unproven: number;
  noEvents: number;
  strictViews: number;
  strictEvents: number;
}

/** A server-generated ISO timestamp as a SQL string literal. */
function sqlTime(ms: number): string {
  return `'${new Date(ms).toISOString()}'`;
}

/** Which rows a pass judges and how it matches them; see the header. */
type Pass = "session" | "visitor" | "anonymised";

/**
 * "This row has an interaction", for a row of `table` (the table being
 * updated). See the header for the matching rules and for why the index is
 * named. The last two terms repeat the index's WHERE clause, which is what
 * lets SQLite use it.
 */
function interactionExists(table: string, pass: Pass): string {
  const edge = (offset: string) =>
    `strftime('%Y-%m-%dT%H:%M:%fZ', ${table}.created_at, '${offset}')`;
  const nearby = `si.visitor_id = ${table}.visitor_id
         AND si.created_at >= ${edge(`-${VISITOR_MATCH_MINUTES} minutes`)}
         AND si.created_at <= ${edge(`+${VISITOR_MATCH_MINUTES} minutes`)}`;
  const key = pass === "session"
    ? `si.session_id = ${table}.session_id`
    : pass === "visitor"
    ? `si.session_id IS NULL
         AND ${nearby}`
    : nearby;
  const index = pass === "anonymised"
    ? "idx_se_clean_interaction_visitor"
    : "idx_se_clean_interaction";
  return `EXISTS (
      SELECT 1 FROM semantic_events si INDEXED BY ${index}
       WHERE si.site_id = ${table}.site_id
         AND ${key}
         AND ${cleanSql("si.bot_score")}
         AND si.event_type IN (${INTERACTION_SQL_LIST}))`;
}

/**
 * "The session (or sessionless visitor, or on an anonymised site the
 * visitor) this event belongs to owns a validated view." Not bounded in
 * time in any pass.
 */
function ownsValidatedView(pass: Pass): string {
  const key = pass === "session"
    ? `vv.session_id = semantic_events.session_id`
    : pass === "visitor"
    ? `vv.session_id IS NULL
         AND vv.visitor_id = semantic_events.visitor_id`
    : `vv.visitor_id = semantic_events.visitor_id`;
  const index = pass === "anonymised"
    ? "idx_vv_validated_visitor"
    : "idx_vv_validated";
  return `EXISTS (
      SELECT 1 FROM visitor_views vv INDEXED BY ${index}
       WHERE vv.site_id = semantic_events.site_id
         AND ${key}
         AND vv.validated = 1)`;
}

/**
 * Set one key in a bot_score_detail value that may be NULL or not JSON.
 * `value` is a SQL expression for an integer; in an UPDATE it sees the row as
 * it was before the statement.
 */
function setDetail(key: string, value: string): string {
  return `CASE WHEN json_valid(bot_score_detail)
               THEN json_set(bot_score_detail, '$.${key}', ${value})
               ELSE json_object('${key}', ${value}) END`;
}

/**
 * What a default-mode mark added to the score, 0 if the row does not carry
 * it. `legacyTrue` is the amount for a mark stored as `true`, which is how
 * `no_events` was written before it recorded its amount.
 */
function markAmount(key: string, legacyTrue = 0): string {
  return `CASE json_type(bot_score_detail, '$.${key}')
               WHEN 'integer' THEN json_extract(bot_score_detail, '$.${key}')
               WHEN 'true' THEN ${legacyTrue}
               ELSE 0 END`;
}

/** The gate's UPDATE statements for one pass, in the order they run. */
export interface GateStatements {
  forgive: string;
  unproven: string;
  noEvents: string;
  strictEvents: string;
  strictViews: string;
}

function passSql(pass: Pass, now: number): GateStatements {
  // Which rows this pass judges: every row belongs to exactly one pass.
  // With no anonymised site configured the first two passes are unchanged
  // and the third does not exist.
  const mine = (table: string) => {
    const anonymised = anonymizedSiteSql(`${table}.site_id`);
    if (pass === "anonymised") return anonymised ?? "0";
    const own = `${table}.session_id IS ${
      pass === "session" ? "NOT NULL" : "NULL"
    }`;
    return anonymised ? `${own}\n       AND NOT ${anonymised}` : own;
  };
  const aged = (maxAgeMs: number, minAgeMs: number) =>
    `created_at >= ${sqlTime(now - maxAgeMs)}
       AND created_at <= ${sqlTime(now - minAgeMs)}`;

  const idleView = (window: string, open = CLEAN_SQL) =>
    `${window}
       AND ${open}
       AND validated = 0
       AND ${mine("visitor_views")}
       AND NOT ${interactionExists("visitor_views", pass)}`;
  const settled = idleView(aged(DEFAULT_MAX_AGE_MS, SETTLE_MS));
  const strictWindow = aged(STRICT_MAX_AGE_MS, STRICT_GRACE_MS);
  const stamp = setDetail("no_engagement", String(NO_ENGAGEMENT_SCORE));

  // json_valid() never raises, and the CASE in each SET expression keeps
  // the JSON functions away from a detail that is not JSON whatever order
  // SQLite evaluates the WHERE terms in.
  return {
    forgive: `UPDATE visitor_views
        SET bot_score = MAX(bot_score - CASE WHEN json_valid(bot_score_detail)
              THEN ${PROVISIONAL_SQL}
              ELSE 0 END, 0),
            bot_score_detail = CASE WHEN json_valid(bot_score_detail)
              THEN NULLIF(json_remove(bot_score_detail,
                                      '$.unproven', '$.no_events'), '{}')
              ELSE bot_score_detail END
      WHERE ${aged(FORGIVE_MAX_AGE_MS, SETTLE_MS)}
        AND ${mine("visitor_views")}
        AND (bot_score_detail LIKE '%"no_events":%'
             OR bot_score_detail LIKE '%"unproven":%')
        AND ${NOT_JUDGED_SINCE_SQL}
        AND json_valid(bot_score_detail)
        AND ${NOT_EXCLUDED_SQL}
        AND ${interactionExists("visitor_views", pass)}`,
    // The view is clean here, so the amount is at least 1.
    unproven: `UPDATE visitor_views
        SET bot_score = ${BOT_THRESHOLD},
            bot_score_detail = ${
      setDetail("unproven", `${BOT_THRESHOLD} - bot_score`)
    }
      WHERE ${settled}
        AND ${UNPROVEN_SQL}`,
    noEvents: `UPDATE visitor_views
        SET bot_score = bot_score + ${NO_EVENTS_PENALTY},
            bot_score_detail = ${
      setDetail("no_events", String(NO_EVENTS_PENALTY))
    }
      WHERE ${settled}
        AND COALESCE(bot_score_detail, '') NOT LIKE '%"no_events"%'`,
    strictEvents: `UPDATE semantic_events
        SET bot_score = ${NO_ENGAGEMENT_SCORE},
            bot_score_detail = ${stamp}
      WHERE ${strictWindow}
        AND ${CLEAN_SQL}
        AND ${mine("semantic_events")}
        AND NOT ${interactionExists("semantic_events", pass)}
        AND NOT ${ownsValidatedView(pass)}`,
    // Also views only this gate's provisional marks hold over the threshold:
    // without the stamp a later gesture would forgive them, and strict mode
    // is not undone. MAX, because such a view may already be above the
    // score strict mode moves rows to and is never lowered; for a clean row
    // it is that score, as before. The provisional marks stay: with them
    // the detail still accounts for the score.
    strictViews: `UPDATE visitor_views
        SET bot_score = MAX(bot_score, ${NO_ENGAGEMENT_SCORE}),
            bot_score_detail = ${stamp}
      WHERE ${
      idleView(strictWindow, `(${CLEAN_SQL} OR ${GATE_RAISED_ONLY_SQL})`)
    }`,
  };
}

/** The statements for rows that have a session id. Exposed for plan tests. */
export function sessionPassSql(now: number): GateStatements {
  return passSql("session", now);
}
/** The statements for rows with no session id. Exposed for plan tests. */
export function visitorPassSql(now: number): GateStatements {
  return passSql("visitor", now);
}

/**
 * The statements for every row of an anonymised site, or null when no site
 * is anonymised. Exposed for plan tests.
 */
export function anonymisedPassSql(now: number): GateStatements | null {
  return anonymizedSiteSql("site_id") ? passSql("anonymised", now) : null;
}

/** Run the gate once. `strict` defaults to ECHELON_REQUIRE_ENGAGEMENT. */
export async function applyEngagementGate(
  db: DbAdapter,
  opts: { now?: number; strict?: boolean } = {},
): Promise<GateResult> {
  const now = opts.now ?? Date.now();
  const strict = opts.strict ?? REQUIRE_ENGAGEMENT;
  const passes = [sessionPassSql(now), visitorPassSql(now)];
  const anonymised = anonymisedPassSql(now);
  if (anonymised) passes.push(anonymised);
  const result: GateResult = {
    forgiven: 0,
    unproven: 0,
    noEvents: 0,
    strictViews: 0,
    strictEvents: 0,
  };

  // ── Forgive ───────────────────────────────────────────────────────────────
  // Before anything is penalised, so a view forgiven here is judged by the
  // statements below as the clean view it is again. They leave it alone: the
  // interaction that forgave it is the one they look for.
  for (const sql of passes) {
    result.forgiven += (await db.run(sql.forgive)).changes;
  }

  // ── Default mode ──────────────────────────────────────────────────────────
  // `unproven` runs first: a view raised by it is no longer clean, so the
  // +15 skips it.
  for (const sql of passes) {
    result.unproven += (await db.run(sql.unproven)).changes;
  }
  for (const sql of passes) {
    result.noEvents += (await db.run(sql.noEvents)).changes;
  }

  // ── Strict mode ───────────────────────────────────────────────────────────
  if (strict) {
    // One transaction, so no reader sees a session's events rescored and its
    // views not. Neither statement changes what the other reads: clean
    // interaction events and validated views are never rescored.
    await db.transaction(async (tx) => {
      for (const sql of passes) {
        result.strictEvents += (await tx.run(sql.strictEvents)).changes;
        result.strictViews += (await tx.run(sql.strictViews)).changes;
      }
    });
  }

  const total = result.forgiven + result.unproven + result.noEvents +
    result.strictViews + result.strictEvents;
  if (total > 0) {
    console.log(
      `[echelon] engagement-gate: forgiven=${result.forgiven} ` +
        `unproven=${result.unproven} ` +
        `no_events=${result.noEvents} strict_views=${result.strictViews} ` +
        `strict_events=${result.strictEvents}`,
    );
  }
  return result;
}
