// Echelon Analytics — Threat Intelligence Feeds
//
// Periodically fetches community-maintained bot/crawler lists and cloud
// provider IP ranges, builds in-memory lookup structures, and exposes
// fast synchronous matchers for use in bot scoring.
//
// Feeds refresh every 6 hours. If a fetch fails, the previous data is
// retained. If no data has ever been loaded, matchers return false
// (safe default — no false positives).
//
// Feeds:
//   1. monperrus/crawler-user-agents  — 600+ crawler UA regex patterns → +30
//   2. ai-robots-txt/robots.json      — 130+ AI bot names             → +40
//   3. AWS ip-ranges.json             — datacenter IPv4+IPv6 CIDRs     → +24
//   4. GCP cloud.json                 — datacenter IPv4+IPv6 CIDRs     → +24
//   5. DigitalOcean geofeed CSV       — datacenter IPv4+IPv6 CIDRs     → +24
//   6. Oracle Cloud public_ip_ranges  — datacenter IPv4+IPv6 CIDRs     → +24

// ── Configuration ───────────────────────────────────────────────────────────

const REFRESH_INTERVAL_MS = 6 * 60 * 60 * 1000; // 6 hours
const FETCH_TIMEOUT_MS = 30_000; // 30s per feed

const CRAWLER_UA_URL =
  "https://raw.githubusercontent.com/monperrus/crawler-user-agents/master/crawler-user-agents.json";
const AI_ROBOTS_URL =
  "https://raw.githubusercontent.com/ai-robots-txt/ai.robots.txt/main/robots.json";
const AWS_IP_URL = "https://ip-ranges.amazonaws.com/ip-ranges.json";
const GCP_IP_URL = "https://www.gstatic.com/ipranges/cloud.json";
const DO_IP_URL = "https://www.digitalocean.com/geo/google.csv";
const OCI_IP_URL =
  "https://docs.oracle.com/en-us/iaas/tools/public_ip_ranges.json";

// ── In-memory state ─────────────────────────────────────────────────────────

let crawlerRegex: RegExp | null = null; // Combined regex from all crawler patterns
let aiCrawlerRegex: RegExp | null = null; // Combined regex from AI bot names
let dcRangesV4: [number, number][] = []; // Merged, sorted IPv4 intervals
let dcRangesV6: [bigint, bigint][] = []; // Merged, sorted IPv6 intervals

let crawlerPatternCount = 0;
let aiCrawlerNameCount = 0;
let dcRangeCount = 0;

type DcRanges = { v4: [number, number][]; v6: [bigint, bigint][] };
const noRanges = (): DcRanges => ({ v4: [], v6: [] });

// Raw ranges per provider, retained across refreshes so one upstream failure
// does not erase another provider's data.
const dcFeeds: Record<"aws" | "gcp" | "digitalocean" | "oracle", DcRanges> = {
  aws: noRanges(),
  gcp: noRanges(),
  digitalocean: noRanges(),
  oracle: noRanges(),
};

// ── Public matchers ─────────────────────────────────────────────────────────

/** True if UA matches a known crawler pattern from the community feed. */
export function matchesCrawlerFeed(ua: string): boolean {
  return crawlerRegex !== null && crawlerRegex.test(ua);
}

/** True if UA matches a known AI bot name from the ai-robots-txt feed. */
export function matchesAiCrawlerFeed(ua: string): boolean {
  return aiCrawlerRegex !== null && aiCrawlerRegex.test(ua);
}

/** True if the IP address falls within a known cloud provider CIDR (AWS, GCP, DigitalOcean, Oracle). */
export function isDatacenterIp(ip: string): boolean {
  // Normalize IPv4-mapped IPv6 (::ffff:a.b.c.d and ::a.b.c.d) to plain IPv4
  // so dual-stack deployments still match the IPv4 CIDR list.
  const mapped = stripV4MappedPrefix(ip);

  // Try IPv4 first (most common)
  const v4 = ipv4ToNum(mapped);
  if (v4 !== null) {
    return dcRangesV4.length > 0 && binarySearchRanges(v4, dcRangesV4);
  }
  // Try IPv6
  const v6 = ipv6ToBigInt(ip);
  if (v6 !== null) {
    return dcRangesV6.length > 0 && binarySearchRangesV6(v6, dcRangesV6);
  }
  return false;
}

/** If ip is `::ffff:a.b.c.d` or `::a.b.c.d`, return the dotted quad. Otherwise return ip unchanged. */
function stripV4MappedPrefix(ip: string): string {
  const lower = ip.toLowerCase();
  if (lower.startsWith("::ffff:")) {
    const tail = ip.slice(7);
    if (/^\d+\.\d+\.\d+\.\d+$/.test(tail)) return tail;
  } else if (lower.startsWith("::")) {
    const tail = ip.slice(2);
    if (/^\d+\.\d+\.\d+\.\d+$/.test(tail)) return tail;
  }
  return ip;
}

// ── IPv4 utilities ──────────────────────────────────────────────────────────

/** Parse an IPv4 dotted-quad string to a 32-bit unsigned integer. */
function ipv4ToNum(ip: string): number | null {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  let n = 0;
  for (const p of parts) {
    // Reject non-decimal octets (hex "0x10", octal "010", empty, whitespace)
    if (!/^\d+$/.test(p)) return null;
    const v = parseInt(p, 10);
    if (v < 0 || v > 255) return null;
    n = ((n << 8) | v) >>> 0;
  }
  return n;
}

/** Parse a CIDR like "10.0.0.0/8" into [start, end] as unsigned 32-bit ints. */
function parseCidrV4(cidr: string): [number, number] | null {
  const slash = cidr.indexOf("/");
  if (slash < 0) return null;
  const ipStr = cidr.substring(0, slash);
  const bits = parseInt(cidr.substring(slash + 1), 10);
  if (isNaN(bits) || bits < 0 || bits > 32) return null;

  const ip = ipv4ToNum(ipStr);
  if (ip === null) return null;

  if (bits === 0) return [0, 0xffffffff];
  const hostBits = 32 - bits;
  const wildcard = hostBits >= 32 ? 0xffffffff : (((1 << hostBits) >>> 0) - 1);
  const start = (ip & ~wildcard) >>> 0;
  const end = (start | wildcard) >>> 0;
  return [start, end];
}

// ── IPv6 utilities ──────────────────────────────────────────────────────────

/** Parse an IPv6 address to a 128-bit BigInt. Handles :: expansion. */
function ipv6ToBigInt(ip: string): bigint | null {
  // Reject if it looks like IPv4
  if (/^\d+\.\d+\.\d+\.\d+$/.test(ip)) return null;

  const halves = ip.split("::");
  if (halves.length > 2) return null;

  let groups: string[];
  if (halves.length === 2) {
    const left = halves[0] ? halves[0].split(":") : [];
    const right = halves[1] ? halves[1].split(":") : [];
    const missing = 8 - left.length - right.length;
    if (missing < 0) return null;
    groups = [...left, ...Array(missing).fill("0"), ...right];
  } else {
    groups = ip.split(":");
  }

  if (groups.length !== 8) return null;

  let result = 0n;
  for (const g of groups) {
    if (!/^[0-9a-fA-F]{1,4}$/.test(g)) return null;
    result = (result << 16n) | BigInt(parseInt(g, 16));
  }
  return result;
}

/** Parse an IPv6 CIDR into [start, end] as BigInts. */
function parseCidrV6(cidr: string): [bigint, bigint] | null {
  const slash = cidr.indexOf("/");
  if (slash < 0) return null;
  const addr = ipv6ToBigInt(cidr.substring(0, slash));
  if (addr === null) return null;
  const bits = parseInt(cidr.substring(slash + 1), 10);
  if (isNaN(bits) || bits < 0 || bits > 128) return null;

  if (bits === 0) return [0n, (1n << 128n) - 1n];
  const hostBits = BigInt(128 - bits);
  const wildcard = (1n << hostBits) - 1n;
  const start = addr & ~wildcard;
  const end = start | wildcard;
  return [start, end];
}

/** Merge overlapping/adjacent IPv6 intervals. */
function mergeRangesV6(
  ranges: [bigint, bigint][],
): [bigint, bigint][] {
  if (ranges.length === 0) return [];
  ranges.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  // Copy the seed tuple — see mergeRanges().
  const merged: [bigint, bigint][] = [[ranges[0][0], ranges[0][1]]];
  for (let i = 1; i < ranges.length; i++) {
    const prev = merged[merged.length - 1];
    const [start, end] = ranges[i];
    if (start <= prev[1] + 1n) {
      if (end > prev[1]) prev[1] = end;
    } else {
      merged.push([start, end]);
    }
  }
  return merged;
}

/** Binary search merged IPv6 ranges. */
function binarySearchRangesV6(
  target: bigint,
  ranges: [bigint, bigint][],
): boolean {
  let lo = 0;
  let hi = ranges.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >>> 1;
    const [start, end] = ranges[mid];
    if (target < start) {
      hi = mid - 1;
    } else if (target > end) {
      lo = mid + 1;
    } else {
      return true;
    }
  }
  return false;
}

/** Merge overlapping/adjacent sorted intervals into non-overlapping set. */
function mergeRanges(
  ranges: [number, number][],
): [number, number][] {
  if (ranges.length === 0) return [];
  ranges.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  // Copy the seed tuple — mutating prev[1] below would otherwise write
  // through into the caller's per-feed array, which outlives this merge.
  const merged: [number, number][] = [[ranges[0][0], ranges[0][1]]];
  for (let i = 1; i < ranges.length; i++) {
    const prev = merged[merged.length - 1];
    const [start, end] = ranges[i];
    if (start <= prev[1] + 1) {
      prev[1] = Math.max(prev[1], end);
    } else {
      merged.push([start, end]);
    }
  }
  return merged;
}

/** Binary search merged non-overlapping ranges for a target value. */
function binarySearchRanges(
  target: number,
  ranges: [number, number][],
): boolean {
  let lo = 0;
  let hi = ranges.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >>> 1;
    const [start, end] = ranges[mid];
    if (target < start) {
      hi = mid - 1;
    } else if (target > end) {
      lo = mid + 1;
    } else {
      return true;
    }
  }
  return false;
}

// ── Feed fetching ───────────────────────────────────────────────────────────

async function fetchJson(url: string): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const resp = await fetch(url, { signal: controller.signal });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    return await resp.json();
  } finally {
    clearTimeout(timer);
  }
}

/** Fetch crawler UA patterns and compile into a single regex. */
async function refreshCrawlerUAs(): Promise<void> {
  try {
    const data = await fetchJson(CRAWLER_UA_URL) as {
      pattern: string;
    }[];
    if (!Array.isArray(data) || data.length === 0) return;

    // Validate each pattern individually, skip invalid ones
    const valid: string[] = [];
    for (const entry of data) {
      if (typeof entry.pattern !== "string") continue;
      try {
        new RegExp(entry.pattern);
        valid.push(entry.pattern);
      } catch { /* skip malformed regex */ }
    }
    if (valid.length === 0) return;

    // Sanity check: if we already have data and the new set is suspiciously
    // small (< 10% of previous), the feed may be corrupted — keep old data.
    if (crawlerPatternCount > 0 && valid.length < crawlerPatternCount * 0.1) {
      console.warn(
        `[echelon] threat-feeds: crawler UA feed shrank from ${crawlerPatternCount} to ${valid.length} patterns — keeping old data`,
      );
      return;
    }

    crawlerRegex = new RegExp(`(?:${valid.join("|")})`, "i");
    crawlerPatternCount = valid.length;
    console.log(
      `[echelon] threat-feeds: loaded ${valid.length} crawler UA patterns`,
    );
  } catch (e) {
    console.warn("[echelon] threat-feeds: failed to fetch crawler UAs:", e);
  }
}

/** Fetch AI bot names and compile into a single regex. */
async function refreshAiCrawlers(): Promise<void> {
  try {
    const data = await fetchJson(AI_ROBOTS_URL) as Record<string, unknown>;
    if (typeof data !== "object" || data === null) return;

    const names = Object.keys(data).filter((k) => k.length > 0);
    if (names.length === 0) return;

    // Sanity check: reject suspiciously small refreshes
    if (aiCrawlerNameCount > 0 && names.length < aiCrawlerNameCount * 0.1) {
      console.warn(
        `[echelon] threat-feeds: AI crawler feed shrank from ${aiCrawlerNameCount} to ${names.length} names — keeping old data`,
      );
      return;
    }

    // Escape regex special chars in bot names, then combine
    const escaped = names.map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
    aiCrawlerRegex = new RegExp(`(?:${escaped.join("|")})`, "i");
    aiCrawlerNameCount = names.length;
    console.log(
      `[echelon] threat-feeds: loaded ${names.length} AI crawler names`,
    );
  } catch (e) {
    console.warn("[echelon] threat-feeds: failed to fetch AI crawlers:", e);
  }
}

async function fetchText(url: string): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const resp = await fetch(url, { signal: controller.signal });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    return await resp.text();
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Sort a CIDR string into the right family. Anything unparseable is skipped,
 * never widened: a feed entry must be a bare address, "/", and a decimal
 * prefix length of 1 or more. A /0 would flag every visitor as a datacenter.
 */
function addCidr(into: DcRanges, cidr: unknown): void {
  if (typeof cidr !== "string") return;
  const c = cidr.trim();
  if (!/^[0-9a-fA-F:.]+\/[1-9]\d{0,2}$/.test(c)) return;
  if (c.includes(":")) {
    const r = parseCidrV6(c);
    if (r) into.v6.push(r);
  } else {
    const r = parseCidrV4(c);
    if (r) into.v4.push(r);
  }
}

/** DigitalOcean publishes a geofeed CSV: cidr,country,region,city,postal. */
function parseDigitalOceanCsv(text: string): DcRanges {
  const out = noRanges();
  for (const line of text.split("\n")) {
    addCidr(out, line.split(",")[0]);
  }
  return out;
}

/** Oracle Cloud: { regions: [{ cidrs: [{ cidr }] }] }. */
function parseOracleJson(data: unknown): DcRanges {
  const out = noRanges();
  const regions = (data as { regions?: unknown } | null)?.regions;
  if (!Array.isArray(regions)) return out;
  for (const region of regions) {
    const cidrs = (region as { cidrs?: unknown } | null)?.cidrs;
    if (!Array.isArray(cidrs)) continue;
    for (const entry of cidrs) {
      addCidr(out, (entry as { cidr?: unknown } | null)?.cidr);
    }
  }
  return out;
}

/**
 * Decide whether a provider's fresh ranges replace what we hold. An empty
 * result, or one under 10% of the prior size, is almost certainly a broken
 * or truncated response: keep the old data for that provider.
 */
function adoptFeed(name: string, prior: DcRanges, next: DcRanges): DcRanges {
  const priorSize = prior.v4.length + prior.v6.length;
  const nextSize = next.v4.length + next.v6.length;
  if (nextSize === 0) return prior;
  if (priorSize > 0 && nextSize < priorSize * 0.1) {
    console.warn(
      `[echelon] threat-feeds: ${name} feed shrank from ${priorSize} to ${nextSize} ranges — keeping old data`,
    );
    return prior;
  }
  return next;
}

/** Fetch each provider's IP ranges and rebuild the merged lookup tables. */
async function refreshDatacenterIps(): Promise<void> {
  const loaders: Record<keyof typeof dcFeeds, () => Promise<DcRanges>> = {
    aws: async () => {
      const data = await fetchJson(AWS_IP_URL) as {
        prefixes?: { ip_prefix: string }[];
        ipv6_prefixes?: { ipv6_prefix: string }[];
      };
      const out = noRanges();
      if (Array.isArray(data?.prefixes)) {
        for (const p of data.prefixes) addCidr(out, p?.ip_prefix);
      }
      if (Array.isArray(data?.ipv6_prefixes)) {
        for (const p of data.ipv6_prefixes) addCidr(out, p?.ipv6_prefix);
      }
      return out;
    },
    gcp: async () => {
      const data = await fetchJson(GCP_IP_URL) as {
        prefixes?: { ipv4Prefix?: string; ipv6Prefix?: string }[];
      };
      const out = noRanges();
      if (Array.isArray(data?.prefixes)) {
        for (const p of data.prefixes) {
          addCidr(out, p?.ipv4Prefix);
          addCidr(out, p?.ipv6Prefix);
        }
      }
      return out;
    },
    digitalocean: async () => parseDigitalOceanCsv(await fetchText(DO_IP_URL)),
    oracle: async () => parseOracleJson(await fetchJson(OCI_IP_URL)),
  };

  // Providers are independent: fetch together, and a failure in one leaves
  // its previous ranges in place.
  await Promise.all(
    (Object.keys(loaders) as (keyof typeof dcFeeds)[]).map(async (name) => {
      try {
        dcFeeds[name] = adoptFeed(name, dcFeeds[name], await loaders[name]());
      } catch (e) {
        console.warn(
          `[echelon] threat-feeds: failed to fetch ${name} IP ranges:`,
          e,
        );
      }
    }),
  );

  // Rebuild the merged lookup tables from the retained per-provider ranges.
  const all = Object.values(dcFeeds);
  const combinedV4 = all.flatMap((f) => f.v4);
  const combinedV6 = all.flatMap((f) => f.v6);
  if (combinedV4.length > 0) dcRangesV4 = mergeRanges(combinedV4);
  if (combinedV6.length > 0) dcRangesV6 = mergeRangesV6(combinedV6);
  dcRangeCount = dcRangesV4.length + dcRangesV6.length;

  if (combinedV4.length + combinedV6.length > 0) {
    const sizes = Object.entries(dcFeeds)
      .map(([name, f]) => `${name}=${f.v4.length + f.v6.length}`)
      .join(", ");
    console.log(
      `[echelon] threat-feeds: loaded datacenter CIDRs (${sizes}) → ` +
        `${dcRangeCount} merged ranges (${dcRangesV4.length} v4, ${dcRangesV6.length} v6)`,
    );
  }
}
/** Refresh all feeds. Errors in one feed don't block others. */
async function refreshAll(): Promise<void> {
  await Promise.allSettled([
    refreshCrawlerUAs(),
    refreshAiCrawlers(),
    refreshDatacenterIps(),
  ]);
}

// ── Lifecycle ───────────────────────────────────────────────────────────────

let refreshTimer: ReturnType<typeof setInterval> | null = null;

/** Start periodic feed refresh. First refresh is async (non-blocking). */
export function startThreatFeeds(): void {
  if (refreshTimer) return;

  // Initial fetch (don't block startup)
  refreshAll().catch((e) =>
    console.error("[echelon] threat-feeds: initial refresh error", e)
  );

  refreshTimer = setInterval(() => {
    refreshAll().catch((e) =>
      console.error("[echelon] threat-feeds: refresh error", e)
    );
  }, REFRESH_INTERVAL_MS);

  console.log(
    `[echelon] threat-feeds: started (refresh every ${
      REFRESH_INTERVAL_MS / 3_600_000
    }h)`,
  );
}

/** Stop refresh timer and clear cached data. */
export function stopThreatFeeds(): void {
  if (refreshTimer) {
    clearInterval(refreshTimer);
    refreshTimer = null;
  }
  crawlerRegex = null;
  aiCrawlerRegex = null;
  dcRangesV4 = [];
  dcRangesV6 = [];
  for (const name of Object.keys(dcFeeds) as (keyof typeof dcFeeds)[]) {
    dcFeeds[name] = noRanges();
  }
  dcRangeCount = 0;
}

// ── Exported for testing ────────────────────────────────────────────────────
export {
  adoptFeed as _adoptFeed,
  binarySearchRanges as _binarySearchRanges,
  binarySearchRangesV6 as _binarySearchRangesV6,
  ipv4ToNum as _ipv4ToNum,
  ipv6ToBigInt as _ipv6ToBigInt,
  mergeRanges as _mergeRanges,
  mergeRangesV6 as _mergeRangesV6,
  parseCidrV4 as _parseCidrV4,
  parseCidrV6 as _parseCidrV6,
  parseDigitalOceanCsv as _parseDigitalOceanCsv,
  parseOracleJson as _parseOracleJson,
};
export type { DcRanges };
