import { page } from "fresh";
import { define } from "../../../utils.ts";
import { AdminNav } from "../../../components/AdminNav.tsx";
import { getLiveStats } from "../../../lib/admin-stats.ts";
import BotActions from "../../../islands/BotActions.tsx";
import { formatTime } from "../../../lib/format.ts";

export const handler = define.handlers({
  async GET(ctx) {
    const db = ctx.state.db;
    const rows = await db.query<Record<string, unknown>>(
      `SELECT ev.*, COUNT(vv.id) AS pageviews, MAX(vv.bot_score) AS max_bot_score
       FROM excluded_visitors ev
       LEFT JOIN visitor_views vv ON vv.visitor_id = ev.visitor_id
       GROUP BY ev.visitor_id
       ORDER BY ev.created_at DESC
       LIMIT 500`,
    );
    const liveStats = await getLiveStats(db);
    ctx.state.pageData = { rows, liveStats };
    return page();
  },
});

export default define.page<typeof handler>(function ExcludedPage({ state }) {
  const { rows, liveStats } = state.pageData;

  return (
    <AdminNav
      title="Excluded Visitors"
      liveStats={liveStats}
      siteId={state.siteId}
      knownSites={state.knownSites}
      days={state.days}
      url={state.url}
      telemetryState={state.telemetryState}
    >
      <div class="bg-[var(--ea-surface)] border border-[var(--ea-border)] overflow-hidden">
        <table class="w-full text-sm">
          <thead>
            <tr class="border-b border-[var(--ea-border)]">
              <th class="text-left px-4 py-2 text-xs text-[var(--ea-muted)]">
                Visitor ID
              </th>
              <th class="text-left px-4 py-2 text-xs text-[var(--ea-muted)]">
                Label
              </th>
              <th class="text-left px-4 py-2 text-xs text-[var(--ea-muted)]">
                Max Score
              </th>
              <th class="text-right px-4 py-2 text-xs text-[var(--ea-muted)]">
                Views
              </th>
              <th class="text-left px-4 py-2 text-xs text-[var(--ea-muted)]">
                Excluded At
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
                class="border-b border-[var(--ea-surface-alt)]"
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
                <td class="px-4 py-1.5 text-[var(--ea-text)]">
                  {(r.label as string) ?? "-"}
                </td>
                <td class="px-4 py-1.5 text-[var(--ea-text)]">
                  {(r.max_bot_score as number) ?? "-"}
                </td>
                <td class="px-4 py-1.5 text-right tabular-nums text-[var(--ea-primary)]">
                  {r.pageviews as number}
                </td>
                <td class="px-4 py-1.5 text-[var(--ea-muted)]">
                  {formatTime(r.created_at as string)}
                </td>
                <td class="px-4 py-1.5">
                  <BotActions
                    visitorId={r.visitor_id as string}
                    isExcluded
                  />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {rows.length === 0 && (
        <p class="text-[var(--ea-muted)] text-sm mt-4">No excluded visitors.</p>
      )}
    </AdminNav>
  );
});
