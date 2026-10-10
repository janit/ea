#!/usr/bin/env -S deno run -A --no-check
// Echelon Analytics — HTTP load test of the tracking endpoints
//
// Drives a running server and reports throughput and latency per endpoint.
// Start the server to be measured with a throwaway database, e.g.
//
//   deno task build
//   ECHELON_DB_PATH=/tmp/bench.db ECHELON_TRUST_PROXY=true \
//     ECHELON_RATE_LIMIT_MAX=1000000000 ECHELON_PORT=1999 deno task start
//
// (ECHELON_TRUST_PROXY lets each request claim its own client address through
// X-Forwarded-For; without it every request comes from 127.0.0.1 and is
// scored as one burst.) Then:
//
//   deno run -A --no-check bench/http_load.ts --url http://127.0.0.1:1999 \
//     [--seconds 8] [--workers 4] [--connections 32] \
//     [--pid <server pid>] [--save out.json] [--against earlier.json]
//
// The client runs on the same machine as the server and is itself the limit
// on some endpoints, so req/s is a floor. With --pid (Linux) the server's own
// CPU time per request is reported too, across all its threads: that is the
// figure to compare between two servers, because it does not depend on how
// fast this client is.

interface Job {
  url: string;
  scenario: string;
  seconds: number;
  connections: number;
  worker: number;
}
interface Done {
  latencies: Float64Array;
  errors: number;
  elapsedMs: number;
}

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36";
const hex = (i: number, len: number) => i.toString(16).padStart(len, "0");

function requestFor(job: Job, i: number): [string, RequestInit] {
  // Distinct per worker and per call: a new visitor, session and address.
  const id = job.worker * 0x1000000 + i;
  const sid = `${hex(id, 8)}-4444-4444-8444-444444444444`;
  const headers: Record<string, string> = {
    "user-agent": UA,
    "accept-language": "fi-FI,fi;q=0.9,en;q=0.8",
    "sec-ch-ua": '"Chromium";v="141", "Not?A_Brand";v="8"',
    "sec-fetch-site": "cross-site",
    "origin": "https://shop.example.com",
    "referer": "https://shop.example.com/products/widget",
    "x-forwarded-for": `81.${(id >> 16) & 255}.${(id >> 8) & 255}.${id & 255}`,
  };
  const beacon = `${job.url}/b.gif?p=${
    btoa(encodeURIComponent("/products/widget-" + (i % 50)))
  }&_v=2400&sw=1920&sh=1080&s=shop&sid=${sid}&_n=${hex(id, 16)}&ref=${
    btoa("https://www.google.com/")
  }`;
  switch (job.scenario) {
    case "/b.gif  no token":
      return [beacon, { headers }];
    case "/b.gif  invalid token":
      return [beacon + "&tok=00112233445566778899aabbccddeeff", { headers }];
    case "/e      3 events":
      return [`${job.url}/e`, {
        method: "POST",
        headers: { ...headers, "content-type": "application/json" },
        body: JSON.stringify({
          siteId: "shop",
          events: [
            { type: "engage", sessionId: sid, data: { via: "pointerdown" } },
            { type: "click", sessionId: sid, data: { tag: "A", href: "/x" } },
            { type: "scroll", sessionId: sid, data: { depth: 50 } },
          ],
        }),
      }];
    case "/ea.js":
      return [`${job.url}/ea.js?s=shop`, { headers }];
    default:
      return [`${job.url}/c`, { headers }];
  }
}

const SCENARIOS = [
  "/b.gif  no token",
  "/b.gif  invalid token",
  "/e      3 events",
  "/ea.js",
  "/c",
];

// ── Worker: run one scenario on `connections` keep-alive loops ──────────────

if (
  typeof WorkerGlobalScope !== "undefined" && self instanceof WorkerGlobalScope
) {
  const me = self as unknown as {
    onmessage: (e: MessageEvent<Job>) => void;
    postMessage: (d: Done, transfer: Transferable[]) => void;
  };
  me.onmessage = async (e) => {
    const job = e.data;
    const latencies: number[] = [];
    let errors = 0;
    let next = 0;
    const start = performance.now();
    const deadline = start + job.seconds * 1000;
    const loop = async () => {
      while (performance.now() < deadline) {
        const [url, init] = requestFor(job, next++);
        const t0 = performance.now();
        try {
          const resp = await fetch(url, init);
          await resp.arrayBuffer();
          if (resp.status >= 400) errors++;
          else latencies.push(performance.now() - t0);
        } catch {
          errors++;
        }
      }
    };
    await Promise.all(Array.from({ length: job.connections }, loop));
    const out = Float64Array.from(latencies);
    me.postMessage(
      { latencies: out, errors, elapsedMs: performance.now() - start },
      [out.buffer],
    );
  };
} else {
  // ── Main: fan out, merge, report ──────────────────────────────────────────
  const flag = (name: string) => {
    const i = Deno.args.indexOf(name);
    return i >= 0 ? Deno.args[i + 1] : undefined;
  };
  const url = (flag("--url") ?? "http://127.0.0.1:1947").replace(/\/$/, "");
  const seconds = Number(flag("--seconds") ?? 8);
  const workers = Number(flag("--workers") ?? 4);
  const connections = Number(flag("--connections") ?? 32);
  const pid = flag("--pid");
  /** The server's CPU time so far (user + system, all threads), in ms. */
  const serverCpuMs = async (): Promise<number> => {
    if (!pid) return NaN;
    const stat = await Deno.readTextFile(`/proc/${pid}/stat`);
    // Fields after the parenthesised command name; utime and stime are the
    // 12th and 13th of those, in clock ticks (100 per second on Linux).
    const f = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    return (Number(f[11]) + Number(f[12])) * 10;
  };
  const savePath = flag("--save");
  const againstPath = flag("--against");
  const baseline: Record<
    string,
    { rps: number; p50: number; p99: number; cpuUs: number }
  > = againstPath ? JSON.parse(await Deno.readTextFile(againstPath)) : {};
  const results: typeof baseline = {};

  const pool = Array.from(
    { length: workers },
    () => new Worker(import.meta.url, { type: "module" }),
  );
  const run = (scenario: string, secs: number) =>
    Promise.all(pool.map((w, worker) =>
      new Promise<Done>((resolve) => {
        w.onmessage = (e: MessageEvent<Done>) => resolve(e.data);
        w.postMessage(
          { url, scenario, seconds: secs, connections, worker: worker + 1 },
        );
      })
    ));

  console.log(
    `${url}  ${workers} workers x ${connections} connections, ${seconds}s each`,
  );
  console.log(
    `${"endpoint".padEnd(24)} ${"req/s".padStart(9)} ${"p50 ms".padStart(8)} ${
      "p99 ms".padStart(8)
    } ${"errors".padStart(7)} ${"cpu µs/req".padStart(11)}`,
  );
  for (const scenario of SCENARIOS) {
    await run(scenario, 1.5); // warm-up
    const cpuBefore = await serverCpuMs();
    const done = await run(scenario, seconds);
    const cpuMs = await serverCpuMs() - cpuBefore;
    const all = new Float64Array(
      done.reduce((sum, d) => sum + d.latencies.length, 0),
    );
    let at = 0;
    for (const d of done) {
      all.set(d.latencies, at);
      at += d.latencies.length;
    }
    all.sort();
    const elapsed = Math.max(...done.map((d) => d.elapsedMs)) / 1000;
    const errors = done.reduce((sum, d) => sum + d.errors, 0);
    const r = {
      cpuUs: (cpuMs * 1000) / (all.length + errors),
      rps: all.length / elapsed,
      p50: all[Math.floor(all.length * 0.5)] ?? NaN,
      p99: all[Math.floor(all.length * 0.99)] ?? NaN,
    };
    results[scenario] = r;
    let line = `${scenario.padEnd(24)} ${
      Math.round(r.rps).toLocaleString("en-US").padStart(9)
    } ${r.p50.toFixed(2).padStart(8)} ${r.p99.toFixed(2).padStart(8)} ${
      String(errors).padStart(7)
    } ${(pid ? r.cpuUs.toFixed(0) : "-").padStart(11)}`;
    const was = baseline[scenario];
    if (was) {
      line += `   was ${Math.round(was.rps).toLocaleString("en-US")} req/s (${
        (r.rps / was.rps).toFixed(2)
      }x)`;
      if (pid && was.cpuUs) {
        line += `, ${was.cpuUs.toFixed(0)} cpu µs/req (${
          (was.cpuUs / r.cpuUs).toFixed(2)
        }x less)`;
      }
    }
    console.log(line);
  }
  for (const w of pool) w.terminate();
  if (savePath) {
    await Deno.writeTextFile(savePath, JSON.stringify(results, null, 2) + "\n");
    console.log(`saved to ${savePath}`);
  }
}
