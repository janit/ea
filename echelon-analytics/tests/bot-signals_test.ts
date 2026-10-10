import { assertEquals } from "@std/assert";
import {
  computeBotScoreWithDetail,
  getCrossSiteCount,
  recordSiteVisit,
} from "@/lib/bot-score.ts";
import type { BotScoreSignals } from "@/types.ts";

const CLEAN: BotScoreSignals = {
  burstCount: 0,
  hasAcceptLanguage: true,
  hasSecChUa: true,
  hasSecFetchSite: true,
};
const WIN =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36";
const LINUX =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36";
const ANDROID6 =
  "Mozilla/5.0 (Linux; Android 6.0; Nexus 5) AppleWebKit/537.36 Chrome/120.0.0.0 Mobile Safari/537.36";
const ANDROID13 =
  "Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 Chrome/120.0.0.0 Mobile Safari/537.36";
const MAC =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36";

const score = (s: Partial<BotScoreSignals>) =>
  computeBotScoreWithDetail({ ...CLEAN, ...s });

// ── Device ──────────────────────────────────────────────────────────────────

Deno.test("signals — Windows UA at a tablet width is a mismatch", () => {
  for (const w of [768, 800, 1024]) {
    assertEquals(
      score({ userAgent: WIN, screenWidth: w, screenHeight: 600 }).detail
        .win_tablet_mismatch,
      34,
      `width ${w}`,
    );
  }
});

Deno.test("signals — Windows UA at desktop or phone widths is not", () => {
  for (const w of [767, 1025, 1366, 1920]) {
    assertEquals(
      score({ userAgent: WIN, screenWidth: w, screenHeight: 800 }).detail
        .win_tablet_mismatch,
      undefined,
      `width ${w}`,
    );
  }
  assertEquals(
    score({ userAgent: MAC, screenWidth: 800, screenHeight: 600 }).detail
      .win_tablet_mismatch,
    undefined,
  );
});

Deno.test("signals — Linux desktop is not scored on the events endpoint, the foreign-Linux rule still is", () => {
  const events = { userAgent: LINUX, surface: "events" as const };
  assertEquals(score(events).detail, {});
  assertEquals(score(events).score, 0);
  assertEquals(
    score({ userAgent: LINUX, surface: "beacon" }).detail.linux_desktop,
    10,
  );
  const foreign = score({
    ...events,
    visitorCountry: "US",
    homeCountry: "FI",
    homeLanguage: "fi",
  });
  assertEquals(foreign.detail.linux_desktop, undefined);
  assertEquals(foreign.detail.linux_foreign, 30);
});

Deno.test("signals — Linux desktop adds 10; Android does not", () => {
  assertEquals(score({ userAgent: LINUX }).detail.linux_desktop, 10);
  assertEquals(score({ userAgent: ANDROID13 }).detail.linux_desktop, undefined);
  assertEquals(score({ userAgent: MAC }).detail.linux_desktop, undefined);
});

Deno.test("signals — hostile user agents: nothing fires and nothing throws", () => {
  for (
    const ua of [
      "",
      "x".repeat(100_000),
      "Mozilla/5.0 (Linux; Android; Mobile)",
      "Android ",
      "Windows NT",
      "\u0000￿",
    ]
  ) {
    const r = score({
      userAgent: ua,
      visitorCountry: "US",
      homeCountry: "FI",
      homeLanguage: "fi",
    });
    assertEquals(r.detail.stale_android_foreign, undefined);
    assertEquals(r.detail.win_tablet_mismatch, undefined);
  }
});

// ── Cross-site ──────────────────────────────────────────────────────────────

Deno.test("cross-site — counts distinct sites per IP hash and user agent", () => {
  const ip = "xsite-ip-count";
  assertEquals(getCrossSiteCount(ip, WIN), 0);
  assertEquals(recordSiteVisit(ip, "a.example", WIN), 1);
  assertEquals(recordSiteVisit(ip, "a.example", WIN), 1);
  assertEquals(recordSiteVisit(ip, "b.example", WIN), 2);
  assertEquals(recordSiteVisit(ip, "c.example", WIN), 3);
  assertEquals(getCrossSiteCount(ip, WIN), 3);
  assertEquals(getCrossSiteCount("xsite-ip-other", WIN), 0);
});

Deno.test("cross-site — different user agents on one address do not pool", () => {
  const ip = "xsite-ip-shared";
  assertEquals(recordSiteVisit(ip, "a.example", WIN), 1);
  assertEquals(recordSiteVisit(ip, "b.example", MAC), 1);
  assertEquals(recordSiteVisit(ip, "c.example", LINUX), 1);
  assertEquals(getCrossSiteCount(ip, WIN), 1);
  assertEquals(recordSiteVisit(ip, "b.example", WIN), 2);
  assertEquals(recordSiteVisit(ip, "c.example", WIN), 3);
});

Deno.test("signals — three or more sites from one IP adds 34", () => {
  assertEquals(score({ crossSiteCount: 2 }).detail.cross_site, undefined);
  assertEquals(score({ crossSiteCount: 3 }).detail.cross_site, 34);
  assertEquals(score({ crossSiteCount: 9 }).detail.cross_site, 34);
});

// ── Geography ───────────────────────────────────────────────────────────────

Deno.test("signals — no home country: no geography signal of any kind", () => {
  const r = score({
    userAgent: ANDROID6,
    visitorCountry: "US",
    screenWidth: 360,
    screenHeight: 640,
  });
  for (
    const k of [
      "country_mismatch",
      "cross_continent",
      "global_common_foreign",
      "linux_foreign",
      "stale_android_foreign",
    ]
  ) {
    assertEquals(r.detail[k], undefined, k);
  }
});

Deno.test("signals — visitor from another continent on a home-anchored site", () => {
  const r = score({
    userAgent: MAC,
    visitorCountry: "JP",
    homeCountry: "FI",
    homeLanguage: "fi",
  });
  assertEquals(r.detail.country_mismatch, 15);
  assertEquals(r.detail.cross_continent, 8);
  assertEquals(r.score, 23);
});

Deno.test("signals — neighbour country: no mismatch", () => {
  const r = score({
    userAgent: MAC,
    visitorCountry: "SE",
    homeCountry: "FI",
    homeLanguage: "fi",
  });
  assertEquals(r.detail.country_mismatch, undefined);
  assertEquals(r.detail.cross_continent, undefined);
});

Deno.test("signals — US on an English site: cross-continent nudge only", () => {
  const r = score({
    userAgent: MAC,
    visitorCountry: "US",
    homeCountry: "IE",
    homeLanguage: "en",
  });
  assertEquals(r.detail.country_mismatch, undefined);
  assertEquals(r.detail.cross_continent, 8);
});

Deno.test("signals — Linux desktop claiming the US on a Finnish site crosses the threshold", () => {
  const r = score({
    userAgent: LINUX,
    visitorCountry: "US",
    homeCountry: "FI",
    homeLanguage: "fi",
  });
  assertEquals(r.detail.linux_desktop, 10);
  assertEquals(r.detail.country_mismatch, 15);
  assertEquals(r.detail.cross_continent, 8);
  assertEquals(r.detail.linux_foreign, 30);
  assertEquals(r.score, 63);
});

Deno.test("signals — Linux desktop claiming the US on an English site stays quiet", () => {
  const r = score({
    userAgent: LINUX,
    visitorCountry: "US",
    homeCountry: "IE",
    homeLanguage: "en",
  });
  assertEquals(r.detail.linux_foreign, undefined);
});

Deno.test("signals — Android 6 claiming the US on a Finnish site", () => {
  const r = score({
    userAgent: ANDROID6,
    visitorCountry: "US",
    homeCountry: "FI",
    homeLanguage: "fi",
  });
  assertEquals(r.detail.stale_android_foreign, 40);
  assertEquals(r.detail.country_mismatch, 15);
});

Deno.test("signals — Android 6 at home, and modern Android abroad, are not flagged", () => {
  assertEquals(
    score({
      userAgent: ANDROID6,
      visitorCountry: "HU",
      homeCountry: "HU",
      homeLanguage: "hu",
    }).detail.stale_android_foreign,
    undefined,
  );
  assertEquals(
    score({
      userAgent: ANDROID13,
      visitorCountry: "US",
      homeCountry: "FI",
      homeLanguage: "fi",
    }).detail.stale_android_foreign,
    undefined,
  );
});

Deno.test("signals — Windows tablet from a global-common country foreign to the site", () => {
  const r = score({
    userAgent: WIN,
    screenWidth: 800,
    screenHeight: 600,
    visitorCountry: "US",
    homeCountry: "ZA",
    homeLanguage: "en",
  });
  assertEquals(r.detail.win_tablet_mismatch, 34);
  assertEquals(r.detail.global_common_foreign, 15);
  assertEquals(r.score >= 50, true);
});

Deno.test("signals — unclassified home: exact comparison only, no continent signal", () => {
  const r = score({
    userAgent: MAC,
    visitorCountry: "KZ",
    homeCountry: "RU",
    homeLanguage: "ru",
  });
  assertEquals(r.detail.country_mismatch, 15);
  assertEquals(r.detail.cross_continent, undefined);
});
