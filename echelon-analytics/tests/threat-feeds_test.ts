import { assertEquals } from "@std/assert";
import {
  _adoptFeed as adoptFeed,
  _binarySearchRanges as binarySearch,
  _binarySearchRangesV6 as binarySearchV6,
  _ipv4ToNum as ipv4ToNum,
  _ipv6ToBigInt as ipv6ToBigInt,
  _mergeRanges as mergeRanges,
  _mergeRangesV6 as mergeRangesV6,
  _parseCidrV4 as parseCidr,
  _parseCidrV6 as parseCidrV6,
  _parseDigitalOceanCsv as parseDoCsv,
  _parseOracleJson as parseOracle,
  isDatacenterIp,
  matchesAiCrawlerFeed,
  matchesCrawlerFeed,
  stopThreatFeeds,
} from "@/lib/threat-feeds.ts";

// ── IPv4 parsing ────────────────────────────────────────────────────────────

Deno.test("ipv4ToNum — parses standard addresses", () => {
  assertEquals(ipv4ToNum("0.0.0.0"), 0);
  assertEquals(ipv4ToNum("255.255.255.255"), 0xffffffff);
  assertEquals(ipv4ToNum("10.0.0.1"), 0x0a000001);
  assertEquals(ipv4ToNum("192.168.1.100"), 0xc0a80164);
});

Deno.test("ipv4ToNum — rejects invalid input", () => {
  assertEquals(ipv4ToNum(""), null);
  assertEquals(ipv4ToNum("not-an-ip"), null);
  assertEquals(ipv4ToNum("10.0.0"), null);
  assertEquals(ipv4ToNum("10.0.0.0.0"), null);
  assertEquals(ipv4ToNum("256.0.0.0"), null);
  assertEquals(ipv4ToNum("10.0.0.-1"), null);
});

// ── CIDR parsing ────────────────────────────────────────────────────────────

Deno.test("parseCidr — /32 gives single IP", () => {
  const r = parseCidr("10.0.0.1/32");
  assertEquals(r, [0x0a000001, 0x0a000001]);
});

Deno.test("parseCidr — /24 gives 256-address range", () => {
  const r = parseCidr("192.168.1.0/24");
  assertEquals(r, [0xc0a80100, 0xc0a801ff]);
});

Deno.test("parseCidr — /8 gives class-A range", () => {
  const r = parseCidr("10.0.0.0/8");
  assertEquals(r, [0x0a000000, 0x0affffff]);
});

Deno.test("parseCidr — /16 gives class-B range", () => {
  const r = parseCidr("172.16.0.0/16");
  assertEquals(r, [0xac100000, 0xac10ffff]);
});

Deno.test("parseCidr — /0 gives all IPs", () => {
  const r = parseCidr("0.0.0.0/0");
  assertEquals(r, [0, 0xffffffff]);
});

Deno.test("parseCidr — host bits are masked off", () => {
  // 10.1.2.3/8 should still give 10.0.0.0 - 10.255.255.255
  const r = parseCidr("10.1.2.3/8");
  assertEquals(r, [0x0a000000, 0x0affffff]);
});

Deno.test("parseCidr — rejects invalid input", () => {
  assertEquals(parseCidr("not-a-cidr"), null);
  assertEquals(parseCidr("10.0.0.0"), null); // no /prefix
  assertEquals(parseCidr("10.0.0.0/33"), null);
  assertEquals(parseCidr("10.0.0.0/-1"), null);
});

// ── Range merging ───────────────────────────────────────────────────────────

Deno.test("mergeRanges — non-overlapping stays separate", () => {
  const merged = mergeRanges([[1, 5], [10, 15], [20, 25]]);
  assertEquals(merged, [[1, 5], [10, 15], [20, 25]]);
});

Deno.test("mergeRanges — overlapping gets merged", () => {
  const merged = mergeRanges([[1, 10], [5, 20], [15, 30]]);
  assertEquals(merged, [[1, 30]]);
});

Deno.test("mergeRanges — adjacent gets merged", () => {
  const merged = mergeRanges([[1, 5], [6, 10]]);
  assertEquals(merged, [[1, 10]]);
});

Deno.test("mergeRanges — subset is absorbed", () => {
  const merged = mergeRanges([[1, 100], [10, 50]]);
  assertEquals(merged, [[1, 100]]);
});

Deno.test("mergeRanges — unsorted input is handled", () => {
  const merged = mergeRanges([[20, 25], [1, 5], [10, 15]]);
  assertEquals(merged, [[1, 5], [10, 15], [20, 25]]);
});

Deno.test("mergeRanges — empty input", () => {
  assertEquals(mergeRanges([]), []);
});

// ── Binary search ───────────────────────────────────────────────────────────

Deno.test("binarySearch — finds IP in range", () => {
  const ranges: [number, number][] = [[10, 20], [30, 40], [50, 60]];
  assertEquals(binarySearch(15, ranges), true);
  assertEquals(binarySearch(35, ranges), true);
  assertEquals(binarySearch(55, ranges), true);
});

Deno.test("binarySearch — finds IP at range boundaries", () => {
  const ranges: [number, number][] = [[10, 20], [30, 40]];
  assertEquals(binarySearch(10, ranges), true); // start
  assertEquals(binarySearch(20, ranges), true); // end
  assertEquals(binarySearch(30, ranges), true);
  assertEquals(binarySearch(40, ranges), true);
});

Deno.test("binarySearch — rejects IP outside ranges", () => {
  const ranges: [number, number][] = [[10, 20], [30, 40], [50, 60]];
  assertEquals(binarySearch(5, ranges), false);
  assertEquals(binarySearch(25, ranges), false);
  assertEquals(binarySearch(45, ranges), false);
  assertEquals(binarySearch(65, ranges), false);
});

Deno.test("binarySearch — empty ranges", () => {
  assertEquals(binarySearch(10, []), false);
});

// ── IPv6 parsing ────────────────────────────────────────────────────────────

Deno.test("ipv6ToBigInt — parses full addresses", () => {
  assertEquals(ipv6ToBigInt("::"), 0n);
  assertEquals(ipv6ToBigInt("::1"), 1n);
  assertEquals(
    ipv6ToBigInt("2001:0db8:0000:0000:0000:0000:0000:0001"),
    0x20010db8000000000000000000000001n,
  );
});

Deno.test("ipv6ToBigInt — handles :: expansion", () => {
  assertEquals(
    ipv6ToBigInt("2001:db8::1"),
    0x20010db8000000000000000000000001n,
  );
  assertEquals(ipv6ToBigInt("fe80::1"), 0xfe800000000000000000000000000001n);
  assertEquals(ipv6ToBigInt("::ffff:c0a8:1"), 0x0000000000000000ffffc0a80001n);
});

Deno.test("ipv6ToBigInt — rejects invalid input", () => {
  assertEquals(ipv6ToBigInt(""), null);
  assertEquals(ipv6ToBigInt("not-an-ip"), null);
  assertEquals(ipv6ToBigInt("10.0.0.1"), null); // IPv4
  assertEquals(ipv6ToBigInt(":::1"), null); // triple colon
  assertEquals(ipv6ToBigInt("2001:db8::1::2"), null); // double ::
});

// ── IPv6 CIDR parsing ───────────────────────────────────────────────────────

Deno.test("parseCidrV6 — /128 gives single address", () => {
  const r = parseCidrV6("2001:db8::1/128");
  assertEquals(r, [
    0x20010db8000000000000000000000001n,
    0x20010db8000000000000000000000001n,
  ]);
});

Deno.test("parseCidrV6 — /44 gives subnet", () => {
  const r = parseCidrV6("2600:1900:8000::/44");
  assertEquals(r![0], 0x26001900800000000000000000000000n);
  // /44 = 84 host bits → 2600:1900:800f:ffff:ffff:ffff:ffff:ffff
  assertEquals(r![1], 0x26001900800fffffffffffffffffffffn);
});

Deno.test("parseCidrV6 — /0 gives all addresses", () => {
  const r = parseCidrV6("::/0");
  assertEquals(r, [0n, (1n << 128n) - 1n]);
});

// ── IPv6 range merging ──────────────────────────────────────────────────────

Deno.test("mergeRangesV6 — merges overlapping", () => {
  const merged = mergeRangesV6([[1n, 10n], [5n, 20n]]);
  assertEquals(merged, [[1n, 20n]]);
});

Deno.test("mergeRangesV6 — keeps non-overlapping", () => {
  const merged = mergeRangesV6([[1n, 5n], [10n, 15n]]);
  assertEquals(merged, [[1n, 5n], [10n, 15n]]);
});

// ── IPv6 binary search ──────────────────────────────────────────────────────

Deno.test("binarySearchV6 — finds and rejects correctly", () => {
  const ranges: [bigint, bigint][] = [[10n, 20n], [30n, 40n]];
  assertEquals(binarySearchV6(15n, ranges), true);
  assertEquals(binarySearchV6(25n, ranges), false);
  assertEquals(binarySearchV6(35n, ranges), true);
});

// ── Matchers with no feeds loaded ───────────────────────────────────────────

Deno.test("matchers return false when no feeds loaded", () => {
  stopThreatFeeds(); // Ensure clean state
  assertEquals(matchesCrawlerFeed("Googlebot/2.1"), false);
  assertEquals(matchesAiCrawlerFeed("GPTBot/1.0"), false);
  assertEquals(isDatacenterIp("3.5.140.1"), false);
});

// ── DigitalOcean + Oracle parsers ───────────────────────────────────────────

Deno.test("parseDoCsv — reads the CIDR column, IPv4 and IPv6", () => {
  const csv = [
    "5.101.96.0/21,NL,NL-NH,Amsterdam,1098",
    "2400:6180::/48,SG,SG-01,Singapore,",
    "",
    "not a cidr,US,,,",
    "104.131.0.0/18,US,US-NY,New York,10013",
  ].join("\n");
  const r = parseDoCsv(csv);
  assertEquals(r.v4.length, 2);
  assertEquals(r.v6.length, 1);
  assertEquals(r.v4[0], parseCidr("5.101.96.0/21"));
});

Deno.test("parseDoCsv — empty and garbage input yield nothing", () => {
  assertEquals(parseDoCsv(""), { v4: [], v6: [] });
  assertEquals(parseDoCsv("<html>503</html>"), { v4: [], v6: [] });
});

Deno.test("parseDoCsv — never widens: /0, trailing junk and bad prefixes are skipped", () => {
  const r = parseDoCsv(
    [
      "0.0.0.0/0,US,,,",
      "::/0,US,,,",
      "10.0.0.0/8junk,US,,,",
      "10.0.0.0/33,US,,,",
      "10.0.0.0/-1,US,,,",
      "5.101.96.0/21\r",
    ].join("\n"),
  );
  assertEquals(r.v4, [parseCidr("5.101.96.0/21")!]);
  assertEquals(r.v6, []);
});

Deno.test("parseOracleJson — reads every region's cidrs", () => {
  const r = parseOracle({
    regions: [
      { region: "us-phoenix-1", cidrs: [{ cidr: "129.146.0.0/21" }] },
      {
        region: "eu-frankfurt-1",
        cidrs: [{ cidr: "130.61.0.0/16" }, { cidr: "bogus" }],
      },
    ],
  });
  assertEquals(r.v4.length, 2);
  assertEquals(r.v6.length, 0);
});

Deno.test("parseOracleJson — tolerates any malformed shape", () => {
  for (
    const bad of [null, undefined, 42, "x", {}, { regions: null }, {
      regions: [null, { cidrs: null }, { cidrs: [null, {}, { cidr: 5 }] }],
    }]
  ) {
    assertEquals(parseOracle(bad), { v4: [], v6: [] });
  }
});

Deno.test("adoptFeed — takes a healthy refresh", () => {
  const prior = { v4: [[1, 2]] as [number, number][], v6: [] };
  const next = { v4: [[5, 6], [7, 8]] as [number, number][], v6: [] };
  assertEquals(adoptFeed("test", prior, next), next);
});

Deno.test("adoptFeed — keeps prior data when a feed is empty or collapses", () => {
  const prior = {
    v4: Array.from({ length: 100 }, (_, i) => [i, i] as [number, number]),
    v6: [],
  };
  assertEquals(adoptFeed("test", prior, { v4: [], v6: [] }), prior);
  assertEquals(adoptFeed("test", prior, { v4: [[1, 1]], v6: [] }), prior);
});
