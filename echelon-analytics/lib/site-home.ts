// Echelon Analytics — Per-Site Home Country and Language
//
// A site may declare where its audience is. The geography bot signals
// (country_mismatch, cross_continent and the combinations built on them) are
// measured against this, and do nothing for a site that has not declared it.
//
// Cached from site_settings and refreshed every 60 seconds, like the consent
// CSS cache: the scorer reads it synchronously on every request.

import type { DbAdapter } from "./db/adapter.ts";
import { continentOf } from "./geo.ts";

export interface SiteHome {
  country: string | null;
  language: string | null;
}

const NONE: SiteHome = Object.freeze({ country: null, language: null });
const cache = new Map<string, SiteHome>();
let refreshedAt = 0;
let stale = true;

/** Force the next refreshSiteHomes() to reload. */
export function markSiteHomesStale(): void {
  stale = true;
}

/** One site's row of site_settings. */
export interface SiteSettingsRow {
  /** As stored, which may differ in case from the id asked for. */
  site_id: string;
  consent_css: string | null;
  home_country: string | null;
  home_language: string | null;
}

/**
 * Every site's settings row, keyed by lower-cased site id (site ids match
 * without regard to case; they are ASCII, so lower() in SQL and
 * toLowerCase() here agree).
 *
 * One rule decides which row is a site's, for every reader: the scorer's
 * home cache, the session classifier, the consent CSS cache, the API and the
 * settings page. Should two rows differ only in case (an earlier build could
 * create them), the site's row is the last in site_id order, whatever either
 * row holds. findSiteSettings() applies the same rule to one site, and the
 * API writes to that row, so what the settings page shows is what is used
 * and clearing a field there clears it everywhere.
 */
export async function loadSiteSettings(
  db: DbAdapter,
): Promise<Map<string, SiteSettingsRow>> {
  const rows = await db.query<SiteSettingsRow>(
    `SELECT site_id, consent_css, home_country, home_language
       FROM site_settings ORDER BY site_id`,
  );
  const sites = new Map<string, SiteSettingsRow>();
  for (const r of rows) sites.set(r.site_id.toLowerCase(), r);
  return sites;
}

/**
 * Every site's declared home, keyed by lower-cased site id, from the rows
 * loadSiteSettings() picks. The scorer's cache and the session classifier
 * both read this, so they agree on which sites have a home.
 *
 * A stored country that normalizeCountry() would refuse today (saved before
 * the rule existed, or written by hand) reads as unset: measured against an
 * unassigned code, every visitor would be a mismatch.
 */
export async function loadSiteHomes(
  db: DbAdapter,
): Promise<Map<string, SiteHome>> {
  const homes = new Map<string, SiteHome>();
  for (const [siteId, r] of await loadSiteSettings(db)) {
    if (r.home_country === null && r.home_language === null) continue;
    homes.set(siteId, {
      country: normalizeCountry(r.home_country) ?? null,
      language: r.home_language,
    });
  }
  return homes;
}

export async function refreshSiteHomes(db: DbAdapter): Promise<void> {
  if (!stale && Date.now() - refreshedAt < 60_000) return;
  let homes;
  try {
    homes = await loadSiteHomes(db);
  } catch (err) {
    // Optional signal on the ingest hot path: fail open. Keep the previous
    // cache and do not retry for the normal interval.
    console.error("[echelon] site home refresh failed:", err);
    refreshedAt = Date.now();
    stale = false;
    return;
  }
  cache.clear();
  for (const [siteId, home] of homes) cache.set(siteId, home);
  refreshedAt = Date.now();
  stale = false;
}

/**
 * The settings row of one site: the row loadSiteSettings() picks for it.
 * The table has one row per site; the scan is of a handful of rows.
 */
export async function findSiteSettings(
  db: DbAdapter,
  siteId: string,
): Promise<SiteSettingsRow | undefined> {
  return await db.queryOne<SiteSettingsRow>(
    `SELECT site_id, consent_css, home_country, home_language
       FROM site_settings
      WHERE lower(site_id) = lower(?)
      ORDER BY site_id DESC LIMIT 1`,
    siteId,
  );
}

/** The site's declared home. Both fields are null when nothing is set. */
export function getSiteHome(siteId: string): SiteHome {
  return cache.get(siteId.toLowerCase()) ?? NONE;
}

/**
 * Validate a submitted home country. Returns the upper-cased ISO 3166-1
 * alpha-2 code, null to clear it (empty or null input), or undefined when
 * the input is not acceptable.
 *
 * Only a code this instance can place is acceptable: one in the continent
 * table (geo.ts), or RU, which that table leaves out on purpose. Any other
 * two letters (UK for GB, EN, XX) would have no continent, and
 * isCountryMismatch() calls every visitor foreign to a home it cannot place.
 * RU is accepted knowing that: on a site whose home is RU no visitor shares
 * its continent, so every visitor from another country is a mismatch (bar
 * the global-common exemption on English-language sites).
 */
export function normalizeCountry(v: unknown): string | null | undefined {
  if (v === null || v === "") return null;
  if (typeof v !== "string") return undefined;
  const code = v.trim().toUpperCase();
  if (code === "") return null;
  if (!/^[A-Z]{2}$/.test(code)) return undefined;
  return code === "RU" || continentOf(code) !== undefined ? code : undefined;
}

/**
 * Validate a submitted home language. Returns the lower-cased primary
 * subtag ("en-GB" → "en"), null to clear it, or undefined when unacceptable.
 */
export function normalizeLanguage(v: unknown): string | null | undefined {
  if (v === null || v === "") return null;
  if (typeof v !== "string") return undefined;
  const primary = v.trim().toLowerCase().split("-")[0];
  if (primary === "") return null;
  return /^[a-z]{2,3}$/.test(primary) ? primary : undefined;
}
