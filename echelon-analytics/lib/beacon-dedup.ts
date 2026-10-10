// Echelon Analytics — Pageview Beacon Idempotency
//
// The pageview beacon is an <img> GET. Mobile radios, CDNs, eager image
// loaders and service-worker replays deliver the exact same request more
// than once, sometimes minutes apart, and each delivery used to be a
// pageview. This remembers each beacon for 10 minutes and lets the caller
// drop repeats.
//
// The key is (site, session, nonce). The nonce is a 16-hex-character value
// the tracker draws once per pageview, so a redelivery of the same URL repeats
// it and a reload, back/forward load or new page gets a new one. (Interaction
// time cannot serve: a gesture before 800 ms is deferred to 800 ms, so reloads
// share it.) Neither the IP nor the visitor id is in the key: a phone changes
// address between the original request and its retry, the cookieless visitor
// id is a hash of that address, and in cookie mode a copy that arrives
// without the cookie is given a new random visitor id.
//
// Key length is bounded: site id at most 64 chars (validateSiteId),
// session id a 36-char UUID, nonce 16 chars, plus two separators: at most
// 118 chars, so 200 000 entries stay in the tens of MB.

const TTL_MS = 10 * 60_000;
const MAX_ENTRIES = 200_000;
const WATERMARK = Math.floor(MAX_ENTRIES * 0.9);

const seen = new Map<string, number>(); // key → first seen (ms)

function enforceCap(now: number): void {
  if (seen.size <= MAX_ENTRIES) return;
  for (const [key, ts] of seen) {
    if (now - ts > TTL_MS) seen.delete(key);
  }
  if (seen.size <= MAX_ENTRIES) return;
  // Still over: drop the oldest (Map keeps insertion order) down to the
  // watermark, so this scan runs once per ~20k inserts, not on each.
  let toRemove = seen.size - WATERMARK;
  for (const key of seen.keys()) {
    if (toRemove-- <= 0) break;
    seen.delete(key);
  }
}

/**
 * Record a beacon. Returns true if the same key was recorded within the last
 * 10 minutes (the caller should drop it), false if it is new.
 */
export function seenBefore(key: string, now: number = Date.now()): boolean {
  const first = seen.get(key);
  if (first !== undefined && now - first <= TTL_MS) return true;
  seen.delete(key);
  seen.set(key, now);
  enforceCap(now);
  return false;
}

/** Test-only: clear all state. */
export function _resetBeaconDedup(): void {
  seen.clear();
}

/** Test-only: number of remembered keys. */
export function _beaconDedupSize(): number {
  return seen.size;
}
