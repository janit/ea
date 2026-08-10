import { page } from "fresh";
import { define } from "../../../utils.ts";
import { decodeParam } from "../../../lib/request.ts";
import { AdminNav } from "../../../components/AdminNav.tsx";
import { getLiveStats } from "../../../lib/admin-stats.ts";
import BotActions from "../../../islands/BotActions.tsx";
import BotScoreDetail from "../../../islands/BotScoreDetail.tsx";
import { PUBLIC_MODE } from "../../../lib/config.ts";
import { formatTime } from "../../../lib/format.ts";
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
              country_code, referrer_type, bot_score, is_pwa, created_at
       FROM visitor_views WHERE visitor_id = ?
       ORDER BY created_at DESC LIMIT 100`,
      visitorId,
    );

    const events = await db.query<Record<string, unknown>>(
      `SELECT id, event_type, site_id, data, device_type, bot_score, created_at
       FROM semantic_events WHERE visitor_id = ?
       ORDER BY created_at DESC LIMIT 100`,
      visitorId,
    );

    const excluded = await db.queryOne<Record<string, unknown>>(
      `SELECT * FROM excluded_visitors WHERE visitor_id = ?`,
      visitorId,
    );

    const liveStats = await getLiveStats(db);
    ctx.state.pageData = {
      visitorId,
      views,
      events,
      isExcluded: !!excluded,
      liveStats,
    };
    return page();
  },
});

export default define.page<typeof handler>(function VisitorDetailPage({
  state,
}) {
  const { visitorId, views, events, isExcluded, liveStats } = state.pageData;

  return (
    <AdminNav
      title={`Visitor ${visitorId.slice(0, 12)}...`}
      liveStats={liveStats}
      siteId={state.siteId}
      knownSites={state.knownSites}
      days={state.days}
      url={state.url}
      telemetryState={state.telemetryState}
    >
      <div class="flex gap-2 mb-4 items-center">
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
        <BotActions
          visitorId={visitorId}
          isExcluded={isExcluded}
          readOnly={PUBLIC_MODE}
        />
      </div>

      <h3 class="text-sm text-[var(--ea-primary)] mb-2">
        Page Views ({views.length})
      </h3>
      <div class="bg-[var(--ea-surface)] border border-[var(--ea-border)] overflow-hidden mb-4">
        <table class="w-full text-sm">
          <thead>
            <tr class="border-b border-[var(--ea-border)]">
              <th class="text-left px-4 py-2 text-xs text-[var(--ea-muted)]">
                Path
              </th>
              <th class="text-left px-4 py-2 text-xs text-[var(--ea-muted)]">
                Site
              </th>
              <th class="text-left px-4 py-2 text-xs text-[var(--ea-muted)]">
                Score
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
                Time
              </th>
            </tr>
          </thead>
          <tbody>
            {views.map((v, i) => (
              <tr key={i} class="border-b border-[var(--ea-surface-alt)]">
                <td class="px-4 py-1.5 truncate max-w-[200px] text-[var(--ea-text)]">
                  {v.path as string}
                </td>
                <td class="px-4 py-1.5 text-[var(--ea-text)]">
                  {v.site_id as string}
                </td>
                <td class="px-4 py-1.5">
                  <BotScoreDetail
                    viewId={v.id as number}
                    score={v.bot_score as number}
                  />
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
                <td class="px-4 py-1.5 text-[var(--ea-muted)]">
                  {formatTime(v.created_at as string)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {events.length > 0 && (
        <>
          <h3 class="text-sm text-[var(--ea-primary)] mb-2">
            Semantic Events ({events.length})
          </h3>
          <div class="bg-[var(--ea-surface)] border border-[var(--ea-border)] overflow-hidden">
            <table class="w-full text-sm">
              <thead>
                <tr class="border-b border-[var(--ea-border)]">
                  <th class="text-left px-4 py-2 text-xs text-[var(--ea-muted)]">
                    Type
                  </th>
                  <th class="text-left px-4 py-2 text-xs text-[var(--ea-muted)]">
                    Site
                  </th>
                  <th class="text-left px-4 py-2 text-xs text-[var(--ea-muted)]">
                    Score
                  </th>
                  <th class="text-left px-4 py-2 text-xs text-[var(--ea-muted)]">
                    Data
                  </th>
                  <th class="text-left px-4 py-2 text-xs text-[var(--ea-muted)]">
                    Time
                  </th>
                </tr>
              </thead>
              <tbody>
                {events.map((e, i) => (
                  <tr key={i} class="border-b border-[var(--ea-surface-alt)]">
                    <td class="px-4 py-1.5 text-[var(--ea-text)]">
                      {e.event_type as string}
                    </td>
                    <td class="px-4 py-1.5 text-[var(--ea-text)]">
                      {e.site_id as string}
                    </td>
                    <td class="px-4 py-1.5">
                      <BotScoreDetail
                        eventId={e.id as number}
                        score={e.bot_score as number}
                      />
                    </td>
                    <td class="px-4 py-1.5 truncate max-w-[200px]">
                      <span class="text-xs text-[var(--ea-muted)]">
                        {e.data as string}
                      </span>
                    </td>
                    <td class="px-4 py-1.5 text-[var(--ea-muted)]">
                      {formatTime(e.created_at as string)}
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
