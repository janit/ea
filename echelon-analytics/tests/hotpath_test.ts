// The Rust module (hotpath/, compiled to WASM) must give the same answers as
// the code it replaces: WebCrypto for HMAC-SHA256 and the JS RegExp built from
// the crawler feed for user agents.

import { assert, assertEquals } from "@std/assert";
import {
  _fallbackHmacSha256Hex,
  buildUaMatcher,
  hmacSha256Hex,
  hotpathBackend,
} from "@/lib/hotpath.ts";

const enc = new TextEncoder();

async function webCryptoHmacHex(
  key: Uint8Array,
  msg: string,
): Promise<string> {
  const k = await crypto.subtle.importKey(
    "raw",
    key as BufferSource,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", k, enc.encode(msg));
  return Array.from(new Uint8Array(sig))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

Deno.test("hotpath — the committed WASM module loads", () => {
  assertEquals(hotpathBackend(), "wasm");
});

Deno.test("hotpath hmac — RFC 4231 test case 2", () => {
  assertEquals(
    hmacSha256Hex(enc.encode("Jefe"), "what do ya want for nothing?"),
    "5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843",
  );
});

Deno.test("hotpath hmac — matches WebCrypto for every key and message shape", async () => {
  const keys = [
    new Uint8Array(1).fill(7),
    crypto.getRandomValues(new Uint8Array(32)),
    crypto.getRandomValues(new Uint8Array(64)),
    // Longer than the SHA-256 block: HMAC hashes such a key first.
    crypto.getRandomValues(new Uint8Array(200)),
    enc.encode("a secret with ünïcödé — and an em dash"),
  ];
  const msgs = [
    "",
    "a",
    "29361234",
    "81.2.69.7|Mozilla/5.0 (Windows NT 10.0; Win64; x64)|shop|2026-10-10",
    "ÄÖ кириллица 日本語 🙂",
    "x".repeat(55),
    "x".repeat(56),
    "x".repeat(64),
    "x".repeat(5000),
    // Larger than the module's scratch buffer.
    "y".repeat(200_000),
    // A lone surrogate: TextEncoder writes U+FFFD, and so must we.
    "bad \ud800 surrogate",
  ];
  for (const key of keys) {
    for (const msg of msgs) {
      const expected = await webCryptoHmacHex(key, msg);
      assertEquals(hmacSha256Hex(key, msg), expected);
      assertEquals(_fallbackHmacSha256Hex(key, msg), expected);
    }
  }
});

Deno.test("hotpath hmac — a call does not disturb the next one", async () => {
  const key = crypto.getRandomValues(new Uint8Array(32));
  const long = hmacSha256Hex(key, "z".repeat(3000));
  const short = hmacSha256Hex(key, "z");
  assertEquals(short, await webCryptoHmacHex(key, "z"));
  assertEquals(hmacSha256Hex(key, "z".repeat(3000)), long);
});

// ── User agent matcher ──────────────────────────────────────────────────────

// Shapes taken from the crawler feed, plus ones the Rust engine must hand
// back to JS (look-around, a back-reference) or reads differently from JS.
const PATTERNS = [
  "Googlebot\\/",
  "Googlebot-Mobile",
  "AdsBot-Google([^-]|$)",
  "Mediapartners \\(Googlebot\\)",
  "[wW]get",
  "^Seekbot",
  "webmon ",
  "grub\\.org",
  "(sistrix|SISTRIX) [cC]rawler",
  "Ahrefs(Bot|SiteAudit)",
  "yandex\\.com\\/bots",
  "ips-agent",
  "bot\\d+\\b",
  "crawl(er|ing)?\\s",
  "^Mozilla\\/5\\.0 \\(compatible; ?\\)$",
  "spider.{0,4}pro",
  "Nmap Scripting Engine",
  "check_http\\/v",
  "[a-z]{3}scan-\\w+",
  "curl(?!\\/8)",
  "(?<=x-)probe",
  "\\<tag\\>",
  "\\Aanchor",
  "[]]x",
  "a{,2}b",
  "zgrab|masscan",
  "python-requests\\/[0-9.]+$",
  "é-bot",
];

const UAS = [
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36",
  "Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.6 Mobile/15E148 Safari/604.1",
  "Mozilla/5.0 (X11; Linux x86_64; rv:143.0) Gecko/20100101 Firefox/143.0",
  "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)",
  "googlebot/2.1",
  "GOOGLEBOT-MOBILE",
  "AdsBot-Google",
  "AdsBot-Google-Mobile",
  "AdsBot-Google (+http://www.google.com/adsbot.html)",
  "Mediapartners (Googlebot)",
  "Wget/1.21",
  "WGET/1.21",
  "Seekbot/1.0",
  "x Seekbot/1.0",
  "webmon 1.0",
  "webmon",
  "grub.org",
  "grubxorg",
  "sistrix crawler",
  "AhrefsBot/7.0",
  "AhrefsSiteAudit",
  "Ahrefs",
  "yandex.com/bots",
  "bot42",
  "bot42x",
  "robot7 end",
  "crawling the web",
  "crawler",
  "Mozilla/5.0 (compatible; )",
  "Mozilla/5.0 (compatible;)",
  "Mozilla/5.0 (compatible; ) x",
  "spiderpro",
  "spider1234pro",
  "spider12345pro",
  "check_http/v2.3",
  "abcscan-x1",
  "curl/8.5.0",
  "curl/7.88",
  "x-probe",
  "probe",
  "abab",
  "ab",
  "<tag>",
  "Aanchor",
  "anchor",
  "]x",
  "a{,2}b",
  "aab",
  "masscan/1.3",
  "python-requests/2.31.0",
  "python-requests/2.31.0 extra",
  "É-BOT",
  "é-bot",
  "",
  " ",
  "ÄÖ Mozilla/5.0 кириллица Googlebot/",
  "tab\tGooglebot/",
  "line\nwget",
  "K".repeat(9000) + "wget",
  "Kelvin wget",
];

/** Deterministic pseudo-random strings assembled from pattern fragments. */
function fuzzCorpus(n: number): string[] {
  let seed = 0x2545f491;
  const rnd = (max: number) => {
    seed ^= seed << 13;
    seed ^= seed >>> 17;
    seed ^= seed << 5;
    return (seed >>> 0) % max;
  };
  const pieces = [
    ...UAS.filter((u) => u.length < 80),
    "Googlebot",
    "/",
    "-",
    " ",
    ".",
    "bot",
    "7",
    "(",
    ")",
    "crawl",
    "er",
    "ing",
    "spider",
    "pro",
    "x",
    "scan-",
    "curl",
    "/8",
    "ab",
    "$",
    "^",
    "\\",
    "|",
    "é",
    " ",
  ];
  const out: string[] = [];
  for (let i = 0; i < n; i++) {
    let s = "";
    for (let k = rnd(5) + 1; k > 0; k--) {
      let p = pieces[rnd(pieces.length)];
      const r = rnd(4);
      if (r === 0) p = p.toUpperCase();
      else if (r === 1) p = p.toLowerCase();
      s += p;
    }
    out.push(s);
  }
  return out;
}

function reference(patterns: string[]): RegExp {
  return new RegExp(`(?:${patterns.join("|")})`, "i");
}

Deno.test("hotpath ua — agrees with the JS RegExp on every pattern shape", () => {
  const js = reference(PATTERNS);
  const matcher = buildUaMatcher(PATTERNS);
  for (const ua of [...UAS, ...fuzzCorpus(20_000)]) {
    assertEquals(matcher.test(ua), js.test(ua), JSON.stringify(ua));
  }
});

Deno.test("hotpath ua — each pattern alone agrees with the JS RegExp", () => {
  const corpus = [...UAS, ...fuzzCorpus(1500)];
  for (const pattern of PATTERNS) {
    const js = reference([pattern]);
    const matcher = buildUaMatcher([pattern]);
    for (const ua of corpus) {
      assertEquals(
        matcher.test(ua),
        js.test(ua),
        `${pattern} on ${JSON.stringify(ua)}`,
      );
    }
  }
});

Deno.test("hotpath ua — plain patterns are compiled by Rust, the rest stay in JS", () => {
  const matcher = buildUaMatcher(PATTERNS);
  // Look-around ×2, \< \>, \A, []], a{,2}b and the non-ASCII pattern are
  // the seven JS keeps.
  assertEquals(matcher.jsPatterns, 7);
  assertEquals(matcher.nativePatterns, PATTERNS.length - 7);
});

Deno.test("hotpath ua — a back-reference keeps the whole list in JS", () => {
  // \\1 counts groups across the combined expression, so here it refers to
  // the group in the first pattern, not to its own.
  const patterns = ["(go+gle)bot", "(ab)\\1", "wget"];
  const js = reference(patterns);
  const matcher = buildUaMatcher(patterns);
  assertEquals(matcher.nativePatterns, 0);
  for (const ua of ["abab", "abgoogle", "googlebot", "ab", "Wget/1"]) {
    assertEquals(matcher.test(ua), js.test(ua), ua);
  }
});

Deno.test("hotpath ua — a newer matcher does not change an older one's answers", () => {
  const first = buildUaMatcher(["alpha-bot"]);
  const second = buildUaMatcher(["beta-bot"]);
  assertEquals(first.test("alpha-bot/1"), true);
  assertEquals(first.test("beta-bot/1"), false);
  assertEquals(second.test("alpha-bot/1"), false);
  assertEquals(second.test("beta-bot/1"), true);
});

Deno.test("hotpath ua — an empty list matches nothing", () => {
  const matcher = buildUaMatcher([]);
  assertEquals(matcher.test("anything"), false);
  assertEquals(matcher.test(""), false);
});

Deno.test("hotpath ua — a pattern JS rejects throws, as new RegExp does", () => {
  let threw = false;
  try {
    buildUaMatcher(["ok", "(unclosed"]);
  } catch (e) {
    threw = e instanceof SyntaxError;
  }
  assert(threw);
});
