import { page } from "fresh";
import { define } from "../../../utils.ts";
import { AdminNav } from "../../../components/AdminNav.tsx";
import { Pagination } from "../../../components/Pagination.tsx";
import { getLiveStats } from "../../../lib/admin-stats.ts";
import { paginate } from "../../../lib/pagination.ts";
import type { SQLParam } from "../../../lib/db/adapter.ts";
import { formatTime } from "../../../lib/format.ts";

export const handler = define.handlers({
  async GET(ctx) {
    const db = ctx.state.db;
    const siteId = ctx.state.siteId !== "default" ? ctx.state.siteId : null;
    const sp = ctx.url.searchParams;

    const device = sp.get("device") || "";
    const country = sp.get("country") || "";
    const bot = sp.get("bot") || "";
    const search = sp.get("search") || "";
    const sort = sp.get("sort") || "time_desc";
    const currentPage = parseInt(sp.get("page") ?? "1");

    // Build WHERE clause
    const conditions: string[] = [];
    const params: SQLParam[] = [];

    if (siteId) {
      conditions.push("site_id = ?");
      params.push(siteId);
    }
    if (device) {
      conditions.push("device_type = ?");
      params.push(device);
    }
    if (country) {
      conditions.push("country_code = ?");
      params.push(country);
    }
    if (bot === "suspect") {
      conditions.push("bot_score >= 50");
    } else if (bot === "clean") {
      conditions.push("bot_score < 50");
    }
    if (search) {
      const escaped = search.replace(/[%_]/g, "\\$&");
      conditions.push(
        "(visitor_id LIKE ? ESCAPE '\\' OR path LIKE ? ESCAPE '\\')",
      );
      params.push(`%${escaped}%`, `%${escaped}%`);
    }

    const where = conditions.length > 0
      ? `WHERE ${conditions.join(" AND ")}`
      : "";

    const orderMap: Record<string, string> = {
      time_desc: "created_at DESC",
      time_asc: "created_at ASC",
    };
    const orderBy = orderMap[sort];
    if (!orderBy) {
      return new Response("Invalid sort parameter", { status: 400 });
    }

    const sql = `SELECT * FROM visitor_views ${where} ORDER BY ${orderBy}`;
    const countSql = `SELECT COUNT(*) AS total FROM visitor_views ${where}`;

    const result = await paginate<Record<string, unknown>>(db, {
      sql,
      countSql,
      params,
      page: currentPage,
    });

    // Fetch distinct values for filter dropdowns
    const devices = await db.query<{ device_type: string }>(
      "SELECT DISTINCT device_type FROM visitor_views WHERE device_type IS NOT NULL ORDER BY device_type",
    );
    const countries = await db.query<{ country_code: string }>(
      "SELECT DISTINCT country_code FROM visitor_views WHERE country_code IS NOT NULL ORDER BY country_code",
    );

    const liveStats = await getLiveStats(db);
    ctx.state.pageData = {
      ...result,
      devices: devices.map((d) => d.device_type),
      countries: countries.map((c) => c.country_code),
      filters: { device, country, bot, search, sort },
      liveStats,
      baseUrl: ctx.url.href,
    };
    return page();
  },
});

function scoreBadge(score: number) {
  const cls = score >= 50
    ? "bot-score-high"
    : score >= 25
    ? "bot-score-med"
    : "bot-score-low";
  return <span class={`bot-score-badge ${cls}`}>{score}</span>;
}

export default define.page<typeof handler>(function PageViewsPage({ state }) {
  const {
    rows,
    total,
    page: currentPage,
    totalPages,
    devices,
    countries,
    filters,
    liveStats,
    baseUrl,
  } = state.pageData;

  return (
    <AdminNav
      title="Page Views"
      liveStats={liveStats}
      siteId={state.siteId}
      knownSites={state.knownSites}
      days={state.days}
      url={state.url}
      telemetryState={state.telemetryState}
    >
      {/* Filters */}
      <form method="get" class="flex flex-wrap gap-2 mb-4 items-end">
        <select
          name="device"
          class="border border-[var(--ea-border)] bg-[var(--ea-bg)] text-[var(--ea-text)] px-2 py-1 text-xs focus:border-[var(--ea-primary)] outline-none"
          onchange="this.form.submit()"
        >
          <option value="">All devices</option>
          {devices.map((d: string) => (
            <option key={d} value={d} selected={d === filters.device}>
              {d}
            </option>
          ))}
        </select>

        <select
          name="country"
          class="border border-[var(--ea-border)] bg-[var(--ea-bg)] text-[var(--ea-text)] px-2 py-1 text-xs focus:border-[var(--ea-primary)] outline-none"
          onchange="this.form.submit()"
        >
          <option value="">All countries</option>
          {countries.map((c: string) => (
            <option key={c} value={c} selected={c === filters.country}>
              {c}
            </option>
          ))}
        </select>

        <select
          name="bot"
          class="border border-[var(--ea-border)] bg-[var(--ea-bg)] text-[var(--ea-text)] px-2 py-1 text-xs focus:border-[var(--ea-primary)] outline-none"
          onchange="this.form.submit()"
        >
          <option value="" selected={!filters.bot}>All scores</option>
          <option value="suspect" selected={filters.bot === "suspect"}>
            Suspect (&ge;50)
          </option>
          <option value="clean" selected={filters.bot === "clean"}>
            Clean (&lt;50)
          </option>
        </select>

        <select
          name="sort"
          class="border border-[var(--ea-border)] bg-[var(--ea-bg)] text-[var(--ea-text)] px-2 py-1 text-xs focus:border-[var(--ea-primary)] outline-none"
          onchange="this.form.submit()"
        >
          <option value="time_desc" selected={filters.sort === "time_desc"}>
            Newest first
          </option>
          <option value="time_asc" selected={filters.sort === "time_asc"}>
            Oldest first
          </option>
        </select>

        <div class="flex gap-1">
          <input
            type="text"
            name="search"
            placeholder="Search visitor or path..."
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
              href="?"
              class="px-2 py-1 text-xs border border-[var(--ea-border)] text-[var(--ea-muted)] hover:text-[var(--ea-primary)]"
            >
              Clear
            </a>
          )}
        </div>
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
                Visitor
              </th>
              <th class="text-left px-4 py-2 text-xs text-[var(--ea-muted)]">
                Path
              </th>
              <th class="text-left px-4 py-2 text-xs text-[var(--ea-muted)]">
                Device
              </th>
              <th class="text-left px-4 py-2 text-xs text-[var(--ea-muted)]">
                Country
              </th>
              <th class="text-left px-4 py-2 text-xs text-[var(--ea-muted)]">
                Referrer
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
            {rows.map((r: Record<string, unknown>, i: number) => (
              <tr
                key={i}
                class="border-b border-[var(--ea-surface-alt)]"
              >
                <td class="px-4 py-1.5 text-[var(--ea-muted)] whitespace-nowrap">
                  {formatTime(r.created_at as string)}
                </td>
                <td class="px-4 py-1.5">
                  <a
                    href={`/admin/visitors/${
                      encodeURIComponent(r.visitor_id as string)
                    }`}
                    class="visitor-id text-[var(--ea-primary)] hover:text-[var(--ea-primary-hover)]"
                  >
                    {(r.visitor_id as string).slice(0, 12)}...
                  </a>
                </td>
                <td
                  class="px-4 py-1.5 text-[var(--ea-text)] truncate max-w-[200px]"
                  title={r.path as string}
                >
                  {r.path as string}
                </td>
                <td class="px-4 py-1.5 text-[var(--ea-text)]">
                  {r.device_type as string}
                </td>
                <td class="px-4 py-1.5 text-[var(--ea-text)]">
                  {r.country_code as string}
                </td>
                <td
                  class="px-4 py-1.5 text-[var(--ea-muted)] truncate max-w-[120px]"
                  title={r.referrer as string ?? ""}
                >
                  {(r.referrer as string) || "-"}
                </td>
                <td class="px-4 py-1.5 tabular-nums text-[var(--ea-primary)]">
                  {r.interaction_ms
                    ? `${((r.interaction_ms as number) / 1000).toFixed(1)}s`
                    : "-"}
                </td>
                <td class="px-4 py-1.5">
                  {scoreBadge(r.bot_score as number)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {rows.length === 0 && (
        <p class="text-[var(--ea-muted)] text-sm mt-4">
          No page views found.
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
