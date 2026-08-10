import { page } from "fresh";
import { define } from "../../../utils.ts";
import { decodeParam } from "../../../lib/request.ts";
import { AdminNav } from "../../../components/AdminNav.tsx";
import { getLiveStats } from "../../../lib/admin-stats.ts";
import BotActions from "../../../islands/BotActions.tsx";
import BotScoreDetail from "../../../islands/BotScoreDetail.tsx";
import { formatDate, formatTime } from "../../../lib/format.ts";
import { terminalDisplayName } from "../../../lib/anonymize.ts";

export const handler = define.handlers({
  async GET(ctx) {
    const db = ctx.state.db;
    const visitorId = decodeParam(ctx.params.id);
    // A malformed percent-escape cannot match any stored ID.
    if (visitorId === null) {
      return new Response("Visitor not found", { status: 404 });
    }

    const views = await db.query<Record<string, unknown>>(
      `SELECT id, path, site_id, interaction_ms, screen_width, screen_height,
              device_type, os_name, browser_name, browser_version,
              country_code, referrer, bot_score, is_returning, is_pwa, created_at
       FROM visitor_views WHERE visitor_id = ?
       ORDER BY created_at DESC LIMIT 200`,
      visitorId,
    );

    const events = await db.query<Record<string, unknown>>(
      `SELECT id, event_type, site_id, data, device_type, bot_score, is_returning, created_at
       FROM semantic_events WHERE visitor_id = ?
       ORDER BY created_at DESC LIMIT 200`,
      visitorId,
    );

    const excluded = await db.queryOne<Record<string, unknown>>(
      `SELECT * FROM excluded_visitors WHERE visitor_id = ?`,
      visitorId,
    );

    // Compute summary stats
    const uniqueDevices = new Set(
      views.map((v) => v.device_type as string).filter(Boolean),
    );
    const uniqueCountries = new Set(
      views.map((v) => v.country_code as string).filter(Boolean),
    );
    const uniqueSites = new Set(
      views.map((v) => v.site_id as string).filter(Boolean),
    );
    const totalInteraction = views.reduce(
      (sum, v) => sum + ((v.interaction_ms as number) || 0),
      0,
    );
    const firstSeen = views.length > 0
      ? (views[views.length - 1].created_at as string)
      : null;
    const lastSeen = views.length > 0 ? (views[0].created_at as string) : null;

    const liveStats = await getLiveStats(db);
    ctx.state.pageData = {
      visitorId,
      views,
      events,
      isExcluded: !!excluded,
      summary: {
        totalViews: views.length,
        totalEvents: events.length,
        firstSeen,
        lastSeen,
        totalInteraction,
        devices: [...uniqueDevices],
        countries: [...uniqueCountries],
        sites: [...uniqueSites],
      },
      liveStats,
    };
    return page();
  },
});

function formatDuration(ms: number): string {
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.floor(ms / 60000)}m ${Math.floor((ms % 60000) / 1000)}s`;
}

export default define.page<typeof handler>(function VisitorDetailPage({
  state,
}) {
  const { visitorId, views, events, isExcluded, summary, liveStats } =
    state.pageData;

  return (
    <AdminNav
      title={`Visitor ${visitorId}`}
      liveStats={liveStats}
      siteId={state.siteId}
      knownSites={state.knownSites}
      days={state.days}
      url={state.url}
      telemetryState={state.telemetryState}
    >
      <a
        href="/admin/visitors"
        class="text-xs text-[var(--ea-muted)] hover:text-[var(--ea-primary)] mb-3 inline-block"
      >
        &larr; Back to Visitors
      </a>

      {/* Header */}
      <div class="flex gap-2 mb-4 items-center flex-wrap">
        <code class="visitor-id bg-[var(--ea-surface)] border border-[var(--ea-border)] px-2 py-1 text-[var(--ea-primary)]">
          {visitorId}
        </code>
        {isExcluded && (
          <span
            class="text-[var(--ea-danger)] text-xs px-2 py-1 border border-[var(--ea-danger-border)]"
            style="background:var(--ea-danger-bg)"
          >
            EXCLUDED
          </span>
        )}
        <BotActions visitorId={visitorId} isExcluded={isExcluded} />
      </div>

      {/* Summary cards */}
      <div class="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-6 gap-3 mb-6">
        <div class="kpi-card">
          <div class="kpi-value">{summary.totalViews}</div>
          <div class="kpi-label">Page Views</div>
        </div>
        <div class="kpi-card">
          <div class="kpi-value">{summary.totalEvents}</div>
          <div class="kpi-label">Events</div>
        </div>
        <div class="kpi-card">
          <div class="kpi-value">
            {summary.firstSeen ? formatDate(summary.firstSeen) : "-"}
          </div>
          <div class="kpi-label">First Seen</div>
        </div>
        <div class="kpi-card">
          <div class="kpi-value">
            {summary.lastSeen ? formatDate(summary.lastSeen) : "-"}
          </div>
          <div class="kpi-label">Last Seen</div>
        </div>
        <div class="kpi-card">
          <div class="kpi-value">
            {formatDuration(summary.totalInteraction)}
          </div>
          <div class="kpi-label">Active Time</div>
        </div>
        <div class="kpi-card">
          <div class="kpi-value">{summary.devices.length}</div>
          <div class="kpi-label">
            Device{summary.devices.length !== 1 ? "s" : ""}
          </div>
        </div>
      </div>

      {/* Page Views */}
      <h3 class="text-sm text-[var(--ea-primary)] mb-2">
        Page Views ({views.length})
      </h3>
      <div class="bg-[var(--ea-surface)] border border-[var(--ea-border)] overflow-x-auto mb-4">
        <table class="w-full text-sm">
          <thead>
            <tr class="border-b border-[var(--ea-border)]">
              <th class="text-left px-4 py-2 text-xs text-[var(--ea-muted)]">
                Time
              </th>
              <th class="text-left px-4 py-2 text-xs text-[var(--ea-muted)]">
                Path
              </th>
              <th class="text-left px-4 py-2 text-xs text-[var(--ea-muted)]">
                Site
              </th>
              <th class="text-left px-4 py-2 text-xs text-[var(--ea-muted)]">
                Device
              </th>
              <th class="text-left px-4 py-2 text-xs text-[var(--ea-muted)]">
                OS
              </th>
              <th class="text-left px-4 py-2 text-xs text-[var(--ea-muted)]">
                Browser
              </th>
              <th class="text-left px-4 py-2 text-xs text-[var(--ea-muted)]">
                Resolution
              </th>
              <th class="text-left px-4 py-2 text-xs text-[var(--ea-muted)]">
                Country
              </th>
              <th class="text-left px-4 py-2 text-xs text-[var(--ea-muted)]">
                Interaction
              </th>
              <th class="text-left px-4 py-2 text-xs text-[var(--ea-muted)]">
                Score
              </th>
            </tr>
          </thead>
          <tbody>
            {views.map((v: Record<string, unknown>, i: number) => (
              <tr key={i} class="border-b border-[var(--ea-surface-alt)]">
                <td class="px-4 py-1.5 text-[var(--ea-muted)] whitespace-nowrap">
                  {formatTime(v.created_at as string)}
                </td>
                <td
                  class="px-4 py-1.5 truncate max-w-[200px] text-[var(--ea-text)]"
                  title={v.path as string}
                >
                  {v.path as string}
                </td>
                <td class="px-4 py-1.5 text-[var(--ea-text)]">
                  {v.site_id as string}
                </td>
                <td class="px-4 py-1.5 text-[var(--ea-text)]">
                  {v.device_type as string}
                </td>
                <td class="px-4 py-1.5 text-[var(--ea-text)]">
                  {(v.os_name as string) || "-"}
                </td>
                <td class="px-4 py-1.5 text-[var(--ea-text)]">
                  {v.browser_name
                    ? `${v.browser_name} ${v.browser_version || ""}`.trim()
                    : "-"}
                </td>
                <td class="px-4 py-1.5 text-[var(--ea-text)] tabular-nums">
                  {v.screen_width
                    ? terminalDisplayName(
                      `${v.screen_width}x${v.screen_height}`,
                    )
                    : "-"}
                </td>
                <td class="px-4 py-1.5 text-[var(--ea-text)]">
                  {v.country_code as string}
                </td>
                <td class="px-4 py-1.5 tabular-nums text-[var(--ea-primary)]">
                  {v.interaction_ms
                    ? `${((v.interaction_ms as number) / 1000).toFixed(1)}s`
                    : "-"}
                </td>
                <td class="px-4 py-1.5">
                  <BotScoreDetail
                    viewId={v.id as number}
                    score={v.bot_score as number}
                  />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {views.length === 0 && (
        <p class="text-[var(--ea-muted)] text-sm mb-4">
          No page views found for this visitor.
        </p>
      )}

      {/* Semantic Events */}
      {events.length > 0 && (
        <>
          <h3 class="text-sm text-[var(--ea-primary)] mb-2">
            Semantic Events ({events.length})
          </h3>
          <div class="bg-[var(--ea-surface)] border border-[var(--ea-border)] overflow-x-auto">
            <table class="w-full text-sm">
              <thead>
                <tr class="border-b border-[var(--ea-border)]">
                  <th class="text-left px-4 py-2 text-xs text-[var(--ea-muted)]">
                    Time
                  </th>
                  <th class="text-left px-4 py-2 text-xs text-[var(--ea-muted)]">
                    Type
                  </th>
                  <th class="text-left px-4 py-2 text-xs text-[var(--ea-muted)]">
                    Site
                  </th>
                  <th class="text-left px-4 py-2 text-xs text-[var(--ea-muted)]">
                    Data
                  </th>
                  <th class="text-left px-4 py-2 text-xs text-[var(--ea-muted)]">
                    Score
                  </th>
                </tr>
              </thead>
              <tbody>
                {events.map((e: Record<string, unknown>, i: number) => (
                  <tr
                    key={i}
                    class="border-b border-[var(--ea-surface-alt)]"
                  >
                    <td class="px-4 py-1.5 text-[var(--ea-muted)] whitespace-nowrap">
                      {formatTime(e.created_at as string)}
                    </td>
                    <td class="px-4 py-1.5">
                      <span class="bot-score-badge bot-score-low">
                        {e.event_type as string}
                      </span>
                    </td>
                    <td class="px-4 py-1.5 text-[var(--ea-text)]">
                      {e.site_id as string}
                    </td>
                    <td
                      class="px-4 py-1.5 truncate max-w-[250px]"
                      title={e.data as string ?? ""}
                    >
                      <span class="text-xs text-[var(--ea-muted)]">
                        {(e.data as string) || "-"}
                      </span>
                    </td>
                    <td class="px-4 py-1.5">
                      <BotScoreDetail
                        eventId={e.id as number}
                        score={e.bot_score as number}
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </AdminNav>
  );
});
