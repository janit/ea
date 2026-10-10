// Ordinary visitors that one new signal used to put exactly on the threshold.
//
// Each stack below is a real person: a scaled Windows laptop, someone browsing
// two sibling sites, a Linux desktop behind a cloud VPN. Each read a page
// without clicking, which costs the engagement gate's no_events penalty, or
// arrived fast on a deep link. None may reach the threshold from that alone.
//
// The scorer, the gate and the events endpoint are the real ones; only the
// request is built here.

import { assert, assertEquals } from "@std/assert";
import { computeBotScoreWithDetail } from "@/lib/bot-score.ts";
import { BOT_THRESHOLD } from "@/lib/bot-threshold.ts";
import { tokenPenalty } from "@/lib/challenge.ts";
import { applyEngagementGate } from "@/lib/engagement-gate.ts";
import { flushRemainingEvents, handleEvents } from "@/lib/events-endpoint.ts";
import type { BotScoreSignals } from "@/types.ts";
import { createTestDb, insertView } from "./_helpers.ts";

const WIN =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36";
const LINUX =
  "Mozilla/5.0 (X11; Linux x86_64; rv:143.0) Gecko/20100101 Firefox/143.0";
const MAC =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15";

/** A browser with a valid token, on a landing page, two seconds in. */
const ORDINARY: BotScoreSignals = {
  burstCount: 1,
  hasAcceptLanguage: true,
  hasSecChUa: true,
  hasSecFetchSite: true,
  screenWidth: 1440,
  screenHeight: 800,
  interactionMs: 2000,
  path: "/",
  siteId: "stacks",
};

/**
 * Score the pageview, store it as the beacon would, and let the real gate
 * judge it ten minutes later with no interaction on record.
 */
async function afterPassiveReading(
  signals: Partial<BotScoreSignals>,
  expectSignals: string[],
): Promise<{ score: number; detail: Record<string, unknown> }> {
  const { score, detail } = computeBotScoreWithDetail({
    ...ORDINARY,
    ...signals,
  });
  assertEquals(Object.keys(detail).sort(), [...expectSignals].sort());
  const db = createTestDb();
  const now = Date.now();
  await insertView(db, {
    visitor_id: "reader",
    site_id: "stacks",
    session_id: "s-reader",
    bot_score: score,
    bot_score_detail: JSON.stringify(detail),
    created_at: new Date(now - 10 * 60_000).toISOString(),
  });
  const result = await applyEngagementGate(db, { now, strict: false });
  assertEquals(result.noEvents, 1, "the gate applied no_events");
  const row = await db.queryOne<{ bot_score: number; d: string }>(
    "SELECT bot_score, bot_score_detail AS d FROM visitor_views",
  );
  await db.close();
  return { score: row!.bot_score, detail: JSON.parse(row!.d) };
}

Deno.test("stacks — a scaled Windows laptop that reads without clicking stays under the threshold", async () => {
  const r = await afterPassiveReading(
    { userAgent: WIN, screenWidth: 960 },
    ["win_tablet_mismatch"],
  );
  assertEquals(r.detail.no_events, 15);
  assert(r.score < BOT_THRESHOLD, `score ${r.score}`);
});

Deno.test("stacks — a third sibling site read without clicking stays under the threshold", async () => {
  const r = await afterPassiveReading(
    { userAgent: MAC, crossSiteCount: 3 },
    ["cross_site"],
  );
  assertEquals(r.detail.no_events, 15);
  assert(r.score < BOT_THRESHOLD, `score ${r.score}`);
});

Deno.test("stacks — a Linux desktop on a datacenter address that reads without clicking stays under the threshold", async () => {
  const r = await afterPassiveReading(
    { userAgent: LINUX, screenWidth: 1920, datacenterIp: true },
    ["linux_desktop", "datacenter_ip"],
  );
  assertEquals(r.detail.no_events, 15);
  assert(r.score < BOT_THRESHOLD, `score ${r.score}`);
});

Deno.test("stacks — a fast deep-link arrival from a datacenter address with a valid token is stored", () => {
  const { score, detail } = computeBotScoreWithDetail({
    ...ORDINARY,
    userAgent: MAC,
    datacenterIp: true,
    interactionMs: 805,
    path: "/blog/post",
    referrer: "direct_or_unknown",
  });
  assertEquals(Object.keys(detail).sort(), [
    "datacenter_ip",
    "referrer",
    "timing",
  ]);
  // A valid token adds nothing; this is the whole write-time score.
  assert(score + tokenPenalty("valid", "beacon") < BOT_THRESHOLD, `${score}`);
});

Deno.test("stacks — a Linux desktop's events with an invalid token are stored, and carry no linux_desktop", async () => {
  const db = createTestDb();
  const site = "stacks-events";
  const sid = "1b1b1b1b-1b1b-4b1b-8b1b-1b1b1b1b1b1b";
  const body = JSON.stringify({
    siteId: site,
    tok: "0000000000000000:not-a-real-token",
    events: [{ type: "click", sessionId: sid, data: {} }],
  });
  const resp = await handleEvents(
    new Request("https://a.example.com/e", {
      method: "POST",
      headers: {
        "user-agent": LINUX,
        "accept-language": "en-US",
        "sec-fetch-site": "cross-site",
        "content-type": "application/json",
        "content-length": String(body.length),
      },
      body,
    }),
    db,
  );
  assertEquals(resp.status, 204);
  await flushRemainingEvents(db);
  const rows = await db.query<{ bot_score: number; d: string }>(
    "SELECT bot_score, bot_score_detail AS d FROM semantic_events WHERE site_id = ?",
    site,
  );
  assertEquals(rows.length, 1, "the batch was stored");
  const detail = JSON.parse(rows[0].d);
  assertEquals(detail.pow_result, "invalid");
  assertEquals(detail.pow, tokenPenalty("invalid", "events"));
  assertEquals(detail.linux_desktop, undefined);
  assert(rows[0].bot_score < BOT_THRESHOLD, `score ${rows[0].bot_score}`);
  await db.close();
});
