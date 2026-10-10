import { assertEquals, assertRejects } from "@std/assert";
import { createTestDb, insertView } from "./_helpers.ts";

Deno.test("SqliteAdapter — query returns rows", async () => {
  const db = createTestDb();
  await db.run(
    "INSERT INTO visitor_views (visitor_id, path, site_id, referrer_type) VALUES (?, ?, ?, ?)",
    "v1",
    "/",
    "test",
    "direct_or_unknown",
  );
  const rows = await db.query<{ visitor_id: string }>(
    "SELECT visitor_id FROM visitor_views",
  );
  assertEquals(rows.length, 1);
  assertEquals(rows[0].visitor_id, "v1");
  await db.close();
});

Deno.test("SqliteAdapter — queryOne returns first row", async () => {
  const db = createTestDb();
  await db.run(
    "INSERT INTO visitor_views (visitor_id, path, site_id, referrer_type) VALUES (?, ?, ?, ?)",
    "v1",
    "/",
    "test",
    "direct_or_unknown",
  );
  const row = await db.queryOne<{ visitor_id: string }>(
    "SELECT visitor_id FROM visitor_views",
  );
  assertEquals(row?.visitor_id, "v1");
  await db.close();
});

Deno.test("SqliteAdapter — queryOne returns undefined for no results", async () => {
  const db = createTestDb();
  const row = await db.queryOne<{ visitor_id: string }>(
    "SELECT visitor_id FROM visitor_views WHERE visitor_id = ?",
    "nonexistent",
  );
  assertEquals(row, undefined);
  await db.close();
});

Deno.test("SqliteAdapter — run returns lastInsertId and changes", async () => {
  const db = createTestDb();
  const result = await db.run(
    "INSERT INTO visitor_views (visitor_id, path, site_id, referrer_type) VALUES (?, ?, ?, ?)",
    "v1",
    "/",
    "test",
    "direct_or_unknown",
  );
  assertEquals(typeof result.lastInsertId, "number");
  assertEquals(result.changes, 1);
  await db.close();
});

Deno.test("SqliteAdapter — exec runs DDL", async () => {
  const db = createTestDb();
  await db.exec("CREATE TABLE test_exec (id INTEGER PRIMARY KEY)");
  await db.run("INSERT INTO test_exec (id) VALUES (1)");
  const row = await db.queryOne<{ id: number }>(
    "SELECT id FROM test_exec WHERE id = 1",
  );
  assertEquals(row?.id, 1);
  await db.close();
});

Deno.test("SqliteAdapter — transaction commits on success", async () => {
  const db = createTestDb();
  await db.transaction(async (tx) => {
    await tx.run(
      "INSERT INTO visitor_views (visitor_id, path, site_id, referrer_type) VALUES (?, ?, ?, ?)",
      "tx1",
      "/",
      "test",
      "direct_or_unknown",
    );
    await tx.run(
      "INSERT INTO visitor_views (visitor_id, path, site_id, referrer_type) VALUES (?, ?, ?, ?)",
      "tx2",
      "/",
      "test",
      "direct_or_unknown",
    );
  });
  const rows = await db.query("SELECT * FROM visitor_views");
  assertEquals(rows.length, 2);
  await db.close();
});

Deno.test("SqliteAdapter — transaction rolls back on error", async () => {
  const db = createTestDb();
  await assertRejects(async () => {
    await db.transaction(async (tx) => {
      await tx.run(
        "INSERT INTO visitor_views (visitor_id, path, site_id, referrer_type) VALUES (?, ?, ?, ?)",
        "rollback",
        "/",
        "test",
        "direct_or_unknown",
      );
      throw new Error("intentional failure");
    });
  });
  const rows = await db.query(
    "SELECT * FROM visitor_views WHERE visitor_id = ?",
    "rollback",
  );
  assertEquals(rows.length, 0);
  await db.close();
});

Deno.test("SqliteAdapter — nested transactions (savepoints)", async () => {
  const db = createTestDb();
  await db.transaction(async (tx) => {
    await tx.run(
      "INSERT INTO visitor_views (visitor_id, path, site_id, referrer_type) VALUES (?, ?, ?, ?)",
      "outer",
      "/",
      "test",
      "direct_or_unknown",
    );
    await tx.transaction(async (inner) => {
      await inner.run(
        "INSERT INTO visitor_views (visitor_id, path, site_id, referrer_type) VALUES (?, ?, ?, ?)",
        "inner",
        "/",
        "test",
        "direct_or_unknown",
      );
    });
  });
  const rows = await db.query("SELECT * FROM visitor_views");
  assertEquals(rows.length, 2);
  await db.close();
});

Deno.test("SqliteAdapter — nested transaction rollback doesn't affect outer", async () => {
  const db = createTestDb();
  await db.transaction(async (tx) => {
    await tx.run(
      "INSERT INTO visitor_views (visitor_id, path, site_id, referrer_type) VALUES (?, ?, ?, ?)",
      "outer-keep",
      "/",
      "test",
      "direct_or_unknown",
    );
    try {
      await tx.transaction(async (inner) => {
        await inner.run(
          "INSERT INTO visitor_views (visitor_id, path, site_id, referrer_type) VALUES (?, ?, ?, ?)",
          "inner-discard",
          "/",
          "test",
          "direct_or_unknown",
        );
        throw new Error("inner failure");
      });
    } catch {
      // expected
    }
  });
  const rows = await db.query<{ visitor_id: string }>(
    "SELECT visitor_id FROM visitor_views",
  );
  assertEquals(rows.length, 1);
  assertEquals(rows[0].visitor_id, "outer-keep");
  await db.close();
});

Deno.test("SqliteAdapter — columnExists for existing column", async () => {
  const db = createTestDb();
  assertEquals(await db.columnExists("visitor_views", "visitor_id"), true);
  assertEquals(await db.columnExists("visitor_views", "bot_score"), true);
  await db.close();
});

Deno.test("SqliteAdapter — columnExists for nonexistent column", async () => {
  const db = createTestDb();
  assertEquals(await db.columnExists("visitor_views", "nonexistent"), false);
  await db.close();
});

Deno.test("SqliteAdapter — boolean params converted to 0/1", async () => {
  const db = createTestDb();
  await db.run(
    "INSERT INTO visitor_views (visitor_id, path, site_id, referrer_type, is_returning) VALUES (?, ?, ?, ?, ?)",
    "bool-test",
    "/",
    "test",
    "direct_or_unknown",
    true,
  );
  const row = await db.queryOne<{ is_returning: number }>(
    "SELECT is_returning FROM visitor_views WHERE visitor_id = ?",
    "bool-test",
  );
  assertEquals(row?.is_returning, 1);
  await db.close();
});

Deno.test("schema — visitor_views.validated exists and defaults to 0", async () => {
  const db = createTestDb();
  assertEquals(await db.columnExists("visitor_views", "validated"), true);
  await insertView(db, { visitor_id: "validateddefault" });
  const row = await db.queryOne<{ validated: number }>(
    "SELECT validated FROM visitor_views WHERE visitor_id = ?",
    "validateddefault",
  );
  assertEquals(row?.validated, 0);
  await db.close();
});

Deno.test("fixtures — insertView accepts validated and bot_score_detail", async () => {
  const db = createTestDb();
  await insertView(db, {
    visitor_id: "fixturevalidated",
    validated: 1,
    bot_score_detail: '{"pow":30}',
  });
  const row = await db.queryOne<
    { validated: number; bot_score_detail: string }
  >(
    "SELECT validated, bot_score_detail FROM visitor_views WHERE visitor_id = ?",
    "fixturevalidated",
  );
  assertEquals(row?.validated, 1);
  assertEquals(row?.bot_score_detail, '{"pow":30}');
  await db.close();
});
