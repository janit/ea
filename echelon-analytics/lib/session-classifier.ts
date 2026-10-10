// Echelon Analytics — Session Classifier
//
// Write-time scoring judges one request. Some bots only show up across
// requests: a session that reads six pages in ten seconds, a "device" that
// changes operating system, a flood of identical one-page visitors from the
// other side of the world. Every 15 minutes this reads the last 30 minutes of
// visitor_views and flags those.
//
// A flagged identity has its views and events set to BOT_EXCLUDE_SCORE, which
// removes it from every query at once, and is added to excluded_visitors as
// `auto:<reason>` so its later requests are dropped at ingest.
//
// Every reason passes through the proven-human gate (proven-human.ts) before
// anything is written — except two whose signature cannot contain a real
// person, and where `validated` is exactly what the bot forges:
//   os_family_flip: one cookie or one tab on two operating-system vendors;
//   burst_cohort:   40+ one-page visitors, same screen, same country, from a
//                   different continent than the site's home.
//
// Cost. node:sqlite is synchronous, so every statement here blocks all
// requests while it runs. The window's views are read once, through
// idx_vv_created_bot, and every heuristic runs in memory on that one list, so
// the cost is linear in the window however its rows concentrate on one
// visitor or session. Flagged views are stamped by primary key; flagged
// events are found by one more pass over the window of semantic_events,
// through idx_se_created_bot, and stamped the same way. No statement looks an
// identity up outside the window and none scans a table.

import type { DbAdapter } from "./db/adapter.ts";
import { shouldAnonymize } from "./anonymize.ts";
import { BOT_EXCLUDE_SCORE } from "./bot-threshold.ts";
import { continentOf } from "./geo.ts";
import { provenHumanIds } from "./proven-human.ts";
import { loadSiteHomes } from "./site-home.ts";

export type Reason =
  | "session_velocity"
  | "os_rotation"
  | "os_family_flip"
  | "burst_cohort";

export const INTERVAL_MS = 15 * 60_000;
/**
 * The first run after a start. With the full interval a restart left the
 * views of the 15 minutes before it unjudged: by the first run they were
 * past the lookback. Two minutes lets the buffered writers flush first.
 */
export const FIRST_RUN_MS = 2 * 60_000;
const LOOKBACK_MS = 30 * 60_000;

/**
 * An identity is judged only once its oldest view in the window is this old:
 * it has then had this long in which it could have been validated. The
 * validator runs every minute and needs a gesture some seconds into the
 * page, so a person who has just arrived cannot have been proven yet. How
 * recent the newest view is does not matter: a crawler that never pauses is
 * judged while it is still going. Under LOOKBACK_MS - INTERVAL_MS, so every
 * view is seen by some run at this age. The correlator waits as long for the
 * same reason (its own constant).
 */
export const SETTLE_MS = 12 * 60_000;

/**
 * A person does not read 6+ pages averaging 3 s each. Pages, not views: the
 * tracker sends a view for every pushState/replaceState that changes the
 * path or the query, so pagination, a carousel or a map that keeps its state
 * in the URL produces many fast views of one page. See findVelocity().
 */
const VELOCITY_MIN_VIEWS = 6;
const VELOCITY_MAX_AVG_GAP_S = 3;

/** Two versions can be a UA parse split ("iOS 18.7" / "iOS 18.7.2"). */
const OS_ROTATION_MIN_VARIANTS = 3;
const OS_FAMILY_FLIP_MIN = 2;

const BURST_MIN_VISITORS = 40;

const BYPASS_GATE: ReadonlySet<Reason> = new Set([
  "os_family_flip",
  "burst_cohort",
]);
const CHUNK = 500;

type Column = "session_id" | "visitor_id";
type Table = "visitor_views" | "semantic_events";
const COLUMNS: Column[] = ["visitor_id", "session_id"];

/** One view in the window. */
interface WindowView {
  id: number;
  site_id: string;
  visitor_id: string;
  session_id: string | null;
  /** As the tracker sent it: pathname plus query string. */
  path: string;
  os_name: string | null;
  country_code: string | null;
  screen_width: number | null;
  screen_height: number | null;
  is_returning: number;
  bot_score: number;
  created_at: string;
}

/**
 * The one read of visitor_views (one parameter: the window's start). Rows
 * already at BOT_EXCLUDE_SCORE come back too: they are never judged or
 * stamped again, but they are still views of their visitor.
 */
export const WINDOW_VIEWS_SQL =
  `SELECT id, site_id, visitor_id, session_id, path, os_name, country_code,
          screen_width, screen_height, is_returning, bot_score, created_at
     FROM visitor_views INDEXED BY idx_vv_created_bot
    WHERE created_at >= ?`;

/**
 * The window's stampable events that carry a flagged id. Parameters: the
 * window's start, then a JSON array of session ids and one of visitor ids.
 * The site is not matched here; the caller does that row by row.
 */
export const FLAGGED_EVENTS_SQL = `SELECT id, site_id, visitor_id, session_id
     FROM semantic_events INDEXED BY idx_se_created_bot
    WHERE created_at >= ?
      AND bot_score < ${BOT_EXCLUDE_SCORE}
      AND (session_id IN (SELECT value FROM json_each(?))
           OR visitor_id IN (SELECT value FROM json_each(?)))`;

/** Stamp `count` rows of one table, by primary key. */
export function stampSql(table: Table, reason: Reason, count: number): string {
  // `reason` is one of four literals, never request data.
  const stamp = `CASE WHEN json_valid(bot_score_detail)
       THEN json_set(bot_score_detail, '$.classifier', '${reason}')
       ELSE '{"classifier":"${reason}"}' END`;
  return `UPDATE ${table}
             SET bot_score = ${BOT_EXCLUDE_SCORE}, bot_score_detail = ${stamp}
           WHERE id IN (${Array(count).fill("?").join(",")})
             AND bot_score < ${BOT_EXCLUDE_SCORE}`;
}

const key = (...parts: string[]) => parts.join("\u0000");

/**
 * Coarse OS vendor from an os_name as parseOS() writes it. iOS and macOS are
 * one family: an iPad in desktop mode sends a Macintosh UA. Linux and
 * ChromeOS are not a family: Android UAs contain "Linux" and sometimes parse
 * as bare "Linux", which would make real phones look like flips.
 */
export function osFamily(
  osName: string,
): "Apple" | "Android" | "Windows" | null {
  const token = osName.trim().split(/\s+/)[0].toLowerCase();
  if (token === "ios" || token === "ipados" || token === "macos") {
    return "Apple";
  }
  if (token === "android") return "Android";
  if (token === "windows") return "Windows";
  return null;
}

/** A stored path without its query string and fragment. */
export function pathnameOf(path: string): string {
  const end = path.search(/[?#]/);
  return end === -1 ? path : path.slice(0, end);
}

/** What the window holds about one visitor id or one session id. */
interface Identity {
  siteId: string;
  column: Column;
  id: string;
  /** Views in the window, at any score. */
  views: number;
  /** One of them: the only one when `views` is 1. */
  view: WindowView;
  /** On a visitor: the session of `view`, where session ids are identities. */
  viewSession: Identity | null;
  /** Every visitor id on those views: the first, and any others. */
  visitorId: string;
  otherVisitorIds: Set<string> | null;
  // The rest is over the views not yet at BOT_EXCLUDE_SCORE.
  rowIds: number[];
  minTs: string;
  maxTs: string;
  /** On a session: each of those views, by pathname. */
  pages: { rowId: number; ts: string; pathname: string }[] | null;
  /** Every OS name on them: the first, and any others. */
  osName: string | null;
  otherOsNames: Set<string> | null;
  /** The lowest visitor id among the views that carry an OS name. */
  osVisitorId: string;
}

interface Finding {
  identity: Identity;
  reason: Reason;
}

/**
 * Group the window's views by visitor id and by session id, per site.
 *
 * Written for a list of tens of thousands: each row's columns are read once
 * (node:sqlite rows are slow to read from) and the sets that are nearly
 * always empty are only made when needed.
 */
function identitiesOf(rows: WindowView[]): Record<Column, Identity[]> {
  const out: Record<Column, Identity[]> = { visitor_id: [], session_id: [] };
  const sites = new Map<
    string,
    Record<Column, Map<string, Identity>> & { anonymised: boolean }
  >();
  for (const r of rows) {
    const { id: rowId, site_id, visitor_id, path, os_name, created_at } = r;
    const live = r.bot_score < BOT_EXCLUDE_SCORE;
    let site = sites.get(site_id);
    if (!site) {
      site = {
        visitor_id: new Map(),
        session_id: new Map(),
        anonymised: shouldAnonymize(site_id),
      };
      sites.set(site_id, site);
    }
    // A session id of an anonymised site is not an identity: it is one of
    // about fifty names (anonymize.ts), shared by unrelated people.
    const sessionId = site.anonymised ? null : r.session_id;
    let newVisitor: Identity | null = null;
    for (const column of COLUMNS) {
      const id = column === "visitor_id" ? visitor_id : sessionId;
      if (id === null) continue;
      let e = site[column].get(id);
      if (!e) {
        e = {
          siteId: site_id,
          column,
          id,
          views: 0,
          view: r,
          viewSession: null,
          visitorId: visitor_id,
          otherVisitorIds: null,
          rowIds: [],
          minTs: created_at,
          maxTs: created_at,
          pages: null,
          osName: null,
          otherOsNames: null,
          osVisitorId: visitor_id,
        };
        site[column].set(id, e);
        out[column].push(e);
        if (column === "visitor_id") newVisitor = e;
      }
      if (column === "session_id" && newVisitor) newVisitor.viewSession = e;
      e.views++;
      if (visitor_id !== e.visitorId) {
        (e.otherVisitorIds ??= new Set()).add(visitor_id);
      }
      if (!live) continue;
      if (e.rowIds.length === 0 || created_at < e.minTs) e.minTs = created_at;
      if (e.rowIds.length === 0 || created_at > e.maxTs) e.maxTs = created_at;
      e.rowIds.push(rowId);
      if (column === "session_id") {
        (e.pages ??= []).push({
          rowId,
          ts: created_at,
          pathname: pathnameOf(path),
        });
      }
      if (os_name === null) continue;
      if (e.osName === null) {
        e.osName = os_name;
        e.osVisitorId = visitor_id;
        continue;
      }
      if (os_name !== e.osName) (e.otherOsNames ??= new Set()).add(os_name);
      if (visitor_id < e.osVisitorId) e.osVisitorId = visitor_id;
    }
  }
  return out;
}

/**
 * True once the identity's oldest view not yet at BOT_EXCLUDE_SCORE is at
 * least SETTLE_MS old. `settledBy` is the run's time less SETTLE_MS, in the
 * one timestamp format created_at is written in, so the strings compare.
 */
function isSettled(e: Identity, settledBy: string): boolean {
  return e.rowIds.length > 0 && e.minTs <= settledBy;
}

/**
 * Sessions that opened VELOCITY_MIN_VIEWS or more pages, of that many
 * different pathnames, averaging VELOCITY_MAX_AVG_GAP_S or less apart.
 *
 * The pace is taken over the session's views in time order, with each run
 * of consecutive views of one pathname counted as one view, at the run's
 * first. A page that rewrites its URL (pagination, a carousel, a map) is
 * then one page however many views it sent, and coming back to a page
 * later is a new view of it.
 */
function findVelocity(sessions: Identity[]): Finding[] {
  const out: Finding[] = [];
  for (const s of sessions) {
    const pages = s.pages;
    if (pages === null || pages.length < VELOCITY_MIN_VIEWS) continue;
    if (new Set(pages.map((p) => p.pathname)).size < VELOCITY_MIN_VIEWS) {
      continue;
    }
    // The window is read through an index on created_at, but nothing says
    // in what order equal times arrive: order by time, then by row.
    pages.sort((a, b) =>
      a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : a.rowId - b.rowId
    );
    let count = 0;
    let last = pages[0];
    let previous: string | null = null;
    for (const p of pages) {
      if (p.pathname === previous) continue;
      previous = p.pathname;
      last = p;
      count++;
    }
    if (count < VELOCITY_MIN_VIEWS) continue;
    const spanS = (Date.parse(last.ts) - Date.parse(pages[0].ts)) / 1000;
    const avgGap = spanS / (count - 1);
    if (avgGap >= 0 && avgGap <= VELOCITY_MAX_AVG_GAP_S) {
      out.push({ identity: s, reason: "session_velocity" });
    }
  }
  return out;
}

function findOsChanges(identities: Identity[]): Finding[] {
  const out: Finding[] = [];
  for (const e of identities) {
    if (e.osName === null || e.otherOsNames === null) continue;
    const families = [e.osName, ...e.otherOsNames].map(osFamily).filter((f) =>
      f !== null
    );
    if (new Set(families).size >= OS_FAMILY_FLIP_MIN) {
      out.push({ identity: e, reason: "os_family_flip" });
    } else if (families.length >= OS_ROTATION_MIN_VARIANTS) {
      // Every classified name is in the one family; unclassified names
      // (Linux, ChromeOS) do not count as variants of it.
      out.push({ identity: e, reason: "os_rotation" });
    }
  }
  return out;
}

async function findBurstCohorts(
  db: DbAdapter,
  visitors: Identity[],
  settledBy: string,
): Promise<Finding[]> {
  // One-page visits, bucketed by what a farm cannot easily vary across its
  // fleet: the country it exits from and the viewport of its browser image.
  //
  // A member is a session with exactly one view in the window whose visitor
  // id has no other view either (the visitor id alone where the view has no
  // session id, or the site's session ids are not identities). The session
  // is what makes it a person: a browser that refuses the cookie gets a new
  // visitor id on every page, and would otherwise count once per page. Every
  // view counts towards "one", whatever it looks like: a cookie visitor's
  // second page is `is_returning = 1`. And the view must have settled:
  // someone who arrived a minute ago may be about to read a second page.
  const buckets = new Map<string, Identity[]>();
  for (const v of visitors) {
    const r = v.view;
    if (
      v.views !== 1 || !isSettled(v, settledBy) ||
      (v.viewSession !== null && v.viewSession.views !== 1) ||
      r.is_returning !== 0 ||
      r.country_code === null || r.screen_width === null ||
      r.screen_height === null
    ) continue;
    const k = key(
      r.site_id,
      r.country_code,
      String(r.screen_width),
      String(r.screen_height),
    );
    const b = buckets.get(k);
    if (b) b.push(v);
    else buckets.set(k, [v]);
  }
  const cohorts = [...buckets.values()].filter((b) =>
    b.length >= BURST_MIN_VISITORS
  );
  if (cohorts.length === 0) return [];

  // The same reading of site_settings as the scorer's cache: one rule for
  // which row is a site's, and for which stored codes are a country.
  const homes = await loadSiteHomes(db);

  const out: Finding[] = [];
  for (const cohort of cohorts) {
    // Foreign means another CONTINENT. A neighbouring country's audience on
    // one popular phone model is an ordinary cohort; a cookieless site cannot
    // tell first-time visitors apart to narrow it further. No home country,
    // or a country on either side with no known continent: nothing to say.
    const { site_id, country_code } = cohort[0].view;
    const homeContinent = continentOf(
      homes.get(site_id.toLowerCase())?.country,
    );
    const cohortContinent = continentOf(country_code);
    if (!homeContinent || !cohortContinent) continue;
    if (homeContinent === cohortContinent) continue;
    for (const v of cohort) out.push({ identity: v, reason: "burst_cohort" });
  }
  return out;
}

/** Identities of one site, column and reason that are to be stamped. */
interface Verdict {
  siteId: string;
  column: Column;
  reason: Reason;
  identities: Identity[];
}

async function stamp(
  tx: DbAdapter,
  table: Table,
  reason: Reason,
  rowIds: number[],
): Promise<void> {
  for (let i = 0; i < rowIds.length; i += CHUNK) {
    const chunk = rowIds.slice(i, i + CHUNK);
    await tx.run(stampSql(table, reason, chunk.length), ...chunk);
  }
}

/** Stamp every verdict's views and events, and exclude their visitors. */
async function apply(
  tx: DbAdapter,
  verdicts: Verdict[],
  cutoff: string,
): Promise<void> {
  // The window's events of each flagged identity, found in one pass.
  const eventIds = new Map<string, number[]>();
  const flaggedIds: Record<Column, string[]> = {
    visitor_id: [],
    session_id: [],
  };
  for (const v of verdicts) {
    for (const e of v.identities) {
      eventIds.set(key(e.siteId, e.column, e.id), []);
      flaggedIds[e.column].push(e.id);
    }
  }
  const events = await tx.query<
    {
      id: number;
      site_id: string;
      visitor_id: string | null;
      session_id: string | null;
    }
  >(
    FLAGGED_EVENTS_SQL,
    cutoff,
    JSON.stringify(flaggedIds.session_id),
    JSON.stringify(flaggedIds.visitor_id),
  );
  for (const r of events) {
    for (const column of COLUMNS) {
      const id = r[column];
      if (id !== null) eventIds.get(key(r.site_id, column, id))?.push(r.id);
    }
  }

  for (const v of verdicts) {
    await stamp(
      tx,
      "visitor_views",
      v.reason,
      v.identities.flatMap((e) => e.rowIds),
    );
    await stamp(
      tx,
      "semantic_events",
      v.reason,
      v.identities.flatMap((e) => eventIds.get(key(e.siteId, e.column, e.id))!),
    );
    const visitorIds = [
      ...new Set(
        v.identities.flatMap((e) => [e.visitorId, ...e.otherVisitorIds ?? []]),
      ),
    ];
    for (let i = 0; i < visitorIds.length; i += CHUNK) {
      const chunk = visitorIds.slice(i, i + CHUNK);
      // INSERT OR IGNORE: an operator's own exclusion keeps its label.
      await tx.run(
        `INSERT OR IGNORE INTO excluded_visitors (visitor_id, label)
         VALUES ${chunk.map(() => "(?, ?)").join(",")}`,
        ...chunk.flatMap((id) => [id, `auto:${v.reason}`]),
      );
    }
  }
}

/**
 * Run every heuristic once. Returns identities flagged, per reason.
 *
 * One transaction from the read to the last stamp: nothing else writes
 * between a verdict and the rows it is written to.
 */
export async function classifySessions(
  db: DbAdapter,
  now: number = Date.now(),
): Promise<Record<Reason, number>> {
  const cutoff = new Date(now - LOOKBACK_MS).toISOString();
  const counts: Record<Reason, number> = {
    session_velocity: 0,
    os_rotation: 0,
    os_family_flip: 0,
    burst_cohort: 0,
  };

  await db.transaction(async (tx) => {
    const all = identitiesOf(
      await tx.query<WindowView>(WINDOW_VIEWS_SQL, cutoff),
    );
    // Only identities that have had time to be validated are judged
    // (SETTLE_MS); a younger one is judged by a later run, on all its views.
    const settledBy = new Date(now - SETTLE_MS).toISOString();
    const visitors = all.visitor_id.filter((e) => isSettled(e, settledBy));
    const sessions = all.session_id.filter((e) => isSettled(e, settledBy));

    // OS changes are looked for per visitor (a cookie rotating sessions) and
    // per session (cookieless mode, where the visitor id includes the UA and
    // so can never show two systems). With a cookie both see the same rows;
    // keep the visitor-level finding and drop the session-level duplicates.
    const osByVisitor = findOsChanges(visitors);
    const flaggedVisitors = new Set(
      osByVisitor.map((f) => key(f.identity.siteId, f.identity.id)),
    );
    const osBySession = findOsChanges(sessions).filter((f) =>
      !flaggedVisitors.has(key(f.identity.siteId, f.identity.osVisitorId))
    );

    // Gate-bypassing reasons first: once an identity is taken, later
    // findings for the same identity are ignored.
    const findings = [
      ...await findBurstCohorts(tx, all.visitor_id, settledBy),
      ...osByVisitor,
      ...osBySession,
      ...findVelocity(sessions),
    ].sort((a, b) =>
      Number(BYPASS_GATE.has(b.reason)) - Number(BYPASS_GATE.has(a.reason))
    );

    // Group by (site, column, reason), one identity counted once.
    const byReason = new Map<string, Verdict>();
    const seen = new Set<Identity>();
    for (const { identity, reason } of findings) {
      if (seen.has(identity)) continue;
      seen.add(identity);
      const { siteId, column } = identity;
      const k = key(siteId, column, reason);
      const verdict = byReason.get(k);
      if (verdict) verdict.identities.push(identity);
      else byReason.set(k, { siteId, column, reason, identities: [identity] });
    }

    const verdicts: Verdict[] = [];
    for (const v of byReason.values()) {
      if (!BYPASS_GATE.has(v.reason)) {
        const proven = await provenHumanIds(
          tx,
          v.siteId,
          v.column,
          v.identities.map((e) => e.id),
        );
        v.identities = v.identities.filter((e) => !proven.has(e.id));
      }
      if (v.identities.length === 0) continue;
      verdicts.push(v);
      counts[v.reason] += v.identities.length;
    }
    if (verdicts.length > 0) await apply(tx, verdicts, cutoff);
  });

  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  if (total > 0) {
    console.log(
      `[echelon] session-classifier: flagged ${total} ` +
        `(${Object.entries(counts).map(([k, v]) => `${k}=${v}`).join(", ")})`,
    );
  }
  return counts;
}

let firstRun: ReturnType<typeof setTimeout> | null = null;
let timer: ReturnType<typeof setInterval> | null = null;
let running = false;

/**
 * Start the background classifier: one run FIRST_RUN_MS from now, then one
 * every INTERVAL_MS.
 */
export function startSessionClassifier(db: DbAdapter): void {
  if (firstRun || timer) return;
  const run = () => {
    if (running) return;
    running = true;
    classifySessions(db)
      .catch((e) => console.error("[echelon] session-classifier: error", e))
      .finally(() => {
        running = false;
      });
  };
  firstRun = setTimeout(() => {
    firstRun = null;
    timer = setInterval(run, INTERVAL_MS);
    run();
  }, FIRST_RUN_MS);
  console.log(
    `[echelon] session-classifier: started (first run in ${
      FIRST_RUN_MS / 60_000
    }min, then every ${INTERVAL_MS / 60_000}min, ` +
      `lookback ${LOOKBACK_MS / 60_000}min)`,
  );
}

/** Stop the background classifier. */
export function stopSessionClassifier(): void {
  if (firstRun) {
    clearTimeout(firstRun);
    firstRun = null;
  }
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}
