// Echelon Analytics — View Validator
//
// bot_score is suspicion: computed when the request arrives, from signals a
// client can partly fake. `validated` is proof, set here after the fact: the
// view's session produced an INTERACTION event (event-classes.ts) and showed
// that the page outlived its initial load.
//
// A view is validated when all of these hold:
//   1. its own bot_score is clean;
//   2. its session has an interaction event with a clean score;
//   3. liveness — either
//        a. a session_end reports dwell_s >= 2 (the page's unload handler
//           actually ran, which a one-second headless load that gets killed
//           never reaches), or
//        b. an interaction arrived at least 10 s after the view AND the
//           session has two distinct interaction types (one late scripted
//           event on its own proves nothing).
//
// Matching is by session, not by view: the pageview beacon is sent up to a
// second after the gesture that triggers it, so the `engage` that proves a
// view is normally stamped just before it.
//
// Views with no session id (sessionStorage blocked) match on visitor id, and
// only against events that also have no session id.
//
// On anonymised sites (ECHELON_ANONYMIZE_SITES) every view matches on the
// stored visitor id, against that visitor's events whatever session id they
// carry. There the stored session id is one of 50 names shared by unrelated
// visits, so matching on it would let one visitor's gesture validate
// everyone else who drew the same name. The engagement gate bounds this
// match to 30 minutes either side of the row; here the lookback already
// does, since the view and the event both lie inside its 15 minutes.
//
// Only events inside the lookback count, for every part of the rule.
//
// Every signal used here is a client claim. Nothing here lets one claim
// validate alone, and callers that need certainty about a cohort (the session
// classifier) do not trust `validated` for it.
//
// Cost. node:sqlite is synchronous and this runs every minute. One client can
// put thousands of events and views on one session id, and a key keeps its
// history for the whole retention period, so a run may not look events up
// per view: that is quadratic in a number a stranger controls. Instead each
// run reads the events inside the lookback once, by time
// (idx_se_created_bot), into one summary row per key, and then matches each
// fresh view to its summary row by primary key. The cost is linear in the
// rows inside the lookback, wherever they are concentrated.
// tests/view-validator_test.ts pins the plans.

import { anonymizedSiteSql } from "./anonymize.ts";
import type { DbAdapter } from "./db/adapter.ts";
import { CLEAN_SQL } from "./bot-threshold.ts";
import { INTERACTION_SQL_LIST } from "./event-classes.ts";

const INTERVAL_MS = 60_000;
/** Covers a normal read: the dwell evidence only arrives when they leave. */
const LOOKBACK_MS = 15 * 60_000;
const LATE_INTERACTION_SECONDS = 10;
const MIN_DWELL_SECONDS = 2;

/** A server-generated ISO timestamp as a SQL string literal. */
function sqlTime(ms: number): string {
  return `'${new Date(ms).toISOString()}'`;
}

/** The statements of one run, in the order they run. */
export interface ValidatorStatements {
  /** Creates the per-connection summary table, once. */
  create: string;
  clear: string;
  /**
   * One summary row per key that has a clean interaction in the lookback.
   * The id leads the key because it is the term that differs between rows,
   * which is what the grouping sort compares first.
   */
  collect: string;
  validate: string;
}

/**
 * The key a row is matched on: `pass` 's' with its session id, or 'v' with
 * its visitor id when it has no session id or its site is anonymised. `t`
 * is a table name or alias.
 */
function keySql(t: string): { pass: string; id: string } {
  const anonymised = anonymizedSiteSql(`${t}.site_id`);
  const byVisitor = anonymised
    ? `(${t}.session_id IS NULL OR ${anonymised})`
    : `${t}.session_id IS NULL`;
  return {
    pass: `CASE WHEN ${byVisitor} THEN 'v' ELSE 's' END`,
    id: anonymised
      ? `CASE WHEN ${byVisitor} THEN ${t}.visitor_id ELSE ${t}.session_id END`
      : `COALESCE(${t}.session_id, ${t}.visitor_id)`,
  };
}

/**
 * The validator's statements. `cutoff` comes from sqlTime(), never from a
 * request. Exposed for plan tests.
 */
export function validatorSql(cutoff: string): ValidatorStatements {
  const key = keySql("semantic_events");
  const view = keySql("visitor_views");
  const isInteraction = `event_type IN (${INTERACTION_SQL_LIST})`;
  // CASE, not AND: SQLite does not promise to evaluate json_valid() first,
  // and json_extract() raises on malformed input.
  const realDwell = `event_type = 'session_end'
              AND CAST(CASE WHEN json_valid(data)
                            THEN json_extract(data, '$.dwell_s') END AS REAL)
                  >= ${MIN_DWELL_SECONDS}`;

  return {
    create: `CREATE TEMP TABLE IF NOT EXISTS view_proof (
        id TEXT NOT NULL,
        pass TEXT NOT NULL,
        site_id TEXT NOT NULL,
        dwelled INTEGER NOT NULL,
        types INTEGER NOT NULL,
        last_interaction TEXT NOT NULL,
        PRIMARY KEY (id, pass, site_id)
      ) WITHOUT ROWID`,
    clear: `DELETE FROM temp.view_proof`,
    collect: `INSERT INTO temp.view_proof
        (id, pass, site_id, dwelled, types, last_interaction)
      SELECT id, pass, site_id,
             MAX(dwelled), COUNT(DISTINCT gesture), MAX(gesture_at)
        FROM (
          SELECT ${key.id} AS id,
                 ${key.pass} AS pass,
                 site_id,
                 CASE WHEN ${isInteraction} THEN event_type END AS gesture,
                 CASE WHEN ${isInteraction} THEN created_at END AS gesture_at,
                 CASE WHEN ${realDwell} THEN 1 ELSE 0 END AS dwelled
            FROM semantic_events INDEXED BY idx_se_created_bot
           WHERE created_at >= ${cutoff}
             AND ${CLEAN_SQL}
             AND (${isInteraction} OR event_type = 'session_end')
        )
       WHERE id IS NOT NULL
       GROUP BY id, pass, site_id
      HAVING COUNT(gesture) > 0`,
    validate: `UPDATE visitor_views INDEXED BY idx_vv_created_bot
        SET validated = 1
      WHERE validated = 0
        AND created_at >= ${cutoff}
        AND ${CLEAN_SQL}
        AND EXISTS (
          SELECT 1 FROM temp.view_proof p
           WHERE p.id = ${view.id}
             AND p.pass = ${view.pass}
             AND p.site_id = visitor_views.site_id
             AND (p.dwelled = 1
                  OR (p.types >= 2
                      AND p.last_interaction >=
                          strftime('%Y-%m-%dT%H:%M:%fZ', visitor_views.created_at,
                                   '+${LATE_INTERACTION_SECONDS} seconds'))))`,
  };
}

/** Validate recent views. Returns how many rows were newly validated. */
export async function validateViews(
  db: DbAdapter,
  now: number = Date.now(),
): Promise<number> {
  const sql = validatorSql(sqlTime(now - LOOKBACK_MS));
  // One transaction: the summary table is shared by every run on this
  // connection, and transactions are serialized.
  const total = await db.transaction(async (tx) => {
    await tx.exec(sql.create);
    await tx.run(sql.clear);
    await tx.run(sql.collect);
    const changes = (await tx.run(sql.validate)).changes;
    await tx.run(sql.clear);
    return changes;
  });
  if (total > 0) {
    console.log(`[echelon] view-validator: validated ${total} views`);
  }
  return total;
}

let timer: ReturnType<typeof setInterval> | null = null;
let running = false;

/** Start the background validator. */
export function startViewValidator(db: DbAdapter): void {
  if (timer) return;
  timer = setInterval(() => {
    if (running) return;
    running = true;
    validateViews(db)
      .catch((e) => console.error("[echelon] view-validator: error", e))
      .finally(() => {
        running = false;
      });
  }, INTERVAL_MS);
  console.log(
    `[echelon] view-validator: started (every ${INTERVAL_MS / 1000}s, ` +
      `lookback ${LOOKBACK_MS / 60_000}min)`,
  );
}

/** Stop the background validator. */
export function stopViewValidator(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}
