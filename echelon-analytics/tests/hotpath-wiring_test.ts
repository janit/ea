// The tracking endpoints reuse work that does not change within a minute
// (the challenge, the rendered tracker script) and match user agents through
// the Rust module. These tests hold the reuse to "never stale, never
// unbounded" and the matcher to the feed's own semantics.

import { assert, assertEquals, assertNotEquals } from "@std/assert";
import { FakeTime } from "@std/testing/time";
import {
  _challengeCacheSize,
  _challengeComputations,
  generateChallenge,
  verifyToken,
} from "@/lib/challenge.ts";
import { CHALLENGE_WINDOW_MINUTES } from "@/lib/config.ts";
import {
  _trackerCacheSize,
  _trackerRenders,
  handleTracker,
} from "@/lib/tracker.ts";
import {
  _refreshCrawlerUAs,
  matchesCrawlerFeed,
  stopThreatFeeds,
} from "@/lib/threat-feeds.ts";
import { createTestDb } from "./_helpers.ts";

const NOON = Date.UTC(2026, 0, 5, 12, 0, 30);

Deno.test("challenge — one minute's challenge is computed once", async () => {
  using _time = new FakeTime(NOON);
  const first = await generateChallenge();
  const computed = _challengeComputations();
  assertEquals(await generateChallenge(), first);
  assertEquals(_challengeComputations(), computed);
});

Deno.test("challenge — a new minute gets a new challenge", async () => {
  using time = new FakeTime(NOON);
  const first = await generateChallenge();
  time.tick(60_000);
  assertNotEquals(await generateChallenge(), first);
});

Deno.test("challenge — rejecting a token computes nothing once the window is known", async () => {
  using _time = new FakeTime(NOON);
  assertEquals(
    await verifyToken("00112233445566778899aabbccddeeff", "wiring", "sid-a"),
    "invalid",
  );
  const computed = _challengeComputations();
  assertEquals(
    await verifyToken("ffeeddccbbaa99887766554433221100", "wiring", "sid-b"),
    "invalid",
  );
  assertEquals(_challengeComputations(), computed);
});

Deno.test("challenge — the cache holds the window, not every minute seen", async () => {
  using time = new FakeTime(NOON);
  for (let i = 0; i < 200; i++) {
    await verifyToken("00112233445566778899aabbccddeeff", "wiring", "sid-c");
    time.tick(60_000);
  }
  assert(
    _challengeCacheSize() <= CHALLENGE_WINDOW_MINUTES + 2,
    `cache holds ${_challengeCacheSize()} minutes`,
  );
});

// ── /ea.js ──────────────────────────────────────────────────────────────────

function trackerReq(host: string, site: string): Request {
  return new Request(`https://${host}/ea.js?s=${site}`, {
    headers: { host },
  });
}

Deno.test("ea.js — a second request in the same minute reuses the rendered script", async () => {
  using _time = new FakeTime(NOON);
  const db = createTestDb();
  const first = await (await handleTracker(trackerReq("a.example", "s1"), db))
    .text();
  const renders = _trackerRenders();
  const again = await (await handleTracker(trackerReq("a.example", "s1"), db))
    .text();
  assertEquals(again, first);
  assertEquals(_trackerRenders(), renders);
});

Deno.test("ea.js — the script is never served with a previous minute's challenge", async () => {
  using time = new FakeTime(NOON);
  const db = createTestDb();
  const old = await generateChallenge();
  const first = await (await handleTracker(trackerReq("a.example", "s1"), db))
    .text();
  assert(first.includes(old));
  time.tick(60_000);
  const fresh = await generateChallenge();
  const second = await (await handleTracker(trackerReq("a.example", "s1"), db))
    .text();
  assert(second.includes(fresh));
  assert(!second.includes(old));
});

Deno.test("ea.js — each origin gets its own script", async () => {
  using _time = new FakeTime(NOON);
  const db = createTestDb();
  const a = await (await handleTracker(trackerReq("a.example", "s1"), db))
    .text();
  const b = await (await handleTracker(trackerReq("b.example", "s1"), db))
    .text();
  assert(a.includes("https://a.example") && !a.includes("https://b.example"));
  assert(b.includes("https://b.example") && !b.includes("https://a.example"));
});

Deno.test("ea.js — forged Host headers cannot grow the cache without bound", async () => {
  using _time = new FakeTime(NOON);
  const db = createTestDb();
  for (let i = 0; i < 500; i++) {
    await handleTracker(trackerReq(`h${i}.example`, "s1"), db);
  }
  assert(_trackerCacheSize() <= 64, `cache holds ${_trackerCacheSize()}`);
  // and the last one is still correct
  const last = await (await handleTracker(trackerReq("h499.example", "s1"), db))
    .text();
  assert(last.includes("https://h499.example"));
});

// ── Crawler feed ────────────────────────────────────────────────────────────

async function withFeed(
  feed: unknown,
  fn: () => void | Promise<void>,
): Promise<void> {
  const realFetch = globalThis.fetch;
  globalThis.fetch = () => Promise.resolve(Response.json(feed));
  try {
    await _refreshCrawlerUAs();
    await fn();
  } finally {
    globalThis.fetch = realFetch;
    stopThreatFeeds();
  }
}

Deno.test("crawler feed — matches as the combined RegExp did", async () => {
  await withFeed(
    [
      { pattern: "Googlebot\\/" },
      { pattern: "[wW]get" },
      { pattern: "curl(?!\\/8)" }, // look-ahead: only JS can run it
      { pattern: "(unclosed" }, // invalid: skipped
      { pattern: 42 }, // not a string: skipped
    ],
    () => {
      const chrome =
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36";
      assertEquals(matchesCrawlerFeed(chrome), false);
      assertEquals(
        matchesCrawlerFeed("Mozilla/5.0 (compatible; googlebot/2.1)"),
        true,
      );
      assertEquals(matchesCrawlerFeed("WGET/1.21"), true);
      assertEquals(matchesCrawlerFeed("curl/7.88"), true);
      assertEquals(matchesCrawlerFeed("curl/8.5"), false);
      assertEquals(matchesCrawlerFeed("ÄÖ кириллица Googlebot/2.1"), true);
      assertEquals(matchesCrawlerFeed("ÄÖ кириллица"), false);
      assertEquals(matchesCrawlerFeed(""), false);
    },
  );
});

Deno.test("crawler feed — stopping the feeds forgets the patterns", async () => {
  await withFeed([{ pattern: "Googlebot\\/" }], () => {
    assertEquals(matchesCrawlerFeed("Googlebot/2.1"), true);
  });
  assertEquals(matchesCrawlerFeed("Googlebot/2.1"), false);
});
