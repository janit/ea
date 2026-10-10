// Echelon Analytics — Per-Site Consent Banner CSS Cache
//
// Caches custom CSS from site_settings table, refreshed every 60 seconds.
// Keyed by lower-cased site id, from the row loadSiteSettings() picks for
// each site: the same row the API writes to and the settings page shows.

import type { DbAdapter } from "./db/adapter.ts";
import { loadSiteSettings } from "./site-home.ts";

const cache = new Map<string, string>();
let refreshedAt = 0;
let stale = true;

export function markConsentCssStale(): void {
  stale = true;
}

export async function refreshConsentCss(db: DbAdapter): Promise<void> {
  if (!stale && Date.now() - refreshedAt < 60_000) return;
  const sites = await loadSiteSettings(db);
  cache.clear();
  for (const [siteId, r] of sites) {
    if (r.consent_css !== null) cache.set(siteId, r.consent_css);
  }
  refreshedAt = Date.now();
  stale = false;
}

export function getConsentCss(siteId: string): string {
  return cache.get(siteId.toLowerCase()) ?? "";
}

/**
 * Neutralise CSS that could make the browser fetch an external resource
 * (data exfiltration from the page embedding the consent banner).
 * 1. Strip backslashes to defeat escape bypasses (\75rl → url)
 * 2. Strip comments, so a comment cannot split a blocked keyword
 * 3. Block url(), image(), image-set(), element(), paint(), @import,
 *    @font-face, @keyframes, expression(), behavior:, javascript:,
 *    -moz-binding:
 */
export function sanitizeConsentCss(raw: string): string {
  return raw
    .replace(/\\/g, "")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(
      /\burl[\s\S]*?\(|\bimage[\s\S]*?\(|\bimage-set[\s\S]*?\(|-webkit-image-set[\s\S]*?\(|\belement[\s\S]*?\(|\bpaint[\s\S]*?\(|@import\b|@font-face\b|@keyframes\b|\bexpression[\s]*\(|\bbehavior[\s]*:|\bjavascript[\s]*:|-moz-binding[\s]*:/gi,
      "/* blocked */",
    );
}
