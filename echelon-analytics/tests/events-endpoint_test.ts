import { assertEquals } from "@std/assert";
import { flushRemainingEvents, handleEvents } from "@/lib/events-endpoint.ts";
import { createTestDb, solvePow } from "./_helpers.ts";

function eventRequest(
  body: unknown,
  headers: Record<string, string> = {},
): Request {
  const json = JSON.stringify(body);
  return new Request("https://analytics.example.com/e", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "content-length": String(json.length),
      "user-agent": "Mozilla/5.0 (X11; Linux x86_64) Chrome/120.0.0.0",
      "accept-language": "en-US",
      "sec-ch-ua": '"Chrome"',
      "sec-fetch-site": "cross-site",
      ...headers,
    },
    body: json,
  });
}

// ── Valid event ──────────────────────────────────────────────────────────────

Deno.test("handleEvents — valid event → 204", async () => {
  const db = createTestDb();
  const req = eventRequest({
    siteId: "test-site",
    events: [{ type: "click", data: { target: "button" } }],
  });

  const resp = await handleEvents(req, db);
  assertEquals(resp.status, 204);
  await db.close();
});

Deno.test("handleEvents — multiple valid events → 204", async () => {
  const db = createTestDb();
  const req = eventRequest({
    siteId: "test-site",
    events: [
      { type: "click", data: { target: "link" } },
      { type: "scroll_depth", data: { depth: 50 } },
      { type: "bounce", data: {} },
    ],
  });

  const resp = await handleEvents(req, db);
  assertEquals(resp.status, 204);
  await db.close();
});

// ── Invalid payloads ────────────────────────────────────────────────────────

Deno.test("handleEvents — invalid JSON → 400", async () => {
  const db = createTestDb();
  const req = new Request("https://analytics.example.com/e", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "content-length": "11",
      "user-agent": "Mozilla/5.0 Chrome/120.0.0.0",
    },
    body: "not json!!!",
  });

  const resp = await handleEvents(req, db);
  assertEquals(resp.status, 400);
  await db.close();
});

Deno.test("handleEvents — empty body → 400", async () => {
  const db = createTestDb();
  const req = new Request("https://analytics.example.com/e", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "content-length": "0",
      "user-agent": "Mozilla/5.0 Chrome/120.0.0.0",
    },
    body: "",
  });

  const resp = await handleEvents(req, db);
  assertEquals(resp.status, 400);
  await db.close();
});

Deno.test("handleEvents — empty events array → 204 (no-op)", async () => {
  const db = createTestDb();
  const req = eventRequest({
    siteId: "test-site",
    events: [],
  });

  const resp = await handleEvents(req, db);
  assertEquals(resp.status, 204);
  await db.close();
});

Deno.test("handleEvents — no events field → 204 (no-op)", async () => {
  const db = createTestDb();
  const req = eventRequest({ siteId: "test-site" });

  const resp = await handleEvents(req, db);
  assertEquals(resp.status, 204);
  await db.close();
});

// ── Hostile JSON shapes ─────────────────────────────────────────────────────

for (
  const body of [null, 42, "str", { events: [null] }, { events: [1, "x"] }]
) {
  Deno.test(`handleEvents — ${JSON.stringify(body)} body → 204, no throw`, async () => {
    const db = createTestDb();
    const resp = await handleEvents(eventRequest(body), db);
    assertEquals(resp.status, 204);
    await db.close();
  });
}

Deno.test("handleEvents — null entry does not abort the batch midway", async () => {
  const db = createTestDb();
  const site = "null-entry-site";
  const sid = "0d9e8f7a-6b5c-4d3e-8f1a-2b3c4d5e6f70";
  const tok = await solvePow(site, sid);
  const resp = await handleEvents(
    eventRequest({
      siteId: site,
      tok,
      events: [
        { type: "click", sessionId: sid },
        null,
        { type: "click", sessionId: sid },
      ],
    }),
    db,
  );
  assertEquals(resp.status, 204);
  await flushRemainingEvents(db);
  const row = await db.queryOne<{ n: number }>(
    "SELECT COUNT(*) AS n FROM semantic_events WHERE site_id = ?",
    site,
  );
  assertEquals(row?.n, 2);
  await db.close();
});

// ── Bot detection ───────────────────────────────────────────────────────────

Deno.test("handleEvents — known bot UA → 204 (dropped)", async () => {
  const db = createTestDb();
  const req = eventRequest(
    {
      siteId: "test-site",
      events: [{ type: "click", data: {} }],
    },
    { "user-agent": "Googlebot/2.1" },
  );

  const resp = await handleEvents(req, db);
  assertEquals(resp.status, 204);
  await db.close();
});

// ── Event type validation ───────────────────────────────────────────────────

Deno.test("handleEvents — unknown event type skipped (still 204)", async () => {
  const db = createTestDb();
  const req = eventRequest({
    siteId: "test-site",
    events: [{ type: "unknown_event_type", data: {} }],
  });

  const resp = await handleEvents(req, db);
  assertEquals(resp.status, 204);
  await db.close();
});

Deno.test("handleEvents — all allowed event types accepted", async () => {
  const db = createTestDb();
  const allowedTypes = [
    "bounce",
    "session_end",
    "session_resume",
    "scroll_depth",
    "click",
    "ad_click",
    "form_focus",
    "form_blur",
    "form_submit",
    "hover",
    "outbound",
    "download",
    "web_vital",
    "custom",
  ];

  for (const type of allowedTypes) {
    const req = eventRequest({
      siteId: "test-site",
      events: [{ type, data: {} }],
    });
    const resp = await handleEvents(req, db);
    assertEquals(resp.status, 204, `Event type "${type}" should be accepted`);
  }
  await db.close();
});

// ── Oversized payload ───────────────────────────────────────────────────────

Deno.test("handleEvents — oversized Content-Length → 413", async () => {
  const db = createTestDb();
  const req = new Request("https://analytics.example.com/e", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "content-length": "99999",
      "user-agent": "Mozilla/5.0 Chrome/120.0.0.0",
    },
    body: "{}",
  });

  const resp = await handleEvents(req, db);
  assertEquals(resp.status, 413);
  await db.close();
});

// ── Ignored sites ───────────────────────────────────────────────────────────

Deno.test("handleEvents — ignored site (smoke-test) → 204", async () => {
  const db = createTestDb();
  const req = eventRequest({
    siteId: "smoke-test",
    events: [{ type: "click", data: {} }],
  });

  const resp = await handleEvents(req, db);
  assertEquals(resp.status, 204);
  await db.close();
});

// ── Session ID validation ───────────────────────────────────────────────────

Deno.test("handleEvents — valid session ID passes through", async () => {
  const db = createTestDb();
  const req = eventRequest({
    siteId: "test-site",
    events: [{
      type: "click",
      data: {},
      sessionId: "550e8400-e29b-41d4-a716-446655440000",
    }],
  });

  const resp = await handleEvents(req, db);
  assertEquals(resp.status, 204);
  await db.close();
});

// ── Device type detection ───────────────────────────────────────────────────

Deno.test("handleEvents — sec-ch-ua-mobile ?1 → mobile", async () => {
  const db = createTestDb();
  const req = eventRequest(
    {
      siteId: "test-site",
      events: [{ type: "click", data: {} }],
    },
    { "sec-ch-ua-mobile": "?1" },
  );

  const resp = await handleEvents(req, db);
  assertEquals(resp.status, 204);
  await db.close();
});
