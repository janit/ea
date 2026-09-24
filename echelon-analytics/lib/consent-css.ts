// Echelon Analytics — Per-Site Consent Banner CSS Cache
//
// Caches custom CSS from site_settings table, refreshed every 60 seconds.

import type { DbAdapter } from "./db/adapter.ts";

const cache = new Map<string, string>();
let refreshedAt = 0;
let stale = true;

export function markConsentCssStale(): void {
  stale = true;
}

export async function refreshConsentCss(db: DbAdapter): Promise<void> {
  if (!stale && Date.now() - refreshedAt < 60_000) return;
  cache.clear();
  const rows = await db.query<{ site_id: string; consent_css: string }>(
    `SELECT site_id, consent_css FROM site_settings WHERE consent_css IS NOT NULL`,
  );
  for (const r of rows) cache.set(r.site_id, r.consent_css);
  refreshedAt = Date.now();
  stale = false;
}

export function getConsentCss(siteId: string): string {
  return cache.get(siteId) ?? "";
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
