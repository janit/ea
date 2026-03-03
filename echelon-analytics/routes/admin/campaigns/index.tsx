import { page } from "fresh";
import { define } from "../../../utils.ts";
import { AdminNav } from "../../../components/AdminNav.tsx";
import { getLiveStats } from "../../../lib/admin-stats.ts";
import { getCampaignStats } from "../../../lib/stats.ts";
import CampaignForm from "../../../islands/CampaignForm.tsx";
import { PUBLIC_MODE } from "../../../lib/config.ts";
import { formatDate } from "../../../lib/format.ts";

export const handler = define.handlers({
  async GET(ctx) {
    const db = ctx.state.db;
    const campaigns = await db.query<Record<string, unknown>>(
      `SELECT * FROM utm_campaigns ORDER BY created_at DESC LIMIT 500`,
    );
    const stats = await getCampaignStats(db, 30);
    const liveStats = await getLiveStats(db);
    ctx.state.pageData = { campaigns, stats, liveStats };
    return page();
  },
});

export default define.page<typeof handler>(function CampaignsPage({ state }) {
  const { campaigns, stats, liveStats } = state.pageData;

  // Build a lookup of stats by campaign id
  const statsById = new Map<string, { views: number; visitors: number }>();
  for (const s of stats) {
    statsById.set(s.id, { views: s.views, visitors: s.visitors });
  }

  return (
    <AdminNav
      title="UTM Campaigns"
      liveStats={liveStats}
      siteId={state.siteId}
      knownSites={state.knownSites}
      days={state.days}
      url={state.url}
      telemetryState={state.telemetryState}
    >
      {!PUBLIC_MODE && (
        <div class="bg-[var(--ea-surface)] border border-[var(--ea-border)] p-4 mb-4">
          <h3 class="text-sm text-[var(--ea-primary)] mb-2">
            Create Campaign
          </h3>
          <CampaignForm />
        </div>
      )}

      <h3 class="text-sm text-[var(--ea-primary)] mb-2">
        All Campaigns ({campaigns.length})
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
                utm_campaign
              </th>
              <th class="text-left px-4 py-2 text-xs text-[var(--ea-muted)]">
                Site
              </th>
              <th class="text-left px-4 py-2 text-xs text-[var(--ea-muted)]">
                Status
              </th>
              <th class="text-right px-4 py-2 text-xs text-[var(--ea-muted)]">
                Views
              </th>
              <th class="text-right px-4 py-2 text-xs text-[var(--ea-muted)]">
                Visitors
              </th>
              <th class="text-left px-4 py-2 text-xs text-[var(--ea-muted)]">
                Created
              </th>
            </tr>
          </thead>
          <tbody>
            {campaigns.map((c) => {
              const cId = c.id as string;
              const s = statsById.get(cId);
              return (
                <tr key={cId} class="border-b border-[var(--ea-surface-alt)]">
                  <td class="px-4 py-1.5">
                    <a
                      href={`/admin/campaigns/${encodeURIComponent(cId)}`}
                      class="text-[var(--ea-primary)] hover:text-[var(--ea-primary-hover)]"
                    >
                      {cId}
                    </a>
                  </td>
                  <td class="px-4 py-1.5 text-[var(--ea-text)]">
                    {c.name as string}
                  </td>
                  <td class="px-4 py-1.5 text-[var(--ea-text)]">
                    {c.utm_campaign as string}
                  </td>
                  <td class="px-4 py-1.5 text-[var(--ea-muted)]">
                    {c.site_id as string}
                  </td>
                  <td class="px-4 py-1.5">
                    <StatusBadge status={c.status as string} />
                  </td>
                  <td class="px-4 py-1.5 text-right tabular-nums text-[var(--ea-primary)]">
                    {s?.views ?? 0}
                  </td>
                  <td class="px-4 py-1.5 text-right tabular-nums text-[var(--ea-primary)]">
                    {s?.visitors ?? 0}
                  </td>
                  <td class="px-4 py-1.5 text-[var(--ea-muted)]">
                    {formatDate(c.created_at as string)}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {campaigns.length === 0 && (
        <p class="text-[var(--ea-muted)] text-sm">No campaigns yet.</p>
      )}
    </AdminNav>
  );
});

function StatusBadge({ status }: { status: string }) {
  const colors: Record<string, string> = {
    active: "text-[var(--ea-primary)] border-[var(--ea-primary)]",
    paused: "text-[var(--ea-warn)] border-[var(--ea-warn)]",
    archived: "text-[var(--ea-muted)] border-[var(--ea-muted)]",
  };
  return (
    <span
      class={`text-xs px-1.5 py-0.5 border ${
        colors[status] ?? "text-[var(--ea-text)] border-[var(--ea-border)]"
      }`}
    >
      {status}
    </span>
  );
}
