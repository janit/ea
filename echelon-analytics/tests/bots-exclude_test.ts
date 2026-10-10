// POST /api/bots/exclude and the daily purge of automatic exclusions.

import { assertEquals } from "@std/assert";
import { handler } from "@/routes/api/bots/exclude.ts";
import { purgeAutoExclusions } from "@/lib/maintenance.ts";
import type { DbAdapter } from "@/lib/db/adapter.ts";
import { createTestDb } from "./_helpers.ts";

type Ctx = Parameters<NonNullable<typeof handler.POST>>[0];

function exclude(db: DbAdapter, body: unknown): Promise<Response> {
  const ctx = {
    state: { db },
    req: new Request("http://localhost/api/bots/exclude", {
      method: "POST",
      body: JSON.stringify(body),
    }),
  } as unknown as Ctx;
  return Promise.resolve(handler.POST!(ctx)) as Promise<Response>;
}

const all = (db: DbAdapter) =>
  db.query<{ visitor_id: string; label: string | null }>(
    "SELECT visitor_id, label FROM excluded_visitors ORDER BY visitor_id",
  );

const NOW = Date.parse("2026-10-09T03:00:00.000Z");
const OLD = new Date(NOW - 31 * 86_400_000).toISOString();

Deno.test("exclude — a manual exclusion replaces an automatic label, and then never expires", async () => {
  const db = createTestDb();
  await db.run(
    "INSERT INTO excluded_visitors (visitor_id, label, created_at) VALUES (?,?,?),(?,?,?)",
    "flagged-then-confirmed",
    "auto:session_velocity",
    OLD,
    "flagged-only",
    "auto:session_velocity",
    OLD,
  );
  const res = await exclude(db, {
    visitor_id: "flagged-then-confirmed",
    label: "scraper, confirmed",
  });
  assertEquals(res.status, 201);
  assertEquals(await all(db), [
    { visitor_id: "flagged-only", label: "auto:session_velocity" },
    { visitor_id: "flagged-then-confirmed", label: "scraper, confirmed" },
  ]);
  assertEquals(await purgeAutoExclusions(db, NOW), 1);
  assertEquals(await all(db), [
    { visitor_id: "flagged-then-confirmed", label: "scraper, confirmed" },
  ]);
  await db.close();
});

Deno.test("exclude — a manual exclusion with no label also replaces an automatic one", async () => {
  const db = createTestDb();
  await db.run(
    "INSERT INTO excluded_visitors (visitor_id, label, created_at) VALUES (?,?,?)",
    "unlabelled",
    "auto:burst_cohort",
    OLD,
  );
  assertEquals((await exclude(db, { visitor_id: "unlabelled" })).status, 201);
  assertEquals(await all(db), [{ visitor_id: "unlabelled", label: null }]);
  assertEquals(await purgeAutoExclusions(db, NOW), 0);
  await db.close();
});

Deno.test("exclude — an existing manual label is kept, and a new visitor is added", async () => {
  const db = createTestDb();
  await exclude(db, { visitor_id: "office", label: "my own office" });
  await exclude(db, { visitor_id: "office", label: "something else" });
  await exclude(db, { visitor_id: "nolabel" });
  await exclude(db, { visitor_id: "nolabel", label: "late label" });
  assertEquals(await all(db), [
    { visitor_id: "nolabel", label: null },
    { visitor_id: "office", label: "my own office" },
  ]);
  assertEquals((await exclude(db, { label: "no id" })).status, 400);
  await db.close();
});

Deno.test("purgeAutoExclusions — goes by the label alone: a hand-typed auto: label expires too", async () => {
  const db = createTestDb();
  await exclude(db, { visitor_id: "typed-auto", label: "auto:mine" });
  await exclude(db, { visitor_id: "typed-other", label: "automatic" });
  await db.run("UPDATE excluded_visitors SET created_at = ?", OLD);
  assertEquals(await purgeAutoExclusions(db, NOW), 1);
  assertEquals(await all(db), [{
    visitor_id: "typed-other",
    label: "automatic",
  }]);
  await db.close();
});
