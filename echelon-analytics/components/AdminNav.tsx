import type { ComponentChildren } from "preact";
import { PUBLIC_MODE, VERSION } from "../lib/config.ts";
import { getTelemetryScript } from "../lib/telemetry-script.ts";
import { DEFAULT_THEME, THEMES } from "../lib/themes.ts";
import type { TelemetryState } from "../lib/telemetry.ts";
import ThemeSelector from "../islands/ThemeSelector.tsx";
import TelemetryBanner from "../islands/TelemetryBanner.tsx";

const DAY_OPTIONS = [7, 14, 30, 60, 90, 180, 365];

interface AdminNavProps {
  title: string;
  children: ComponentChildren;
  siteId: string;
  knownSites: string[];
  days: number;
  url?: string;
  telemetryState?: TelemetryState;
  liveStats?: {
    viewBuffer: number;
    eventBuffer: number;
    humanViews: number;
    botViews: number;
    uniqueVisitors: number;
    avgResponseMs: number;
    rps: number;
    uptimeSeconds: number;
    windowMinutes: number;
  };
}

function formatUptime(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86400) {
    return `${Math.floor(seconds / 3600)}h ${
      Math.floor((seconds % 3600) / 60)
    }m`;
  }
  return `${Math.floor(seconds / 86400)}d ${
    Math.floor((seconds % 86400) / 3600)
  }h`;
}

// CSS for expanded/collapsed states — driven by JS overflow detection, not media queries
const NAV_CSS = `
#an .nav-toggle-label{display:none}
#an .nav-inner{display:flex;align-items:center;gap:1rem;flex-wrap:nowrap;min-height:3rem}
#an .nav-menu{display:flex;align-items:center;gap:.75rem;flex:1}
#an .nav-links{display:flex;gap:.75rem;white-space:nowrap;font-size:.875rem}
#an .nav-links a{color:var(--ea-nav-muted);text-decoration:none;padding:0}
#an .nav-links a:hover{color:var(--ea-nav-text)}
#an .desk-bots{display:block}
#an .mob-bots{display:none}
#an .nav-right{margin-left:auto;display:flex;align-items:center;gap:.75rem;flex-shrink:0}
#an .nav-close{display:none}
#an[data-c] .nav-toggle-label{display:block}
#an[data-c] .nav-inner{flex-wrap:wrap}
#an[data-c] .nav-bar{width:calc(100% - 2.5rem)}
#an[data-c] .nav-menu{display:none;width:100%;order:10}
#an[data-c] #nav-toggle:checked~.nav-menu{display:block}
#an[data-c] #nav-toggle:checked~.nav-toggle-label .nav-close{display:inline}
#an[data-c] #nav-toggle:checked~.nav-toggle-label .nav-open{display:none}
#an[data-c] .nav-links{flex-direction:column;gap:0;padding:.5rem 0;border-top:1px solid var(--ea-border)}
#an[data-c] .nav-links a{padding:.35rem 0}
#an[data-c] .desk-bots{display:none}
#an[data-c] .mob-bots{display:block}
#an[data-c] .nav-right{margin-left:0;padding:.75rem 0;border-top:1px solid var(--ea-border)}
`;

// Overflow detection: expand nav by default, collapse when items don't fit
const NAV_JS = `(function(){
var n=document.getElementById('an');
if(!n)return;
var inner=n.querySelector('.nav-inner');
function check(){
n.removeAttribute('data-c');
if(inner.scrollWidth>inner.clientWidth+2){
n.setAttribute('data-c','');
}else{
var cb=document.getElementById('nav-toggle');
if(cb)cb.checked=false;
}
}
window.addEventListener('resize',check);
check();
n.style.visibility='';
n.querySelectorAll('select[name]').forEach(function(s){
s.onchange=function(){var u=new URL(location.href);u.searchParams.set(this.name,this.value);u.searchParams.delete('page');location.href=u.toString()};
});
})()`;

export function AdminNav(
  {
    title,
    children,
    siteId,
    knownSites,
    days,
    url,
    telemetryState,
    liveStats,
  }: AdminNavProps,
) {
  const fullTitle = `${title} - Echelon Analytics`;
  const description =
    `${title} — Echelon Analytics: privacy-first, cookieless web analytics.`;
  const robotsContent = PUBLIC_MODE ? "index, follow" : "noindex, nofollow";

  return (
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1.0" />
        <title>{fullTitle}</title>
        <meta name="description" content={description} />
        <meta name="robots" content={robotsContent} />
        {url && <link rel="canonical" href={url} />}
        <meta property="og:title" content={fullTitle} />
        <meta property="og:description" content={description} />
        <meta property="og:type" content="website" />
        <meta property="og:site_name" content="Echelon Analytics" />
        <link rel="icon" href="/favicon.ico" />
        <link rel="stylesheet" href="/styles.css" />
        {telemetryState === "on" && (
          <script
            dangerouslySetInnerHTML={{ __html: getTelemetryScript() }}
          >
          </script>
        )}
        <style dangerouslySetInnerHTML={{ __html: NAV_CSS }} />
        {/* Theme detection must run before paint to prevent FOUC */}
        <script
          dangerouslySetInnerHTML={{
            __html:
              `document.documentElement.dataset.theme=(document.cookie.match(/(?:^|;\\s*)echelon_theme=(\\w+)/)||[])[1]||"${DEFAULT_THEME}"`,
          }}
        />
      </head>
      <body>
        <nav
          id="an"
          class="border-t-[3px] border-t-[var(--ea-accent)] border-b border-b-[var(--ea-border)]"
          style="visibility:hidden;background:var(--ea-nav-bg)"
        >
          <div class="nav-inner max-w-[90rem] mx-auto px-4">
            <input type="checkbox" id="nav-toggle" class="hidden" />

            {/* Left cluster: logo + selectors (always visible) */}
            <div class="nav-bar flex items-center h-12 gap-4 shrink-0">
              <a
                href="/admin"
                class="font-bold text-lg tracking-tight text-[var(--ea-nav-text)] whitespace-nowrap"
              >
                Echelon 🩺
              </a>

              <div class="flex items-center gap-2">
                <select
                  name="site_id"
                  class="border border-[var(--ea-nav-muted)] bg-[var(--ea-nav-bg)] text-[var(--ea-nav-text)] px-2 py-1 text-xs focus:border-[var(--ea-nav-text)] outline-none"
                >
                  {knownSites.map((s: string) => (
                    <option key={s} value={s} selected={s === siteId}>
                      {s}
                    </option>
                  ))}
                </select>
                <select
                  name="days"
                  class="border border-[var(--ea-nav-muted)] bg-[var(--ea-nav-bg)] text-[var(--ea-nav-text)] px-2 py-1 text-xs focus:border-[var(--ea-nav-text)] outline-none"
                >
                  {DAY_OPTIONS.map((d) => (
                    <option key={d} value={d} selected={d === days}>
                      {d}d
                    </option>
                  ))}
                </select>
              </div>
            </div>

            {/* Collapsible: page links + right cluster */}
            <div class="nav-menu">
              <div class="nav-links">
                <a href="/admin">Dashboard</a>
                <a href="/admin/realtime">Realtime</a>
                <a href="/admin/visitors">Visitors</a>
                <a href="/admin/pageviews">Page Views</a>
                <a href="/admin/events">Events</a>

                {/* Bots — expanded: hover dropdown */}
                <div class="relative group desk-bots">
                  <span class="cursor-default text-[var(--ea-nav-muted)]">
                    Bots
                  </span>
                  <div
                    class="hidden group-hover:block absolute left-0 top-full py-1 z-10 min-w-32 border border-[var(--ea-border)]"
                    style="background:var(--ea-nav-bg)"
                  >
                    <a
                      href="/admin/bots"
                      class="block px-4 py-1.5 text-sm text-[var(--ea-nav-muted)] hover:text-[var(--ea-nav-text)] hover:bg-[var(--ea-accent)]"
                    >
                      Suspicious
                    </a>
                    <a
                      href="/admin/bots/excluded"
                      class="block px-4 py-1.5 text-sm text-[var(--ea-nav-muted)] hover:text-[var(--ea-nav-text)] hover:bg-[var(--ea-accent)]"
                    >
                      Excluded
                    </a>
                  </div>
                </div>

                {/* Bots — collapsed: expanded links */}
                <div class="mob-bots py-1">
                  <span class="text-[var(--ea-nav-muted)]">Bots</span>
                  <a
                    href="/admin/bots"
                    class="block pl-4 py-1 text-[var(--ea-nav-muted)] hover:text-[var(--ea-nav-text)]"
                  >
                    Suspicious
                  </a>
                  <a
                    href="/admin/bots/excluded"
                    class="block pl-4 py-1 text-[var(--ea-nav-muted)] hover:text-[var(--ea-nav-text)]"
                  >
                    Excluded
                  </a>
                </div>

                <a href="/admin/experiments">Experiments</a>
                <a href="/admin/campaigns">Campaigns</a>
                <a href="/admin/perf">Performance</a>
                <a href="/admin/settings">Settings</a>
              </div>

              {/* Right cluster: theme + telemetry + logout */}
              <div class="nav-right">
                <ThemeSelector themes={THEMES} />
                <form method="POST" action="/admin/logout" class="inline">
                  <button
                    type="submit"
                    class="text-sm text-[var(--ea-nav-muted)] hover:text-[var(--ea-nav-text)] whitespace-nowrap bg-transparent border-none cursor-pointer p-0"
                  >
                    Logout 🪵<span class="text-red-500">➡</span>🚪
                  </button>
                </form>
              </div>
            </div>

            {/* Hamburger toggle (always visible when collapsed) */}
            <label
              for="nav-toggle"
              class="nav-toggle-label cursor-pointer text-[var(--ea-nav-text)] text-xl leading-none select-none shrink-0"
            >
              <span class="nav-open">🍔</span>
              <span class="nav-close">✕</span>
            </label>
          </div>
        </nav>
        <script dangerouslySetInnerHTML={{ __html: NAV_JS }} />

        {liveStats && (
          <div
            class="border-b border-[var(--ea-border)]"
            style="background:var(--ea-bg)"
          >
            <div class="max-w-7xl mx-auto px-4 flex items-center h-8 gap-3 text-xs text-[var(--ea-muted)]">
              <span
                title={`Human views (${liveStats.windowMinutes}m)`}
              >
                <span class="text-[var(--ea-primary)]">
                  {liveStats.humanViews}
                </span>{" "}
                users
              </span>
              <span title={`Bot views (${liveStats.windowMinutes}m)`}>
                <span class="text-[var(--ea-danger)]">
                  {liveStats.botViews}
                </span>{" "}
                bots
              </span>
              <span class="text-[var(--ea-border)]">|</span>
              <span
                title={`Unique visitors (${liveStats.windowMinutes}m)`}
              >
                {liveStats.uniqueVisitors} unique
              </span>
              <span class="text-[var(--ea-border)]">|</span>
              <span title="Views buffered / Events buffered">
                buf: {liveStats.viewBuffer}v/{liveStats.eventBuffer}e
              </span>
              <span class="text-[var(--ea-border)]">|</span>
              <span title="Avg response time (5 min)">
                {liveStats.avgResponseMs.toFixed(0)}ms
              </span>
              <span title="Requests per second">
                {liveStats.rps} rps
              </span>
              <span class="text-[var(--ea-border)]">|</span>
              <span title="Uptime">
                {formatUptime(liveStats.uptimeSeconds)}
              </span>
              {telemetryState && telemetryState !== "undecided" && (
                <a
                  href="https://ea.js.org/telemetry.html"
                  target="_blank"
                  rel="noopener"
                  title={telemetryState === "on"
                    ? "Telemetry: active \u2014 click for details"
                    : "Telemetry: inactive \u2014 click for details"}
                  class="ml-auto hover:opacity-80"
                >
                  📞 {telemetryState === "on" ? "\u{1F7E2}" : "\u{1F534}"}
                </a>
              )}
            </div>
          </div>
        )}
        {telemetryState === "undecided" && (
          <TelemetryBanner readOnly={PUBLIC_MODE} />
        )}
        <main class="max-w-7xl mx-auto px-4 py-6">
          <h1 class="text-xl font-semibold text-[var(--ea-primary)] mb-4">
            <span class="text-[var(--ea-accent)]">##</span>
            {title}
          </h1>
          {children}
        </main>
        <footer class="max-w-7xl mx-auto px-4 py-4 text-xs text-[var(--ea-muted)] text-center border-t border-[var(--ea-border)]">
          🛢️ "Data er den nye oljen!" -🦭 —{" "}
          <a
            href="https://ea.js.org/"
            target="_blank"
            rel="noopener"
            class="hover:text-[var(--ea-primary)]"
          >
            Echelon Analytics 🩺
          </a>{" "}
          {VERSION}
        </footer>
      </body>
    </html>
  );
}
