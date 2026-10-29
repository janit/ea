import { page } from "fresh";
import { define } from "../../../utils.ts";
import { AdminNav } from "../../../components/AdminNav.tsx";
import { getLiveStats } from "../../../lib/admin-stats.ts";
import { getExperimentStats } from "../../../lib/stats.ts";
import ExperimentForm from "../../../islands/ExperimentForm.tsx";
import { PUBLIC_MODE } from "../../../lib/config.ts";
import { formatDate } from "../../../lib/format.ts";

export const handler = define.handlers({
  async GET(ctx) {
    const db = ctx.state.db;
    const experiments = await db.query<Record<string, unknown>>(
      `SELECT * FROM experiments ORDER BY created_at DESC`,
    );
    const stats = await getExperimentStats(db);
    const liveStats = await getLiveStats(db);
    return page({ experiments, stats, liveStats });
  },
});

export default define.page<typeof handler>(function ExperimentsPage(props) {
  const { data, state } = props;
  const { experiments, stats, liveStats } = data;

  return (
    <AdminNav
      title="A/B Experiments"
      liveStats={liveStats}
      siteId={state.siteId}
      knownSites={state.knownSites}
      days={state.days}
      url={state.url}
      telemetryState={state.telemetryState}
    >
      {!PUBLIC_MODE && (
        <div class="bg-[var(--ea-surface)] border border-[var(--ea-border)] p-4 mb-4">
          <h2 class="text-sm text-[var(--ea-primary)] mb-2">
            Create Experiment
          </h2>
          <ExperimentForm />
        </div>
      )}

      <h2 class="text-sm text-[var(--ea-primary)] mb-2">
        All Experiments ({experiments.length})
      </h2>
      <div class="bg-[var(--ea-surface)] border border-[var(--ea-border)] overflow-x-auto mb-4">
        <table class="w-full text-sm">
          <thead>
            <tr class="border-b border-[var(--ea-border)]">
              <th class="text-left px-4 py-2 text-xs text-[var(--ea-muted)]">
                ID
              </th>
              <th class="text-left px-4 py-2 text-xs text-[var(--ea-muted)]">
                Name
              </th>
              <th class="text-left px-4 py-2 text-xs text-[var(--ea-muted)]">
                Status
              </th>
              <th class="text-left px-4 py-2 text-xs text-[var(--ea-muted)]">
                Metric
              </th>
              <th class="text-left px-4 py-2 text-xs text-[var(--ea-muted)]">
                Created
              </th>
              <th class="text-left px-4 py-2 text-xs text-[var(--ea-muted)]">
                Actions
              </th>
            </tr>
          </thead>
          <tbody>
            {experiments.map((e) => (
              <tr
                key={e.experiment_id as string}
                class="border-b border-[var(--ea-surface-alt)]"
              >
                <td class="px-4 py-1.5">
                  <a
                    href={`/admin/experiments/${
                      encodeURIComponent(e.experiment_id as string)
                    }`}
                    class="text-[var(--ea-primary)] hover:text-[var(--ea-primary-hover)]"
                  >
                    {e.experiment_id as string}
                  </a>
                </td>
                <td class="px-4 py-1.5 text-[var(--ea-text)]">
                  {e.name as string}
                </td>
                <td class="px-4 py-1.5">
                  <span class={`status-${e.status as string}`}>
                    {e.status as string}
                  </span>
                </td>
                <td class="px-4 py-1.5 text-[var(--ea-text)]">
                  {e.metric_event_type as string}
                </td>
                <td class="px-4 py-1.5 text-[var(--ea-muted)]">
                  {formatDate(e.created_at as string)}
                </td>
                <td class="px-4 py-1.5">
                  <a
                    href={`/admin/experiments/${
                      encodeURIComponent(e.experiment_id as string)
                    }`}
                    class="text-xs text-[var(--ea-primary)] hover:text-[var(--ea-primary-hover)]"
                  >
                    view
                  </a>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {experiments.length === 0 && (
        <p class="text-[var(--ea-muted)] text-sm">No experiments yet.</p>
      )}

      {stats.length > 0 && (
        <>
          <h2 class="text-sm text-[var(--ea-primary)] mb-2 mt-4">
            Active/Completed Stats
          </h2>
          {stats.map((s) => (
            <div
              key={s.experiment_id}
              class="bg-[var(--ea-surface)] border border-[var(--ea-border)] p-4 mb-3"
            >
              <h3 class="text-sm text-[var(--ea-primary)]">
                {s.name} <span class={`status-${s.status}`}>({s.status})</span>
              </h3>
              <table class="w-full text-sm mt-2">
                <thead>
                  <tr class="border-b border-[var(--ea-border)]">
                    <th class="text-left py-1 text-xs text-[var(--ea-muted)]">
                      Variant
                    </th>
                    <th class="text-right py-1 text-xs text-[var(--ea-muted)]">
                      Impressions
                    </th>
                    <th class="text-right py-1 text-xs text-[var(--ea-muted)]">
                      Conversions
                    </th>
                    <th class="text-right py-1 text-xs text-[var(--ea-muted)]">
                      Rate
                    </th>
                    <th class="text-right py-1 text-xs text-[var(--ea-muted)]">
                      Uplift
                    </th>
                    <th class="text-left py-1 text-xs text-[var(--ea-muted)]">
                      Significance
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {s.variants.map((v) => (
                    <tr
                      key={v.variant_id}
                      class="border-b border-[var(--ea-surface-alt)]"
                    >
                      <td class="py-1 text-[var(--ea-text)]">
                        {v.name} {v.is_control && "(control)"}
                      </td>
                      <td class="py-1 text-right tabular-nums text-[var(--ea-primary)]">
                        {v.impressions}
                      </td>
                      <td class="py-1 text-right tabular-nums text-[var(--ea-series-2)]">
                        {v.conversions}
                      </td>
                      <td class="py-1 text-right tabular-nums text-[var(--ea-primary)]">
                        {(v.conversion_rate * 100).toFixed(2)}%
                      </td>
                      <td class="py-1 text-right tabular-nums text-[var(--ea-warn)]">
                        {v.relative_uplift !== null
                          ? `${(v.relative_uplift * 100).toFixed(1)}%`
                          : "-"}
                      </td>
                      <td class="py-1 text-xs text-[var(--ea-muted)]">
                        {v.significance}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ))}
        </>
      )}
    </AdminNav>
  );
});
