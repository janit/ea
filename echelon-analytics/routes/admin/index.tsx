import { page } from "fresh";
import { define } from "../../utils.ts";
import { AdminNav } from "../../components/AdminNav.tsx";
import { getOverview } from "../../lib/stats.ts";
import { getLiveStats } from "../../lib/admin-stats.ts";
import TrendChart from "../../islands/TrendChart.tsx";
import DashboardLive from "../../islands/DashboardLive.tsx";

export const handler = define.handlers({
  async GET(ctx) {
    const siteId = ctx.state.siteId;
    const days = ctx.state.days;
    const data = await getOverview(ctx.state.db, siteId, days);
    const liveStats = await getLiveStats(ctx.state.db);
    return page({ data, days, liveStats });
  },
});

export default define.page<typeof handler>(function Dashboard({ data, state }) {
  const { data: stats, liveStats } = data;

  return (
    <AdminNav
      title="Dashboard"
      liveStats={liveStats}
      siteId={state.siteId}
      knownSites={state.knownSites}
      days={state.days}
      url={state.url}
      telemetryState={state.telemetryState}
    >
      {/* Live: Now + 60 min + 24h + Recent visitors/events */}
      <DashboardLive siteId={state.siteId} />

      <div class="grid grid-cols-4 gap-3 mb-4">
        <div class="kpi-card">
          <div class="kpi-value">{stats.visits.toLocaleString()}</div>
          <div class="kpi-label">Total Visits</div>
        </div>
        <div class="kpi-card">
          <div class="kpi-value">
            {stats.unique_visitors.toLocaleString()}
          </div>
          <div class="kpi-label">Unique Visitors</div>
        </div>
        <div class="kpi-card">
          <div class="kpi-value">
            {stats.avg_interaction_ms
              ? (stats.avg_interaction_ms / 1000).toFixed(1) + "s"
              : "-"}
          </div>
          <div class="kpi-label">Avg Interaction</div>
        </div>
        <div class="kpi-card">
          <div class="kpi-value">{stats.top_paths.length}</div>
          <div class="kpi-label">Active Pages</div>
        </div>
      </div>

      {stats.daily_trend.length > 0 && (
        <div class="bg-[var(--ea-surface)] border border-[var(--ea-border)] p-4 mb-4">
          <h3 class="text-sm text-[var(--ea-primary)] mb-2">Daily Trend</h3>
          <TrendChart data={stats.daily_trend} />
        </div>
      )}

      <div class="grid grid-cols-2 gap-3">
        <div class="bg-[var(--ea-surface)] border border-[var(--ea-border)] overflow-hidden">
          <div class="px-4 py-3 border-b border-[var(--ea-border)]">
            <h3 class="text-sm text-[var(--ea-primary)]">Top Pages</h3>
          </div>
          <table class="w-full text-sm">
            <thead>
              <tr class="border-b border-[var(--ea-border)]">
                <th class="text-left px-4 py-2 text-xs text-[var(--ea-muted)]">
                  Path
                </th>
                <th class="text-right px-4 py-2 text-xs text-[var(--ea-muted)]">
                  Views
                </th>
                <th class="text-right px-4 py-2 text-xs text-[var(--ea-muted)]">
                  Visitors
                </th>
              </tr>
            </thead>
            <tbody>
              {stats.top_paths.slice(0, 10).map((p) => (
                <tr
                  key={p.path}
                  class="border-b border-[var(--ea-surface-alt)]"
                >
                  <td class="px-4 py-1.5 truncate max-w-[250px] text-[var(--ea-text)]">
                    {p.path}
                  </td>
                  <td class="px-4 py-1.5 text-right tabular-nums text-[var(--ea-primary)]">
                    {p.views}
                  </td>
                  <td class="px-4 py-1.5 text-right tabular-nums text-[var(--ea-text)]">
                    {p.visitors}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div class="space-y-3">
          <div class="bg-[var(--ea-surface)] border border-[var(--ea-border)] overflow-hidden">
            <div class="px-4 py-3 border-b border-[var(--ea-border)]">
              <h3 class="text-sm text-[var(--ea-primary)]">Devices</h3>
            </div>
            <table class="w-full text-sm">
              <thead>
                <tr class="border-b border-[var(--ea-border)]">
                  <th class="text-left px-4 py-2 text-xs text-[var(--ea-muted)]">
                    Type
                  </th>
                  <th class="text-right px-4 py-2 text-xs text-[var(--ea-muted)]">
                    Visits
                  </th>
                </tr>
              </thead>
              <tbody>
                {stats.devices.map((d) => (
                  <tr
                    key={d.device_type}
                    class="border-b border-[var(--ea-surface-alt)]"
                  >
                    <td class="px-4 py-1.5 text-[var(--ea-text)]">
                      {d.device_type}
                    </td>
                    <td class="px-4 py-1.5 text-right tabular-nums text-[var(--ea-primary)]">
                      {d.visits}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div class="bg-[var(--ea-surface)] border border-[var(--ea-border)] overflow-hidden">
            <div class="px-4 py-3 border-b border-[var(--ea-border)]">
              <h3 class="text-sm text-[var(--ea-primary)]">Countries</h3>
            </div>
            <table class="w-full text-sm">
              <thead>
                <tr class="border-b border-[var(--ea-border)]">
                  <th class="text-left px-4 py-2 text-xs text-[var(--ea-muted)]">
                    Code
                  </th>
                  <th class="text-right px-4 py-2 text-xs text-[var(--ea-muted)]">
                    Visits
                  </th>
                </tr>
              </thead>
              <tbody>
                {stats.countries.map((c) => (
                  <tr
                    key={c.country_code}
                    class="border-b border-[var(--ea-surface-alt)]"
                  >
                    <td class="px-4 py-1.5 text-[var(--ea-text)]">
                      {c.country_code}
                    </td>
                    <td class="px-4 py-1.5 text-right tabular-nums text-[var(--ea-primary)]">
                      {c.visits}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </div>

      <div class="grid grid-cols-3 gap-3 mt-3">
        <div class="bg-[var(--ea-surface)] border border-[var(--ea-border)] overflow-hidden">
          <div class="px-4 py-3 border-b border-[var(--ea-border)]">
            <h3 class="text-sm text-[var(--ea-primary)]">Operating Systems</h3>
          </div>
          <table class="w-full text-sm">
            <thead>
              <tr class="border-b border-[var(--ea-border)]">
                <th class="text-left px-4 py-2 text-xs text-[var(--ea-muted)]">
                  OS
                </th>
                <th class="text-right px-4 py-2 text-xs text-[var(--ea-muted)]">
                  Views
                </th>
                <th class="text-right px-4 py-2 text-xs text-[var(--ea-muted)]">
                  Visitors
                </th>
              </tr>
            </thead>
            <tbody>
              {stats.os_systems.map(
                (o: { os_name: string; views: number; visitors: number }) => (
                  <tr
                    key={o.os_name}
                    class="border-b border-[var(--ea-surface-alt)]"
                  >
                    <td class="px-4 py-1.5 text-[var(--ea-text)]">
                      {o.os_name}
                    </td>
                    <td class="px-4 py-1.5 text-right tabular-nums text-[var(--ea-primary)]">
                      {o.views}
                    </td>
                    <td class="px-4 py-1.5 text-right tabular-nums text-[var(--ea-text)]">
                      {o.visitors}
                    </td>
                  </tr>
                ),
              )}
            </tbody>
          </table>
        </div>

        <div class="bg-[var(--ea-surface)] border border-[var(--ea-border)] overflow-hidden">
          <div class="px-4 py-3 border-b border-[var(--ea-border)]">
            <h3 class="text-sm text-[var(--ea-primary)]">Browsers</h3>
          </div>
          <table class="w-full text-sm">
            <thead>
              <tr class="border-b border-[var(--ea-border)]">
                <th class="text-left px-4 py-2 text-xs text-[var(--ea-muted)]">
                  Browser
                </th>
                <th class="text-right px-4 py-2 text-xs text-[var(--ea-muted)]">
                  Views
                </th>
                <th class="text-right px-4 py-2 text-xs text-[var(--ea-muted)]">
                  Visitors
                </th>
              </tr>
            </thead>
            <tbody>
              {stats.browsers.map(
                (b: { browser: string; views: number; visitors: number }) => (
                  <tr
                    key={b.browser}
                    class="border-b border-[var(--ea-surface-alt)]"
                  >
                    <td class="px-4 py-1.5 text-[var(--ea-text)]">
                      {b.browser}
                    </td>
                    <td class="px-4 py-1.5 text-right tabular-nums text-[var(--ea-primary)]">
                      {b.views}
                    </td>
                    <td class="px-4 py-1.5 text-right tabular-nums text-[var(--ea-text)]">
                      {b.visitors}
                    </td>
                  </tr>
                ),
              )}
            </tbody>
          </table>
        </div>

        <div class="bg-[var(--ea-surface)] border border-[var(--ea-border)] overflow-hidden">
          <div class="px-4 py-3 border-b border-[var(--ea-border)]">
            <h3 class="text-sm text-[var(--ea-primary)]">Resolutions</h3>
          </div>
          <table class="w-full text-sm">
            <thead>
              <tr class="border-b border-[var(--ea-border)]">
                <th class="text-left px-4 py-2 text-xs text-[var(--ea-muted)]">
                  Resolution
                </th>
                <th class="text-right px-4 py-2 text-xs text-[var(--ea-muted)]">
                  Views
                </th>
                <th class="text-right px-4 py-2 text-xs text-[var(--ea-muted)]">
                  Visitors
                </th>
              </tr>
            </thead>
            <tbody>
              {stats.resolutions.map(
                (r: {
                  resolution: string;
                  views: number;
                  visitors: number;
                }) => (
                  <tr
                    key={r.resolution}
                    class="border-b border-[var(--ea-surface-alt)]"
                  >
                    <td class="px-4 py-1.5 text-[var(--ea-text)]">
                      {r.resolution}
                    </td>
                    <td class="px-4 py-1.5 text-right tabular-nums text-[var(--ea-primary)]">
                      {r.views}
                    </td>
                    <td class="px-4 py-1.5 text-right tabular-nums text-[var(--ea-text)]">
                      {r.visitors}
                    </td>
                  </tr>
                ),
              )}
            </tbody>
          </table>
        </div>
      </div>

      <div class="mt-3">
        <div class="bg-[var(--ea-surface)] border border-[var(--ea-border)] overflow-hidden">
          <div class="px-4 py-3 border-b border-[var(--ea-border)]">
            <h3 class="text-sm text-[var(--ea-primary)]">Referrer Sources</h3>
          </div>
          <table class="w-full text-sm">
            <thead>
              <tr class="border-b border-[var(--ea-border)]">
                <th class="text-left px-4 py-2 text-xs text-[var(--ea-muted)]">
                  Type
                </th>
                <th class="text-right px-4 py-2 text-xs text-[var(--ea-muted)]">
                  Views
                </th>
              </tr>
            </thead>
            <tbody>
              {stats.referrers.map((r) => (
                <tr
                  key={r.referrer_type}
                  class="border-b border-[var(--ea-surface-alt)]"
                >
                  <td class="px-4 py-1.5 text-[var(--ea-text)]">
                    {r.referrer_type}
                  </td>
                  <td class="px-4 py-1.5 text-right tabular-nums text-[var(--ea-primary)]">
                    {r.views}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </AdminNav>
  );
});
