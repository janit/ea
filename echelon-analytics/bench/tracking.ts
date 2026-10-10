#!/usr/bin/env -S deno run -A --no-check
// Echelon Analytics — tracking endpoint benchmark (in-process, no HTTP)
//
// Times the four public endpoints' handlers and the parts they are made of,
// on one core, with the real threat feeds loaded (needs network access).
//
// It measures the checkout it is run from, so two checkouts can be compared:
//
//   deno task bench --save /tmp/before.json        (in the old checkout)
//   deno task bench --against /tmp/before.json     (in the new one)
//
// To measure a checkout that predates this file, run this file from there:
//   cd <old>/echelon-analytics && deno run -A --no-check <new>/bench/tracking.ts
//
// Numbers move a few percent between runs; --rounds N keeps the best of N.

const root = `file://${Deno.cwd()}`;
const flag = (name: string) => {
  const i = Deno.args.indexOf(name);
  return i >= 0 ? Deno.args[i + 1] : undefined;
};
const savePath = flag("--save");
const againstPath = flag("--against");
const rounds = Number(flag("--rounds") ?? 3);
const scale = Number(flag("--scale") ?? 1);

Deno.env.set("ECHELON_DB_PATH", ":memory:");
const { handleBeacon, flushRemainingViews } = await import(
  `${root}/lib/beacon.ts`
);
const { handleEvents, flushRemainingEvents } = await import(
  `${root}/lib/events-endpoint.ts`
);
const { handleTracker, handleChallenge } = await import(
  `${root}/lib/tracker.ts`
);
const botScore = await import(`${root}/lib/bot-score.ts`);
const feeds = await import(`${root}/lib/threat-feeds.ts`);
const challenge = await import(`${root}/lib/challenge.ts`);
const ipLib = await import(`${root}/lib/ip.ts`);
const { createTestDb, solvePow } = await import(`${root}/tests/_helpers.ts`);

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36";
const HEADERS = {
  "user-agent": UA,
  "accept-language": "fi-FI,fi;q=0.9,en;q=0.8",
  "sec-ch-ua": '"Chromium";v="141", "Not?A_Brand";v="8"',
  "sec-fetch-site": "cross-site",
  "origin": "https://shop.example.com",
  "referer": "https://shop.example.com/products/widget",
  "host": "a.example.com",
};

// The handlers log each dropped record once their buffers are full; a
// benchmark fills them on purpose.
const realWarn = console.warn, realLog = console.log, realError = console.error;
const out = (line: string) => realLog(line);
console.warn = console.error = () => {};
console.log = () => {};

const db = createTestDb();
feeds.startThreatFeeds();
const feedsReady = () =>
  feeds.matchesCrawlerFeed("Googlebot/2.1") &&
  feeds.isDatacenterIp("3.5.140.2");
for (let i = 0; i < 60 && !feedsReady(); i++) {
  await new Promise((r) => setTimeout(r, 500));
}
if (!feedsReady()) {
  out(
    "WARNING: threat feeds did not load (no network?). The crawler-feed and " +
      "datacenter numbers below are for empty feeds and are not comparable.",
  );
}

const hex = (i: number, len: number) => i.toString(16).padStart(len, "0");
const sidOf = (i: number) => `${hex(i, 8)}-4444-4444-8444-444444444444`;
const withPeer = (req: Request, i: number) => {
  ipLib.setPeerAddr(
    req,
    {
      remoteAddr: {
        transport: "tcp",
        hostname: `81.${(i >> 16) & 255}.${(i >> 8) & 255}.${i & 255}`,
        port: 1,
      },
    } as Deno.ServeHandlerInfo,
  );
  return req;
};
const beaconReq = (i: number, tok?: string) =>
  withPeer(
    new Request(
      `https://a.example.com/b.gif?p=${
        btoa(encodeURIComponent("/products/widget-" + (i % 50)))
      }&_v=2400&sw=1920&sh=1080&s=shop&sid=${sidOf(i)}&_n=${hex(i, 16)}&ref=${
        btoa("https://www.google.com/")
      }${tok ? "&tok=" + tok : ""}`,
      { headers: HEADERS },
    ),
    i,
  );
const eventsReq = (i: number) => {
  const body = JSON.stringify({
    siteId: "shop",
    events: [
      { type: "engage", sessionId: sidOf(i), data: { via: "pointerdown" } },
      { type: "click", sessionId: sidOf(i), data: { tag: "A", href: "/x" } },
      { type: "scroll", sessionId: sidOf(i), data: { depth: 50 } },
    ],
  });
  return withPeer(
    new Request("https://a.example.com/e", {
      method: "POST",
      headers: {
        ...HEADERS,
        "content-type": "application/json",
        "content-length": String(body.length),
      },
      body,
    }),
    i,
  );
};
const trackerReq = (i: number) =>
  withPeer(
    new Request("https://a.example.com/ea.js?s=shop", { headers: HEADERS }),
    i,
  );

const results: Record<string, number> = {};
const baseline: Record<string, number> | null = againstPath
  ? JSON.parse(await Deno.readTextFile(againstPath))
  : null;
let n = 1;

/** Best of `rounds` timings of `iters` awaited calls, in µs per call. */
async function bench(
  name: string,
  iters: number,
  fn: (i: number) => unknown,
  after?: () => unknown,
) {
  iters = Math.max(100, Math.round(iters * scale));
  for (let i = 0; i < Math.min(2000, iters / 5); i++) await fn(n++);
  let best = Infinity;
  for (let r = 0; r < rounds; r++) {
    await after?.();
    const t0 = performance.now();
    for (let i = 0; i < iters; i++) await fn(n++);
    best = Math.min(best, ((performance.now() - t0) * 1000) / iters);
  }
  await after?.();
  results[name] = best;
  let line = `${name.padEnd(44)} ${best.toFixed(2).padStart(9)} µs  ${
    Math.round(1e6 / best).toLocaleString("en-US").padStart(10)
  }/s`;
  const before = baseline?.[name];
  if (before !== undefined) {
    line += `   was ${before.toFixed(2).padStart(9)} µs   ${
      (before / best).toFixed(2).padStart(6)
    }x`;
  }
  out(line);
}

out(`checkout: ${Deno.cwd()}`);
out("\n== handlers (request object built per call, included in the time) ==");
await bench("build a beacon Request (overhead)", 50_000, (i) => beaconReq(i));
await bench(
  "/b.gif  no token",
  10_000,
  (i) => handleBeacon(beaconReq(i), db),
  () => flushRemainingViews(db),
);
await bench(
  "/b.gif  invalid token",
  5_000,
  (i) => handleBeacon(beaconReq(i, "00112233445566778899aabbccddeeff"), db),
  () => flushRemainingViews(db),
);
{
  // A valid token is good for one session, so each call needs its own.
  const count = Math.max(100, Math.round(500 * scale));
  const base = 0x7f000000;
  const toks: string[] = [];
  for (let i = 0; i < count * rounds; i++) {
    toks.push(await solvePow("shop", sidOf(base + i)));
  }
  let k = 0;
  let best = Infinity;
  for (let r = 0; r < rounds; r++) {
    const t0 = performance.now();
    for (let i = 0; i < count; i++, k++) {
      await handleBeacon(beaconReq(base + k, toks[k]), db);
    }
    best = Math.min(best, ((performance.now() - t0) * 1000) / count);
    await flushRemainingViews(db);
  }
  const name = "/b.gif  valid token, first use";
  results[name] = best;
  const before = baseline?.[name];
  out(
    `${name.padEnd(44)} ${best.toFixed(2).padStart(9)} µs  ${
      Math.round(1e6 / best).toLocaleString("en-US").padStart(10)
    }/s` +
      (before !== undefined
        ? `   was ${before.toFixed(2).padStart(9)} µs   ${
          (before / best).toFixed(2).padStart(6)
        }x`
        : ""),
  );
}
await bench(
  "/e      3 events, no token",
  10_000,
  (i) => handleEvents(eventsReq(i), db),
  () => flushRemainingEvents(db),
);
await bench(
  "/ea.js",
  20_000,
  async (i) => await (await handleTracker(trackerReq(i), db)).text(),
);
await bench("/c", 50_000, async () => await (await handleChallenge()).text());

out("\n== parts ==");
await bench(
  "hashIp",
  100_000,
  (i) => botScore.hashIp(`81.2.${i & 255}.7`),
);
await bench(
  "hashVisitor",
  100_000,
  (i) => botScore.hashVisitor(`81.2.${i & 255}.7`, UA, "shop", "2026-10-10"),
);
await bench(
  "matchesCrawlerFeed  browser UA",
  200_000,
  () => feeds.matchesCrawlerFeed(UA),
);
await bench(
  "matchesCrawlerFeed  crawler UA",
  200_000,
  () =>
    feeds.matchesCrawlerFeed(
      "Mozilla/5.0 (compatible; SemrushBot/7~bl; +http://www.semrush.com/bot.html)",
    ),
);
await bench("isKnownBot", 200_000, () => botScore.isKnownBot(UA));
await bench(
  "isDatacenterIp  v4",
  200_000,
  (i) => feeds.isDatacenterIp(`81.2.${i & 255}.7`),
);
await bench(
  "verifyToken  invalid",
  5_000,
  (i) =>
    challenge.verifyToken("00112233445566778899aabbccddeeff", "shop", sidOf(i)),
);
await bench("generateChallenge", 100_000, () => challenge.generateChallenge());

feeds.stopThreatFeeds();
console.warn = realWarn;
console.log = realLog;
console.error = realError;
if (savePath) {
  await Deno.writeTextFile(savePath, JSON.stringify(results, null, 2) + "\n");
  out(`\nsaved to ${savePath}`);
}
Deno.exit(0);
