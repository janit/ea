import { assertEquals, assertGreater, assertLessOrEqual } from "@std/assert";
import {
  classifyDevice,
  classifyReferrer,
  computeBotScore,
  getBurstCount,
  hashIp,
  hashVisitor,
  isKnownBot,
  parseBrowser,
  parseOS,
  recordBurst,
} from "@/lib/bot-score.ts";
import type { BotScoreSignals } from "@/types.ts";

// ── isKnownBot ──────────────────────────────────────────────────────────────

Deno.test("isKnownBot — known bot UAs return true", () => {
  assertEquals(isKnownBot("Googlebot/2.1"), true);
  assertEquals(isKnownBot("Mozilla/5.0 (compatible; GPTBot/1.0)"), true);
  assertEquals(isKnownBot("ClaudeBot"), true);
  assertEquals(isKnownBot("python-requests/2.28.0"), true);
  assertEquals(isKnownBot("curl/7.88.1"), true);
  assertEquals(isKnownBot("wget/1.21.4"), true);
  assertEquals(isKnownBot("Go-http-client/1.1"), true);
  assertEquals(isKnownBot("HeadlessChrome/120.0.0.0"), true);
});

Deno.test("isKnownBot — real browser UAs return false", () => {
  assertEquals(
    isKnownBot(
      "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36",
    ),
    false,
  );
  assertEquals(
    isKnownBot(
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Safari/605.1.15",
    ),
    false,
  );
});

Deno.test("isKnownBot — undefined/empty returns false", () => {
  assertEquals(isKnownBot(undefined), false);
  assertEquals(isKnownBot(""), false);
});

// ── hashIp ──────────────────────────────────────────────────────────────────

Deno.test("hashIp — returns hex string", async () => {
  const hash = await hashIp("192.168.1.1");
  assertEquals(typeof hash, "string");
  assertEquals(/^[0-9a-f]+$/.test(hash), true);
});

Deno.test("hashIp — same IP produces same hash", async () => {
  const h1 = await hashIp("10.0.0.1");
  const h2 = await hashIp("10.0.0.1");
  assertEquals(h1, h2);
});

Deno.test("hashIp — different IPs produce different hashes", async () => {
  const h1 = await hashIp("10.0.0.1");
  const h2 = await hashIp("10.0.0.2");
  assertEquals(h1 !== h2, true);
});

// ── hashVisitor ─────────────────────────────────────────────────────────────

Deno.test("hashVisitor — returns 16-char hex string", async () => {
  const id = await hashVisitor("1.2.3.4", "Chrome/120", "mysite", "2024-01-01");
  assertEquals(id.length, 16);
  assertEquals(/^[0-9a-f]{16}$/.test(id), true);
});

Deno.test("hashVisitor — same inputs produce same ID", async () => {
  const args = ["1.2.3.4", "Chrome/120", "mysite", "2024-01-01"] as const;
  const a = await hashVisitor(...args);
  const b = await hashVisitor(...args);
  assertEquals(a, b);
});

Deno.test("hashVisitor — different date changes ID", async () => {
  const a = await hashVisitor("1.2.3.4", "Chrome/120", "mysite", "2024-01-01");
  const b = await hashVisitor("1.2.3.4", "Chrome/120", "mysite", "2024-01-02");
  assertEquals(a !== b, true);
});

// ── recordBurst / getBurstCount ─────────────────────────────────────────────

Deno.test("recordBurst — increments count", () => {
  const key = `burst-test-${crypto.randomUUID()}`;
  assertEquals(recordBurst(key), 1);
  assertEquals(recordBurst(key), 2);
  assertEquals(recordBurst(key), 3);
});

Deno.test("getBurstCount — returns 0 for unknown key", () => {
  assertEquals(getBurstCount(`unknown-${crypto.randomUUID()}`), 0);
});

Deno.test("getBurstCount — returns current count after recording", () => {
  const key = `burst-read-${crypto.randomUUID()}`;
  recordBurst(key);
  recordBurst(key);
  assertEquals(getBurstCount(key), 2);
});

// ── computeBotScore ─────────────────────────────────────────────────────────

function cleanSignals(
  overrides: Partial<BotScoreSignals> = {},
): BotScoreSignals {
  return {
    interactionMs: 2000,
    burstCount: 1,
    hasAcceptLanguage: true,
    hasSecChUa: true,
    hasSecFetchSite: true,
    screenWidth: 1920,
    screenHeight: 1080,
    referrer: "https://google.com",
    path: "/",
    ...overrides,
  };
}

Deno.test("computeBotScore — clean request → low score", () => {
  const score = computeBotScore(cleanSignals());
  assertLessOrEqual(score, 10);
});

Deno.test("computeBotScore — missing Accept-Language → +10", () => {
  const baseline = computeBotScore(cleanSignals());
  const penalized = computeBotScore(
    cleanSignals({ hasAcceptLanguage: false }),
  );
  assertEquals(penalized - baseline, 10);
});

Deno.test("computeBotScore — missing Sec-CH-UA AND Sec-Fetch-Site → +10", () => {
  const baseline = computeBotScore(cleanSignals());
  const penalized = computeBotScore(
    cleanSignals({ hasSecChUa: false, hasSecFetchSite: false }),
  );
  assertEquals(penalized - baseline, 10);
});

Deno.test("computeBotScore — low interaction time → +20", () => {
  const baseline = computeBotScore(cleanSignals());
  const penalized = computeBotScore(cleanSignals({ interactionMs: 100 }));
  assertEquals(penalized - baseline, 20);
});

Deno.test("computeBotScore — high burst count → +25", () => {
  const baseline = computeBotScore(cleanSignals());
  const penalized = computeBotScore(cleanSignals({ burstCount: 20 }));
  assertEquals(penalized - baseline, 25);
});

Deno.test("computeBotScore — unrealistic screen dimensions → +10", () => {
  const baseline = computeBotScore(cleanSignals());
  const penalized = computeBotScore(
    cleanSignals({ screenWidth: 0, screenHeight: 0 }),
  );
  assertEquals(penalized - baseline, 10);
});

Deno.test("computeBotScore — score capped at 100", () => {
  const score = computeBotScore({
    interactionMs: 100,
    burstCount: 100,
    hasAcceptLanguage: false,
    hasSecChUa: false,
    hasSecFetchSite: false,
    screenWidth: 0,
    screenHeight: 0,
    path: "/deep/nested/path",
  });
  assertLessOrEqual(score, 100);
});

Deno.test("computeBotScore — no referrer + deep path → +5", () => {
  const baseline = computeBotScore(
    cleanSignals({ referrer: undefined, path: "/" }),
  );
  const penalized = computeBotScore(
    cleanSignals({ referrer: undefined, path: "/a/b" }),
  );
  assertEquals(penalized - baseline, 5);
});

Deno.test("computeBotScore — cfBotScore very low → +50", () => {
  const baseline = computeBotScore(cleanSignals());
  const penalized = computeBotScore(cleanSignals({ cfBotScore: 1 }));
  assertEquals(penalized - baseline, 50);
});

Deno.test("computeBotScore — cfVerifiedBot → +15", () => {
  const baseline = computeBotScore(cleanSignals());
  const penalized = computeBotScore(
    cleanSignals({ cfBotScore: 50, cfVerifiedBot: true }),
  );
  assertEquals(penalized - baseline, 15);
});

// ── classifyReferrer ────────────────────────────────────────────────────────

Deno.test("classifyReferrer — search engines", () => {
  assertEquals(classifyReferrer("https://www.google.com/search"), "search");
  assertEquals(classifyReferrer("https://bing.com/"), "search");
  assertEquals(classifyReferrer("https://duckduckgo.com/?q=test"), "search");
});

Deno.test("classifyReferrer — social media", () => {
  assertEquals(classifyReferrer("https://facebook.com/post/123"), "social");
  assertEquals(classifyReferrer("https://t.co/abc123"), "social");
  assertEquals(classifyReferrer("https://www.reddit.com/r/test"), "social");
});

Deno.test("classifyReferrer — AI platforms", () => {
  assertEquals(classifyReferrer("https://perplexity.ai/search"), "ai");
  assertEquals(classifyReferrer("https://chatgpt.com/c/abc"), "ai");
  assertEquals(classifyReferrer("https://claude.ai/chat"), "ai");
});

Deno.test("classifyReferrer — direct / unknown", () => {
  assertEquals(classifyReferrer(""), "direct_or_unknown");
  assertEquals(classifyReferrer("direct_or_unknown"), "direct_or_unknown");
  assertEquals(classifyReferrer("not-a-url"), "direct_or_unknown");
  assertEquals(classifyReferrer("https://example.com"), "direct_or_unknown");
});

// ── classifyDevice ──────────────────────────────────────────────────────────

Deno.test("classifyDevice — mobile / tablet / desktop / undefined", () => {
  assertEquals(classifyDevice(375), "mobile");
  assertEquals(classifyDevice(767), "mobile");
  assertEquals(classifyDevice(768), "tablet");
  assertEquals(classifyDevice(1024), "tablet");
  assertEquals(classifyDevice(1025), "desktop");
  assertEquals(classifyDevice(1920), "desktop");
  assertEquals(classifyDevice(undefined), undefined);
});

// ── parseOS ─────────────────────────────────────────────────────────────────

Deno.test("parseOS — iOS", () => {
  assertEquals(
    parseOS("Mozilla/5.0 (iPhone; CPU iPhone OS 17_2 like Mac OS X)"),
    "iOS 17.2",
  );
});

Deno.test("parseOS — Android", () => {
  assertEquals(
    parseOS("Mozilla/5.0 (Linux; Android 14; Pixel 8)"),
    "Android 14",
  );
});

Deno.test("parseOS — Windows 10+", () => {
  assertEquals(
    parseOS("Mozilla/5.0 (Windows NT 10.0; Win64; x64)"),
    "Windows 10+",
  );
});

Deno.test("parseOS — macOS", () => {
  assertEquals(
    parseOS("Mozilla/5.0 (Macintosh; Intel Mac OS X 14_2_1)"),
    "macOS 14",
  );
});

Deno.test("parseOS — ChromeOS", () => {
  assertEquals(
    parseOS("Mozilla/5.0 (X11; CrOS x86_64 14541.0.0)"),
    "ChromeOS",
  );
});

Deno.test("parseOS — Linux", () => {
  assertEquals(
    parseOS("Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36"),
    "Linux",
  );
});

Deno.test("parseOS — undefined for empty/unknown", () => {
  assertEquals(parseOS(undefined), undefined);
  assertEquals(parseOS(""), undefined);
  assertEquals(parseOS("SomeWeirdBot/1.0"), undefined);
});

// ── extractCloudflareSignals — tested indirectly via computeBotScore since
//    it requires BEHIND_CLOUDFLARE config which is false by default ────────

Deno.test("computeBotScore — cumulative penalties stack", () => {
  const score = computeBotScore({
    interactionMs: 100, // +20
    burstCount: 20, // +25
    hasAcceptLanguage: false, // +10
    hasSecChUa: false,
    hasSecFetchSite: false, // +10
    screenWidth: 1920,
    screenHeight: 1080,
  });
  assertGreater(score, 50);
});

// ── parseBrowser ──────────────────────────────────────────────────────────

Deno.test("parseBrowser — Chrome", () => {
  const r = parseBrowser(
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  );
  assertEquals(r?.name, "Chrome");
  assertEquals(r?.version, "120.0.0.0");
});

Deno.test("parseBrowser — Edge (not misidentified as Chrome)", () => {
  const r = parseBrowser(
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36 Edg/120.0.0.0",
  );
  assertEquals(r?.name, "Edge");
  assertEquals(r?.version, "120.0.0.0");
});

Deno.test("parseBrowser — Firefox", () => {
  const r = parseBrowser(
    "Mozilla/5.0 (X11; Linux x86_64; rv:121.0) Gecko/20100101 Firefox/121.0",
  );
  assertEquals(r?.name, "Firefox");
  assertEquals(r?.version, "121.0");
});

Deno.test("parseBrowser — Safari", () => {
  const r = parseBrowser(
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.2.1 Safari/605.1.15",
  );
  assertEquals(r?.name, "Safari");
  assertEquals(r?.version, "17.2.1");
});

Deno.test("parseBrowser — Opera (not misidentified as Chrome)", () => {
  const r = parseBrowser(
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36 OPR/106.0.0.0",
  );
  assertEquals(r?.name, "Opera");
  assertEquals(r?.version, "106.0.0.0");
});

Deno.test("parseBrowser — Samsung Browser (not misidentified as Chrome)", () => {
  const r = parseBrowser(
    "Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 SamsungBrowser/23.0 Chrome/115.0.0.0 Mobile Safari/537.36",
  );
  assertEquals(r?.name, "Samsung Browser");
  assertEquals(r?.version, "23.0");
});

Deno.test("parseBrowser — UC Browser", () => {
  const r = parseBrowser(
    "Mozilla/5.0 (Linux; Android 10) AppleWebKit/537.36 UCBrowser/13.4.0.1306 Mobile Safari/537.36",
  );
  assertEquals(r?.name, "UC Browser");
  assertEquals(r?.version, "13.4.0.1306");
});

Deno.test("parseBrowser — undefined for empty/unknown", () => {
  assertEquals(parseBrowser(undefined), undefined);
  assertEquals(parseBrowser(""), undefined);
  assertEquals(parseBrowser("SomeWeirdBot/1.0"), undefined);
});

Deno.test("parseBrowser — never throws on arbitrary strings", () => {
  const cases = [
    "💀",
    "a".repeat(10000),
    "Edg/",
    "Chrome/",
    "Version/ Safari",
    "\x00\x01\x02",
    "OPR/abc",
  ];
  for (const ua of cases) {
    // Should not throw — may return undefined or a result
    parseBrowser(ua);
  }
});
