// Echelon Analytics — Proven-Identity Store
//
// Remembers which sessions and visitors have presented a VALID proof-of-work
// token, so a later request from the same identity that arrives without a
// token (the solve lost a race) or with a stale one (long-lived tab, resumed
// session) is not penalised for it.
//
// An identity is only ever proven by a real WASM solve. A client that can do
// that gains nothing by then dropping the token: every other signal still
// stacks, and the waiver is scoped to the site it proved on.
//
// In-memory and per-process, like the nonce cache in challenge.ts. After a
// restart the worst case is the pre-existing behaviour (penalty applied).

/** How long a valid token vouches for its session and visitor. */
export const PROVEN_TTL_MS = 60 * 60_000;

const MAX_PROVEN = 400_000;
const SESSION_RE = /^[0-9a-f-]{36}$/;

const proven = new Map<string, number>(); // key → expiry (ms)
let lastEviction = 0;

function evict(now: number, force: boolean): void {
  if (!force && now - lastEviction < 60_000) return;
  lastEviction = now;
  for (const [key, expiry] of proven) {
    if (expiry <= now) proven.delete(key);
  }
  if (proven.size > MAX_PROVEN) {
    let toRemove = proven.size - Math.floor(MAX_PROVEN * 0.75);
    for (const key of proven.keys()) {
      if (toRemove-- <= 0) break;
      proven.delete(key);
    }
  }
}

/**
 * Keys under which an identity is recorded. The site is part of every key
 * because tokens are site-bound. A session id that is not UUID-shaped (the
 * tracker's fallback when sessionStorage is blocked) is not a stable identity
 * and gets no key.
 */
export function provenKeys(
  siteId: string,
  sessionId: string | null,
  visitorId: string | null,
): string[] {
  const keys: string[] = [];
  if (sessionId && SESSION_RE.test(sessionId)) {
    keys.push(`s:${siteId}:${sessionId}`);
  }
  if (visitorId) keys.push(`v:${siteId}:${visitorId}`);
  return keys;
}

/** Record that these keys presented a valid token. */
export function markProven(keys: string[], now: number = Date.now()): void {
  if (keys.length === 0) return;
  evict(now, proven.size > MAX_PROVEN * 0.9);
  for (const key of keys) proven.set(key, now + PROVEN_TTL_MS);
}

/**
 * Which kind of key vouches for this identity: "s" if its session key
 * presented a valid token within the TTL, otherwise "v" if only its visitor
 * key did, otherwise null. The session wins when both are proven: it is the
 * stronger evidence, because in cookieless mode a visitor key is shared by
 * everyone behind one IP and user agent.
 */
export function provenBy(
  keys: string[],
  now: number = Date.now(),
): "s" | "v" | null {
  let by: "v" | null = null;
  for (const key of keys) {
    const expiry = proven.get(key);
    if (expiry === undefined) continue;
    if (expiry <= now) {
      proven.delete(key);
      continue;
    }
    if (key.startsWith("s:")) return "s";
    by = "v";
  }
  return by;
}

/** True if any of these keys presented a valid token within the TTL. */
export function isProven(keys: string[], now: number = Date.now()): boolean {
  return provenBy(keys, now) !== null;
}

/** Test-only: clear all state. */
export function _resetProven(): void {
  proven.clear();
  lastEviction = 0;
}
