// Echelon Analytics — Daily Maintenance
//
// Rolls up visitor_views → visitor_views_daily, purges expired data, VACUUMs.
// Runs at 03:00 UTC via hourly check interval.

import type { DbAdapter } from "./db/adapter.ts";
import { BOT_RETENTION_DAYS, RETENTION_DAYS } from "./config.ts";

const DAILY_ROLLUP_RETENTION_DAYS = 730; // 2 years for rollup tables

/** Yesterday's date as YYYY-MM-DD in UTC. */
function yesterdayUTC(): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

function daysAgoUTC(days: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}

/**
 * Aggregate yesterday's visitor_views into visitor_views_daily.
 * Filters: bot_score BETWEEN 0 AND 49, not in excluded_visitors.
 *
 * Re-runnable: deletes the target date's existing daily rows and re-inserts,
 * atomically in a transaction. This is required (rather than INSERT OR REPLACE
 * alone) so that re-rollups after bot correlator corrections also clear groups
 * that fully converted to bots — those vanish from the SELECT and would
 * otherwise leave a stale clean-visit aggregate behind forever.
 */
export async function rollupDay(
  db: DbAdapter,
  targetDate?: string,
): Promise<number> {
  const date = targetDate ?? yesterdayUTC();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    throw new Error(`rollup: invalid date format: ${date}`);
  }

  // visitor_views_daily is kept for 730 days but visitor_views only for 90, so
  // the rollup is recomputable for a far shorter window than it retains. If the
  // source rows for this date are gone, the unconditional DELETE below would
  // destroy a good aggregate and re-insert nothing — permanently losing the
  // only remaining copy.
  //
  // Guard on the source actually being empty rather than on the retention
  // window, so an explicit re-roll of an older date still works while a purged
  // date is left intact. Counting raw rows regardless of bot_score is
  // deliberate: a day whose views all became bots after correlator corrections
  // must still clear its stale clean-visit aggregate.
  const src = await db.queryOne<{ n: number }>(
    `SELECT COUNT(*) AS n FROM visitor_views
     WHERE (created_at >= (? || 'T00:00:00.000Z'))
       AND (created_at < (date(?, '+1 day') || 'T00:00:00.000Z'))`,
    date,
    date,
  );
  if ((src?.n ?? 0) === 0) {
    const existing = await db.queryOne<{ n: number }>(
      `SELECT COUNT(*) AS n FROM visitor_views_daily WHERE date = ?`,
      date,
    );
    if ((existing?.n ?? 0) > 0) {
      console.warn(
        `[echelon] rollup: ${date} has no raw rows but ${existing?.n} aggregate ` +
          `row(s) — leaving them intact (raw data purged; cannot be rebuilt)`,
      );
      return 0;
    }
  }

  console.log(`[echelon] rollup: aggregating visitor_views for ${date}`);
  const start = Date.now();

  const changes = await db.transaction(async (tx) => {
    // Clear this date's prior aggregates so vanished groups don't linger.
    await tx.run(`DELETE FROM visitor_views_daily WHERE date = ?`, date);

    const result = await tx.run(
      `INSERT INTO visitor_views_daily
        (site_id, date, device_type, country_code, is_returning,
         visits, unique_visitors, avg_interaction_ms)
      SELECT
        site_id,
        ? AS date,
        COALESCE(device_type, 'unknown'),
        COALESCE(country_code, 'unknown'),
        is_returning,
        COUNT(*),
        COUNT(DISTINCT visitor_id),
        COALESCE(CAST(AVG(CASE WHEN interaction_ms > 0 THEN interaction_ms END) AS INTEGER), 0)
      FROM visitor_views
      WHERE (created_at >= (? || 'T00:00:00.000Z'))
        AND (created_at < (date(?, '+1 day') || 'T00:00:00.000Z'))
        AND (bot_score BETWEEN 0 AND 49)
        AND NOT EXISTS (
          SELECT 1 FROM excluded_visitors ev
          WHERE ev.visitor_id = visitor_views.visitor_id
        )
      GROUP BY site_id, COALESCE(device_type, 'unknown'),
               COALESCE(country_code, 'unknown'), is_returning`,
      date,
      date,
      date,
    );
    return result.changes;
  });

  console.log(
    `[echelon] rollup: completed for ${date} in ${
      Date.now() - start
    }ms (${changes} rows)`,
  );
  return changes;
}

/**
 * Purge raw data older than retention period.
 * - visitor_views + semantic_events: configurable (default 90 days)
 * - visitor_views_daily: 2 years
 * - perf_metrics: same as raw data
 * - Experiment metadata: never deleted
 */
export async function purgeExpiredData(
  db: DbAdapter,
  retentionDays: number = RETENTION_DAYS,
  botRetentionDays: number = BOT_RETENTION_DAYS,
): Promise<{
  views_deleted: number;
  events_deleted: number;
  bot_views_deleted: number;
  bot_events_deleted: number;
  daily_deleted: number;
  perf_deleted: number;
}> {
  const rawCutoff = daysAgoUTC(retentionDays);
  const dailyCutoff = daysAgoUTC(DAILY_ROLLUP_RETENTION_DAYS);

  // Clean data (bot_score BETWEEN 0 AND 49)
  // Note: || is string concatenation in SQLite, not logical OR.
  // Parentheses are explicit for clarity and portability.
  const views = await db.run(
    `DELETE FROM visitor_views WHERE (created_at < (? || 'T00:00:00.000Z')) AND (bot_score BETWEEN 0 AND 49)`,
    rawCutoff,
  );

  const events = await db.run(
    `DELETE FROM semantic_events WHERE (created_at < (? || 'T00:00:00.000Z')) AND (bot_score BETWEEN 0 AND 49)`,
    rawCutoff,
  );

  // Bot data (bot_score >= 50 OR bot_score < 0) — separate retention period.
  // bot_score < 0 covers server-ingested events (bot_score=-1) which would
  // otherwise accumulate forever since they match neither the clean nor bot filter.
  const botCutoff = daysAgoUTC(botRetentionDays);

  const botViews = await db.run(
    `DELETE FROM visitor_views WHERE (created_at < (? || 'T00:00:00.000Z')) AND (bot_score >= 50 OR bot_score < 0)`,
    botCutoff,
  );

  const botEvents = await db.run(
    `DELETE FROM semantic_events WHERE (created_at < (? || 'T00:00:00.000Z')) AND (bot_score >= 50 OR bot_score < 0)`,
    botCutoff,
  );

  const daily = await db.run(
    `DELETE FROM visitor_views_daily WHERE date < ?`,
    dailyCutoff,
  );

  const perf = await db.run(
    `DELETE FROM perf_metrics WHERE (recorded_at < (? || 'T00:00:00.000Z'))`,
    rawCutoff,
  );

  return {
    views_deleted: views.changes,
    events_deleted: events.changes,
    bot_views_deleted: botViews.changes,
    bot_events_deleted: botEvents.changes,
    daily_deleted: daily.changes,
    perf_deleted: perf.changes,
  };
}

/**
 * Roll up any date inside the raw retention window that has no completed
 * maintenance_log entry, up to (but excluding) `upTo`.
 *
 * Bounded by retention on the old end and by `upTo` on the new end, so the
 * work is proportional to the outage, not to the age of the instance.
 */
async function backfillMissedRollups(
  db: DbAdapter,
  upTo: string,
  rawCutoff: string,
): Promise<void> {
  const done = new Set(
    (await db.query<{ date: string }>(
      `SELECT date FROM maintenance_log WHERE date >= ? AND date < ?`,
      rawCutoff,
      upTo,
    )).map((r) => r.date),
  );

  // Only consider dates that actually have raw rows. Walking every calendar
  // day in the window instead would "backfill" days with no traffic — and on a
  // fresh instance, every day before it existed — writing a maintenance_log
  // row and an empty rollup for each.
  const candidates = await db.query<{ date: string }>(
    `SELECT DISTINCT substr(created_at, 1, 10) AS date
     FROM visitor_views
     WHERE created_at >= (? || 'T00:00:00.000Z')
       AND created_at < (? || 'T00:00:00.000Z')
     ORDER BY date`,
    rawCutoff,
    upTo,
  );

  const missing = candidates.map((r) => r.date).filter((d) => !done.has(d));
  if (missing.length === 0) return;

  console.log(
    `[echelon] backfilling ${missing.length} missed rollup(s): ${
      missing.join(", ")
    }`,
  );
  for (const iso of missing) {
    await db.run(
      `INSERT OR IGNORE INTO maintenance_log (date, status) VALUES (?, 'started')`,
      iso,
    );
    try {
      const rows = await rollupDay(db, iso);
      await db.run(
        `UPDATE maintenance_log SET status = 'complete', rollup_rows = ?, completed_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE date = ?`,
        rows,
        iso,
      );
    } catch (e) {
      console.error(`[echelon] backfill rollup failed for ${iso}:`, e);
    }
  }
}

/**
 * Run the full daily maintenance cycle:
 * 1. Retry incomplete rollups (bounded to raw retention)
 * 2. Backfill days missed while the process was down
 * 3. Rollup yesterday's visitor_views
 * 4. Purge expired data
 * 5. VACUUM
 */
export async function runDailyMaintenance(db: DbAdapter): Promise<void> {
  const start = Date.now();
  const date = yesterdayUTC();
  console.log("[echelon] daily maintenance: starting");

  // Retry incomplete rollups, bounded to the raw retention window — beyond it
  // the source rows are gone, so retrying forever could only ever destroy the
  // aggregate. (The old comment claimed a 7-day bound; there was none.)
  const rawCutoff = daysAgoUTC(RETENTION_DAYS);
  const incomplete = await db.query<{ date: string }>(
    `SELECT date FROM maintenance_log WHERE status != 'complete' ORDER BY date`,
  );
  for (const row of incomplete) {
    if (row.date < rawCutoff) {
      console.warn(
        `[echelon] rollup for ${row.date} is beyond raw retention — marking unrecoverable`,
      );
      await db.run(
        `UPDATE maintenance_log SET status = 'unrecoverable' WHERE date = ?`,
        row.date,
      );
      continue;
    }
    console.log(`[echelon] retrying incomplete rollup for ${row.date}`);
    try {
      await rollupDay(db, row.date);
      await db.run(
        `UPDATE maintenance_log SET status = 'complete', completed_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE date = ?`,
        row.date,
      );
    } catch (e) {
      console.error(`[echelon] retry rollup failed for ${row.date}:`, e);
    }
  }

  // Backfill days the process was down for. A run only ever rolled up
  // yesterday, and the retry loop above only reconsiders dates that already
  // have a maintenance_log row — which only a run that actually happened
  // creates. So any day with no run at 03:00 UTC was never aggregated and
  // never queued, and silently vanished once its raw rows aged out.
  await backfillMissedRollups(db, date, rawCutoff);

  // Mark today's run as started
  await db.run(
    `INSERT OR IGNORE INTO maintenance_log (date, status) VALUES (?, 'started')`,
    date,
  );

  try {
    const rollupRows = await rollupDay(db, date);
    const purged = await purgeExpiredData(db);
    console.log("[echelon] daily maintenance: purged", purged);

    await db.run(
      `UPDATE maintenance_log SET status = 'complete', rollup_rows = ?, purge_views = ?, purge_events = ?, completed_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE date = ?`,
      rollupRows,
      purged.views_deleted + purged.bot_views_deleted,
      purged.events_deleted + purged.bot_events_deleted,
      date,
    );

    await db.exec("PRAGMA incremental_vacuum(2000)");
    console.log(
      `[echelon] daily maintenance: completed in ${Date.now() - start}ms`,
    );
  } catch (e) {
    console.error("[echelon] daily maintenance: failed", e);
    await db.run(
      `UPDATE maintenance_log SET status = 'failed' WHERE date = ?`,
      date,
    ).catch(() => {});
  }
}

/**
 * Schedule daily maintenance at 03:00 UTC.
 * Runs an immediate check on start (in case we're restarting inside the
 * target hour) and then polls every hour thereafter. The one-per-day guard
 * (lastDate) ensures we don't re-run if the immediate check and a timer
 * tick both fall in the target hour.
 */
export function scheduleDailyMaintenance(db: DbAdapter): void {
  const CHECK_MS = 3_600_000; // 1 hour
  const TARGET_HOUR = 3;
  let lastDate = "";

  const tick = () => {
    const now = new Date();
    if (now.getUTCHours() !== TARGET_HOUR) return;

    const today = now.toISOString().slice(0, 10);
    if (lastDate === today) return;

    lastDate = today;
    runDailyMaintenance(db).catch((e) =>
      console.error("[echelon] daily maintenance: unhandled error", e)
    );
  };

  // Immediate check — a process restart between 03:00 and 04:00 would
  // otherwise miss today's target window because setInterval's first
  // tick is CHECK_MS in the future.
  tick();

  setInterval(tick, CHECK_MS);

  console.log("[echelon] daily maintenance scheduled (runs at ~3 AM UTC)");
}
