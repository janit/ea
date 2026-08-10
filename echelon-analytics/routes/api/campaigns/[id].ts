import { define } from "../../../utils.ts";
import { decodeParam } from "../../../lib/request.ts";
import { readJsonObject } from "../../../lib/request.ts";
import { markStale, refreshUtmCampaigns } from "../../../lib/utm.ts";

const VALID_STATUSES = new Set(["active", "paused", "archived"]);

export const handler = define.handlers({
  async PATCH(ctx) {
    const db = ctx.state.db;
    const rawId = decodeParam(ctx.params.id);
    if (rawId === null) {
      return Response.json(
        { error: "invalid_id", message: "Malformed campaign ID" },
        { status: 400 },
      );
    }
    const campaignId = rawId.slice(0, 128);

    const body = await readJsonObject(ctx.req);
    if (!body) {
      return Response.json(
        { error: "invalid_payload", message: "Invalid JSON" },
        { status: 400 },
      );
    }

    const { status } = body;
    if (!status || !VALID_STATUSES.has(status as string)) {
      return Response.json(
        {
          error: "invalid_payload",
          message: "Invalid status. Must be one of: " +
            [...VALID_STATUSES].join(", "),
        },
        { status: 400 },
      );
    }

    const result = await db.run(
      `UPDATE utm_campaigns SET status = ? WHERE id = ?`,
      status as string,
      campaignId,
    );

    if (result.changes === 0) {
      return Response.json(
        { error: "not_found", message: "Campaign not found" },
        { status: 404 },
      );
    }

    markStale();
    await refreshUtmCampaigns(db);
    return Response.json({ updated: campaignId });
  },

  async DELETE(ctx) {
    const db = ctx.state.db;
    const rawId = decodeParam(ctx.params.id);
    if (rawId === null) {
      return Response.json(
        { error: "invalid_id", message: "Malformed campaign ID" },
        { status: 400 },
      );
    }
    const campaignId = rawId.slice(0, 128);

    const result = await db.run(
      `DELETE FROM utm_campaigns WHERE id = ?`,
      campaignId,
    );

    if (result.changes === 0) {
      return Response.json(
        { error: "not_found", message: "Campaign not found" },
        { status: 404 },
      );
    }

    markStale();
    await refreshUtmCampaigns(db);
    return Response.json({ deleted: campaignId });
  },
});
