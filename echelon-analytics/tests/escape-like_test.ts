import { assertEquals } from "@std/assert";
import { escapeLike } from "@/lib/request.ts";
import { createTestDb } from "./_helpers.ts";

async function matches(term: string, values: string[]): Promise<string[]> {
  const db = createTestDb();
  await db.exec("CREATE TABLE t (v TEXT)");
  for (const v of values) await db.run("INSERT INTO t VALUES (?)", v);
  const rows = await db.query<{ v: string }>(
    "SELECT v FROM t WHERE v LIKE ? ESCAPE '\\' ORDER BY v",
    `%${escapeLike(term)}%`,
  );
  await db.close();
  return rows.map((r) => r.v);
}

Deno.test("escapeLike — % and _ match literally", async () => {
  assertEquals(await matches("50%", ["50% off", "500 off"]), ["50% off"]);
  assertEquals(await matches("a_b", ["a_b", "axb"]), ["a_b"]);
});

Deno.test("escapeLike — a typed backslash does not re-arm the wildcard", async () => {
  assertEquals(await matches("\\%", ["x\\%y", "x\\abc"]), ["x\\%y"]);
  assertEquals(await matches("\\", ["a\\b", "ab"]), ["a\\b"]);
});
