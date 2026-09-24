import { define } from "../../../utils.ts";
import { decodeParam } from "../../../lib/request.ts";
import { readJsonObject } from "../../../lib/request.ts";
import { validateSiteIdStrict } from "../../../lib/config.ts";
import {
  markConsentCssStale,
  sanitizeConsentCss,
} from "../../../lib/consent-css.ts";

export const handler = define.handlers({
  async GET(ctx) {
    const rawId = decodeParam(ctx.params.id);
    const siteId = rawId === null ? null : validateSiteIdStrict(rawId);
    if (!siteId) {
      return Response.json(
        { error: "invalid_site_id", message: "Invalid site ID" },
        { status: 400 },
      );
    }
    const row = await ctx.state.db.queryOne<{ consent_css: string | null }>(
      `SELECT consent_css FROM site_settings WHERE site_id = ?`,
      siteId,
    );
    return Response.json({
      site_id: siteId,
      consent_css: row?.consent_css ?? null,
    });
  },

  async PATCH(ctx) {
    const db = ctx.state.db;
    const rawId = decodeParam(ctx.params.id);
    const siteId = rawId === null ? null : validateSiteIdStrict(rawId);
    if (!siteId) {
      return Response.json(
        { error: "invalid_site_id", message: "Invalid site ID" },
        { status: 400 },
      );
    }

    const body = await readJsonObject(ctx.req);
    if (!body) {
      return Response.json(
        { error: "invalid_payload", message: "Invalid JSON" },
        { status: 400 },
      );
    }

    const rawCss = typeof body.consent_css === "string"
      ? body.consent_css.slice(0, 4096)
      : null;
    const css = rawCss ? sanitizeConsentCss(rawCss) : null;

    await db.run(
      `INSERT INTO site_settings (site_id, consent_css, updated_at)
       VALUES (?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'))
       ON CONFLICT(site_id) DO UPDATE SET
         consent_css = excluded.consent_css,
         updated_at = excluded.updated_at`,
      siteId,
      css,
    );

    markConsentCssStale();
    return Response.json({ updated: siteId });
  },
});
