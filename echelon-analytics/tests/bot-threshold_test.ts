// The human/bot cut-off lives in lib/bot-threshold.ts. These tests pin the
// places that must stay in lockstep with it.

import { assert, assertEquals } from "@std/assert";
import { DatabaseSync } from "node:sqlite";
import {
  BOT_EXCLUDE_SCORE,
  BOT_THRESHOLD,
  CLEAN_SQL,
  cleanSql,
  isBotScore,
  NO_ENGAGEMENT_SCORE,
} from "@/lib/bot-threshold.ts";
import { SCHEMA_SQL } from "@/lib/db/schema.ts";
import { getOverview } from "@/lib/stats.ts";
import { createTestDb, insertView } from "./_helpers.ts";

Deno.test("threshold — boundary: threshold-1 is human, threshold is bot", () => {
  assertEquals(isBotScore(BOT_THRESHOLD - 1), false);
  assertEquals(isBotScore(BOT_THRESHOLD), true);
  assertEquals(
    cleanSql("vv.bot_score"),
    `vv.bot_score BETWEEN 0 AND ${BOT_THRESHOLD - 1}`,
  );
});

Deno.test("threshold — analytics count threshold-1 and drop threshold and ingested (-1)", async () => {
  const db = createTestDb();
  await insertView(db, {
    visitor_id: "edge-human",
    bot_score: BOT_THRESHOLD - 1,
  });
  await insertView(db, { visitor_id: "edge-bot", bot_score: BOT_THRESHOLD });
  await insertView(db, { visitor_id: "ingested", bot_score: -1 });
  const o = await getOverview(db, "test-site", 30);
  assertEquals(o.visits, 1);
  await db.close();
});

Deno.test("threshold — new schema builds the clean partial index from CLEAN_SQL", () => {
  const raw = new DatabaseSync(":memory:");
  raw.exec(SCHEMA_SQL);
  const row = raw.prepare(
    "SELECT sql FROM sqlite_master WHERE name = 'idx_vv_site_created_clean'",
  ).get() as { sql: string };
  assert(row.sql.includes(CLEAN_SQL), row.sql);
  raw.close();
});

Deno.test("threshold — clean queries can use the partial index", () => {
  const raw = new DatabaseSync(":memory:");
  raw.exec(SCHEMA_SQL);
  const plan = raw.prepare(
    `EXPLAIN QUERY PLAN SELECT COUNT(*) FROM visitor_views INDEXED BY idx_vv_site_created_clean
     WHERE site_id = 's' AND created_at >= '2026-01-01' AND ${CLEAN_SQL}`,
  ).all() as { detail: string }[];
  assert(plan.some((p) => p.detail.includes("idx_vv_site_created_clean")));
  raw.close();
});

Deno.test("threshold — startup rebuilds a clean index built for another threshold", async () => {
  const dir = await Deno.makeTempDir();
  const path = `${dir}/old.db`;
  const raw = new DatabaseSync(path);
  raw.exec(SCHEMA_SQL);
  raw.exec("DROP INDEX idx_vv_site_created_clean");
  raw.exec(
    `CREATE INDEX idx_vv_site_created_clean ON visitor_views(site_id, created_at)
     WHERE bot_score BETWEEN 0 AND 39`,
  );
  raw.close();

  const code = `
    import { initDb } from "@/lib/db/database.ts";
    const db = await initDb();
    const r = await db.queryOne("SELECT sql FROM sqlite_master WHERE name = 'idx_vv_site_created_clean'");
    console.log(JSON.stringify(r.sql));
    Deno.exit(0);`;
  const config = new URL("../deno.json", import.meta.url).pathname;
  const out = await new Deno.Command(Deno.execPath(), {
    args: ["eval", "--config", config, code],
    env: { ECHELON_DB_PATH: path },
    stdout: "piped",
    stderr: "piped",
  }).output();
  assert(out.success, new TextDecoder().decode(out.stderr));
  const lines = new TextDecoder().decode(out.stdout).trim().split("\n");
  const sql = JSON.parse(lines[lines.length - 1]) as string;
  assert(sql.includes(CLEAN_SQL), sql);
  await Deno.remove(dir, { recursive: true });
});

Deno.test("score constants — exclude score is in the bot band, engagement score is the threshold", () => {
  assertEquals(BOT_EXCLUDE_SCORE, 60);
  assertEquals(BOT_EXCLUDE_SCORE > BOT_THRESHOLD, true);
  assertEquals(NO_ENGAGEMENT_SCORE, BOT_THRESHOLD);
});
