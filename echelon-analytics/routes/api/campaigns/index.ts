import { define } from "../../../utils.ts";
import { readJsonObject } from "../../../lib/request.ts";
import { markStale, refreshUtmCampaigns } from "../../../lib/utm.ts";
import { validateSiteId } from "../../../lib/config.ts";

const ID_RE = /^[a-zA-Z0-9._-]+$/;

export const handler = define.handlers({
  async GET(ctx) {
    const rows = await ctx.state.db.query(
      `SELECT * FROM utm_campaigns ORDER BY created_at DESC LIMIT 200`,
    );
    return Response.json(rows);
  },

  async POST(ctx) {
    const db = ctx.state.db;
    const body = await readJsonObject(ctx.req);
    if (!body) {
      return Response.json(
        { error: "invalid_payload", message: "Invalid JSON" },
        { status: 400 },
      );
    }

    const { id, name, utm_campaign, site_id } = body;
    if (!id || !name || !utm_campaign) {
      return Response.json(
        {
          error: "invalid_payload",
          message: "Missing required fields: id, name, utm_campaign",
        },
        { status: 400 },
      );
    }

    const cId = String(id).slice(0, 128);
    if (!ID_RE.test(cId)) {
      return Response.json(
        {
          error: "invalid_id",
          message: "ID must be alphanumeric with ._- only",
        },
        { status: 400 },
      );
    }

    // deno-lint-ignore no-control-regex
    const cName = String(name).slice(0, 256).replace(/[\x00-\x1f]/g, "");
    // deno-lint-ignore no-control-regex
    const cUtm = String(utm_campaign).slice(0, 256).replace(/[\x00-\x1f]/g, "");
    const cSite = validateSiteId(site_id ? String(site_id) : "default");

    try {
      await db.run(
        `INSERT INTO utm_campaigns (id, name, utm_campaign, site_id)
         VALUES (?, ?, ?, ?)`,
        cId,
        cName,
        cUtm,
        cSite,
      );
    } catch (err) {
      // Only a constraint violation is a genuine conflict. Any other failure
      // (locked DB, full disk, missing table) is a 500 so operators see a real
      // error instead of a misleading "duplicate".
      if (err instanceof Error && /constraint failed/i.test(err.message)) {
        return Response.json(
          {
            error: "conflict",
            message:
              "Campaign already exists (duplicate id or utm_campaign+site_id)",
          },
          { status: 409 },
        );
      }
      console.error("[echelon] campaign creation failed:", err);
      return Response.json(
        { error: "internal_error", message: "Campaign creation failed" },
        { status: 500 },
      );
    }

    // Post-commit cache refresh. Kept outside the try so a failure here cannot
    // be reported as "creation failed" for a campaign that was in fact created.
    markStale();
    await refreshUtmCampaigns(db);
    return Response.json({ created: cId }, { status: 201 });
  },
});
