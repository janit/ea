// Echelon Analytics — Challenge Generation + Verification
//
// Runtime-generated WASM PoW challenges that rotate every 6 hours on a
// calendar boundary. With ECHELON_SECRET set, a window's module is derived
// from the secret, so restarts do not invalidate tokens in flight.

import {
  CHALLENGE_WINDOW_MINUTES,
  constantTimeEquals,
  SECRET,
} from "./config.ts";
import { BOT_THRESHOLD } from "./bot-threshold.ts";
import { buildChallengeWasm, generateParams } from "./challenge-wasm.ts";
import { debug } from "./debug.ts";
import { hmacSha256Hex } from "./hotpath.ts";

const ROTATION_MS = 6 * 60 * 60 * 1000; // 6 hours
const encoder = new TextEncoder();

// ── HMAC key (derived from SECRET, stable across restarts) ───────────────────

if (!SECRET) {
  console.warn(
    "[echelon] WARNING: ECHELON_SECRET not set. Challenge tokens will not survive restarts or work across workers. Set a secret for production use.",
  );
}

let hmacKey: Uint8Array | null = null;

function getHmacKey(): Uint8Array {
  hmacKey ??= SECRET
    ? encoder.encode(SECRET)
    : crypto.getRandomValues(new Uint8Array(32));
  return hmacKey;
}

// ── Challenge generation (HMAC of minute bucket) ────────────────────────────

function minuteBucket(offsetMinutes = 0): string {
  const now = Math.floor(Date.now() / 60_000) + offsetMinutes;
  return String(now);
}

// A minute's challenge is a function of the key and the minute alone, and
// verifyToken needs every minute of the window for each token it rejects.
// Computed once per minute instead of once per request.
const challenges = new Map<string, string>();
let challengeComputations = 0;

function challengeFor(bucket: string): string {
  let challenge = challenges.get(bucket);
  if (challenge === undefined) {
    // The first 16 bytes of the tag, as hex.
    challenge = hmacSha256Hex(getHmacKey(), bucket).slice(0, 32);
    challengeComputations++;
    challenges.set(bucket, challenge);
    if (challenges.size > CHALLENGE_WINDOW_MINUTES + 2) {
      const newest = Number(minuteBucket());
      const oldest = newest - CHALLENGE_WINDOW_MINUTES;
      for (const key of challenges.keys()) {
        const minute = Number(key);
        if (minute < oldest || minute > newest) challenges.delete(key);
      }
    }
  }
  return challenge;
}

/** Generate a challenge string for the current minute bucket. */
// deno-lint-ignore require-await
export async function generateChallenge(): Promise<string> {
  const bucket = minuteBucket();
  const challenge = challengeFor(bucket);
  debug("pow", "generateChallenge", {
    bucket,
    challenge: challenge.slice(0, 8) + "...",
  });
  return challenge;
}

/** Exported for testing: how many challenges have been computed. */
export function _challengeComputations(): number {
  return challengeComputations;
}

/** Exported for testing: how many minutes' challenges are held. */
export function _challengeCacheSize(): number {
  return challenges.size;
}

// ── WASM instance management ────────────────────────────────────────────────

interface WasmSlot {
  wasm: Uint8Array;
  wasmB64: string;
  instance: WebAssembly.Instance;
  bucket: number;
  createdAt: number;
}

let currentSlot: WasmSlot | null = null;
let previousSlot: WasmSlot | null = null;
let rotationPromise: Promise<WasmSlot> | null = null;

/** The rotation window a timestamp falls in. */
export function rotationBucket(now: number = Date.now()): number {
  return Math.floor(now / ROTATION_MS);
}

/**
 * 64-byte seed for a rotation bucket's WASM parameters.
 *
 * With a secret, the seed is a function of (secret, bucket): a restart inside
 * a window rebuilds the SAME module, so the blob embedded in every cached
 * /ea.js and every open tab keeps verifying. Rotating on process-relative age
 * with a random seed invalidated all of them on each deploy.
 *
 * Without a secret there is nothing stable to derive from; the seed is random
 * per process, as it always was (challenge.ts warns about this at startup).
 */
export async function slotSeed(
  secret: string,
  bucket: number,
): Promise<Uint8Array> {
  if (!secret) return crypto.getRandomValues(new Uint8Array(64));
  const half = async (label: string) =>
    new Uint8Array(
      await crypto.subtle.digest(
        "SHA-256",
        encoder.encode(`${label}:${secret}:${bucket}`),
      ),
    );
  const seed = new Uint8Array(64);
  seed.set(await half("echelon-wasm-a"), 0);
  seed.set(await half("echelon-wasm-b"), 32);
  return seed;
}

async function createSlot(bucket: number): Promise<WasmSlot> {
  const params = generateParams(await slotSeed(SECRET, bucket));
  const wasm = buildChallengeWasm(params);
  const module = await WebAssembly.compile(wasm.buffer as ArrayBuffer);
  const instance = await WebAssembly.instantiate(module);
  // Base64 encode the WASM for embedding in the tracker JS
  const wasmB64 = btoa(String.fromCharCode(...wasm));
  debug("pow", "createSlot", { wasmSize: wasm.length, bucket });
  return { wasm, wasmB64, instance, bucket, createdAt: Date.now() };
}

function ensureCurrentSlot(): Promise<WasmSlot> {
  // Guard against concurrent rotation: if a rotation is in progress, await it
  if (rotationPromise) return rotationPromise;

  const bucket = rotationBucket();
  if (!currentSlot || currentSlot.bucket !== bucket) {
    rotationPromise = (async () => {
      if (currentSlot) {
        previousSlot = currentSlot;
      } else if (SECRET) {
        // Cold start: rebuild the previous window's module too, so a tab
        // that loaded /ea.js just before a rotation still verifies after a
        // restart. Only possible when the seed is derivable.
        previousSlot = await createSlot(bucket - 1);
      }
      currentSlot = await createSlot(bucket);
      rotationPromise = null;
      return currentSlot;
    })().catch((e) => {
      rotationPromise = null;
      throw e;
    });
    return rotationPromise;
  }
  return Promise.resolve(currentSlot);
}

/** Get the current WASM blob as base64 (for embedding in tracker JS). */
export async function getWasmBase64(): Promise<string> {
  const slot = await ensureCurrentSlot();
  return slot.wasmB64;
}

/** Get the WASM generation ID (timestamp-based, for cache busting). */
export async function getWasmGeneration(): Promise<string> {
  const slot = await ensureCurrentSlot();
  return String(slot.createdAt);
}

// ── Solve using a WASM instance ─────────────────────────────────────────────

function solveWith(
  instance: WebAssembly.Instance,
  input: string,
): string {
  const memory = instance.exports.memory as WebAssembly.Memory;
  const solve = instance.exports.solve as (
    ptr: number,
    len: number,
    out: number,
  ) => void;
  const inputBytes = encoder.encode(input);
  const mem = new Uint8Array(memory.buffer);
  mem.set(inputBytes, 0);
  solve(0, inputBytes.length, 2048);
  return Array.from(mem.slice(2048, 2064))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

// ── Nonce tracking (prevent token replay) ───────────────────────────────────

const usedTokens = new Map<string, number>(); // "tok:sid" → expiry timestamp
const NONCE_TTL_MS = (CHALLENGE_WINDOW_MINUTES + 1) * 60_000;
const MAX_USED_TOKENS = 100_000;
let lastEviction = Date.now();

function evictExpiredTokens(force = false): void {
  const now = Date.now();
  if (!force && now - lastEviction < 60_000) return; // evict at most once/min
  lastEviction = now;
  for (const [tok, expiry] of usedTokens) {
    if (expiry <= now) usedTokens.delete(tok);
  }
  // Hard cap: if still too large after expiry eviction, drop oldest entries
  if (usedTokens.size > MAX_USED_TOKENS) {
    const toRemove = usedTokens.size - Math.floor(MAX_USED_TOKENS * 0.75);
    let removed = 0;
    for (const key of usedTokens.keys()) {
      if (removed >= toRemove) break;
      usedTokens.delete(key);
      removed++;
    }
  }
}

// ── Token verification ──────────────────────────────────────────────────────

/**
 * Verify a PoW token. Returns "valid", "missing", or "invalid".
 *
 * Tries the current + previous WASM instances against
 * the last CHALLENGE_WINDOW_MINUTES minute buckets.
 * Same-session re-presentations (beacon + events endpoint) are valid.
 */
export async function verifyToken(
  tok: string | null,
  siteId: string,
  sid: string,
): Promise<"valid" | "missing" | "invalid"> {
  if (!tok) {
    debug("pow", "verifyToken → missing", {
      siteId,
      sid: sid.slice(0, 8) + "...",
    });
    return "missing";
  }
  if (!/^[0-9a-f]{32}$/.test(tok)) {
    debug("pow", "verifyToken → invalid (format)", {
      tok: tok.slice(0, 16),
      siteId,
      sid: sid.slice(0, 8) + "...",
    });
    return "invalid";
  }

  // Key on tok:sid:siteId so the same session can reuse its token across
  // endpoints (beacon + events) and across pageviews within the same minute
  // bucket. Including siteId prevents cross-site replay on multi-tenant
  // instances. The WASM solve is deterministic for the same
  // challenge+sid+site, so a tok:sid:siteId hit means "this session already
  // proved its PoW for this site" — that's valid, not a replay attack.
  const nonceKey = tok + ":" + sid + ":" + siteId;
  evictExpiredTokens(usedTokens.size > MAX_USED_TOKENS * 0.9);
  if (usedTokens.has(nonceKey)) {
    debug("pow", "verifyToken → valid (same session)", {
      tok: tok.slice(0, 8) + "...",
      siteId,
      sid: sid.slice(0, 8) + "...",
    });
    return "valid";
  }

  const slot = await ensureCurrentSlot();

  // Collect active WASM slots
  const slots = [slot];
  if (previousSlot) slots.push(previousSlot);

  const bucketsTried: string[] = [];

  // Try each minute bucket within the challenge window
  for (let offset = 0; offset >= -CHALLENGE_WINDOW_MINUTES; offset--) {
    const bucket = minuteBucket(offset);
    bucketsTried.push(bucket);
    const challenge = challengeFor(bucket);

    const input = challenge + ":" + sid + ":" + siteId;

    for (const s of slots) {
      const expected = solveWith(s.instance, input);
      if (constantTimeEquals(expected, tok)) {
        // Mark token+session as used
        usedTokens.set(nonceKey, Date.now() + NONCE_TTL_MS);
        debug("pow", "verifyToken → valid", {
          tok: tok.slice(0, 8) + "...",
          siteId,
          sid: sid.slice(0, 8) + "...",
          matchedBucket: bucket,
          slotAge: Math.round((Date.now() - s.createdAt) / 1000) + "s",
        });
        return "valid";
      }
    }
  }

  debug("pow", "verifyToken → invalid", {
    tok: tok.slice(0, 8) + "...",
    siteId,
    sid: sid.slice(0, 8) + "...",
    bucketsChecked: bucketsTried.length,
    currentBucket: bucketsTried[0],
    slotsChecked: slots.length,
    usedTokensSize: usedTokens.size,
  });
  return "invalid";
}

/** Which endpoint is being scored. The invalid-token penalty differs. */
export type PowSurface = "beacon" | "events";

/** Invalid-token penalty on the events surface. See tokenPenalty. */
const EVENTS_INVALID_PENALTY = 40;
/** Missing-token penalty on both surfaces. See tokenPenalty. */
const MISSING_PENALTY = 30;

/**
 * Bot score penalty for a token verification result.
 *
 * "missing" is 30 on both surfaces. A browser that cannot run WebAssembly
 * (iOS Lockdown Mode, hardened browsers) or whose solve loses the tracker's
 * 150 ms wait looks exactly like a bot here, so it must not be decisive. The
 * engagement gate raises a view that never proved work AND never interacted
 * to the threshold afterwards — the forgiveness is conditional on behaviour.
 *
 * "invalid" depends on the surface:
 * - beacon → BOT_THRESHOLD. No honest first pageview sends a bad token, and
 *   the proven-identity waiver (proven-sessions.ts) covers the stale-token
 *   case for anyone who has already proved work.
 * - events → 40, under the threshold. Events fire for the whole life of a tab
 *   and are the evidence the view validator runs on; discarding them for a
 *   stale token would erase proof that a real session interacted.
 */
export function tokenPenalty(
  result: "valid" | "missing" | "invalid",
  surface: PowSurface,
): number {
  if (result === "valid") return 0;
  if (result === "missing") return MISSING_PENALTY;
  return surface === "beacon" ? BOT_THRESHOLD : EVENTS_INVALID_PENALTY;
}
