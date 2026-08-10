// Failed-authentication throttling.
//
// Shared by the login form and by bearer-token checks in both middlewares.
// Previously only the password path was throttled; ECHELON_SECRET could be
// guessed as fast as requests could be issued, with every wrong guess a clean
// 401 and no counter, delay or lockout anywhere.
//
// Only *failures* are recorded — a valid credential is never throttled, so
// legitimate high-volume API clients are unaffected.

const WINDOW_MS = 15 * 60 * 1000; // 15 minutes
const MAX_ATTEMPTS = 5;
const MAX_MAP_SIZE = 50_000;

interface AttemptEntry {
  attempts: number;
  firstAttempt: number;
}

const attempts = new Map<string, AttemptEntry>();

/** Drop entries whose window has closed. */
export function pruneAuthAttempts(): void {
  const now = Date.now();
  for (const [key, entry] of attempts) {
    if (now - entry.firstAttempt > WINDOW_MS) attempts.delete(key);
  }
}

// GC stale entries every 5 minutes.
setInterval(pruneAuthAttempts, 5 * 60 * 1000);

/** True if `key` has exhausted its attempts within the current window. */
export function isAuthLimited(key: string): boolean {
  const entry = attempts.get(key);
  if (!entry) return false;
  if (Date.now() - entry.firstAttempt > WINDOW_MS) {
    attempts.delete(key);
    return false;
  }
  return entry.attempts >= MAX_ATTEMPTS;
}

/** Record one failed attempt against `key`. */
export function recordAuthFailure(key: string): void {
  // Bound the map so a distributed attack cannot grow it without limit.
  if (attempts.size >= MAX_MAP_SIZE) {
    pruneAuthAttempts();
    if (attempts.size >= MAX_MAP_SIZE) {
      const oldest = attempts.keys().next().value;
      if (oldest !== undefined) attempts.delete(oldest);
    }
  }
  const now = Date.now();
  const entry = attempts.get(key);
  if (!entry || now - entry.firstAttempt > WINDOW_MS) {
    attempts.set(key, { attempts: 1, firstAttempt: now });
  } else {
    entry.attempts++;
  }
}

/** Clear all state. Test helper. */
export function _resetAuthAttempts(): void {
  attempts.clear();
}
