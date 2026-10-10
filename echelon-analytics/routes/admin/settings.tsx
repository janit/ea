import { page } from "fresh";
import { define } from "../../utils.ts";
import { AdminNav } from "../../components/AdminNav.tsx";
import { DEBUG, PUBLIC_MODE, TELEMETRY_OVERRIDE } from "../../lib/config.ts";
import { getLiveStats } from "../../lib/admin-stats.ts";
import ConsentCssEditor from "../../islands/ConsentCssEditor.tsx";
import SiteHomeEditor from "../../islands/SiteHomeEditor.tsx";
import DebugToggle from "../../islands/DebugToggle.tsx";
import TelemetryToggle from "../../islands/TelemetryToggle.tsx";
import { isDebugEnabled } from "../../lib/debug.ts";
import { findSiteSettings } from "../../lib/site-home.ts";

export const handler = define.handlers({
  async GET(ctx) {
    const db = ctx.state.db;
    const site = ctx.state.siteId;
    const liveStats = await getLiveStats(db);

    const row = await findSiteSettings(db, site);

    return page({
      site,
      consentCss: row?.consent_css ?? "",
      homeCountry: row?.home_country ?? "",
      homeLanguage: row?.home_language ?? "",
      liveStats,
      debugEnabled: isDebugEnabled(),
    });
  },
});

export default define.page<typeof handler>(function SettingsPage(props) {
  const { data, state } = props;
  const {
    site,
    consentCss,
    homeCountry,
    homeLanguage,
    liveStats,
    debugEnabled,
  } = data;

  return (
    <AdminNav
      title="Settings"
      liveStats={liveStats}
      siteId={state.siteId}
      knownSites={state.knownSites}
      days={state.days}
      url={state.url}
      telemetryState={state.telemetryState}
    >
      <div class="bg-[var(--ea-surface)] border border-[var(--ea-border)] p-4 mb-4">
        <h3 class="text-sm text-[var(--ea-primary)] mb-3">
          Cookie Consent Banner — {site}
        </h3>
        <ConsentCssEditor
          siteId={site}
          initialCss={consentCss}
          readOnly={PUBLIC_MODE}
        />
      </div>

      <div class="text-xs text-[var(--ea-muted)] mb-6">
        <p class="mb-1">
          The consent banner uses a Web Component (shadow DOM) so custom CSS
          won't leak into or be affected by the host page's styles.
        </p>
        <p>
          Requires{" "}
          <code class="text-[var(--ea-text)]">
            ECHELON_COOKIE_CONSENT=true
          </code>{" "}
          and <code class="text-[var(--ea-text)]">data-cookie</code>{" "}
          on the script tag.
        </p>
      </div>

      <div class="bg-[var(--ea-surface)] border border-[var(--ea-border)] p-4 mb-4">
        <h3 class="text-sm text-[var(--ea-primary)] mb-3">
          Home Audience — {site}
        </h3>
        <p class="text-xs text-[var(--ea-muted)] mb-3">
          Where this site's visitors are expected to come from. When set,
          visitors from another continent, and device patterns that only make
          sense with a forged location, add to the bot score. Leave both empty
          for a site with a worldwide audience: no geography signal is applied.
        </p>
        <SiteHomeEditor
          siteId={site}
          initialCountry={homeCountry}
          initialLanguage={homeLanguage}
          readOnly={PUBLIC_MODE}
        />
      </div>

      <div class="bg-[var(--ea-surface)] border border-[var(--ea-border)] p-4 mb-4">
        <h3 class="text-sm text-[var(--ea-primary)] mb-3">Debug Logging</h3>
        <p class="text-xs text-[var(--ea-muted)] mb-3">
          Verbose server + client console output for diagnosing PoW
          verification, bot scoring, beacon/event processing, and tracker
          behavior. Resets on restart.
        </p>
        <DebugToggle
          initialState={debugEnabled}
          envOverride={DEBUG}
          readOnly={PUBLIC_MODE}
        />
      </div>

      <div class="bg-[var(--ea-surface)] border border-[var(--ea-border)] p-4 mb-4">
        <h3 class="text-sm text-[var(--ea-primary)] mb-3">Telemetry</h3>
        <p class="text-xs text-[var(--ea-muted)] mb-3">
          Anonymous admin panel usage data sent to the Echelon project. No
          visitor data, page content, or PII is ever shared.{" "}
          <a
            href="https://ea.js.org/telemetry.html"
            target="_blank"
            rel="noopener"
            class="underline"
          >
            Learn more
          </a>
        </p>
        <TelemetryToggle
          initialState={state.telemetryState}
          envOverride={TELEMETRY_OVERRIDE}
          readOnly={PUBLIC_MODE}
        />
      </div>
    </AdminNav>
  );
});
