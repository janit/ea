import { define } from "../../../utils.ts";
import type { SQLParam } from "../../../lib/db/adapter.ts";
import { validateSiteId } from "../../../lib/config.ts";

export const handler = define.handlers({
  async GET(ctx) {
    const url = new URL(ctx.req.url);
    const db = ctx.state.db;
    const rawSiteId = url.searchParams.get("site_id");
    const siteId = rawSiteId ? validateSiteId(rawSiteId) : null;
    const minScore = parseInt(url.searchParams.get("min_score") ?? "25");
    const limit = Math.min(
      Math.max(parseInt(url.searchParams.get("limit") ?? "50") || 50, 1),
      200,
    );

    const params: SQLParam[] = [minScore];
    let where = "WHERE bot_score >= ?";
    if (siteId) {
      where += " AND site_id = ?";
      params.push(siteId);
    }

    const rows = await db.query(
      `SELECT visitor_id,
              MAX(bot_score) AS max_bot_score,
              COUNT(*) AS pageviews,
              MIN(created_at) AS first_seen,
              MAX(created_at) AS last_seen,
              GROUP_CONCAT(DISTINCT site_id) AS sites,
              GROUP_CONCAT(DISTINCT device_type) AS devices,
              GROUP_CONCAT(DISTINCT country_code) AS countries,
              GROUP_CONCAT(DISTINCT os_name) AS os_names,
              GROUP_CONCAT(DISTINCT (browser_name || ' ' || browser_version)) AS browsers,
              EXISTS(SELECT 1 FROM excluded_visitors ev WHERE ev.visitor_id = visitor_views.visitor_id) AS is_excluded
       FROM visitor_views ${where}
       GROUP BY visitor_id
       ORDER BY max_bot_score DESC, pageviews DESC
       LIMIT ?`,
      ...params,
      limit,
    );

    return Response.json(rows);
  },
});
