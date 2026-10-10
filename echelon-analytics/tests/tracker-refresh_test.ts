// Runs the real /ea.js output inside a minimal fake browser to exercise the
// PoW refresh path. No DOM library: only the globals the tracker touches.

import { assert, assertEquals, assertMatch } from "@std/assert";
import { verifyToken } from "@/lib/challenge.ts";
import { loadTracker } from "./_tracker_harness.ts";

const settle = () => new Promise((r) => setTimeout(r, 50));
type Echelon = { _refreshToken(): Promise<string> };

Deno.test("tracker — stores the token with the time it was solved", async () => {
  const h = await loadTracker({ site: "trk-store" });
  await settle();
  const parts = (h.storage.get("_etok") ?? "").split(":");
  assertEquals(parts.length, 3);
  assertMatch(parts[1], /^[0-9a-f]{32}$/);
  assert(Number(parts[2]) > 0, "third part is the solve timestamp");
});

Deno.test("tracker — _refreshToken fetches /c and stores a token the server accepts", async () => {
  const site = "trk-refresh";
  const h = await loadTracker({ site });
  await settle();
  const tok = await (h.win.echelon as Echelon)._refreshToken();
  assertEquals(h.fetched, ["https://ea.example.com/c"]);
  assertMatch(tok, /^[0-9a-f]{32}$/);
  assertEquals(
    await verifyToken(tok, site, "99999999-9999-4999-8999-999999999999"),
    "valid",
  );
});

Deno.test("tracker — the timer re-solves once the token is older than 4 minutes", async () => {
  const h = await loadTracker({ site: "trk-timer" });
  await settle();
  const t0 = Date.now();

  h.setNow(t0 + 3 * 60_000);
  h.tick();
  await settle();
  assertEquals(h.fetched.length, 0, "fresh token is left alone");

  h.setNow(t0 + 4 * 60_000 + 1000);
  h.tick();
  await settle();
  assertEquals(h.fetched.length, 1, "stale token triggers one refresh");
});

Deno.test("tracker — a hidden tab does not refresh on the timer", async () => {
  const h = await loadTracker({ site: "trk-hidden" });
  await settle();
  (h.win.document as { hidden: boolean }).hidden = true;
  h.setNow(Date.now() + 10 * 60_000);
  h.tick();
  await settle();
  assertEquals(h.fetched.length, 0);
});

Deno.test("tracker — bad challenge: a garbage /c response keeps the current token", async () => {
  const h = await loadTracker({
    site: "trk-bad",
    challengeResponse: () => Promise.resolve("<html>502 Bad Gateway</html>"),
  });
  await settle();
  const before = (h.storage.get("_etok") ?? "").split(":")[1];
  const after = await (h.win.echelon as Echelon)._refreshToken();
  assertEquals(after, before);
});

Deno.test("tracker — bad challenge: a failed fetch keeps the current token", async () => {
  const h = await loadTracker({
    site: "trk-offline",
    challengeResponse: () => Promise.reject(new Error("offline")),
  });
  await settle();
  const before = (h.storage.get("_etok") ?? "").split(":")[1];
  const after = await (h.win.echelon as Echelon)._refreshToken();
  assertEquals(after, before);
});

Deno.test("tracker — no WASM: loads, sends no token, and refresh is a no-op", async () => {
  const h = await loadTracker({ site: "trk-nowasm", wasm: false });
  await settle();
  assertEquals(h.storage.get("_etok"), undefined);
  assertEquals(await (h.win.echelon as Echelon)._refreshToken(), "");
  h.setNow(Date.now() + 10 * 60_000);
  h.tick();
  await settle();
  assertEquals(h.fetched.length, 0, "no refresh attempts without a solver");
});

Deno.test("tracker — backoff: after a failed /c refresh no trigger retries for 60s", async () => {
  const h = await loadTracker({
    site: "trk-backoff",
    challengeResponse: () => Promise.reject(new Error("offline")),
  });
  await settle();
  const t0 = Date.now();

  h.setNow(t0 + 5 * 60_000);
  h.tick();
  await settle();
  assertEquals(h.fetched.length, 1, "stale token attempts one refresh");

  h.setNow(t0 + 5 * 60_000 + 10_000);
  h.tick();
  h.fire("visibilitychange");
  await (h.win.echelon as Echelon)._refreshToken();
  await settle();
  assertEquals(h.fetched.length, 1, "no retry inside the 60s backoff");

  h.setNow(t0 + 5 * 60_000 + 61_000);
  h.tick();
  await settle();
  assertEquals(h.fetched.length, 2, "retry once the backoff has passed");
});

Deno.test("tracker — WASM instantiate rejecting disables solving: no /c fetch, nothing throws", async () => {
  const h = await loadTracker({ site: "trk-wasmfail", wasmRejects: true });
  await settle();
  assertEquals(h.storage.get("_etok"), undefined);
  h.setNow(Date.now() + 10 * 60_000);
  h.tick();
  h.fire("visibilitychange");
  await settle();
  assertEquals(await (h.win.echelon as Echelon)._refreshToken(), "");
  assertEquals(
    h.fetched.length,
    0,
    "never fetches /c without a working solver",
  );
});

// ── Pageview beacons and token age ──────────────────────────────────────────

const FRESH_CHALLENGE = "f".repeat(32);
const tokOf = (url: string) => new URL(url).searchParams.get("tok");
const storedTok = (h: { storage: Map<string, string> }) =>
  (h.storage.get("_etok") ?? "").split(":");

Deno.test("tracker — first pageview beacon: a token older than 4 minutes is re-solved against /c first", async () => {
  const h = await loadTracker({
    site: "trk-first-stale",
    challengeResponse: () => Promise.resolve(FRESH_CHALLENGE),
  });
  await settle();
  const staleTok = storedTok(h)[1];
  assertMatch(staleTok, /^[0-9a-f]{32}$/);

  // The tab sat frozen or in the background: no timer ran, the token aged.
  h.setNow(Date.now() + 4 * 60_000 + 1000);
  h.fire("scroll");
  await settle();

  assertEquals(h.fetched, ["https://ea.example.com/c"]);
  assertEquals(h.beacons.length, 1, "one pageview beacon");
  const [ch, freshTok] = storedTok(h);
  assertEquals(
    ch,
    FRESH_CHALLENGE,
    "token was solved against the /c challenge",
  );
  assert(freshTok !== staleTok, "the re-solve produced a different token");
  assertEquals(tokOf(h.beacons[0]), freshTok, "beacon carries the fresh token");
});

Deno.test("tracker — first pageview beacon: a token younger than 4 minutes is sent as is, no /c fetch", async () => {
  const h = await loadTracker({ site: "trk-first-fresh" });
  await settle();
  const tok = storedTok(h)[1];
  h.setNow(Date.now() + 3 * 60_000);
  h.fire("scroll");
  await settle();
  assertEquals(h.fetched.length, 0);
  assertEquals(h.beacons.length, 1);
  assertEquals(tokOf(h.beacons[0]), tok);
});

Deno.test("tracker — first pageview beacon: when /c fails the beacon still goes out with the current token", async () => {
  const h = await loadTracker({
    site: "trk-first-offline",
    challengeResponse: () => Promise.reject(new Error("offline")),
  });
  await settle();
  const tok = storedTok(h)[1];
  h.setNow(Date.now() + 5 * 60_000);
  h.fire("scroll");
  await settle();
  assertEquals(h.fetched.length, 1, "a refresh was attempted");
  assertEquals(h.beacons.length, 1, "beacon sent despite the failed refresh");
  assertEquals(tokOf(h.beacons[0]), tok);
});

Deno.test("tracker — first pageview beacon: a /c that never answers delays the beacon by at most 1s", async () => {
  const h = await loadTracker({
    site: "trk-first-hang",
    challengeResponse: () => new Promise<string>(() => {}),
  });
  await settle();
  const tok = storedTok(h)[1];
  h.setNow(Date.now() + 5 * 60_000);
  h.fire("scroll");
  await settle();
  assertEquals(h.fetched.length, 1, "a refresh was attempted");
  assertEquals(h.beacons.length, 0, "beacon waits for the refresh");

  h.runTimers(999);
  await settle();
  assertEquals(h.beacons.length, 0, "still waiting just under the cap");

  h.runTimers(1000);
  await settle();
  assertEquals(h.beacons.length, 1, "the 1s cap releases the beacon");
  assertEquals(tokOf(h.beacons[0]), tok, "with the current token");
});

Deno.test("tracker — first pageview beacon: inside the 60s backoff it does not wait on /c again", async () => {
  const h = await loadTracker({
    site: "trk-first-backoff",
    challengeResponse: () => Promise.reject(new Error("offline")),
  });
  await settle();
  const tok = storedTok(h)[1];
  const t0 = Date.now();
  h.setNow(t0 + 5 * 60_000);
  h.tick();
  await settle();
  assertEquals(h.fetched.length, 1, "the timer's refresh failed");

  h.setNow(t0 + 5 * 60_000 + 10_000);
  h.fire("scroll");
  await settle();
  assertEquals(h.fetched.length, 1, "no second attempt inside the backoff");
  assertEquals(h.beacons.length, 1);
  assertEquals(tokOf(h.beacons[0]), tok);
});

Deno.test("tracker — SPA navigation: a token older than 4 minutes is re-solved before the beacon", async () => {
  const h = await loadTracker({
    site: "trk-spa-stale",
    challengeResponse: () => Promise.resolve(FRESH_CHALLENGE),
  });
  await settle();
  const staleTok = storedTok(h)[1];

  h.setNow(Date.now() + 4 * 60_000 + 1000);
  h.navigate("/other");
  await settle();

  assertEquals(h.fetched, ["https://ea.example.com/c"]);
  assertEquals(h.beacons.length, 1, "one SPA pageview beacon");
  const [ch, freshTok] = storedTok(h);
  assertEquals(ch, FRESH_CHALLENGE);
  assert(freshTok !== staleTok);
  const url = new URL(h.beacons[0]);
  assertEquals(url.searchParams.get("_v"), "spa");
  assertEquals(url.searchParams.get("tok"), freshTok);
});

Deno.test("tracker — first pageview beacon: a hidden page sends at once with the current token, no /c wait", async () => {
  const h = await loadTracker({
    site: "trk-first-hidden",
    challengeResponse: () => new Promise<string>(() => {}),
  });
  await settle();
  const tok = storedTok(h)[1];

  // No gesture; the tab is hidden (or closing) with an aged token.
  h.setNow(Date.now() + 5 * 60_000);
  (h.win.document as { hidden: boolean }).hidden = true;
  h.fire("visibilitychange");

  // Synchronously: nothing may be awaited on the way out.
  assertEquals(h.beacons.length, 1, "beacon sent without waiting");
  assertEquals(tokOf(h.beacons[0]), tok, "with the current token");
  assertEquals(h.fetched.length, 0, "no /c round trip on hide");
  await settle();
  assertEquals(h.beacons.length, 1);
  assertEquals(h.fetched.length, 0);
});

// ── A beacon parked behind the token wait ───────────────────────────────────
// While a pageview beacon waits for /c it must keep its own page's URL, and a
// navigation or a hide must send it at once, exactly once.

const pathOf = (url: string) => atob(new URL(url).searchParams.get("p") ?? "");
const vOf = (url: string) => new URL(url).searchParams.get("_v");

/** A /c whose answer the test releases by hand. */
function heldChallenge() {
  let release: (ch: string) => void = () => {};
  const held = new Promise<string>((r) => (release = r));
  return { challengeResponse: () => held, release };
}

Deno.test("tracker — parked beacon: an SPA navigation before /c answers sends the landing view, then the new one", async () => {
  const c = heldChallenge();
  const h = await loadTracker({
    site: "trk-park-spa",
    challengeResponse: c.challengeResponse,
  });
  await settle();
  const staleTok = storedTok(h)[1];

  h.setNow(Date.now() + 5 * 60_000);
  h.fire("scroll");
  assertEquals(h.beacons.length, 0, "landing beacon is parked behind /c");

  h.navigate("/other");
  assertEquals(h.beacons.length, 1, "navigation flushes the landing beacon");
  assertEquals(pathOf(h.beacons[0]), "/page");
  assert(vOf(h.beacons[0]) !== "spa", "landing beacon keeps its timing marker");
  assert(Number(vOf(h.beacons[0])) >= 800, "timed from the landing page load");
  assertEquals(tokOf(h.beacons[0]), staleTok, "token current at that moment");

  c.release(FRESH_CHALLENGE);
  await settle();
  h.runTimers(1000);
  await settle();

  assertEquals(h.beacons.length, 2, "exactly one beacon per pageview");
  assertEquals(h.beacons.map(pathOf), ["/page", "/other"]);
  assertEquals(vOf(h.beacons[1]), "spa");
  assertEquals(
    tokOf(h.beacons[1]),
    storedTok(h)[1],
    "SPA view got the fresh token",
  );
  assertEquals(h.fetched.length, 1);
});

Deno.test("tracker — parked beacon: hiding the page sends it at once, and the late /c answer sends nothing more", async () => {
  const c = heldChallenge();
  const h = await loadTracker({
    site: "trk-park-hide",
    challengeResponse: c.challengeResponse,
  });
  await settle();
  const staleTok = storedTok(h)[1];

  h.setNow(Date.now() + 5 * 60_000);
  h.fire("scroll");
  assertEquals(h.beacons.length, 0, "beacon is parked behind /c");

  (h.win.document as { hidden: boolean }).hidden = true;
  h.fire("visibilitychange");
  assertEquals(h.beacons.length, 1, "sent synchronously on hide");
  assertEquals(pathOf(h.beacons[0]), "/page");
  assertEquals(tokOf(h.beacons[0]), staleTok);

  h.fire("pagehide");
  c.release(FRESH_CHALLENGE);
  await settle();
  h.runTimers(1000);
  await settle();
  assertEquals(h.beacons.length, 1, "nothing more once /c answers");
});

Deno.test("tracker — parked beacon: pagehide alone flushes it", async () => {
  const c = heldChallenge();
  const h = await loadTracker({
    site: "trk-park-pagehide",
    challengeResponse: c.challengeResponse,
  });
  await settle();
  h.setNow(Date.now() + 5 * 60_000);
  h.fire("scroll");
  assertEquals(h.beacons.length, 0);
  h.fire("pagehide");
  assertEquals(h.beacons.length, 1, "sent synchronously on pagehide");
  h.runTimers(1000);
  await settle();
  assertEquals(h.beacons.length, 1);
});

Deno.test("tracker — parked beacon: two quick SPA navigations send one beacon each with the right paths", async () => {
  const c = heldChallenge();
  const h = await loadTracker({
    site: "trk-park-spa2",
    challengeResponse: c.challengeResponse,
  });
  await settle();
  // The landing view goes out with a fresh token; then the token ages.
  const t0 = Date.now();
  h.setNow(t0 + 1000);
  h.fire("scroll");
  assertEquals(h.beacons.map(pathOf), ["/page"]);
  h.setNow(t0 + 5 * 60_000);

  h.navigate("/a");
  assertEquals(h.beacons.length, 1, "first SPA beacon is parked behind /c");
  h.navigate("/b");
  assertEquals(
    h.beacons.map(pathOf),
    ["/page", "/a"],
    "second navigation flushes the first SPA beacon",
  );

  c.release(FRESH_CHALLENGE);
  await settle();
  h.runTimers(1000);
  await settle();
  assertEquals(h.beacons.map(pathOf), ["/page", "/a", "/b"]);
  assertEquals(h.beacons.slice(1).map(vOf), ["spa", "spa"]);
  assertEquals(tokOf(h.beacons[2]), storedTok(h)[1]);
});

Deno.test("tracker — parked beacon: the 150ms first-solve wait is flushed by a navigation too", async () => {
  // The first solve never finishes: WebAssembly.instantiate hangs.
  const slow = await loadTracker({ site: "trk-park-150", wasmHangs: true });
  await settle();
  slow.setNow(Date.now() + 2000);
  slow.fire("scroll");
  assertEquals(slow.beacons.length, 0, "waiting up to 150ms for the solve");
  slow.navigate("/other");
  assertEquals(slow.beacons.length, 1, "navigation flushes the landing beacon");
  assertEquals(pathOf(slow.beacons[0]), "/page");
  assertEquals(tokOf(slow.beacons[0]), null, "no token yet");
  slow.runTimers(1000);
  await settle();
  assertEquals(slow.beacons.map(pathOf), ["/page", "/other"]);
});

// ── Per-pageview nonce (beacon dedup key) ───────────────────────────────────

const nonceOf = (u: string) => new URL(u).searchParams.get("_n");

Deno.test("tracker — landing beacon carries a 16-hex nonce", async () => {
  const h = await loadTracker({ site: "trk-nonce" });
  await settle();
  h.fire("scroll");
  h.runTimers(1000);
  await settle();
  assertEquals(h.beacons.length, 1);
  assertMatch(nonceOf(h.beacons[0]) ?? "", /^[0-9a-f]{16}$/);
});

Deno.test("tracker — a parked beacon flushed on hide carries a valid nonce, sent once", async () => {
  const c = heldChallenge();
  const h = await loadTracker({
    site: "trk-nonce-park",
    challengeResponse: c.challengeResponse,
  });
  await settle();
  h.setNow(Date.now() + 5 * 60_000);
  h.fire("scroll");
  assertEquals(h.beacons.length, 0, "beacon is parked behind /c");
  (h.win.document as { hidden: boolean }).hidden = true;
  h.fire("visibilitychange");
  assertEquals(h.beacons.length, 1);
  const n = nonceOf(h.beacons[0]);
  assertMatch(n ?? "", /^[0-9a-f]{16}$/);
  c.release(FRESH_CHALLENGE);
  await settle();
  h.runTimers(1000);
  assertEquals(h.beacons.length, 1, "the late /c answer sends nothing more");
  assertEquals(nonceOf(h.beacons[0]), n);
});

Deno.test("tracker — two page loads produce different nonces", async () => {
  const seen = new Set<string>();
  for (const site of ["trk-nonce-a", "trk-nonce-b"]) {
    const h = await loadTracker({ site });
    await settle();
    h.fire("scroll");
    h.runTimers(1000);
    await settle();
    seen.add(nonceOf(h.beacons[0]) ?? "");
  }
  assertEquals(seen.size, 2);
});
