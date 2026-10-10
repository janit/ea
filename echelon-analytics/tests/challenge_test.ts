import { assertEquals, assertMatch } from "@std/assert";
import { BOT_THRESHOLD } from "@/lib/bot-threshold.ts";
import { buildChallengeWasm, generateParams } from "@/lib/challenge-wasm.ts";
import {
  generateChallenge,
  getWasmBase64,
  getWasmGeneration,
  rotationBucket,
  slotSeed,
  tokenPenalty,
  verifyToken,
} from "@/lib/challenge.ts";

// ── tokenPenalty ────────────────────────────────────────────────────────────

Deno.test("tokenPenalty — valid → 0 on both surfaces", () => {
  assertEquals(tokenPenalty("valid", "beacon"), 0);
  assertEquals(tokenPenalty("valid", "events"), 0);
});

Deno.test("tokenPenalty — missing → 30 on both surfaces", () => {
  assertEquals(tokenPenalty("missing", "beacon"), 30);
  assertEquals(tokenPenalty("missing", "events"), 30);
});

Deno.test("tokenPenalty — invalid is decisive on the beacon, under the gate on events", () => {
  assertEquals(tokenPenalty("invalid", "beacon"), BOT_THRESHOLD);
  assertEquals(tokenPenalty("invalid", "events"), 40);
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

// ── WASM rotation ───────────────────────────────────────────────────────────

const SIX_HOURS = 6 * 60 * 60 * 1000;

Deno.test("rotationBucket — flips on the 6-hour calendar boundary", () => {
  assertEquals(rotationBucket(0), 0);
  assertEquals(rotationBucket(SIX_HOURS - 1), 0);
  assertEquals(rotationBucket(SIX_HOURS), 1);
  assertEquals(rotationBucket(SIX_HOURS * 7 + 5), 7);
});

Deno.test("slotSeed — seed is stable for one secret and bucket", async () => {
  const a = await slotSeed("s3cret", 42);
  const b = await slotSeed("s3cret", 42);
  assertEquals(a.length, 64);
  assertEquals(Array.from(a), Array.from(b));
});

Deno.test("slotSeed — differs across buckets and across secrets", async () => {
  const base = Array.from(await slotSeed("s3cret", 42));
  assertEquals(
    Array.from(await slotSeed("s3cret", 43)).join() === base.join(),
    false,
  );
  assertEquals(
    Array.from(await slotSeed("other", 42)).join() === base.join(),
    false,
  );
});

Deno.test("slotSeed — the two halves are derived independently", async () => {
  const seed = await slotSeed("s3cret", 42);
  assertEquals(
    Array.from(seed.slice(0, 32)).join() === Array.from(seed.slice(32)).join(),
    false,
  );
});

Deno.test("slotSeed — random when no secret is configured", async () => {
  const a = await slotSeed("", 42);
  const b = await slotSeed("", 42);
  assertEquals(a.length, 64);
  assertEquals(Array.from(a).join() === Array.from(b).join(), false);
});

Deno.test("WASM build — byte-identical for one seed, differs across buckets", async () => {
  const build = async (bucket: number) =>
    Array.from(
      buildChallengeWasm(generateParams(await slotSeed("s3cret", bucket))),
    ).join();
  assertEquals(await build(42), await build(42));
  assertEquals((await build(42)) === (await build(43)), false);
});

const CHILD_SCRIPT = `
import { getWasmBase64, rotationBucket } from ${
  JSON.stringify(new URL("../lib/challenge.ts", import.meta.url).href)
};
const b = rotationBucket();
const w = await getWasmBase64();
console.log(JSON.stringify({ b, w }));
`;

async function childBlob(
  secret: string,
): Promise<{ b: number; w: string }> {
  const out = await new Deno.Command(Deno.execPath(), {
    args: ["eval", "--no-check", "--ext=ts", CHILD_SCRIPT],
    env: { ECHELON_SECRET: secret },
    stdout: "piped",
    stderr: "piped", // captured, not inherited: the child logs startup warnings
  }).output();
  if (!out.success) {
    throw new Error(new TextDecoder().decode(out.stderr));
  }
  return JSON.parse(new TextDecoder().decode(out.stdout).trim());
}

Deno.test("WASM rotation — a restart with the same secret reproduces the solver", async () => {
  let a, b, c;
  for (let attempt = 0; attempt < 2; attempt++) {
    a = await childBlob("restart-secret");
    b = await childBlob("restart-secret");
    c = await childBlob("other-secret");
    // Retry once if a rotation boundary fell between the children.
    if (a.b === b.b && a.b === c.b) break;
  }
  assertEquals(a!.b, b!.b, "rotation boundary crossed twice in a row");
  assertEquals(a!.w.length > 0, true);
  assertEquals(a!.w, b!.w);
  assertEquals(a!.w === c!.w, false);
});
