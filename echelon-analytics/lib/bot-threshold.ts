// Echelon Analytics — Bot Score Threshold
//
// The one place the human/bot cut-off is defined. Every SQL filter and the
// partial index idx_vv_site_created_clean are built from these strings: SQLite
// only uses a partial index when the query repeats its WHERE clause exactly,
// so a hand-typed copy that drifts silently loses the index or miscounts.
//
// Negative scores mark server-ingested rows (bot_score = -1): neither human
// nor bot, and excluded from analytics.

/** Scores at or above this are bots: excluded from analytics and rollups. */
export const BOT_THRESHOLD = 50;

/** SQL predicate for human traffic, optionally on a qualified column. */
export function cleanSql(col = "bot_score"): string {
  return `${col} BETWEEN 0 AND ${BOT_THRESHOLD - 1}`;
}

/** SQL predicate for traffic scored as bots. */
export function botSql(col = "bot_score"): string {
  return `${col} >= ${BOT_THRESHOLD}`;
}

/** Human traffic on the unqualified `bot_score` column. */
export const CLEAN_SQL = cleanSql();

/** Bot traffic on the unqualified `bot_score` column. */
export const BOT_SQL = botSql();

/** True if a score classifies the request as a bot. */
export function isBotScore(score: number): boolean {
  return score >= BOT_THRESHOLD;
}

/**
 * Score stamped onto rows the session classifier proves are bots. Above the
 * threshold so every query that reads bot_score excludes them at once.
 */
export const BOT_EXCLUDE_SCORE = 60;

/**
 * Score stamped by strict engagement mode onto sessions that landed, did
 * nothing and left. Exactly the threshold, not the 60 band: these are not
 * proven bots, only proven to have done nothing.
 */
export const NO_ENGAGEMENT_SCORE = BOT_THRESHOLD;
