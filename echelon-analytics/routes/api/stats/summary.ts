import { define } from "../../../utils.ts";
import { PUBLIC_MODE } from "../../../lib/config.ts";
import { getViewBufferSize } from "../../../lib/beacon.ts";
import { getEventBufferSize } from "../../../lib/events-endpoint.ts";
import { BOT_SQL, CLEAN_SQL } from "../../../lib/bot-threshold.ts";

export const handler = define.handlers({
  async GET(ctx) {
    const db = ctx.state.db;

    // Recent visitor/bot counts (last 24h)
    const stats = await db.queryOne<{
      total_views: number;
      human_views: number;
      bot_views: number;
      unique_visitors: number;
    }>(
      `SELECT
         COUNT(*) AS total_views,
         SUM(CASE WHEN ${CLEAN_SQL} THEN 1 ELSE 0 END) AS human_views,
         SUM(CASE WHEN ${BOT_SQL} THEN 1 ELSE 0 END) AS bot_views,
         COUNT(DISTINCT visitor_id) AS unique_visitors
       FROM visitor_views
       WHERE created_at >= strftime('%Y-%m-%dT%H:%M:%SZ', datetime('now', '-24 hours'))`,
    );

    return Response.json({
      // Redact operational internals in public mode
      buffers: PUBLIC_MODE
        ? undefined
        : { views: getViewBufferSize(), events: getEventBufferSize() },
      last_24h: {
        total_views: stats?.total_views ?? 0,
        human_views: stats?.human_views ?? 0,
        bot_views: stats?.bot_views ?? 0,
        unique_visitors: stats?.unique_visitors ?? 0,
      },
    });
  },
});
