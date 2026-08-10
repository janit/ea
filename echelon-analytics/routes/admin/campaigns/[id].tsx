import { page } from "fresh";
import { define } from "../../../utils.ts";
import { decodeParam } from "../../../lib/request.ts";
import { AdminNav } from "../../../components/AdminNav.tsx";
import { getLiveStats } from "../../../lib/admin-stats.ts";
import { getCampaignDetail, getCampaignStats } from "../../../lib/stats.ts";
import CampaignActions from "../../../islands/CampaignActions.tsx";
import { PUBLIC_MODE } from "../../../lib/config.ts";
import { formatTime } from "../../../lib/format.ts";

export const handler = define.handlers({
  async GET(ctx) {
    const db = ctx.state.db;
    const campaignId = decodeParam(ctx.params.id);
    // A malformed percent-escape cannot match any stored ID.
    if (campaignId === null) {
      return new Response("Campaign not found", { status: 404 });
    }

    const campaign = await db.queryOne<Record<string, unknown>>(
      `SELECT * FROM utm_campaigns WHERE id = ?`,
      campaignId,
    );

    if (!campaign) {
      return new Response("Campaign not found", { status: 404 });
    }

    const detail = await getCampaignDetail(
      db,
      campaign.utm_campaign as string,
      campaign.site_id as string,
      30,
    );

    const liveStats = await getLiveStats(db);
    const summaryArr = await getCampaignStats(db, 30, campaignId);
    const summary = summaryArr[0] ?? { views: 0, visitors: 0 };

    ctx.state.pageData = { campaign, detail, summary, liveStats };
    return page();
  },
});

export default define.page<typeof handler>(function CampaignDetailPage({
  state,
}) {
  const { campaign: c, detail, summary, liveStats } = state.pageData;
  const cId = c.id as string;

  return (
    <AdminNav
      title={c.name as string}
      liveStats={liveStats}
      siteId={state.siteId}
      knownSites={state.knownSites}
      days={state.days}
      url={state.url}
      telemetryState={state.telemetryState}
    >
      <div class="flex gap-2 mb-3">
        <span
          class={`text-xs px-2 py-1 border ${
            statusColors[c.status as string] ??
              "border-[var(--ea-border)] text-[var(--ea-text)]"
          }`}
        >
          {c.status as string}
        </span>
        <span class="bg-[var(--ea-border)] text-[var(--ea-primary)] text-xs px-2 py-1">
          utm_campaign: {c.utm_campaign as string}
        </span>
        <span class="bg-[var(--ea-border)] text-[var(--ea-primary)] text-xs px-2 py-1">
          site: {c.site_id as string}
        </span>
      </div>

      <div class="grid grid-cols-2 md:grid-cols-3 gap-3 mb-4">
        <div class="bg-[var(--ea-surface)] border border-[var(--ea-border)] p-3">
          <div class="text-xs text-[var(--ea-muted)] mb-1">Views (30d)</div>
          <div class="text-xl tabular-nums text-[var(--ea-primary)]">
            {summary.views ?? 0}
          </div>
        </div>
        <div class="bg-[var(--ea-surface)] border border-[var(--ea-border)] p-3">
          <div class="text-xs text-[var(--ea-muted)] mb-1">Visitors (30d)</div>
          <div class="text-xl tabular-nums text-[var(--ea-primary)]">
            {summary.visitors ?? 0}
          </div>
        </div>
      </div>

      {!PUBLIC_MODE && (
        <div class="flex flex-wrap gap-2 mb-4">
          {c.status === "active" && (
            <StatusButton
              campaignId={cId}
              status="paused"
              label="> pause"
              cls="border-[var(--ea-warn)] text-[var(--ea-warn)] hover:bg-[var(--ea-warn)] hover:text-[var(--ea-bg)]"
            />
          )}
          {c.status === "active" && (
            <StatusButton
              campaignId={cId}
              status="archived"
              label="> archive"
              cls="border-[var(--ea-muted)] text-[var(--ea-muted)] hover:bg-[var(--ea-muted)] hover:text-[var(--ea-bg)]"
            />
          )}
          {c.status === "paused" && (
            <>
              <StatusButton
                campaignId={cId}
                status="active"
                label="> resume"
                cls="border-[var(--ea-primary)] text-[var(--ea-primary)] hover:bg-[var(--ea-primary)] hover:text-[var(--ea-bg)]"
              />
              <StatusButton
                campaignId={cId}
                status="archived"
                label="> archive"
                cls="border-[var(--ea-muted)] text-[var(--ea-muted)] hover:bg-[var(--ea-muted)] hover:text-[var(--ea-bg)]"
              />
            </>
          )}
          {c.status === "archived" && (
            <StatusButton
              campaignId={cId}
              status="active"
              label="> reactivate"
              cls="border-[var(--ea-primary)] text-[var(--ea-primary)] hover:bg-[var(--ea-primary)] hover:text-[var(--ea-bg)]"
            />
          )}
          <button
            type="button"
            class="px-3 py-1.5 text-xs border border-[var(--ea-danger)] text-[var(--ea-danger)] hover:bg-[var(--ea-danger)] hover:text-[var(--ea-bg)]"
            data-campaign-id={cId}
            data-action="delete"
          >
            {">"} delete
          </button>
        </div>
      )}

      <h3 class="text-xs text-[var(--ea-muted)] mb-3">Last 30 days</h3>

      {/* Sources */}
      {detail.bySource.length > 0 && (
        <>
          <h3 class="text-sm text-[var(--ea-primary)] mb-2">By Source</h3>
          <div class="bg-[var(--ea-surface)] border border-[var(--ea-border)] overflow-hidden mb-4">
            <table class="w-full text-sm">
              <thead>
                <tr class="border-b border-[var(--ea-border)]">
                  <th class="text-left px-4 py-2 text-xs text-[var(--ea-muted)]">
                    Source
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
                {detail.bySource.map(
                  (
                    s: { utm_source: string; views: number; visitors: number },
                  ) => (
                    <tr
                      key={s.utm_source}
                      class="border-b border-[var(--ea-surface-alt)]"
                    >
                      <td class="px-4 py-1.5 text-[var(--ea-text)]">
                        {s.utm_source}
                      </td>
                      <td class="px-4 py-1.5 text-right tabular-nums text-[var(--ea-primary)]">
                        {s.views}
                      </td>
                      <td class="px-4 py-1.5 text-right tabular-nums text-[var(--ea-primary)]">
                        {s.visitors}
                      </td>
                    </tr>
                  ),
                )}
              </tbody>
            </table>
          </div>
        </>
      )}

      {/* Mediums */}
      {detail.byMedium.length > 0 && (
        <>
          <h3 class="text-sm text-[var(--ea-primary)] mb-2">By Medium</h3>
          <div class="bg-[var(--ea-surface)] border border-[var(--ea-border)] overflow-hidden mb-4">
            <table class="w-full text-sm">
              <thead>
                <tr class="border-b border-[var(--ea-border)]">
                  <th class="text-left px-4 py-2 text-xs text-[var(--ea-muted)]">
                    Medium
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
                {detail.byMedium.map(
                  (
                    m: { utm_medium: string; views: number; visitors: number },
                  ) => (
                    <tr
                      key={m.utm_medium}
                      class="border-b border-[var(--ea-surface-alt)]"
                    >
                      <td class="px-4 py-1.5 text-[var(--ea-text)]">
                        {m.utm_medium}
                      </td>
                      <td class="px-4 py-1.5 text-right tabular-nums text-[var(--ea-primary)]">
                        {m.views}
                      </td>
                      <td class="px-4 py-1.5 text-right tabular-nums text-[var(--ea-primary)]">
                        {m.visitors}
                      </td>
                    </tr>
                  ),
                )}
              </tbody>
            </table>
          </div>
        </>
      )}

      {/* Content */}
      {detail.byContent.length > 0 && (
        <>
          <h3 class="text-sm text-[var(--ea-primary)] mb-2">By Content</h3>
          <div class="bg-[var(--ea-surface)] border border-[var(--ea-border)] overflow-hidden mb-4">
            <table class="w-full text-sm">
              <thead>
                <tr class="border-b border-[var(--ea-border)]">
                  <th class="text-left px-4 py-2 text-xs text-[var(--ea-muted)]">
                    Content
                  </th>
                  <th class="text-right px-4 py-2 text-xs text-[var(--ea-muted)]">
                    Views
                  </th>
                </tr>
              </thead>
              <tbody>
                {detail.byContent.map(
                  (ct: { utm_content: string; views: number }) => (
                    <tr
                      key={ct.utm_content}
                      class="border-b border-[var(--ea-surface-alt)]"
                    >
                      <td class="px-4 py-1.5 text-[var(--ea-text)]">
                        {ct.utm_content}
                      </td>
                      <td class="px-4 py-1.5 text-right tabular-nums text-[var(--ea-primary)]">
                        {ct.views}
                      </td>
                    </tr>
                  ),
                )}
              </tbody>
            </table>
          </div>
        </>
      )}

      {/* Term */}
      {detail.byTerm.length > 0 && (
        <>
          <h3 class="text-sm text-[var(--ea-primary)] mb-2">By Term</h3>
          <div class="bg-[var(--ea-surface)] border border-[var(--ea-border)] overflow-hidden mb-4">
            <table class="w-full text-sm">
              <thead>
                <tr class="border-b border-[var(--ea-border)]">
                  <th class="text-left px-4 py-2 text-xs text-[var(--ea-muted)]">
                    Term
                  </th>
                  <th class="text-right px-4 py-2 text-xs text-[var(--ea-muted)]">
                    Views
                  </th>
                </tr>
              </thead>
              <tbody>
                {detail.byTerm.map(
                  (t: { utm_term: string; views: number }) => (
                    <tr
                      key={t.utm_term}
                      class="border-b border-[var(--ea-surface-alt)]"
                    >
                      <td class="px-4 py-1.5 text-[var(--ea-text)]">
                        {t.utm_term}
                      </td>
                      <td class="px-4 py-1.5 text-right tabular-nums text-[var(--ea-primary)]">
                        {t.views}
                      </td>
                    </tr>
                  ),
                )}
              </tbody>
            </table>
          </div>
        </>
      )}

      {/* Top Landing Pages */}
      {detail.topPaths.length > 0 && (
        <>
          <h3 class="text-sm text-[var(--ea-primary)] mb-2">
            Top Landing Pages
          </h3>
          <div class="bg-[var(--ea-surface)] border border-[var(--ea-border)] overflow-hidden mb-4">
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
                {detail.topPaths.map(
                  (p: { path: string; views: number; visitors: number }) => (
                    <tr
                      key={p.path}
                      class="border-b border-[var(--ea-surface-alt)]"
                    >
                      <td class="px-4 py-1.5 text-[var(--ea-text)]">
                        {p.path}
                      </td>
                      <td class="px-4 py-1.5 text-right tabular-nums text-[var(--ea-primary)]">
                        {p.views}
                      </td>
                      <td class="px-4 py-1.5 text-right tabular-nums text-[var(--ea-primary)]">
                        {p.visitors}
                      </td>
                    </tr>
                  ),
                )}
              </tbody>
            </table>
          </div>
        </>
      )}

      {/* Daily Trend */}
      {detail.dailyTrend.length > 0 && (
        <>
          <h3 class="text-sm text-[var(--ea-primary)] mb-2">Daily Trend</h3>
          <div class="bg-[var(--ea-surface)] border border-[var(--ea-border)] overflow-hidden mb-4">
            <table class="w-full text-sm">
              <thead>
                <tr class="border-b border-[var(--ea-border)]">
                  <th class="text-left px-4 py-2 text-xs text-[var(--ea-muted)]">
                    Date
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
                {detail.dailyTrend.map(
                  (d: { date: string; views: number; visitors: number }) => (
                    <tr
                      key={d.date}
                      class="border-b border-[var(--ea-surface-alt)]"
                    >
                      <td class="px-4 py-1.5 text-[var(--ea-muted)]">
                        {d.date}
                      </td>
                      <td class="px-4 py-1.5 text-right tabular-nums text-[var(--ea-primary)]">
                        {d.views}
                      </td>
                      <td class="px-4 py-1.5 text-right tabular-nums text-[var(--ea-primary)]">
                        {d.visitors}
                      </td>
                    </tr>
                  ),
                )}
              </tbody>
            </table>
          </div>
        </>
      )}

      {detail.bySource.length === 0 && detail.dailyTrend.length === 0 && (
        <p class="text-[var(--ea-muted)] text-sm">
          No data yet for this campaign.
        </p>
      )}

      <div class="mt-3 text-xs text-[var(--ea-muted)]">
        created: {formatTime(c.created_at as string)}
      </div>
      <CampaignActions />
    </AdminNav>
  );
});

const statusColors: Record<string, string> = {
  active: "border-[var(--ea-primary)] text-[var(--ea-primary)]",
  paused: "border-[var(--ea-warn)] text-[var(--ea-warn)]",
  archived: "border-[var(--ea-muted)] text-[var(--ea-muted)]",
};

function StatusButton(
  { campaignId, status, label, cls }: {
    campaignId: string;
    status: string;
    label: string;
    cls: string;
  },
) {
  return (
    <button
      type="button"
      class={`px-3 py-1.5 text-xs border ${cls}`}
      data-campaign-id={campaignId}
      data-status={status}
    >
      {label}
    </button>
  );
}
