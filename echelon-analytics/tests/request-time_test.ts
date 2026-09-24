// created_at must record when a request arrived, not when its buffered row
// was flushed. The view and event writers flush on different timers, so
// flush-time stamps ordered a visitor's events before the pageview that
// produced them — and the no-event bounce check then penalised real users.

import { assert, assertEquals } from "@std/assert";
import { flushRemainingViews, handleBeacon } from "@/lib/beacon.ts";
import { flushRemainingEvents, handleEvents } from "@/lib/events-endpoint.ts";
import { createTestDb, solvePow } from "./_helpers.ts";

const SITE = "request-time-site";
const SID = "6f1c2a9e-3b4d-4e5f-8a6b-7c8d9e0f1a2b";
const HEADERS = {
  "user-agent":
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/120.0.0.0",
  "accept-language": "en-US",
  "sec-ch-ua": '"Chrome"',
  "sec-fetch-site": "cross-site",
};

Deno.test("created_at — pageview precedes its events even when events flush first", async () => {
  const db = createTestDb();
  const tok = await solvePow(SITE, SID);

  await handleBeacon(
    new Request(
      `https://a.example.com/b.gif?p=${
        btoa("/page")
      }&_v=2000&sw=1920&sh=1080&s=${SITE}&sid=${SID}&tok=${tok}`,
      { headers: HEADERS },
    ),
    db,
  );
  await new Promise((r) => setTimeout(r, 20));
  const body = JSON.stringify({
    siteId: SITE,
    tok,
    events: [{ type: "click", sessionId: SID, data: { target: "a" } }],
  });
  await handleEvents(
    new Request("https://a.example.com/e", {
      method: "POST",
      headers: {
        ...HEADERS,
        "content-type": "application/json",
        "content-length": String(body.length),
      },
      body,
    }),
    db,
  );

  // Event writer flushes first; the view writer flushes later.
  await flushRemainingEvents(db);
  await new Promise((r) => setTimeout(r, 20));
  const viewFlushedAt = new Date().toISOString();
  await flushRemainingViews(db);

  const view = await db.queryOne<{ created_at: string; bot_score: number }>(
    "SELECT created_at, bot_score FROM visitor_views WHERE site_id = ?",
    SITE,
  );
  const event = await db.queryOne<{ created_at: string }>(
    "SELECT created_at FROM semantic_events WHERE site_id = ?",
    SITE,
  );
  assert(view && event, "both rows written");
  assert(view.bot_score < 50, `view scored as human (${view.bot_score})`);
  assert(view.created_at < event.created_at, "view is older than its event");
  assert(view.created_at < viewFlushedAt, "stamped at request, not flush");
  assertEquals(view.created_at.length, "2026-01-01T00:00:00.000Z".length);
  await db.close();
});
