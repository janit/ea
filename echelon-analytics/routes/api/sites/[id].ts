import { define } from "../../../utils.ts";
import { decodeParam } from "../../../lib/request.ts";
import { readJsonObject } from "../../../lib/request.ts";
import { validateSiteIdStrict } from "../../../lib/config.ts";
import {
  markConsentCssStale,
  sanitizeConsentCss,
} from "../../../lib/consent-css.ts";
import {
  findSiteSettings,
  markSiteHomesStale,
  normalizeCountry,
  normalizeLanguage,
} from "../../../lib/site-home.ts";

const invalid = (error: string, message: string) =>
  Response.json({ error, message }, { status: 400 });

export const handler = define.handlers({
  async GET(ctx) {
    const rawId = decodeParam(ctx.params.id);
    const siteId = rawId === null ? null : validateSiteIdStrict(rawId);
    if (!siteId) return invalid("invalid_site_id", "Invalid site ID");
    const row = await findSiteSettings(ctx.state.db, siteId);
    return Response.json({
      site_id: siteId,
      consent_css: row?.consent_css ?? null,
      home_country: row?.home_country ?? null,
      home_language: row?.home_language ?? null,
    });
  },

  async PATCH(ctx) {
    const db = ctx.state.db;
    const rawId = decodeParam(ctx.params.id);
    const siteId = rawId === null ? null : validateSiteIdStrict(rawId);
    if (!siteId) return invalid("invalid_site_id", "Invalid site ID");

    const body = await readJsonObject(ctx.req);
    if (!body) return invalid("invalid_payload", "Invalid JSON");

    // Only fields present in the body change; the rest keep their value.
    // The row is matched without regard to case and written back under the
    // id it was saved with, so `MySite` updates `mysite` and never adds a
    // second row for the one site.
    const current = await findSiteSettings(db, siteId);
    let css = current?.consent_css ?? null;
    let country = current?.home_country ?? null;
    let language = current?.home_language ?? null;

    if ("consent_css" in body) {
      const rawCss = typeof body.consent_css === "string"
        ? body.consent_css.slice(0, 4096)
        : null;
      css = rawCss ? sanitizeConsentCss(rawCss) : null;
    }
    if ("home_country" in body) {
      const c = normalizeCountry(body.home_country);
      if (c === undefined) {
        return invalid(
          "invalid_home_country",
          "home_country must be an assigned two-letter ISO country code or null",
        );
      }
      country = c;
    }
    if ("home_language" in body) {
      const l = normalizeLanguage(body.home_language);
      if (l === undefined) {
        return invalid(
          "invalid_home_language",
          "home_language must be a language code such as en or fi, or null",
        );
      }
      language = l;
    }

    await db.run(
      `INSERT INTO site_settings
         (site_id, consent_css, home_country, home_language, updated_at)
       VALUES (?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'))
       ON CONFLICT(site_id) DO UPDATE SET
         consent_css = excluded.consent_css,
         home_country = excluded.home_country,
         home_language = excluded.home_language,
         updated_at = excluded.updated_at`,
      current?.site_id ?? siteId,
      css,
      country,
      language,
    );

    markConsentCssStale();
    markSiteHomesStale();
    return Response.json({ updated: siteId });
  },
});
