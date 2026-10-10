// Echelon Analytics — Proven-Human Gate
//
// The one question every retroactive penalty asks before it writes: has this
// visitor or session already been shown to be a person? `validated = 1` is
// that evidence (view-validator.ts). Routing every penalty through this one
// function is what stops a new heuristic from quietly excluding real users.
//
// A validated view that came from a datacenter IP does not count. A bot in a
// cloud region scores only the datacenter penalty, stays under the threshold,
// and can emit the events that validate it; letting that buy lifelong
// immunity would turn validation into a self-service shield. A real person
// behind a flagged egress loses only this shield, never gets flagged by it.

import type { DbAdapter } from "./db/adapter.ts";

const CHUNK = 500;

/**
 * The index that holds exactly the validated rows for each key. Named in
 * the statement (INDEXED BY): left to itself SQLite reads every view of the
 * site through idx_vv_site_created, which took a third of a second per
 * cluster on a site with 500k views. Both indexes are created in migrate().
 */
const INDEX = {
  visitor_id: "idx_vv_validated_visitor",
  session_id: "idx_vv_validated",
} as const;

type Column = keyof typeof INDEX;

/**
 * The statement for `count` ids: parameters are the site id, then the ids.
 * Exposed for plan tests. `column` is inlined, so anything but the two
 * known columns is refused at run time as well as by the type.
 */
export function provenHumanSql(column: Column, count: number): string {
  if (!Object.hasOwn(INDEX, column)) {
    throw new Error(`provenHumanIds: unsupported column ${String(column)}`);
  }
  const placeholders = Array(count).fill("?").join(",");
  return `SELECT DISTINCT ${column} AS id
            FROM visitor_views INDEXED BY ${INDEX[column]}
           WHERE site_id = ?
             AND ${column} IN (${placeholders})
             AND validated = 1
             AND COALESCE(bot_score_detail, '') NOT LIKE '%"datacenter_ip"%'`;
}

/**
 * The subset of `ids` that own a validated, non-datacenter view on `siteId`.
 */
export async function provenHumanIds(
  db: DbAdapter,
  siteId: string,
  column: Column,
  ids: string[],
): Promise<Set<string>> {
  const proven = new Set<string>();
  // Checked here too, so a bad column fails even when there are no ids.
  provenHumanSql(column, 0);
  for (let i = 0; i < ids.length; i += CHUNK) {
    const chunk = ids.slice(i, i + CHUNK);
    const rows = await db.query<{ id: string }>(
      provenHumanSql(column, chunk.length),
      siteId,
      ...chunk,
    );
    for (const r of rows) proven.add(r.id);
  }
  return proven;
}
