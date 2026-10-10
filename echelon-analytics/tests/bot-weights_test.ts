import { assertEquals } from "@std/assert";
import {
  computeBotScoreWithDetail,
  DEFAULT_WEIGHTS,
  parseWeightOverrides,
} from "@/lib/bot-score.ts";

const CLEAN = {
  burstCount: 0,
  hasAcceptLanguage: true,
  hasSecChUa: true,
  hasSecFetchSite: true,
};

Deno.test("weights — defaults match the documented table", () => {
  assertEquals(DEFAULT_WEIGHTS, {
    timing_fast: 20,
    timing_quick: 8,
    burst: 25,
    no_accept_language: 10,
    no_sec_headers: 10,
    screen: 10,
    referrer: 5,
    crawler_feed: 30,
    ai_crawler_feed: 40,
    datacenter_ip: 24,
    win_tablet_mismatch: 34,
    linux_desktop: 10,
    cross_site: 34,
    country_mismatch: 15,
    cross_continent: 8,
    global_common_foreign: 15,
    linux_foreign: 30,
    stale_android_foreign: 40,
  });
});

Deno.test("weights — empty override string yields the defaults", () => {
  const { weights, warnings } = parseWeightOverrides("");
  assertEquals(weights, { ...DEFAULT_WEIGHTS });
  assertEquals(warnings, []);
});

Deno.test("weights — valid overrides replace individual entries", () => {
  const { weights, warnings } = parseWeightOverrides(
    "linux_desktop:0, datacenter_ip:40",
  );
  assertEquals(weights.linux_desktop, 0);
  assertEquals(weights.datacenter_ip, 40);
  assertEquals(weights.burst, 25);
  assertEquals(warnings, []);
});

Deno.test("weights — malformed overrides are ignored, each with a warning", () => {
  const { weights, warnings } = parseWeightOverrides(
    "linux_desktop:-5,no_such_key:10,burst:abc,datacenter_ip,screen:250,:7,referrer:3.9",
  );
  assertEquals(weights.linux_desktop, 10, "negative ignored");
  assertEquals(weights.burst, 25, "non-numeric ignored");
  assertEquals(weights.datacenter_ip, 24, "missing value ignored");
  assertEquals(weights.screen, 10, "over 100 ignored");
  assertEquals(weights.referrer, 3, "fraction truncated, accepted");
  assertEquals(warnings.length, 6);
});

Deno.test("scoring — a datacenter IP now adds 24", () => {
  const r = computeBotScoreWithDetail({ ...CLEAN, datacenterIp: true });
  assertEquals(r.detail.datacenter_ip, 24);
  assertEquals(r.score, 24);
});

Deno.test("scoring — existing detail keys and values are unchanged", () => {
  const r = computeBotScoreWithDetail({
    burstCount: 16,
    hasAcceptLanguage: false,
    hasSecChUa: false,
    hasSecFetchSite: false,
    interactionMs: 820,
    screenWidth: 0,
    screenHeight: 0,
    referrer: "direct_or_unknown",
    path: "/a/b",
    crawlerFeedMatch: true,
    aiCrawlerFeedMatch: true,
  });
  assertEquals(r.detail, {
    timing: 20,
    burst: 25,
    headers: 20,
    screen: 10,
    referrer: 5,
    crawler_feed: 30,
    ai_crawler_feed: 40,
  });
  assertEquals(r.score, 100);
});
