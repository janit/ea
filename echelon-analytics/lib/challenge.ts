// Echelon Analytics — Challenge Generation + Verification
//
// Runtime-generated WASM PoW challenges that rotate every 6 hours.
// Each deployment/rotation produces a unique WASM blob, making
// cross-deployment bot toolkits impractical.

import {
  CHALLENGE_WINDOW_MINUTES,
  constantTimeEquals,
  SECRET,
} from "./config.ts";
import { buildChallengeWasm, generateParams } from "./challenge-wasm.ts";
import { debug } from "./debug.ts";

const ROTATION_MS = 6 * 60 * 60 * 1000; // 6 hours
const encoder = new TextEncoder();

// ── HMAC key (derived from SECRET, stable across restarts) ───────────────────

if (!SECRET) {
  console.warn(
    "[echelon] WARNING: ECHELON_SECRET not set. Challenge tokens will not survive restarts or work across workers. Set a secret for production use.",
  );
}

let hmacKey: CryptoKey | null = null;

async function getHmacKey(): Promise<CryptoKey> {
  if (hmacKey) return hmacKey;
  const keyMaterial = SECRET
    ? encoder.encode(SECRET)
    : crypto.getRandomValues(new Uint8Array(32));
  hmacKey = await crypto.subtle.importKey(
    "raw",
    keyMaterial,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return hmacKey;
}

// ── Challenge generation (HMAC of minute bucket) ────────────────────────────

function minuteBucket(offsetMinutes = 0): string {
  const now = Math.floor(Date.now() / 60_000) + offsetMinutes;
  return String(now);
}

/** Generate a challenge string for the current minute bucket. */
export async function generateChallenge(): Promise<string> {
  const key = await getHmacKey();
  const bucket = minuteBucket();
  const data = encoder.encode(bucket);
  const sig = await crypto.subtle.sign("HMAC", key, data);
  const challenge = Array.from(new Uint8Array(sig).slice(0, 16))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  debug("pow", "generateChallenge", {
    bucket,
    challenge: challenge.slice(0, 8) + "...",
  });
  return challenge;
}

// ── WASM instance management ────────────────────────────────────────────────

interface WasmSlot {
  wasm: Uint8Array;
  wasmB64: string;
  instance: WebAssembly.Instance;
  createdAt: number;
}

let currentSlot: WasmSlot | null = null;
let previousSlot: WasmSlot | null = null;
let rotationPromise: Promise<WasmSlot> | null = null;

async function createSlot(): Promise<WasmSlot> {
  const seed = crypto.getRandomValues(new Uint8Array(64));
  const params = generateParams(seed);
  const wasm = buildChallengeWasm(params);
  const module = await WebAssembly.compile(wasm.buffer as ArrayBuffer);
  const instance = await WebAssembly.instantiate(module);
  // Base64 encode the WASM for embedding in the tracker JS
  const wasmB64 = btoa(String.fromCharCode(...wasm));
  debug("pow", "createSlot", { wasmSize: wasm.length, createdAt: Date.now() });
  return { wasm, wasmB64, instance, createdAt: Date.now() };
}

function ensureCurrentSlot(): Promise<WasmSlot> {
  // Guard against concurrent rotation: if a rotation is in progress, await it
  if (rotationPromise) return rotationPromise;

  const now = Date.now();
  if (!currentSlot || now - currentSlot.createdAt >= ROTATION_MS) {
    rotationPromise = (async () => {
      if (currentSlot) previousSlot = currentSlot;
      currentSlot = await createSlot();
      rotationPromise = null;
      return currentSlot;
    })();
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

  // Key on tok:sid so the same session can reuse its token across endpoints
  // (beacon + events) and across pageviews within the same minute bucket.
  // The WASM solve is deterministic for the same challenge+sid+site, so a
  // tok:sid hit means "this session already proved its PoW" — that's valid,
  // not a replay attack. Cross-session replay is impossible because sid is
  // baked into the WASM input.
  const nonceKey = tok + ":" + sid;
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
  const key = await getHmacKey();

  // Collect active WASM slots
  const slots = [slot];
  if (previousSlot) slots.push(previousSlot);

  const bucketsTried: string[] = [];

  // Try each minute bucket within the challenge window
  for (let offset = 0; offset >= -CHALLENGE_WINDOW_MINUTES; offset--) {
    const bucket = minuteBucket(offset);
    bucketsTried.push(bucket);
    const sig = await crypto.subtle.sign("HMAC", key, encoder.encode(bucket));
    const challenge = Array.from(new Uint8Array(sig).slice(0, 16))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");

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

/** Bot score penalty for token verification result. */
export function tokenPenalty(
  result: "valid" | "missing" | "invalid",
): number {
  if (result === "valid") return 0;
  if (result === "missing") return 30;
  return 40; // invalid
}
