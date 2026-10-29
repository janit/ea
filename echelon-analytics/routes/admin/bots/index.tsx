import { page } from "fresh";
import { define } from "../../../utils.ts";
import { AdminNav } from "../../../components/AdminNav.tsx";
import { getLiveStats } from "../../../lib/admin-stats.ts";
import type { SQLParam } from "../../../lib/db/adapter.ts";
import BotActions from "../../../islands/BotActions.tsx";
import { PUBLIC_MODE } from "../../../lib/config.ts";
import { formatTime } from "../../../lib/format.ts";
import { scoreBadge } from "../../../components/ScoreBadge.tsx";

export const handler = define.handlers({
  async GET(ctx) {
    const db = ctx.state.db;
    const siteId = ctx.state.siteId !== "default" ? ctx.state.siteId : null;
    const minScore = Math.min(
      100,
      Math.max(
        0,
        parseInt(ctx.url.searchParams.get("min_score") ?? "25") || 25,
      ),
    );
    const limit = Math.min(
      200,
      Math.max(1, parseInt(ctx.url.searchParams.get("limit") ?? "50") || 50),
    );

    const params: SQLParam[] = [minScore];
    let where = "WHERE bot_score >= ?";
    if (siteId) {
      where += " AND site_id = ?";
      params.push(siteId);
    }

    const rows = await db.query<Record<string, unknown>>(
      `SELECT visitor_id,
              MAX(bot_score) AS max_bot_score,
              COUNT(*) AS pageviews,
              MIN(created_at) AS first_seen,
              MAX(created_at) AS last_seen,
              GROUP_CONCAT(DISTINCT site_id) AS sites,
              GROUP_CONCAT(DISTINCT device_type) AS devices,
              GROUP_CONCAT(DISTINCT os_name) AS os_names,
              GROUP_CONCAT(DISTINCT (browser_name || ' ' || browser_version)) AS browsers,
              GROUP_CONCAT(DISTINCT country_code) AS countries,
              EXISTS(SELECT 1 FROM excluded_visitors ev WHERE ev.visitor_id = visitor_views.visitor_id) AS is_excluded
       FROM visitor_views ${where}
       GROUP BY visitor_id
       ORDER BY max_bot_score DESC, pageviews DESC
       LIMIT ?`,
      ...params,
      limit,
    );

    const liveStats = await getLiveStats(db);
    return page({ rows, siteId, minScore, liveStats });
  },
});

export default define.page<typeof handler>(function SuspiciousPage(props) {
  const { data, state } = props;
  const { rows, liveStats } = data;

  return (
    <AdminNav
      title="Bot Detection"
      liveStats={liveStats}
      siteId={state.siteId}
      knownSites={state.knownSites}
      days={state.days}
      url={state.url}
      telemetryState={state.telemetryState}
    >
      <div class="bg-[var(--ea-surface)] border border-[var(--ea-border)] overflow-x-auto">
        <table class="w-full text-sm">
          <thead>
            <tr class="border-b border-[var(--ea-border)]">
              <th class="text-left px-4 py-2 text-xs text-[var(--ea-muted)]">
                Visitor ID
              </th>
              <th class="text-left px-4 py-2 text-xs text-[var(--ea-muted)]">
                Score
              </th>
              <th class="text-right px-4 py-2 text-xs text-[var(--ea-muted)]">
                Views
              </th>
              <th class="text-left px-4 py-2 text-xs text-[var(--ea-muted)]">
                Countries
              </th>
              <th class="text-left px-4 py-2 text-xs text-[var(--ea-muted)]">
                Devices
              </th>
              <th class="text-left px-4 py-2 text-xs text-[var(--ea-muted)]">
                OS
              </th>
              <th class="text-left px-4 py-2 text-xs text-[var(--ea-muted)]">
                Browser
              </th>
              <th class="text-left px-4 py-2 text-xs text-[var(--ea-muted)]">
                Last Seen
              </th>
              <th class="text-left px-4 py-2 text-xs text-[var(--ea-muted)]">
                Actions
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr
                key={r.visitor_id as string}
                class={`border-b border-[var(--ea-surface-alt)] ${
                  r.is_excluded ? "excluded-row" : ""
                }`}
              >
                <td class="px-4 py-1.5">
                  <a
                    href={`/admin/bots/${
                      encodeURIComponent(r.visitor_id as string)
                    }`}
                    class="visitor-id text-[var(--ea-primary)] hover:text-[var(--ea-primary-hover)]"
                  >
                    {(r.visitor_id as string).slice(0, 12)}...
                  </a>
                </td>
                <td class="px-4 py-1.5">
                  {scoreBadge(r.max_bot_score as number)}
                </td>
                <td class="px-4 py-1.5 text-right tabular-nums text-[var(--ea-primary)]">
                  {r.pageviews as number}
                </td>
                <td class="px-4 py-1.5 text-[var(--ea-text)]">
                  {r.countries as string}
                </td>
                <td class="px-4 py-1.5 text-[var(--ea-text)]">
                  {r.devices as string}
                </td>
                <td class="px-4 py-1.5 text-[var(--ea-text)]">
                  {(r.os_names as string) || "-"}
                </td>
                <td class="px-4 py-1.5 text-[var(--ea-text)]">
                  {(r.browsers as string) || "-"}
                </td>
                <td class="px-4 py-1.5 text-[var(--ea-muted)]">
                  {formatTime(r.last_seen as string)}
                </td>
                <td class="px-4 py-1.5">
                  <BotActions
                    visitorId={r.visitor_id as string}
                    isExcluded={!!(r.is_excluded as number)}
                    readOnly={PUBLIC_MODE}
                  />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {rows.length === 0 && (
        <p class="text-[var(--ea-muted)] text-sm mt-4">
          No suspicious visitors found.
        </p>
      )}
    </AdminNav>
  );
});
