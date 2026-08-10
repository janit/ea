import { define } from "../../../../utils.ts";
import { decodeParam } from "../../../../lib/request.ts";

export const handler = define.handlers({
  async GET(ctx) {
    const db = ctx.state.db;
    const raw = decodeParam(ctx.params.id);
    if (raw === null) {
      return Response.json(
        { error: "invalid_id", message: "Malformed visitor ID" },
        { status: 400 },
      );
    }
    const visitorId = raw.slice(0, 128);

    const views = await db.query(
      `SELECT path, site_id, interaction_ms, device_type, os_name,
              browser_name, browser_version,
              country_code, referrer_type, bot_score, is_pwa, created_at
       FROM visitor_views WHERE visitor_id = ?
       ORDER BY created_at DESC LIMIT 100`,
      visitorId,
    );

    const events = await db.query(
      `SELECT event_type, site_id, data, device_type, bot_score, created_at
       FROM semantic_events WHERE visitor_id = ?
       ORDER BY created_at DESC LIMIT 100`,
      visitorId,
    );

    const excluded = await db.queryOne(
      `SELECT * FROM excluded_visitors WHERE visitor_id = ?`,
      visitorId,
    );

    return Response.json({
      visitor_id: visitorId,
      is_excluded: !!excluded,
      exclusion: excluded ?? null,
      views,
      events,
    });
  },
});
