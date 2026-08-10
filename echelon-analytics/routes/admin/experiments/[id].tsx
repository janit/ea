import { page } from "fresh";
import { define } from "../../../utils.ts";
import { decodeParam } from "../../../lib/request.ts";
import { AdminNav } from "../../../components/AdminNav.tsx";
import { getLiveStats } from "../../../lib/admin-stats.ts";
import { getExperimentStats } from "../../../lib/stats.ts";
import ExperimentActions from "../../../islands/ExperimentActions.tsx";
import { PUBLIC_MODE } from "../../../lib/config.ts";
import { formatTime } from "../../../lib/format.ts";

export const handler = define.handlers({
  async GET(ctx) {
    const db = ctx.state.db;
    const expId = decodeParam(ctx.params.id);
    // A malformed percent-escape cannot match any stored ID.
    if (expId === null) {
      return new Response("Experiment not found", { status: 404 });
    }

    const experiment = await db.queryOne<Record<string, unknown>>(
      `SELECT * FROM experiments WHERE experiment_id = ?`,
      expId,
    );

    if (!experiment) {
      return new Response("Experiment not found", { status: 404 });
    }

    const variants = await db.query<Record<string, unknown>>(
      `SELECT * FROM experiment_variants WHERE experiment_id = ? ORDER BY is_control DESC`,
      expId,
    );

    const stats = await getExperimentStats(db, expId);
    const liveStats = await getLiveStats(db);

    ctx.state.pageData = {
      experiment,
      variants,
      stats: stats[0] ?? null,
      liveStats,
    };
    return page();
  },
});

export default define.page<typeof handler>(function ExperimentDetailPage({
  state,
}) {
  const { experiment: exp, variants, stats, liveStats } = state.pageData;
  const expId = exp.experiment_id as string;

  return (
    <AdminNav
      title={exp.name as string}
      liveStats={liveStats}
      siteId={state.siteId}
      knownSites={state.knownSites}
      days={state.days}
      url={state.url}
      telemetryState={state.telemetryState}
    >
      <div class="flex gap-2 mb-3">
        <span
          class={`text-xs px-2 py-1 border border-[var(--ea-border)] status-${exp
            .status as string}`}
        >
          {exp.status as string}
        </span>
        <span class="bg-[var(--ea-border)] text-[var(--ea-primary)] text-xs px-2 py-1">
          metric: {exp.metric_event_type as string}
        </span>
        <span class="bg-[var(--ea-border)] text-[var(--ea-primary)] text-xs px-2 py-1">
          alloc: {exp.allocation_percent as number}%
        </span>
        {exp.utm_campaign && (
          <span class="bg-[var(--ea-border)] text-[var(--ea-primary)] text-xs px-2 py-1">
            campaign: {exp.utm_campaign as string}
          </span>
        )}
      </div>

      {exp.description && (
        <p class="text-sm text-[var(--ea-text)] mb-3">
          {exp.description as string}
        </p>
      )}

      {!PUBLIC_MODE && (
        <div class="flex gap-2 mb-4">
          {exp.status === "draft" && (
            <StatusButton
              expId={expId}
              status="active"
              label="> start"
              cls="border-[var(--ea-primary)] text-[var(--ea-primary)] hover:bg-[var(--ea-primary)] hover:text-[var(--ea-bg)]"
            />
          )}
          {exp.status === "active" && (
            <>
              <StatusButton
                expId={expId}
                status="paused"
                label="> pause"
                cls="border-[var(--ea-warn)] text-[var(--ea-warn)] hover:bg-[var(--ea-warn)] hover:text-[var(--ea-bg)]"
              />
              <StatusButton
                expId={expId}
                status="completed"
                label="> complete"
                cls="border-[var(--ea-info)] text-[var(--ea-info)] hover:bg-[var(--ea-info)] hover:text-[var(--ea-bg)]"
              />
            </>
          )}
          {exp.status === "paused" && (
            <>
              <StatusButton
                expId={expId}
                status="active"
                label="> resume"
                cls="border-[var(--ea-primary)] text-[var(--ea-primary)] hover:bg-[var(--ea-primary)] hover:text-[var(--ea-bg)]"
              />
              <StatusButton
                expId={expId}
                status="archived"
                label="> archive"
                cls="border-[var(--ea-muted)] text-[var(--ea-muted)] hover:bg-[var(--ea-muted)] hover:text-[var(--ea-bg)]"
              />
            </>
          )}
          {exp.status === "completed" && (
            <StatusButton
              expId={expId}
              status="archived"
              label="> archive"
              cls="border-[var(--ea-muted)] text-[var(--ea-muted)] hover:bg-[var(--ea-muted)] hover:text-[var(--ea-bg)]"
            />
          )}
        </div>
      )}

      <h3 class="text-sm text-[var(--ea-primary)] mb-2">
        Variants ({variants.length})
      </h3>
      <div class="bg-[var(--ea-surface)] border border-[var(--ea-border)] overflow-hidden mb-4">
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
                Weight
              </th>
              <th class="text-left px-4 py-2 text-xs text-[var(--ea-muted)]">
                Control
              </th>
            </tr>
          </thead>
          <tbody>
            {variants.map((v) => (
              <tr
                key={v.variant_id as string}
                class="border-b border-[var(--ea-surface-alt)]"
              >
                <td class="px-4 py-1.5 text-[var(--ea-text)]">
                  {v.variant_id as string}
                </td>
                <td class="px-4 py-1.5 text-[var(--ea-text)]">
                  {v.name as string}
                </td>
                <td class="px-4 py-1.5 tabular-nums text-[var(--ea-primary)]">
                  {v.weight as number}
                </td>
                <td class="px-4 py-1.5 text-[var(--ea-primary)]">
                  {v.is_control ? "yes" : ""}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {stats && stats.variants.length > 0 && (
        <>
          <h3 class="text-sm text-[var(--ea-primary)] mb-2">Results</h3>
          <div class="bg-[var(--ea-surface)] border border-[var(--ea-border)] overflow-hidden">
            <table class="w-full text-sm">
              <thead>
                <tr class="border-b border-[var(--ea-border)]">
                  <th class="text-left px-4 py-2 text-xs text-[var(--ea-muted)]">
                    Variant
                  </th>
                  <th class="text-right px-4 py-2 text-xs text-[var(--ea-muted)]">
                    Impressions
                  </th>
                  <th class="text-right px-4 py-2 text-xs text-[var(--ea-muted)]">
                    Conversions
                  </th>
                  <th class="text-right px-4 py-2 text-xs text-[var(--ea-muted)]">
                    Rate
                  </th>
                  <th class="text-right px-4 py-2 text-xs text-[var(--ea-muted)]">
                    Uplift
                  </th>
                  <th class="text-left px-4 py-2 text-xs text-[var(--ea-muted)]">
                    Significance
                  </th>
                </tr>
              </thead>
              <tbody>
                {stats.variants.map((v) => (
                  <tr
                    key={v.variant_id}
                    class="border-b border-[var(--ea-surface-alt)]"
                  >
                    <td class="px-4 py-1.5 text-[var(--ea-text)]">
                      {v.name} {v.is_control && "(control)"}
                    </td>
                    <td class="px-4 py-1.5 text-right tabular-nums text-[var(--ea-primary)]">
                      {v.impressions}
                    </td>
                    <td class="px-4 py-1.5 text-right tabular-nums text-[#ff6600]">
                      {v.conversions}
                    </td>
                    <td class="px-4 py-1.5 text-right tabular-nums text-[var(--ea-primary)]">
                      {(v.conversion_rate * 100).toFixed(2)}%
                    </td>
                    <td class="px-4 py-1.5 text-right tabular-nums text-[var(--ea-warn)]">
                      {v.relative_uplift !== null
                        ? `${(v.relative_uplift * 100).toFixed(1)}%`
                        : "-"}
                    </td>
                    <td class="px-4 py-1.5 text-xs text-[var(--ea-muted)]">
                      {v.significance}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}

      <div class="mt-3 text-xs text-[var(--ea-muted)]">
        created: {formatTime(exp.created_at as string)}
        {exp.started_at &&
          ` | started: ${formatTime(exp.started_at as string)}`}
        {exp.ended_at &&
          ` | ended: ${formatTime(exp.ended_at as string)}`}
      </div>
      <ExperimentActions />
    </AdminNav>
  );
});

function StatusButton(
  { expId, status, label, cls }: {
    expId: string;
    status: string;
    label: string;
    cls: string;
  },
) {
  return (
    <button
      type="button"
      class={`px-3 py-1.5 text-xs border ${cls}`}
      data-exp-id={expId}
      data-status={status}
    >
      {label}
    </button>
  );
}
