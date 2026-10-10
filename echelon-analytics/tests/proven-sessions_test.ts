import { assertEquals } from "@std/assert";
import {
  _resetProven,
  isProven,
  markProven,
  PROVEN_TTL_MS,
  provenBy,
  provenKeys,
} from "@/lib/proven-sessions.ts";

const SID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const VID = "0123456789abcdef";

Deno.test("provenKeys — builds site-scoped session and visitor keys", () => {
  assertEquals(provenKeys("site-a", SID, VID), [
    `s:site-a:${SID}`,
    `v:site-a:${VID}`,
  ]);
});

Deno.test("provenKeys — drops a session id that is not a UUID", () => {
  assertEquals(provenKeys("site-a", "k3j2h1", VID), [`v:site-a:${VID}`]);
  assertEquals(provenKeys("site-a", null, null), []);
});

Deno.test("isProven — false until marked, true after, for either key", () => {
  _resetProven();
  const keys = provenKeys("site-a", SID, VID);
  assertEquals(isProven(keys), false);
  markProven(keys);
  assertEquals(isProven([keys[0]]), true);
  assertEquals(isProven([keys[1]]), true);
});

Deno.test("isProven — scoped to the site it was proven on", () => {
  _resetProven();
  markProven(provenKeys("site-a", SID, VID));
  assertEquals(isProven(provenKeys("site-b", SID, VID)), false);
});

Deno.test("isProven — expires after the TTL", () => {
  _resetProven();
  const keys = provenKeys("site-a", SID, VID);
  const t0 = 1_000_000;
  markProven(keys, t0);
  assertEquals(isProven(keys, t0 + PROVEN_TTL_MS - 1), true);
  assertEquals(isProven(keys, t0 + PROVEN_TTL_MS), false);
});

Deno.test("isProven — empty key list is never proven", () => {
  _resetProven();
  assertEquals(isProven([]), false);
});

Deno.test("provenBy — null until marked, session wins when both keys are proven", () => {
  _resetProven();
  const keys = provenKeys("site-a", SID, VID);
  assertEquals(provenBy(keys), null);
  assertEquals(provenBy([]), null);
  markProven(keys);
  assertEquals(provenBy(keys), "s");
  // Order of the keys does not matter.
  assertEquals(provenBy([keys[1], keys[0]]), "s");
});

Deno.test("provenBy — 'v' when only the visitor key is proven", () => {
  _resetProven();
  markProven(provenKeys("site-a", SID, VID));
  const otherSession = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
  assertEquals(provenBy(provenKeys("site-a", otherSession, VID)), "v");
  assertEquals(provenBy(provenKeys("site-a", "k3j2h1", VID)), "v");
  assertEquals(provenBy(provenKeys("site-a", SID, "fedcba9876543210")), "s");
  assertEquals(provenBy(provenKeys("site-b", otherSession, VID)), null);
});

Deno.test("provenBy — an expired session key falls back to a live visitor key", () => {
  _resetProven();
  const [sKey, vKey] = provenKeys("site-a", SID, VID);
  const t0 = 1_000_000;
  markProven([sKey], t0);
  markProven([vKey], t0 + 10);
  assertEquals(provenBy([sKey, vKey], t0 + PROVEN_TTL_MS - 1), "s");
  assertEquals(provenBy([sKey, vKey], t0 + PROVEN_TTL_MS), "v");
  assertEquals(provenBy([sKey, vKey], t0 + PROVEN_TTL_MS + 10), null);
});
