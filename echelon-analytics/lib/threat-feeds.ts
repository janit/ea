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
//   3. AWS ip-ranges.json             — datacenter IPv4+IPv6 CIDRs     → +15
//   4. GCP cloud.json                 — datacenter IPv4+IPv6 CIDRs     → +15

// ── Configuration ───────────────────────────────────────────────────────────

const REFRESH_INTERVAL_MS = 6 * 60 * 60 * 1000; // 6 hours
const FETCH_TIMEOUT_MS = 30_000; // 30s per feed

const CRAWLER_UA_URL =
  "https://raw.githubusercontent.com/monperrus/crawler-user-agents/master/crawler-user-agents.json";
const AI_ROBOTS_URL =
  "https://raw.githubusercontent.com/ai-robots-txt/ai.robots.txt/main/robots.json";
const AWS_IP_URL = "https://ip-ranges.amazonaws.com/ip-ranges.json";
const GCP_IP_URL = "https://www.gstatic.com/ipranges/cloud.json";

// ── In-memory state ─────────────────────────────────────────────────────────

let crawlerRegex: RegExp | null = null; // Combined regex from all crawler patterns
let aiCrawlerRegex: RegExp | null = null; // Combined regex from AI bot names
let dcRangesV4: [number, number][] = []; // Merged, sorted IPv4 intervals
let dcRangesV6: [bigint, bigint][] = []; // Merged, sorted IPv6 intervals

let crawlerPatternCount = 0;
let aiCrawlerNameCount = 0;
let dcRangeCount = 0;

// Per-feed raw CIDR counts, retained across refreshes so a single upstream
// failure doesn't silently erase the other feed's ranges.
let awsV4Ranges: [number, number][] = [];
let awsV6Ranges: [bigint, bigint][] = [];
let gcpV4Ranges: [number, number][] = [];
let gcpV6Ranges: [bigint, bigint][] = [];

// ── Public matchers ─────────────────────────────────────────────────────────

/** True if UA matches a known crawler pattern from the community feed. */
export function matchesCrawlerFeed(ua: string): boolean {
  return crawlerRegex !== null && crawlerRegex.test(ua);
}

/** True if UA matches a known AI bot name from the ai-robots-txt feed. */
export function matchesAiCrawlerFeed(ua: string): boolean {
  return aiCrawlerRegex !== null && aiCrawlerRegex.test(ua);
}

/** True if the IP address falls within a known cloud provider CIDR (AWS/GCP). */
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
  const merged: [bigint, bigint][] = [ranges[0]];
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
  const merged: [number, number][] = [ranges[0]];
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

/** Fetch AWS + GCP IP ranges and build merged interval lists (v4 + v6). */
async function refreshDatacenterIps(): Promise<void> {
  // AWS
  let awsOk = false;
  const newAwsV4: [number, number][] = [];
  const newAwsV6: [bigint, bigint][] = [];
  try {
    const data = await fetchJson(AWS_IP_URL) as {
      prefixes?: { ip_prefix: string }[];
      ipv6_prefixes?: { ipv6_prefix: string }[];
    };
    if (Array.isArray(data?.prefixes)) {
      for (const p of data.prefixes) {
        const range = parseCidrV4(p.ip_prefix);
        if (range) newAwsV4.push(range);
      }
    }
    if (Array.isArray(data?.ipv6_prefixes)) {
      for (const p of data.ipv6_prefixes) {
        const range = parseCidrV6(p.ipv6_prefix);
        if (range) newAwsV6.push(range);
      }
    }
    awsOk = newAwsV4.length > 0 || newAwsV6.length > 0;
  } catch (e) {
    console.warn("[echelon] threat-feeds: failed to fetch AWS IP ranges:", e);
  }

  // GCP
  let gcpOk = false;
  const newGcpV4: [number, number][] = [];
  const newGcpV6: [bigint, bigint][] = [];
  try {
    const data = await fetchJson(GCP_IP_URL) as {
      prefixes?: { ipv4Prefix?: string; ipv6Prefix?: string }[];
    };
    if (Array.isArray(data?.prefixes)) {
      for (const p of data.prefixes) {
        if (p.ipv4Prefix) {
          const range = parseCidrV4(p.ipv4Prefix);
          if (range) newGcpV4.push(range);
        }
        if (p.ipv6Prefix) {
          const range = parseCidrV6(p.ipv6Prefix);
          if (range) newGcpV6.push(range);
        }
      }
    }
    gcpOk = newGcpV4.length > 0 || newGcpV6.length > 0;
  } catch (e) {
    console.warn("[echelon] threat-feeds: failed to fetch GCP IP ranges:", e);
  }

  // Per-feed sanity check: a single feed shrinking to <10% of its prior
  // size (non-empty) is almost certainly a feed corruption — keep the old
  // data for that feed only.
  if (awsOk) {
    const prior = awsV4Ranges.length + awsV6Ranges.length;
    const next = newAwsV4.length + newAwsV6.length;
    if (prior > 0 && next < prior * 0.1) {
      console.warn(
        `[echelon] threat-feeds: AWS feed shrank from ${prior} to ${next} ranges — keeping old data`,
      );
    } else {
      awsV4Ranges = newAwsV4;
      awsV6Ranges = newAwsV6;
    }
  }
  if (gcpOk) {
    const prior = gcpV4Ranges.length + gcpV6Ranges.length;
    const next = newGcpV4.length + newGcpV6.length;
    if (prior > 0 && next < prior * 0.1) {
      console.warn(
        `[echelon] threat-feeds: GCP feed shrank from ${prior} to ${next} ranges — keeping old data`,
      );
    } else {
      gcpV4Ranges = newGcpV4;
      gcpV6Ranges = newGcpV6;
    }
  }

  // Rebuild the merged lookup tables from the retained per-feed ranges.
  const combinedV4 = [...awsV4Ranges, ...gcpV4Ranges];
  const combinedV6 = [...awsV6Ranges, ...gcpV6Ranges];
  if (combinedV4.length > 0) {
    dcRangesV4 = mergeRanges(combinedV4);
  }
  if (combinedV6.length > 0) {
    dcRangesV6 = mergeRangesV6(combinedV6);
  }
  dcRangeCount = dcRangesV4.length + dcRangesV6.length;

  const totalRaw = combinedV4.length + combinedV6.length;
  if (totalRaw > 0) {
    console.log(
      `[echelon] threat-feeds: loaded ${totalRaw} datacenter CIDRs (aws=${
        awsV4Ranges.length + awsV6Ranges.length
      }, gcp=${
        gcpV4Ranges.length + gcpV6Ranges.length
      }) → ${dcRangeCount} merged ranges (${dcRangesV4.length} v4, ${dcRangesV6.length} v6)`,
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
  awsV4Ranges = [];
  awsV6Ranges = [];
  gcpV4Ranges = [];
  gcpV6Ranges = [];
  dcRangeCount = 0;
}

/** Current feed stats for admin/debugging. */
export function getThreatFeedStats(): {
  crawlerPatterns: number;
  aiCrawlerNames: number;
  datacenterRanges: number;
} {
  return {
    crawlerPatterns: crawlerPatternCount,
    aiCrawlerNames: aiCrawlerNameCount,
    datacenterRanges: dcRangeCount,
  };
}

// ── Exported for testing ────────────────────────────────────────────────────
export {
  binarySearchRanges as _binarySearchRanges,
  binarySearchRangesV6 as _binarySearchRangesV6,
  ipv4ToNum as _ipv4ToNum,
  ipv6ToBigInt as _ipv6ToBigInt,
  mergeRanges as _mergeRanges,
  mergeRangesV6 as _mergeRangesV6,
  parseCidrV4 as _parseCidrV4,
  parseCidrV6 as _parseCidrV6,
};
