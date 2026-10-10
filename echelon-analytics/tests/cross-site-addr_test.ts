import { assert, assertEquals } from "@std/assert";
import { flushRemainingViews, handleBeacon } from "@/lib/beacon.ts";
import {
  hasUnresolvedClientAddr,
  isUnresolvedAddr,
  resolveClientAddr,
  setPeerAddr,
} from "@/lib/ip.ts";
import { createTestDb, solvePow } from "./_helpers.ts";

const UA_A =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/120.0.0.0";
const UA_B =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0";

function req(
  site: string,
  sid: string,
  tok: string,
  ua: string,
  peer: string | null,
  extra: Record<string, string> = {},
): Request {
  const r = new Request(
    `https://a.example.com/b.gif?p=${
      btoa("/page")
    }&_v=2000&sw=1440&sh=900&s=${site}&sid=${sid}&tok=${tok}`,
    {
      headers: {
        "user-agent": ua,
        "accept-language": "en-US",
        "sec-ch-ua": '"Chrome"',
        "sec-fetch-site": "cross-site",
        ...extra,
      },
    },
  );
  if (peer) {
    setPeerAddr(r, {
      remoteAddr: { transport: "tcp", hostname: peer, port: 1 },
    } as Deno.ServeHandlerInfo);
  }
  return r;
}

/** Three sites in a row; returns the stored detail of each view. */
async function threeSites(
  prefix: string,
  uas: string[],
  peer: string | null,
  extra: Record<string, string> = {},
): Promise<Record<string, number | string>[]> {
  const db = createTestDb();
  const out = [];
  for (let i = 0; i < 3; i++) {
    const site = `${prefix}-${i}`;
    const sid = `${i}0000000-0000-4000-8000-00000000000${i}`;
    const tok = await solvePow(site, sid);
    await handleBeacon(req(site, sid, tok, uas[i], peer, extra), db);
    await flushRemainingViews(db);
    const row = await db.queryOne<{ bot_score_detail: string }>(
      "SELECT bot_score_detail FROM visitor_views WHERE site_id = ?",
      site,
    );
    assert(row, `view on ${site} stored`);
    out.push(JSON.parse(row.bot_score_detail));
  }
  await db.close();
  return out;
}

Deno.test("cross-site addr — one UA, one address, three sites: third is flagged", async () => {
  const d = await threeSites("xsa-same", [UA_A, UA_A, UA_A], "198.51.100.7");
  assertEquals(d[0].cross_site, undefined);
  assertEquals(d[1].cross_site, undefined);
  assertEquals(d[2].cross_site, 34);
});

Deno.test("cross-site addr — different UAs from one address are not pooled", async () => {
  const d = await threeSites("xsa-mixed", [UA_A, UA_B, UA_A], "198.51.100.8");
  for (const x of d) assertEquals(x.cross_site, undefined);
});

Deno.test("cross-site addr — unresolved address never counts", async () => {
  const d = await threeSites("xsa-unknown", [UA_A, UA_A, UA_A], null);
  for (const x of d) assertEquals(x.cross_site, undefined);
});

// The environment flags are read at import, so the proxy cases go through the
// pure resolver with the flags passed in; the result does not depend on the
// developer's shell.
const bare = (headers: Record<string, string> = {}) =>
  new Request("https://a.example.com/b.gif", { headers });
const unresolved = (
  headers: Record<string, string>,
  flags: { behindCloudflare: boolean; trustProxy: boolean },
  peer: string | null = "10.0.0.1",
) =>
  isUnresolvedAddr(resolveClientAddr(bare(headers), flags, peer ?? undefined));
const NONE = { behindCloudflare: false, trustProxy: false };
const CF = { behindCloudflare: true, trustProxy: false };
const TRUSTED = { behindCloudflare: false, trustProxy: true };

Deno.test("addr resolver — unresolved only when unknown or behind an untrusted proxy", () => {
  // no peer, no headers
  assertEquals(unresolved({}, NONE, null), true);
  // direct peer, no forwarding header
  assertEquals(unresolved({}, NONE), false);
  // forwarding header without trust: the peer is the proxy
  assertEquals(unresolved({ "x-forwarded-for": "1.2.3.4" }, NONE), true);
  // trusted proxy resolves from the header
  assertEquals(unresolved({ "x-forwarded-for": "1.2.3.4" }, TRUSTED), false);
  assertEquals(unresolved({ "x-real-ip": "1.2.3.4" }, TRUSTED), false);
});

Deno.test("addr resolver — Cloudflare-only instance with X-Forwarded-For is resolved", () => {
  const h = { "cf-connecting-ip": "203.0.113.5", "x-forwarded-for": "1.2.3.4" };
  const r = resolveClientAddr(bare(h), CF, "10.0.0.1");
  assertEquals(r.ip, "203.0.113.5");
  assertEquals(isUnresolvedAddr(r), false);
  // Cloudflare flag set but header missing and a forwarder present: unresolved.
  assertEquals(unresolved({ "x-forwarded-for": "1.2.3.4" }, CF), true);
  // cf-connecting-ip is ignored without the flag.
  assertEquals(unresolved({ "cf-connecting-ip": "203.0.113.5" }, NONE), false);
});

Deno.test("hasUnresolvedClientAddr — unknown peer vs direct peer", () => {
  assertEquals(hasUnresolvedClientAddr(req("s", "x", "t", UA_A, null)), true);
  assertEquals(
    hasUnresolvedClientAddr(req("s", "x", "t", UA_A, "10.0.0.2")),
    false,
  );
});
