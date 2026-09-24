import { page } from "fresh";
import { define } from "../../utils.ts";
import { AdminNav } from "../../components/AdminNav.tsx";
import { getLiveStats } from "../../lib/admin-stats.ts";
import { getTrends, queryMetrics } from "../../lib/perf.ts";
import { formatDate, formatTime } from "../../lib/format.ts";

export const handler = define.handlers({
  async GET(ctx) {
    const url = new URL(ctx.req.url);
    const category = url.searchParams.get("category") ?? undefined;
    const limit = parseInt(url.searchParams.get("limit") ?? "50");

    const metrics = await queryMetrics(ctx.state.db, { category, limit });
    const trends = await getTrends(ctx.state.db, { limit: 20 });
    const liveStats = await getLiveStats(ctx.state.db);

    return page({ metrics, trends, category, liveStats });
  },
});

export default define.page<typeof handler>(function PerfPage({ data, state }) {
  const { metrics, trends, liveStats } = data;
  const trendKeys = Object.keys(trends);

  return (
    <AdminNav
      title="Performance"
      liveStats={liveStats}
      siteId={state.siteId}
      knownSites={state.knownSites}
      days={state.days}
      url={state.url}
      telemetryState={state.telemetryState}
    >
      <h3 class="text-sm text-[var(--ea-primary)] mb-2">
        Recent Metrics ({metrics.length})
      </h3>
      <div class="bg-[var(--ea-surface)] border border-[var(--ea-border)] overflow-hidden mb-4">
        <table class="w-full text-sm">
          <thead>
            <tr class="border-b border-[var(--ea-border)]">
              <th class="text-left px-4 py-2 text-xs text-[var(--ea-muted)]">
                Category
              </th>
              <th class="text-left px-4 py-2 text-xs text-[var(--ea-muted)]">
                Metric
              </th>
              <th class="text-right px-4 py-2 text-xs text-[var(--ea-muted)]">
                Value
              </th>
              <th class="text-left px-4 py-2 text-xs text-[var(--ea-muted)]">
                Unit
              </th>
              <th class="text-left px-4 py-2 text-xs text-[var(--ea-muted)]">
                Branch
              </th>
              <th class="text-left px-4 py-2 text-xs text-[var(--ea-muted)]">
                Time
              </th>
            </tr>
          </thead>
          <tbody>
            {metrics.map((m) => (
              <tr key={m.id} class="border-b border-[var(--ea-surface-alt)]">
                <td class="px-4 py-1.5 text-[var(--ea-text)]">{m.category}</td>
                <td class="px-4 py-1.5 text-[var(--ea-text)]">{m.metric}</td>
                <td class="px-4 py-1.5 text-right tabular-nums text-[var(--ea-primary)]">
                  {m.value.toFixed(2)}
                </td>
                <td class="px-4 py-1.5 text-[var(--ea-muted)]">{m.unit}</td>
                <td class="px-4 py-1.5 text-[var(--ea-text)]">
                  {m.branch ?? "-"}
                </td>
                <td class="px-4 py-1.5 text-[var(--ea-muted)]">
                  {formatTime(m.recorded_at)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {metrics.length === 0 && (
        <p class="text-[var(--ea-muted)] text-sm">
          No performance metrics recorded.
        </p>
      )}

      {trendKeys.length > 0 && (
        <>
          <h3 class="text-sm text-[var(--ea-primary)] mb-2">Trends</h3>
          {trendKeys.map((key) => {
            const rows = trends[key];
            if (!rows.length) return null;
            const values = rows.map((r) => r.value);
            const max = Math.max(...values);
            const min = Math.min(...values);
            const last = values[values.length - 1];
            return (
              <div
                key={key}
                class="bg-[var(--ea-surface)] border border-[var(--ea-border)] p-3 mb-2"
              >
                <div class="flex justify-between items-center">
                  <span class="text-sm text-[var(--ea-primary)]">{key}</span>
                  <span class="text-sm tabular-nums text-[var(--ea-primary)]">
                    {last.toFixed(2)} {rows[0].unit}
                    <span class="text-xs text-[var(--ea-muted)] ml-2">
                      (min: {min.toFixed(2)}, max: {max.toFixed(2)})
                    </span>
                  </span>
                </div>
                <div class="flex gap-px items-end h-6 mt-1">
                  {values.map((v, i) => {
                    const h = max > min
                      ? Math.max(2, ((v - min) / (max - min)) * 24)
                      : 12;
                    return (
                      <div
                        key={i}
                        style={`width:${
                          100 / values.length
                        }%;height:${h}px;background:#ff6600`}
                        class="rounded-sm"
                        title={`${v.toFixed(2)} (${
                          formatDate(rows[i].recorded_at)
                        })`}
                      />
                    );
                  })}
                </div>
              </div>
            );
          })}
        </>
      )}
    </AdminNav>
  );
});
