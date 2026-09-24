import { page } from "fresh";
import { define } from "../../../utils.ts";
import { AdminNav } from "../../../components/AdminNav.tsx";
import { Pagination } from "../../../components/Pagination.tsx";
import { getLiveStats } from "../../../lib/admin-stats.ts";
import { paginate } from "../../../lib/pagination.ts";
import { escapeLike } from "../../../lib/request.ts";
import type { SQLParam } from "../../../lib/db/adapter.ts";
import BotActions from "../../../islands/BotActions.tsx";
import { PUBLIC_MODE } from "../../../lib/config.ts";
import { formatTime } from "../../../lib/format.ts";
import { botSql } from "../../../lib/bot-threshold.ts";
import { scoreBadge } from "../../../components/ScoreBadge.tsx";
import { submitOnChange } from "../../../components/submitOnChange.ts";

export const handler = define.handlers({
  async GET(ctx) {
    const db = ctx.state.db;
    const siteId = ctx.state.siteId !== "default" ? ctx.state.siteId : null;
    const sp = ctx.url.searchParams;

    const device = sp.get("device") || "";
    const country = sp.get("country") || "";
    const returning = sp.get("returning") || "";
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
    if (returning === "returning") {
      conditions.push("MAX(is_returning) = 1");
    } else if (returning === "new") {
      conditions.push("MAX(is_returning) = 0");
    }
    if (bot === "suspect") {
      conditions.push(botSql("MAX(bot_score)"));
    } else if (bot === "clean") {
      conditions.push(`NOT ${botSql("MAX(bot_score)")}`);
    }
    if (search) {
      const escaped = escapeLike(search);
      conditions.push("visitor_id LIKE ? ESCAPE '\\'");
      params.push(`%${escaped}%`);
    }

    // Split conditions into WHERE (pre-group) and HAVING (post-group)
    const whereConds: string[] = [];
    const havingConds: string[] = [];
    const whereParams: SQLParam[] = [];
    const havingParams: SQLParam[] = [];

    for (let i = 0; i < conditions.length; i++) {
      const cond = conditions[i];
      if (
        cond.startsWith("MAX(") || cond.startsWith("COUNT(")
      ) {
        havingConds.push(cond);
      } else {
        whereConds.push(cond);
        // Count placeholders in condition to pull matching params
        const placeholders = (cond.match(/\?/g) || []).length;
        for (let j = 0; j < placeholders; j++) {
          whereParams.push(params.shift()!);
        }
        continue;
      }
      const placeholders = (cond.match(/\?/g) || []).length;
      for (let j = 0; j < placeholders; j++) {
        havingParams.push(params.shift()!);
      }
    }

    const where = whereConds.length > 0
      ? `WHERE ${whereConds.join(" AND ")}`
      : "";
    const having = havingConds.length > 0
      ? `HAVING ${havingConds.join(" AND ")}`
      : "";

    const allParams = [...whereParams, ...havingParams];

    const orderMap: Record<string, string> = {
      time_desc: "last_seen DESC",
      time_asc: "last_seen ASC",
      views_desc: "view_count DESC",
      views_asc: "view_count ASC",
    };
    const orderBy = orderMap[sort];
    if (!orderBy) {
      return new Response("Invalid sort parameter", { status: 400 });
    }

    const sql = `SELECT
      visitor_id,
      COUNT(*) AS view_count,
      MAX(created_at) AS last_seen,
      MIN(created_at) AS first_seen,
      MAX(device_type) AS device_type,
      MAX(os_name) AS os_name,
      MAX(browser_name || ' ' || browser_version) AS browser,
      MAX(country_code) AS country_code,
      MAX(is_returning) AS is_returning,
      MAX(bot_score) AS max_bot_score,
      EXISTS(SELECT 1 FROM excluded_visitors ev WHERE ev.visitor_id = vv.visitor_id) AS is_excluded
      FROM visitor_views vv
      ${where}
      GROUP BY visitor_id
      ${having}
      ORDER BY ${orderBy}`;

    const countSql =
      `SELECT COUNT(*) AS total FROM (SELECT visitor_id FROM visitor_views ${where} GROUP BY visitor_id ${having})`;

    const result = await paginate<Record<string, unknown>>(db, {
      sql,
      countSql,
      params: allParams,
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
    return page({
      ...result,
      devices: devices.map((d) => d.device_type),
      countries: countries.map((c) => c.country_code),
      filters: { device, country, returning, bot, search, sort },
      liveStats,
      baseUrl: ctx.url.href,
    });
  },
});

export default define.page<typeof handler>(function VisitorsPage(props) {
  const { data, state } = props;
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
  } = data;

  return (
    <AdminNav
      title="Visitors"
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
          {...submitOnChange}
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
          {...submitOnChange}
        >
          <option value="">All countries</option>
          {countries.map((c: string) => (
            <option key={c} value={c} selected={c === filters.country}>
              {c}
            </option>
          ))}
        </select>

        <select
          name="returning"
          class="border border-[var(--ea-border)] bg-[var(--ea-bg)] text-[var(--ea-text)] px-2 py-1 text-xs focus:border-[var(--ea-primary)] outline-none"
          {...submitOnChange}
        >
          <option value="" selected={!filters.returning}>All visitors</option>
          <option
            value="returning"
            selected={filters.returning === "returning"}
          >
            Returning
          </option>
          <option value="new" selected={filters.returning === "new"}>
            New
          </option>
        </select>

        <select
          name="bot"
          class="border border-[var(--ea-border)] bg-[var(--ea-bg)] text-[var(--ea-text)] px-2 py-1 text-xs focus:border-[var(--ea-primary)] outline-none"
          {...submitOnChange}
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
          {...submitOnChange}
        >
          <option value="time_desc" selected={filters.sort === "time_desc"}>
            Last seen
          </option>
          <option value="time_asc" selected={filters.sort === "time_asc"}>
            First seen
          </option>
          <option value="views_desc" selected={filters.sort === "views_desc"}>
            Most views
          </option>
          <option value="views_asc" selected={filters.sort === "views_asc"}>
            Fewest views
          </option>
        </select>

        <div class="flex gap-1">
          <input
            type="text"
            name="search"
            placeholder="Search visitor ID..."
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
                Visitor
              </th>
              <th class="text-right px-4 py-2 text-xs text-[var(--ea-muted)]">
                Views
              </th>
              <th class="text-left px-4 py-2 text-xs text-[var(--ea-muted)]">
                Last Seen
              </th>
              <th class="text-left px-4 py-2 text-xs text-[var(--ea-muted)]">
                First Seen
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
                Country
              </th>
              <th class="text-left px-4 py-2 text-xs text-[var(--ea-muted)]">
                Score
              </th>
              <th class="text-left px-4 py-2 text-xs text-[var(--ea-muted)]">
                Status
              </th>
              <th class="text-left px-4 py-2 text-xs text-[var(--ea-muted)]">
                Actions
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r: Record<string, unknown>, i: number) => (
              <tr
                key={i}
                class={`border-b border-[var(--ea-surface-alt)] ${
                  r.is_excluded ? "excluded-row" : ""
                }`}
              >
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
                <td class="px-4 py-1.5 text-right tabular-nums text-[var(--ea-primary)]">
                  {r.view_count as number}
                </td>
                <td class="px-4 py-1.5 text-[var(--ea-muted)] whitespace-nowrap">
                  {formatTime(r.last_seen as string)}
                </td>
                <td class="px-4 py-1.5 text-[var(--ea-muted)] whitespace-nowrap">
                  {formatTime(r.first_seen as string)}
                </td>
                <td class="px-4 py-1.5 text-[var(--ea-text)]">
                  {r.device_type as string}
                </td>
                <td class="px-4 py-1.5 text-[var(--ea-text)]">
                  {(r.os_name as string) || "-"}
                </td>
                <td class="px-4 py-1.5 text-[var(--ea-text)]">
                  {(r.browser as string) || "-"}
                </td>
                <td class="px-4 py-1.5 text-[var(--ea-text)]">
                  {r.country_code as string}
                </td>
                <td class="px-4 py-1.5">
                  {scoreBadge(r.max_bot_score as number)}
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
          No visitors found.
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
