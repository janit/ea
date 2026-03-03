/**
 * Echelon Analytics — Database Initialization
 *
 * Singleton access to the DbAdapter. Sets WAL mode, PRAGMAs, creates schema.
 */

import { DatabaseSync } from "node:sqlite";
import { SqliteAdapter } from "./sqlite-adapter.ts";
import { SCHEMA_SQL } from "./schema.ts";
import { DB_PATH } from "../config.ts";
import type { DbAdapter } from "./adapter.ts";

let db: DbAdapter | null = null;
let initPromise: Promise<DbAdapter> | null = null;

export function initDb(): Promise<DbAdapter> {
  if (db) return Promise.resolve(db);
  if (initPromise) return initPromise;
  initPromise = _initDb();
  return initPromise;
}

async function _initDb(): Promise<DbAdapter> {
  const raw = new DatabaseSync(DB_PATH);

  // WAL mode for concurrent reads + append-heavy writes
  const walResult = raw.prepare("PRAGMA journal_mode = WAL").get() as {
    journal_mode: string;
  };
  if (walResult?.journal_mode !== "wal") {
    console.warn(
      `[echelon] WARNING: WAL mode failed to activate (got: ${walResult?.journal_mode}). Performance may be degraded.`,
    );
  }
  raw.exec("PRAGMA synchronous = NORMAL");
  raw.exec("PRAGMA busy_timeout = 5000");
  raw.exec("PRAGMA foreign_keys = ON");
  raw.exec("PRAGMA cache_size = -32000"); // 32 MB page cache
  raw.exec("PRAGMA temp_store = MEMORY");

  // Create schema
  raw.exec(SCHEMA_SQL);

  db = new SqliteAdapter(raw);

  // Migrations for existing databases
  await migrate(db);

  console.log(`[echelon] Database initialized: ${DB_PATH}`);
  return db;
}

/** Run schema migrations for existing databases. */
async function migrate(adapter: DbAdapter): Promise<void> {
  // Add experiment_id + variant_id columns to semantic_events (check each individually for crash-safety)
  if (!await adapter.columnExists("semantic_events", "experiment_id")) {
    await adapter.exec(
      "ALTER TABLE semantic_events ADD COLUMN experiment_id TEXT",
    );
    console.log(
      "[echelon] Migration: added experiment_id to semantic_events",
    );
  }
  if (!await adapter.columnExists("semantic_events", "variant_id")) {
    await adapter.exec(
      "ALTER TABLE semantic_events ADD COLUMN variant_id TEXT",
    );
    console.log(
      "[echelon] Migration: added variant_id to semantic_events",
    );
  }
  await adapter.exec(
    "CREATE INDEX IF NOT EXISTS idx_se_experiment ON semantic_events(experiment_id, variant_id)",
  );

  // Add UTM columns to visitor_views (check each individually for crash-safety)
  const utmViewCols = [
    "utm_source",
    "utm_medium",
    "utm_campaign",
    "utm_content",
    "utm_term",
  ];
  for (const col of utmViewCols) {
    if (!await adapter.columnExists("visitor_views", col)) {
      await adapter.exec(`ALTER TABLE visitor_views ADD COLUMN ${col} TEXT`);
      console.log(`[echelon] Migration: added ${col} to visitor_views`);
    }
  }
  // Composite indexes for UTM campaign queries
  await adapter.exec(
    "CREATE INDEX IF NOT EXISTS idx_vv_utm_campaign ON visitor_views(utm_campaign)",
  );
  await adapter.exec(
    `CREATE INDEX IF NOT EXISTS idx_vv_utm_site_created
     ON visitor_views(utm_campaign, site_id, created_at)
     WHERE utm_campaign IS NOT NULL`,
  );

  // Add utm_campaign column to semantic_events (if missing)
  if (!await adapter.columnExists("semantic_events", "utm_campaign")) {
    await adapter.exec(
      "ALTER TABLE semantic_events ADD COLUMN utm_campaign TEXT",
    );
    console.log(
      "[echelon] Migration: added utm_campaign to semantic_events",
    );
  }
  await adapter.exec(
    `CREATE INDEX IF NOT EXISTS idx_se_utm_campaign
     ON semantic_events(utm_campaign, site_id)
     WHERE utm_campaign IS NOT NULL`,
  );

  // Partial index for bot-filtered queries (speeds up overview, top paths, referrers, etc.)
  await adapter.exec(
    `CREATE INDEX IF NOT EXISTS idx_vv_site_created_clean
     ON visitor_views(site_id, created_at)
     WHERE bot_score < 50`,
  );

  // Add bot_score_detail column for detailed score breakdown
  if (!await adapter.columnExists("visitor_views", "bot_score_detail")) {
    await adapter.exec(
      "ALTER TABLE visitor_views ADD COLUMN bot_score_detail TEXT",
    );
    console.log(
      "[echelon] Migration: added bot_score_detail to visitor_views",
    );
  }
  // Add browser_name + browser_version columns to visitor_views
  if (!await adapter.columnExists("visitor_views", "browser_name")) {
    await adapter.exec(
      "ALTER TABLE visitor_views ADD COLUMN browser_name TEXT",
    );
    console.log("[echelon] Migration: added browser_name to visitor_views");
  }
  if (!await adapter.columnExists("visitor_views", "browser_version")) {
    await adapter.exec(
      "ALTER TABLE visitor_views ADD COLUMN browser_version TEXT",
    );
    console.log(
      "[echelon] Migration: added browser_version to visitor_views",
    );
  }

  // Partial index for bots page queries (WHERE bot_score >= 25)
  await adapter.exec(
    `CREATE INDEX IF NOT EXISTS idx_vv_bot_score
     ON visitor_views(bot_score, visitor_id)
     WHERE bot_score >= 25`,
  );

  if (!await adapter.columnExists("semantic_events", "bot_score_detail")) {
    await adapter.exec(
      "ALTER TABLE semantic_events ADD COLUMN bot_score_detail TEXT",
    );
    console.log(
      "[echelon] Migration: added bot_score_detail to semantic_events",
    );
  }
}

export function getDb(): DbAdapter {
  if (!db) {
    throw new Error("[echelon] Database not initialized — call initDb() first");
  }
  return db;
}

export async function closeDb(): Promise<void> {
  if (db) {
    await db.close();
    db = null;
  }
}
