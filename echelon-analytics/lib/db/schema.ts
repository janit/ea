/**
 * Echelon Analytics — Database Schema
 *
 * Unified schema: visitor_views + visitor_views_daily + semantic_events.
 * No legacy sessions/events/daily_aggregates tables.
 */

// NOTE: Indexes over columns that migrate() adds (utm_* on visitor_views and
// semantic_events, experiment_id/variant_id on semantic_events) deliberately
// live in migrate(), NOT here. SCHEMA_SQL runs first, and CREATE TABLE IF NOT
// EXISTS is a no-op on an existing database — so an index here over a
// migrate-added column threw "no such column" on exactly the legacy databases
// migrate() exists to upgrade, aborting before it could run. DatabaseSync.exec
// is not atomic either, so the statements before the failure stayed committed.
import { CLEAN_SQL } from "../bot-threshold.ts";
import { INTERACTION_SQL_LIST } from "../event-classes.ts";

/**
 * The clean interaction events, keyed for the engagement gate's two lookups:
 * "any in this session" (site_id, session_id) and "any by this sessionless
 * visitor near this time" (site_id, session_id IS NULL, visitor_id,
 * created_at). Partial, so a lookup never steps over a row that does not
 * count: one session or visitor id can hold thousands of passive or
 * bot-scored events, and a lookup that walked them once per row judged
 * blocked the process for seconds. Only gestures pay for it on insert.
 *
 * SQLite uses a partial index only for queries repeating its WHERE clause, so
 * migrate() rebuilds it when the threshold or the event list has changed.
 * All of its columns are in the original table (see the note above).
 */
export const CLEAN_INTERACTION_SQL =
  `${CLEAN_SQL} AND event_type IN (${INTERACTION_SQL_LIST})`;
export const CLEAN_INTERACTION_INDEX_SQL =
  `CREATE INDEX IF NOT EXISTS idx_se_clean_interaction
    ON semantic_events(site_id, session_id, visitor_id, created_at)
    WHERE ${CLEAN_INTERACTION_SQL}`;

/**
 * The same events keyed for the lookup anonymised sites need: "any by this
 * visitor near this time", whatever session id the event carries. On those
 * sites the stored session id is one of 50 names shared by unrelated visits,
 * so it cannot be part of the key, and the index above cannot answer the
 * question without stepping over every session name. One more entry per
 * clean gesture on insert, on every site. Rebuilt by migrate() like the
 * index above.
 */
export const CLEAN_INTERACTION_VISITOR_INDEX_SQL =
  `CREATE INDEX IF NOT EXISTS idx_se_clean_interaction_visitor
    ON semantic_events(site_id, visitor_id, created_at)
    WHERE ${CLEAN_INTERACTION_SQL}`;

/**
 * "Does this visitor own a validated view", whatever its session id: the
 * engagement gate on anonymised sites, and the proven-human check. Costs
 * nothing on insert (views are written with validated = 0). Over a column
 * migrate() adds, so migrate() creates it and SCHEMA_SQL does not.
 */
export const VALIDATED_VISITOR_INDEX_SQL =
  `CREATE INDEX IF NOT EXISTS idx_vv_validated_visitor
    ON visitor_views(site_id, visitor_id)
    WHERE validated = 1`;

export const SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS visitor_views (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    visitor_id TEXT NOT NULL,
    path TEXT NOT NULL,
    site_id TEXT NOT NULL,
    session_id TEXT,
    interaction_ms INTEGER,
    screen_width INTEGER,
    screen_height INTEGER,
    device_type TEXT,
    os_name TEXT,
    browser_name TEXT,
    browser_version TEXT,
    country_code TEXT,
    is_returning INTEGER NOT NULL DEFAULT 0,
    referrer TEXT,
    referrer_type TEXT,
    bot_score INTEGER NOT NULL DEFAULT 0,
    bot_score_detail TEXT,
    validated INTEGER NOT NULL DEFAULT 0,
    is_pwa INTEGER NOT NULL DEFAULT 0,
    utm_source TEXT,
    utm_medium TEXT,
    utm_campaign TEXT,
    utm_content TEXT,
    utm_term TEXT,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  );

  CREATE INDEX IF NOT EXISTS idx_vv_visitor      ON visitor_views(visitor_id);
  CREATE INDEX IF NOT EXISTS idx_vv_site_created ON visitor_views(site_id, created_at);
  CREATE INDEX IF NOT EXISTS idx_vv_path         ON visitor_views(path);
  CREATE INDEX IF NOT EXISTS idx_vv_country      ON visitor_views(country_code);
  CREATE INDEX IF NOT EXISTS idx_vv_device       ON visitor_views(device_type);
  CREATE INDEX IF NOT EXISTS idx_vv_created_bot  ON visitor_views(created_at, bot_score);
  CREATE INDEX IF NOT EXISTS idx_vv_site_created_clean
    ON visitor_views(site_id, created_at)
    WHERE ${CLEAN_SQL};

  CREATE INDEX IF NOT EXISTS idx_vv_bot_score
    ON visitor_views(bot_score, visitor_id)
    WHERE bot_score >= 25;

  CREATE TABLE IF NOT EXISTS visitor_views_daily (
    site_id TEXT NOT NULL,
    date TEXT NOT NULL,
    device_type TEXT NOT NULL DEFAULT 'unknown',
    country_code TEXT NOT NULL DEFAULT 'unknown',
    is_returning INTEGER NOT NULL DEFAULT 0,
    visits INTEGER NOT NULL DEFAULT 0,
    unique_visitors INTEGER NOT NULL DEFAULT 0,
    avg_interaction_ms INTEGER DEFAULT 0,
    PRIMARY KEY (site_id, date, device_type, country_code, is_returning)
  );

  CREATE INDEX IF NOT EXISTS idx_vvd_site_date ON visitor_views_daily(site_id, date);
  CREATE INDEX IF NOT EXISTS idx_vvd_date      ON visitor_views_daily(date);

  CREATE TABLE IF NOT EXISTS semantic_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    event_type TEXT NOT NULL,
    site_id TEXT NOT NULL,
    session_id TEXT,
    visitor_id TEXT,
    data TEXT,
    experiment_id TEXT,
    variant_id TEXT,
    utm_campaign TEXT,
    device_type TEXT,
    referrer TEXT,
    hour INTEGER,
    month INTEGER,
    day_of_week INTEGER,
    is_returning INTEGER NOT NULL DEFAULT 0,
    bot_score INTEGER NOT NULL DEFAULT 0,
    bot_score_detail TEXT,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  );

  CREATE INDEX IF NOT EXISTS idx_se_site_type_created ON semantic_events(site_id, event_type, created_at);
  CREATE INDEX IF NOT EXISTS idx_se_visitor           ON semantic_events(visitor_id);
  CREATE INDEX IF NOT EXISTS idx_se_created_bot       ON semantic_events(created_at, bot_score);
  ${CLEAN_INTERACTION_INDEX_SQL};
  ${CLEAN_INTERACTION_VISITOR_INDEX_SQL};

  CREATE TABLE IF NOT EXISTS excluded_visitors (
    visitor_id TEXT PRIMARY KEY,
    label TEXT,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  );

  CREATE TABLE IF NOT EXISTS experiments (
    experiment_id       TEXT PRIMARY KEY,
    name                TEXT NOT NULL,
    description         TEXT,
    status              TEXT NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','active','paused','completed','archived')),
    metric_event_type   TEXT NOT NULL,
    allocation_percent  INTEGER NOT NULL DEFAULT 100 CHECK(allocation_percent BETWEEN 1 AND 100),
    created_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    started_at          TEXT,
    ended_at            TEXT
  );

  CREATE TABLE IF NOT EXISTS experiment_variants (
    experiment_id   TEXT NOT NULL REFERENCES experiments(experiment_id) ON DELETE CASCADE,
    variant_id      TEXT NOT NULL,
    name            TEXT NOT NULL,
    weight          INTEGER NOT NULL CHECK(weight > 0),
    is_control      INTEGER NOT NULL DEFAULT 0,
    config          TEXT,
    PRIMARY KEY (experiment_id, variant_id)
  );

  CREATE TABLE IF NOT EXISTS perf_metrics (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    recorded_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    commit_hash  TEXT,
    branch       TEXT,
    category     TEXT NOT NULL,
    metric       TEXT NOT NULL,
    value        REAL NOT NULL,
    unit         TEXT NOT NULL,
    metadata     TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_perf_metrics_time ON perf_metrics(recorded_at);
  CREATE INDEX IF NOT EXISTS idx_perf_metrics_cat  ON perf_metrics(category, metric);

  CREATE TABLE IF NOT EXISTS maintenance_log (
    date TEXT PRIMARY KEY,
    status TEXT NOT NULL DEFAULT 'started',
    rollup_rows INTEGER,
    purge_views INTEGER,
    purge_events INTEGER,
    started_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    completed_at TEXT
  );

  CREATE TABLE IF NOT EXISTS utm_campaigns (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    utm_campaign TEXT NOT NULL,
    site_id TEXT NOT NULL DEFAULT 'default',
    status TEXT NOT NULL DEFAULT 'active'
      CHECK(status IN ('active','paused','archived')),
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  );
  CREATE UNIQUE INDEX IF NOT EXISTS idx_uc_campaign_site
    ON utm_campaigns(utm_campaign, site_id);

  CREATE TABLE IF NOT EXISTS site_settings (
    site_id TEXT PRIMARY KEY,
    consent_css TEXT,
    home_country TEXT,
    home_language TEXT,
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  );

  CREATE TABLE IF NOT EXISTS instance_settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  );
`;
