import { assertEquals, assertMatch } from "@std/assert";
import {
  generateChallenge,
  getWasmBase64,
  getWasmGeneration,
  tokenPenalty,
  verifyToken,
} from "@/lib/challenge.ts";

// ── tokenPenalty ────────────────────────────────────────────────────────────

Deno.test("tokenPenalty — valid → 0", () => {
  assertEquals(tokenPenalty("valid"), 0);
});

Deno.test("tokenPenalty — missing → 30", () => {
  assertEquals(tokenPenalty("missing"), 30);
});

Deno.test("tokenPenalty — invalid → 40", () => {
  assertEquals(tokenPenalty("invalid"), 40);
});

// ── generateChallenge ───────────────────────────────────────────────────────

Deno.test("generateChallenge — returns 32-char hex string", async () => {
  const challenge = await generateChallenge();
  assertEquals(challenge.length, 32);
  assertMatch(challenge, /^[0-9a-f]{32}$/);
});

Deno.test("generateChallenge — same minute produces same challenge", async () => {
  const a = await generateChallenge();
  const b = await generateChallenge();
  assertEquals(a, b);
});

// ── getWasmBase64 / getWasmGeneration ───────────────────────────────────────

Deno.test("getWasmBase64 — returns non-empty base64 string", async () => {
  const wasm = await getWasmBase64();
  assertEquals(typeof wasm, "string");
  assertEquals(wasm.length > 0, true);
  // Should be valid base64 (decodable)
  const decoded = atob(wasm);
  assertEquals(decoded.length > 0, true);
});

Deno.test("getWasmGeneration — returns timestamp string", async () => {
  const gen = await getWasmGeneration();
  assertEquals(typeof gen, "string");
  const ts = parseInt(gen, 10);
  assertEquals(isNaN(ts), false);
  assertEquals(ts > 0, true);
});

// ── verifyToken ─────────────────────────────────────────────────────────────

Deno.test("verifyToken — null token → 'missing'", async () => {
  const result = await verifyToken(null, "test-site", "session-1");
  assertEquals(result, "missing");
});

Deno.test("verifyToken — malformed token → 'invalid'", async () => {
  const result = await verifyToken("not-hex", "test-site", "session-1");
  assertEquals(result, "invalid");
});

Deno.test("verifyToken — wrong-length hex → 'invalid'", async () => {
  const result = await verifyToken("abcdef", "test-site", "session-1");
  assertEquals(result, "invalid");
});

Deno.test("verifyToken — random valid-format hex → 'invalid'", async () => {
  const fakeToken = "0".repeat(32);
  const result = await verifyToken(fakeToken, "test-site", "session-1");
  assertEquals(result, "invalid");
});
