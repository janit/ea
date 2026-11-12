// Echelon Analytics — IP-based Rate Limiter
//
// In-memory sliding window per IP. Drops requests that exceed the limit.

import {
  EVENT_BYTES_PER_MIN,
  RATE_LIMIT_MAX,
  RATE_LIMIT_WINDOW_MS,
} from "./config.ts";
import { getClientIp, networkKey } from "./ip.ts";

interface RateEntry {
  count: number;
  windowStart: number;
}

const MAX_MAP_SIZE = 200_000;
const rateMap = new Map<string, RateEntry>();
let lastPrune = Date.now();

/** Prune expired entries, then enforce MAX_MAP_SIZE as a hard cap. */
function pruneRateMap(): void {
  const now = Date.now();
  lastPrune = now;
  for (const [key, entry] of rateMap) {
    if (now - entry.windowStart > RATE_LIMIT_WINDOW_MS) {
      rateMap.delete(key);
    }
  }

  // Expiry alone is not a bound: if enough entries are live, the map stays
  // over MAX_MAP_SIZE and the size check below then re-runs this full scan on
  // every subsequent request. Evict oldest-first (Map preserves insertion
  // order) so the cap actually holds and the scan cannot become per-request.
  if (rateMap.size > MAX_MAP_SIZE) {
    const excess = rateMap.size - MAX_MAP_SIZE;
    let removed = 0;
    for (const key of rateMap.keys()) {
      rateMap.delete(key);
      if (++removed >= excess) break;
    }
  }
}

/**
 * Check if a request should be rate-limited.
 * Returns true if the request should be DROPPED.
 */
export function isRateLimited(req: Request): boolean {
  if (RATE_LIMIT_MAX <= 0) return false;

  // Per network, not per address: an IPv6 /64 is one subscriber.
  const ip = networkKey(getClientIp(req));

  const now = Date.now();

  // Periodic cleanup: every 2 minutes or when map is too large
  if (rateMap.size > MAX_MAP_SIZE || now - lastPrune > 120_000) {
    pruneRateMap();
  }

  const entry = rateMap.get(ip);
  if (!entry || now - entry.windowStart > RATE_LIMIT_WINDOW_MS) {
    rateMap.set(ip, { count: 1, windowStart: now });
    return false;
  }

  entry.count++;
  return entry.count > RATE_LIMIT_MAX;
}

// ── Event storage budget ────────────────────────────────────────────────────

const BUDGET_WINDOW_MS = 60_000;
const budgetMap = new Map<string, RateEntry>(); // count = bytes this window
let lastBudgetPrune = Date.now();

function pruneBudgetMap(now: number): void {
  lastBudgetPrune = now;
  for (const [key, entry] of budgetMap) {
    if (now - entry.windowStart > BUDGET_WINDOW_MS) budgetMap.delete(key);
  }
  if (budgetMap.size > MAX_MAP_SIZE) {
    let excess = budgetMap.size - MAX_MAP_SIZE;
    for (const key of budgetMap.keys()) {
      if (excess-- <= 0) break;
      budgetMap.delete(key);
    }
  }
}

/**
 * Charge `bytes` of stored event data to `key` (a network, see networkKey).
 * Returns false when that would take the key over its budget for the minute:
 * the caller does not store the event. `limit` is for tests.
 */
export function spendEventBytes(
  key: string,
  bytes: number,
  now: number = Date.now(),
  limit: number = EVENT_BYTES_PER_MIN,
): boolean {
  if (limit <= 0) return true;
  if (budgetMap.size > MAX_MAP_SIZE || now - lastBudgetPrune > 120_000) {
    pruneBudgetMap(now);
  }
  const entry = budgetMap.get(key);
  if (!entry || now - entry.windowStart > BUDGET_WINDOW_MS) {
    budgetMap.set(key, { count: bytes, windowStart: now });
    return bytes <= limit;
  }
  if (entry.count + bytes > limit) return false;
  entry.count += bytes;
  return true;
}

/** Test-only: clear the event budget. */
export function _resetEventBudget(): void {
  budgetMap.clear();
}
