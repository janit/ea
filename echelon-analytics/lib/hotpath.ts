// Echelon Analytics — Hot Path Helpers (Rust, compiled to WASM)
//
// Two things every tracking request does were slow in JS:
//
//   HMAC-SHA256   WebCrypto is async: each sign() is a round trip off the
//                 event loop and costs ~35 µs for ~1 µs of hashing.
//   crawler feed  one RegExp with ~1,500 alternatives; an ordinary browser
//                 user agent matches none of them, so all are tried (~17 µs).
//
// Both run in the Rust module in hotpath/, embedded in hotpath-wasm.ts. This
// file is the only caller, and it decides what the module may be given, so
// that the answers are the ones the JS code would give:
//
//   - HMAC is the same function everywhere; the module is simply faster.
//   - A user agent goes to Rust only if it is printable ASCII, and a pattern
//     only if it reads the same in both engines. Everything else is answered
//     by the RegExp that was used before.
//
// If the module cannot be loaded, node:crypto and the RegExp do all the work.

import { createHmac } from "node:crypto";
import { HOTPATH_WASM_BASE64 } from "./hotpath-wasm.ts";

interface HotpathExports {
  memory: WebAssembly.Memory;
  alloc(len: number): number;
  dealloc(ptr: number, len: number): void;
  hmac_sha256(
    key: number,
    keyLen: number,
    msg: number,
    msgLen: number,
    out: number,
  ): void;
  ua_set(text: number, textLen: number, rej: number, rejCap: number): number;
  ua_match(ua: number, uaLen: number): number;
}

// Scratch layout: [ key | tag (32) | message or user agent ].
const KEY_CAP = 1024;
const TAG_LEN = 32;
const MSG_CAP = 16 * 1024;
/** A longer user agent is left to the RegExp. */
const UA_CAP = 4096;

const encoder = new TextEncoder();
const HEX: string[] = [];
for (let i = 0; i < 256; i++) HEX.push(i.toString(16).padStart(2, "0"));

let wasm: HotpathExports | null = null;
let scratch = 0;
let mem = new Uint8Array(0);

try {
  const bin = atob(HOTPATH_WASM_BASE64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  const instance = new WebAssembly.Instance(new WebAssembly.Module(bytes));
  wasm = instance.exports as unknown as HotpathExports;
  scratch = wasm.alloc(KEY_CAP + TAG_LEN + MSG_CAP);
} catch (e) {
  wasm = null;
  console.warn(
    "[echelon] hotpath: WASM module unavailable, using the JS fallbacks:",
    e,
  );
}

/** The module's memory. Growing it detaches the old buffer, so re-check. */
function memory(w: HotpathExports): Uint8Array {
  if (mem.buffer !== w.memory.buffer) mem = new Uint8Array(w.memory.buffer);
  return mem;
}

/** Which implementation is serving: the Rust module or the JS fallbacks. */
export function hotpathBackend(): "wasm" | "js" {
  return wasm ? "wasm" : "js";
}

// ── HMAC-SHA256 ─────────────────────────────────────────────────────────────

/** The fallback, exported so the tests can hold it to the same answers. */
export function _fallbackHmacSha256Hex(key: Uint8Array, msg: string): string {
  return createHmac("sha256", key).update(encoder.encode(msg)).digest("hex");
}

/**
 * HMAC-SHA256 of the UTF-8 encoding of `msg`, as 64 lowercase hex characters.
 * Synchronous; the same value `crypto.subtle.sign("HMAC", …)` produces.
 */
export function hmacSha256Hex(key: Uint8Array, msg: string): string {
  const w = wasm;
  if (!w || key.length > KEY_CAP) return _fallbackHmacSha256Hex(key, msg);
  const m = memory(w);
  const msgPtr = scratch + KEY_CAP + TAG_LEN;
  const { read, written } = encoder.encodeInto(
    msg,
    m.subarray(msgPtr, msgPtr + MSG_CAP),
  );
  // Did not fit: rare (the inputs are an address, a user agent, a site id).
  if (read < msg.length) return _fallbackHmacSha256Hex(key, msg);
  m.set(key, scratch);
  const tagPtr = scratch + KEY_CAP;
  w.hmac_sha256(scratch, key.length, msgPtr, written, tagPtr);
  let hex = "";
  for (let i = tagPtr; i < tagPtr + TAG_LEN; i++) hex += HEX[m[i]];
  return hex;
}

// ── User agent matcher ──────────────────────────────────────────────────────

export interface UaMatcher {
  /** True when any pattern matches, exactly as the combined RegExp would. */
  test(ua: string): boolean;
  /** Patterns compiled by the Rust module. */
  readonly nativePatterns: number;
  /** Patterns only the RegExp evaluates. */
  readonly jsPatterns: number;
}

const QUANTIFIER_RE = /^\{\d+(?:,\d*)?\}/;
const ESCAPES = "dDwWsSbBtnrfv";
const CLASS_ESCAPES = "dDwWsStnrfv";

/**
 * True when `p` uses a back-reference. Group numbers count across the whole
 * combined expression, so one such pattern ties every pattern's meaning to
 * its position in the list, and the set cannot be split between engines.
 */
function hasBackreference(p: string): boolean {
  for (let i = 0; i < p.length; i++) {
    if (p[i] !== "\\") continue;
    const next = p[++i];
    if (next >= "1" && next <= "9") return true;
    if (next === "k" && p[i + 1] === "<") return true;
  }
  return false;
}

/**
 * True when `p` means the same to Rust's regex engine (bytes, no Unicode,
 * ASCII case-insensitive) as to a JS RegExp with the `i` flag, for printable
 * ASCII input. Deliberately narrow: a pattern this refuses is still matched,
 * by JS. Where the two engines read one spelling differently the pattern is
 * refused here; where Rust has no such syntax (look-around) it refuses the
 * pattern itself.
 */
function isRustSafe(p: string): boolean {
  let inClass = false;
  for (let i = 0; i < p.length; i++) {
    const code = p.charCodeAt(i);
    if (code < 0x20 || code > 0x7e) return false;
    const ch = p[i];
    if (ch === "\\") {
      const next = p[++i];
      if (next === undefined) return false;
      const alnum = /[A-Za-z0-9]/.test(next);
      if (alnum) {
        // \A \z \< \> \p{…} \x41 \0 … : anchors or classes in Rust, literals
        // or something else in JS. \b in a class is a backspace in JS.
        if (!(inClass ? CLASS_ESCAPES : ESCAPES).includes(next)) return false;
      } else if (next === "<" || next === ">" || next === " ") {
        return false; // \< \> are word boundaries in Rust
      }
      continue;
    }
    if (inClass) {
      if (ch === "]") inClass = false;
      // Nested classes, POSIX classes and set operators exist only in Rust.
      else if (ch === "[") return false;
      else if (
        (ch === "&" || ch === "-" || ch === "~") && p[i + 1] === ch
      ) return false;
      continue;
    }
    if (ch === "[") {
      inClass = true;
      if (p[i + 1] === "^") i++;
      // []] is an empty class then "]" in JS, a class holding "]" in Rust.
      if (p[i + 1] === "]") return false;
    } else if (ch === "(") {
      // (?: only. (?i) (?P<…>) are Rust's; look-around is JS's.
      if (p[i + 1] === "?" && p[i + 2] !== ":") return false;
    } else if (ch === "{") {
      // JS reads a brace that is not a quantifier as a literal.
      if (!QUANTIFIER_RE.test(p.slice(i, i + 24))) return false;
    }
  }
  return !inClass;
}

/** Bumped by every build; the module holds only the newest pattern set. */
let uaGeneration = 0;

/** Hand `patterns` to the module. Returns the indexes it refused, or null. */
function installPatterns(
  w: HotpathExports,
  patterns: string[],
): number[] | null {
  const text = encoder.encode(patterns.join("\n"));
  const textPtr = w.alloc(text.length);
  const rejCap = patterns.length;
  const rejPtr = w.alloc(rejCap * 4);
  try {
    memory(w).set(text, textPtr);
    const n = w.ua_set(textPtr, text.length, rejPtr, rejCap);
    if (n < 0) return null;
    const m = memory(w);
    const view = new DataView(m.buffer, rejPtr, rejCap * 4);
    const rejected: number[] = [];
    for (let i = 0; i < n; i++) rejected.push(view.getUint32(i * 4, true));
    return rejected;
  } finally {
    w.dealloc(textPtr, text.length);
    w.dealloc(rejPtr, rejCap * 4);
  }
}

/**
 * Build a matcher for a list of RegExp sources: `test(ua)` answers what
 * `new RegExp("(?:" + patterns.join("|") + ")", "i").test(ua)` answers.
 * Throws a SyntaxError, as that constructor does, if a pattern is invalid.
 *
 * Compiling takes a while for a large list (about a tenth of a second for
 * the crawler feed) and runs on the calling thread.
 *
 * Only the most recently built matcher uses the module; an older one keeps
 * working, through its RegExp.
 */
export function buildUaMatcher(patterns: string[]): UaMatcher {
  if (patterns.length === 0) {
    return { test: () => false, nativePatterns: 0, jsPatterns: 0 };
  }
  const full = new RegExp(`(?:${patterns.join("|")})`, "i");
  const jsOnly: UaMatcher = {
    test: (ua) => full.test(ua),
    nativePatterns: 0,
    jsPatterns: patterns.length,
  };
  const w = wasm;
  if (!w || patterns.some(hasBackreference)) return jsOnly;

  const safe: string[] = [];
  const rest: string[] = [];
  for (const p of patterns) (isRustSafe(p) ? safe : rest).push(p);
  if (safe.length === 0) return jsOnly;

  let rejected: number[] | null;
  try {
    rejected = installPatterns(w, safe);
  } catch {
    rejected = null;
  }
  const generation = ++uaGeneration;
  if (rejected === null) return jsOnly;
  const refused = new Set(rejected);
  for (const i of refused) rest.push(safe[i]);
  const nativePatterns = safe.length - refused.size;
  if (nativePatterns === 0) return jsOnly;

  const residual = rest.length > 0
    ? new RegExp(`(?:${rest.join("|")})`, "i")
    : null;
  const uaPtr = scratch + KEY_CAP + TAG_LEN;

  return {
    nativePatterns,
    jsPatterns: rest.length,
    test(ua: string): boolean {
      const len = ua.length;
      if (generation !== uaGeneration || len > UA_CAP) return full.test(ua);
      const m = memory(w);
      for (let i = 0; i < len; i++) {
        const code = ua.charCodeAt(i);
        // Outside printable ASCII the engines differ (case folding, what a
        // dot or \s matches): JS answers, as it always did.
        if (code < 0x20 || code > 0x7e) return full.test(ua);
        m[uaPtr + i] = code;
      }
      try {
        const found = w.ua_match(uaPtr, len);
        if (found === 1) return true;
        if (found !== 0) return full.test(ua); // search not completed
      } catch {
        // A trap in the module must not fail the request.
        return full.test(ua);
      }
      return residual !== null && residual.test(ua);
    },
  };
}
