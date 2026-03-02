import { assertEquals } from "@std/assert";
import { handleBeacon, PIXEL } from "@/lib/beacon.ts";
import { createTestDb } from "./_helpers.ts";

// ── PIXEL constant ──────────────────────────────────────────────────────────

Deno.test("PIXEL — is 43-byte GIF", () => {
  assertEquals(PIXEL.length, 43);
  // GIF89a magic bytes
  assertEquals(PIXEL[0], 0x47); // G
  assertEquals(PIXEL[1], 0x49); // I
  assertEquals(PIXEL[2], 0x46); // F
  assertEquals(PIXEL[3], 0x38); // 8
  assertEquals(PIXEL[4], 0x39); // 9
  assertEquals(PIXEL[5], 0x61); // a
});

// ── handleBeacon ────────────────────────────────────────────────────────────

Deno.test("handleBeacon — returns GIF response", async () => {
  const db = createTestDb();
  const path = btoa("/test-page");
  const req = new Request(
    `https://analytics.example.com/b.gif?p=${path}&_v=2000&sw=1920&sh=1080&s=test-site&sid=550e8400-e29b-41d4-a716-446655440000`,
    {
      headers: {
        "user-agent":
          "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/120.0.0.0",
        "accept-language": "en-US",
        "sec-ch-ua": '"Chrome"',
        "sec-fetch-site": "cross-site",
      },
    },
  );

  const resp = await handleBeacon(req, db);
  assertEquals(resp.status, 200);
  assertEquals(resp.headers.get("Content-Type"), "image/gif");
  assertEquals(resp.headers.get("Cache-Control"), "no-store");

  const body = new Uint8Array(await resp.arrayBuffer());
  assertEquals(body.length, 43);
  await db.close();
});

Deno.test("handleBeacon — known bot → returns GIF without tracking", async () => {
  const db = createTestDb();
  const req = new Request(
    "https://analytics.example.com/b.gif?p=Lw==&_v=2000&s=test-site",
    {
      headers: { "user-agent": "Googlebot/2.1" },
    },
  );

  const resp = await handleBeacon(req, db);
  assertEquals(resp.status, 200);
  assertEquals(resp.headers.get("Content-Type"), "image/gif");
  await db.close();
});

Deno.test("handleBeacon — missing path → still returns GIF (graceful)", async () => {
  const db = createTestDb();
  const req = new Request(
    "https://analytics.example.com/b.gif?_v=2000&s=test-site",
    {
      headers: {
        "user-agent": "Mozilla/5.0 Chrome/120.0.0.0",
      },
    },
  );

  const resp = await handleBeacon(req, db);
  assertEquals(resp.status, 200);
  assertEquals(resp.headers.get("Content-Type"), "image/gif");
  await db.close();
});

Deno.test("handleBeacon — invalid interaction time → returns GIF without recording", async () => {
  const db = createTestDb();
  const path = btoa("/test");
  const req = new Request(
    `https://analytics.example.com/b.gif?p=${path}&_v=100&s=test-site`,
    {
      headers: {
        "user-agent": "Mozilla/5.0 Chrome/120.0.0.0",
      },
    },
  );

  const resp = await handleBeacon(req, db);
  assertEquals(resp.status, 200);
  assertEquals(resp.headers.get("Content-Type"), "image/gif");
  await db.close();
});

Deno.test("handleBeacon — SPA navigation (_v=spa) → accepted", async () => {
  const db = createTestDb();
  const path = btoa("/spa-page");
  const req = new Request(
    `https://analytics.example.com/b.gif?p=${path}&_v=spa&s=test-site&sid=550e8400-e29b-41d4-a716-446655440000`,
    {
      headers: {
        "user-agent": "Mozilla/5.0 Chrome/120.0.0.0",
        "accept-language": "en-US",
        "sec-ch-ua": '"Chrome"',
        "sec-fetch-site": "cross-site",
      },
    },
  );

  const resp = await handleBeacon(req, db);
  assertEquals(resp.status, 200);
  assertEquals(resp.headers.get("Content-Type"), "image/gif");
  await db.close();
});

Deno.test("handleBeacon — cookie mode sets Set-Cookie header", async () => {
  const db = createTestDb();
  const path = btoa("/cookie-test");
  const req = new Request(
    `https://analytics.example.com/b.gif?p=${path}&_v=2000&s=test-site&ck=1&sid=550e8400-e29b-41d4-a716-446655440000`,
    {
      headers: {
        "user-agent": "Mozilla/5.0 Chrome/120.0.0.0",
        "accept-language": "en-US",
        "sec-ch-ua": '"Chrome"',
        "sec-fetch-site": "cross-site",
      },
    },
  );

  const resp = await handleBeacon(req, db);
  assertEquals(resp.status, 200);
  const setCookie = resp.headers.get("Set-Cookie");
  assertEquals(setCookie !== null, true);
  assertEquals(setCookie!.includes("_ev="), true);
  assertEquals(setCookie!.includes("HttpOnly"), true);
  assertEquals(setCookie!.includes("SameSite=None"), true);
  assertEquals(setCookie!.includes("Partitioned"), true);
  await db.close();
});

Deno.test("handleBeacon — ignored site returns GIF silently", async () => {
  const db = createTestDb();
  const path = btoa("/test");
  const req = new Request(
    `https://analytics.example.com/b.gif?p=${path}&_v=2000&s=smoke-test`,
    {
      headers: { "user-agent": "Mozilla/5.0 Chrome/120.0.0.0" },
    },
  );

  const resp = await handleBeacon(req, db);
  assertEquals(resp.status, 200);
  assertEquals(resp.headers.get("Content-Type"), "image/gif");
  await db.close();
});
