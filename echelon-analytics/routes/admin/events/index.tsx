import { page } from "fresh";
import { define } from "../../../utils.ts";
import { AdminNav } from "../../../components/AdminNav.tsx";
import { Pagination } from "../../../components/Pagination.tsx";
import { getLiveStats } from "../../../lib/admin-stats.ts";
import { paginate } from "../../../lib/pagination.ts";
import { escapeLike } from "../../../lib/request.ts";
import type { SQLParam } from "../../../lib/db/adapter.ts";
import { formatTime } from "../../../lib/format.ts";
import { scoreBadge } from "../../../components/ScoreBadge.tsx";

export const handler = define.handlers({
  async GET(ctx) {
    const db = ctx.state.db;
    const siteId = ctx.state.siteId !== "default" ? ctx.state.siteId : null;
    const sp = ctx.url.searchParams;

    const type = sp.get("type") || "";
    const search = sp.get("search") || "";
    const currentPage = parseInt(sp.get("page") ?? "1");

    // Event type distribution
    const typeParams: SQLParam[] = [];
    let typeWhere = "";
    if (siteId) {
      typeWhere = "WHERE site_id = ?";
      typeParams.push(siteId);
    }
    const typeCounts = await db.query<
      { event_type: string; count: number }
    >(
      `SELECT event_type, COUNT(*) as count FROM semantic_events ${typeWhere} GROUP BY event_type ORDER BY count DESC`,
      ...typeParams,
    );

    // Build WHERE clause for listing
    const conditions: string[] = [];
    const params: SQLParam[] = [];

    if (siteId) {
      conditions.push("site_id = ?");
      params.push(siteId);
    }
    if (type) {
      conditions.push("event_type = ?");
      params.push(type);
    }
    if (search) {
      const escaped = escapeLike(search);
      conditions.push(
        "(event_type LIKE ? ESCAPE '\\' OR data LIKE ? ESCAPE '\\')",
      );
      params.push(`%${escaped}%`, `%${escaped}%`);
    }

    const where = conditions.length > 0
      ? `WHERE ${conditions.join(" AND ")}`
      : "";

    const sql =
      `SELECT event_type, site_id, visitor_id, data, device_type, bot_score, is_returning, created_at
       FROM semantic_events ${where}
       ORDER BY created_at DESC`;

    const countSql = `SELECT COUNT(*) AS total FROM semantic_events ${where}`;

    const result = await paginate<Record<string, unknown>>(db, {
      sql,
      countSql,
      params,
      page: currentPage,
    });

    const liveStats = await getLiveStats(db);
    return page({
      ...result,
      typeCounts,
      filters: { type, search },
      liveStats,
      baseUrl: ctx.url.href,
    });
  },
});

export default define.page<typeof handler>(function EventsPage(props) {
  const { data, state } = props;
  const {
    rows,
    total,
    page: currentPage,
    totalPages,
    typeCounts,
    filters,
    liveStats,
    baseUrl,
  } = data;

  return (
    <AdminNav
      title="Events"
      liveStats={liveStats}
      siteId={state.siteId}
      knownSites={state.knownSites}
      days={state.days}
      url={state.url}
      telemetryState={state.telemetryState}
    >
      {/* Type filter badges */}
      <div class="flex flex-wrap gap-2 mb-4">
        <a
          href="?"
          class={`inline-block px-3 py-1 text-xs border ${
            !filters.type
              ? "border-[var(--ea-primary)] text-[var(--ea-primary)] bg-[var(--ea-surface-alt)]"
              : "border-[var(--ea-border)] text-[var(--ea-muted)] hover:text-[var(--ea-primary)] hover:border-[var(--ea-primary)]"
          }`}
        >
          All
        </a>
        {typeCounts.map(
          (tc: { event_type: string; count: number }) => (
            <a
              key={tc.event_type}
              href={`?type=${encodeURIComponent(tc.event_type)}`}
              class={`inline-block px-3 py-1 text-xs border ${
                filters.type === tc.event_type
                  ? "border-[var(--ea-primary)] text-[var(--ea-primary)] bg-[var(--ea-surface-alt)]"
                  : "border-[var(--ea-border)] text-[var(--ea-muted)] hover:text-[var(--ea-primary)] hover:border-[var(--ea-primary)]"
              }`}
            >
              {tc.event_type} <span class="tabular-nums">({tc.count})</span>
            </a>
          ),
        )}
      </div>

      {/* Search */}
      <form method="get" class="flex gap-2 mb-4 items-end">
        {filters.type && (
          <input type="hidden" name="type" value={filters.type} />
        )}
        <input
          type="text"
          name="search"
          placeholder="Search type or data..."
          value={filters.search}
          class="border border-[var(--ea-border)] bg-[var(--ea-bg)] text-[var(--ea-text)] px-2 py-1 text-xs focus:border-[var(--ea-primary)] outline-none w-48"
        />
        <button
          type="submit"
          class="px-2 py-1 text-xs border border-[var(--ea-border)] text-[var(--ea-primary)] hover:bg-[var(--ea-surface-alt)]"
        >
          Search
        </button>
        {filters.search && (
          <a
            href={filters.type
              ? `?type=${encodeURIComponent(filters.type)}`
              : "?"}
            class="px-2 py-1 text-xs border border-[var(--ea-border)] text-[var(--ea-muted)] hover:text-[var(--ea-primary)]"
          >
            Clear
          </a>
        )}
      </form>

      {/* Table */}
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
                Device
              </th>
              <th class="text-left px-4 py-2 text-xs text-[var(--ea-muted)]">
                Data
              </th>
              <th class="text-left px-4 py-2 text-xs text-[var(--ea-muted)]">
                Visitor
              </th>
              <th class="text-left px-4 py-2 text-xs text-[var(--ea-muted)]">
                Score
              </th>
              <th class="text-left px-4 py-2 text-xs text-[var(--ea-muted)]">
                Status
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r: Record<string, unknown>, i: number) => (
              <tr key={i} class="border-b border-[var(--ea-surface-alt)]">
                <td class="px-4 py-1.5 text-[var(--ea-muted)] whitespace-nowrap">
                  {formatTime(r.created_at as string)}
                </td>
                <td class="px-4 py-1.5">
                  <span class="bot-score-badge bot-score-low">
                    {r.event_type as string}
                  </span>
                </td>
                <td class="px-4 py-1.5 text-[var(--ea-text)]">
                  {r.site_id as string}
                </td>
                <td class="px-4 py-1.5 text-[var(--ea-text)]">
                  {(r.device_type as string) || "-"}
                </td>
                <td
                  class="px-4 py-1.5 truncate max-w-[250px]"
                  title={r.data as string ?? ""}
                >
                  <span class="text-xs text-[var(--ea-muted)]">
                    {(r.data as string) || "-"}
                  </span>
                </td>
                <td class="px-4 py-1.5">
                  {r.visitor_id
                    ? (
                      <a
                        href={`/admin/visitors/${
                          encodeURIComponent(r.visitor_id as string)
                        }`}
                        class="visitor-id text-[var(--ea-primary)] hover:text-[var(--ea-primary-hover)]"
                      >
                        {(r.visitor_id as string).slice(0, 12)}...
                      </a>
                    )
                    : <span class="text-[var(--ea-muted)]">-</span>}
                </td>
                <td class="px-4 py-1.5">
                  {scoreBadge(r.bot_score as number)}
                </td>
                <td class="px-4 py-1.5">
                  {r.is_returning
                    ? (
                      <span class="text-xs text-[var(--ea-info)]">
                        returning
                      </span>
                    )
                    : <span class="text-xs text-[var(--ea-muted)]">new</span>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {rows.length === 0 && (
        <p class="text-[var(--ea-muted)] text-sm mt-4">
          No events found.
        </p>
      )}

      <Pagination
        page={currentPage}
        totalPages={totalPages}
        total={total}
        baseUrl={baseUrl}
      />
    </AdminNav>
  );
});
