// Echelon Analytics — Admin Live Stats Helper
//
// Provides live stats for the AdminNav header on every admin page.

import type { DbAdapter } from "./db/adapter.ts";
import { getViewBufferSize } from "./beacon.ts";
import { getEventBufferSize } from "./events-endpoint.ts";
import { getRequestStats } from "./request-stats.ts";
import { LIVE_STATS_MINUTES, PUBLIC_MODE } from "./config.ts";
import { BOT_SQL, CLEAN_SQL } from "./bot-threshold.ts";

export interface LiveStats {
  viewBuffer: number;
  eventBuffer: number;
  humanViews: number;
  botViews: number;
  uniqueVisitors: number;
  avgResponseMs: number;
  rps: number;
  uptimeSeconds: number;
  windowMinutes: number;
}

export async function getLiveStats(db: DbAdapter): Promise<LiveStats> {
  const stats = await db.queryOne<{
    human_views: number;
    bot_views: number;
    unique_visitors: number;
  }>(
    `SELECT
       SUM(CASE WHEN ${CLEAN_SQL} THEN 1 ELSE 0 END) AS human_views,
       SUM(CASE WHEN ${BOT_SQL} THEN 1 ELSE 0 END) AS bot_views,
       COUNT(DISTINCT visitor_id) AS unique_visitors
     FROM visitor_views
     WHERE created_at >= strftime('%Y-%m-%dT%H:%M:%SZ', datetime('now', '-' || ? || ' minutes'))`,
    LIVE_STATS_MINUTES,
  );

  const reqStats = getRequestStats();

  return {
    // In PUBLIC_MODE, redact operational internals
    viewBuffer: PUBLIC_MODE ? 0 : getViewBufferSize(),
    eventBuffer: PUBLIC_MODE ? 0 : getEventBufferSize(),
    humanViews: stats?.human_views ?? 0,
    botViews: stats?.bot_views ?? 0,
    uniqueVisitors: stats?.unique_visitors ?? 0,
    avgResponseMs: PUBLIC_MODE ? 0 : reqStats.avgResponseMs,
    rps: PUBLIC_MODE ? 0 : reqStats.rps,
    uptimeSeconds: PUBLIC_MODE ? 0 : reqStats.uptimeSeconds,
    windowMinutes: LIVE_STATS_MINUTES,
  };
}
