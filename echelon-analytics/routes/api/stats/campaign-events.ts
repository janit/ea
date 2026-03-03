import { define } from "../../../utils.ts";
import { getCampaignEvents } from "../../../lib/stats.ts";
import { validateSiteId } from "../../../lib/config.ts";

export const handler = define.handlers({
  async GET(ctx) {
    const db = ctx.state.db;
    const url = new URL(ctx.req.url);
    const siteId = validateSiteId(
      url.searchParams.get("site_id") ?? "default",
    );
    const days = Math.min(
      90,
      Math.max(1, parseInt(url.searchParams.get("days") ?? "30")),
    );
    const eventType = url.searchParams.get("event_type") ?? undefined;

    const stats = await getCampaignEvents(db, siteId, days, eventType);
    return Response.json(stats);
  },
});
