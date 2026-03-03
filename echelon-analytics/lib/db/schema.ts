/**
 * Echelon Analytics — Database Schema
 *
 * Unified schema: visitor_views + visitor_views_daily + semantic_events.
 * No legacy sessions/events/daily_aggregates tables.
 */

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
  CREATE INDEX IF NOT EXISTS idx_vv_utm_campaign ON visitor_views(utm_campaign);
  CREATE INDEX IF NOT EXISTS idx_vv_utm_site_created
    ON visitor_views(utm_campaign, site_id, created_at)
    WHERE utm_campaign IS NOT NULL;

  CREATE INDEX IF NOT EXISTS idx_vv_site_created_clean
    ON visitor_views(site_id, created_at)
    WHERE bot_score < 50;

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
  CREATE INDEX IF NOT EXISTS idx_se_experiment        ON semantic_events(experiment_id, variant_id);
  CREATE INDEX IF NOT EXISTS idx_se_utm_campaign
    ON semantic_events(utm_campaign, site_id)
    WHERE utm_campaign IS NOT NULL;

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
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  );

  CREATE TABLE IF NOT EXISTS instance_settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  );
`;
