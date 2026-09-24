// Echelon Analytics — Runtime WASM Challenge Generator
//
// Builds a WASM binary with randomized constants from a seed.
// Each deployment generates unique WASM blobs that rotate every 6 hours.
// The algorithm structure is public (SipHash-inspired), but the specific
// constants change, making cross-deployment bot toolkits impractical.
//
// WASM exports:
//   memory  (1 page = 64KB)
//   solve(input_ptr: i32, input_len: i32, output_ptr: i32): void

// ── LEB128 encoding ──────────────────────────────────────────────────────────

function leb128u(v: number): number[] {
  const r: number[] = [];
  do {
    let b = v & 0x7f;
    v >>>= 7;
    if (v) b |= 0x80;
    r.push(b);
  } while (v);
  return r;
}

function leb128s(v: number): number[] {
  const r: number[] = [];
  let more = true;
  while (more) {
    let b = v & 0x7f;
    v >>= 7;
    if ((v === 0 && (b & 0x40) === 0) || (v === -1 && (b & 0x40) !== 0)) {
      more = false;
    } else {
      b |= 0x80;
    }
    r.push(b);
  }
  return r;
}

function leb128s64(v: bigint): number[] {
  const r: number[] = [];
  let more = true;
  while (more) {
    let b = Number(v & 0x7fn);
    v >>= 7n;
    if ((v === 0n && (b & 0x40) === 0) || (v === -1n && (b & 0x40) !== 0)) {
      more = false;
    } else {
      b |= 0x80;
    }
    r.push(b);
  }
  return r;
}

// ── WASM bytecode builder ────────────────────────────────────────────────────

class W {
  buf: number[] = [];
  block_void() {
    this.buf.push(0x02, 0x40);
  }
  loop_void() {
    this.buf.push(0x03, 0x40);
  }
  end() {
    this.buf.push(0x0b);
  }
  br(d: number) {
    this.buf.push(0x0c, ...leb128u(d));
  }
  br_if(d: number) {
    this.buf.push(0x0d, ...leb128u(d));
  }
  local_get(i: number) {
    this.buf.push(0x20, ...leb128u(i));
  }
  local_set(i: number) {
    this.buf.push(0x21, ...leb128u(i));
  }
  i32_const(v: number) {
    this.buf.push(0x41, ...leb128s(v));
  }
  i32_add() {
    this.buf.push(0x6a);
  }
  i32_sub() {
    this.buf.push(0x6b);
  }
  i32_shl() {
    this.buf.push(0x74);
  }
  i32_lt_u() {
    this.buf.push(0x49);
  }
  i32_ge_u() {
    this.buf.push(0x4e);
  }
  i64_const(v: bigint) {
    // Ensure values with bit 63 set are encoded as negative (two's complement)
    if (v > 0x7fffffffffffffffn) v -= 0x10000000000000000n;
    this.buf.push(0x42, ...leb128s64(v));
  }
  i64_add() {
    this.buf.push(0x7c);
  }
  i64_xor() {
    this.buf.push(0x85);
  }
  i64_or() {
    this.buf.push(0x84);
  }
  i64_shl() {
    this.buf.push(0x86);
  }
  i64_rotl() {
    this.buf.push(0x89);
  }
  i64_and() {
    this.buf.push(0x83);
  }
  i64_extend_i32_u() {
    this.buf.push(0xad);
  }
  i64_load() {
    this.buf.push(0x29, 0, 0);
  }
  i64_store() {
    this.buf.push(0x37, 0, 0);
  }
  i32_load8_u() {
    this.buf.push(0x2d, 0, 0);
  }
}

// ── Challenge parameters ─────────────────────────────────────────────────────

export interface ChallengeParams {
  /** 4 magic constants for state initialization */
  magic: [bigint, bigint, bigint, bigint];
  /** Rotation amounts: [r1, r2, r3, r4, r5] used in sipRound */
  rotations: [number, number, number, number, number];
}

/** Generate random challenge parameters from a seed. */
export function generateParams(seed: Uint8Array): ChallengeParams {
  // Use the seed to derive deterministic but random-looking parameters
  // Simple approach: hash the seed to get enough bytes
  const magic: bigint[] = [];
  const view = new DataView(seed.buffer, seed.byteOffset, seed.byteLength);

  // We need 4 × 8 bytes for magic + 5 bytes for rotations = 37 bytes
  // Seed should be at least 37 bytes (we'll use 64)
  for (let i = 0; i < 4; i++) {
    magic.push(view.getBigUint64(i * 8, true));
  }

  // Rotation amounts: valid range 1-63, avoid extremes (use 7-53)
  const rots: number[] = [];
  for (let i = 0; i < 5; i++) {
    rots.push(7 + (seed[32 + i] % 47)); // Range: 7-53
  }

  return {
    magic: magic as [bigint, bigint, bigint, bigint],
    rotations: rots as [number, number, number, number, number],
  };
}

// ── WASM module construction ─────────────────────────────────────────────────

function buildSolve(p: ChallengeParams): number[] {
  const w = new W();
  const [m0, m1, m2, m3] = p.magic;
  const [r1, r2, r3, r4, r5] = p.rotations;

  // params: 0=input_ptr, 1=input_len, 2=output_ptr
  // locals: 3=v0, 4=v1, 5=v2, 6=v3, 7=block (i64), 8=i, 9=j (i32)
  function sipRound() {
    w.local_get(3);
    w.local_get(4);
    w.i64_add();
    w.local_set(3);
    w.local_get(4);
    w.i64_const(BigInt(r1));
    w.i64_rotl();
    w.local_get(3);
    w.i64_xor();
    w.local_set(4);
    w.local_get(3);
    w.i64_const(32n);
    w.i64_rotl();
    w.local_set(3);
    w.local_get(5);
    w.local_get(6);
    w.i64_add();
    w.local_set(5);
    w.local_get(6);
    w.i64_const(BigInt(r2));
    w.i64_rotl();
    w.local_get(5);
    w.i64_xor();
    w.local_set(6);
    w.local_get(3);
    w.local_get(6);
    w.i64_add();
    w.local_set(3);
    w.local_get(6);
    w.i64_const(BigInt(r3));
    w.i64_rotl();
    w.local_get(3);
    w.i64_xor();
    w.local_set(6);
    w.local_get(5);
    w.local_get(4);
    w.i64_add();
    w.local_set(5);
    w.local_get(4);
    w.i64_const(BigInt(r4));
    w.i64_rotl();
    w.local_get(5);
    w.i64_xor();
    w.local_set(4);
    w.local_get(5);
    w.i64_const(BigInt(r5));
    w.i64_rotl();
    w.local_set(5);
  }

  // Init state
  w.i64_const(m0);
  w.local_set(3);
  w.i64_const(m1);
  w.local_set(4);
  w.i64_const(m2);
  w.local_set(5);
  w.i64_const(m3);
  w.local_set(6);

  // i = 0
  w.i32_const(0);
  w.local_set(8);

  // Absorb full 8-byte blocks
  w.block_void();
  w.loop_void();
  w.local_get(1);
  w.local_get(8);
  w.i32_const(8);
  w.i32_add();
  w.i32_lt_u();
  w.br_if(1);
  w.local_get(0);
  w.local_get(8);
  w.i32_add();
  w.i64_load();
  w.local_set(7);
  w.local_get(6);
  w.local_get(7);
  w.i64_xor();
  w.local_set(6);
  sipRound();
  sipRound();
  w.local_get(3);
  w.local_get(7);
  w.i64_xor();
  w.local_set(3);
  w.local_get(8);
  w.i32_const(8);
  w.i32_add();
  w.local_set(8);
  w.br(0);
  w.end();
  w.end();

  // Remaining bytes: block = (len & 0xff) << 56
  w.local_get(1);
  w.i64_extend_i32_u();
  w.i64_const(0xffn);
  w.i64_and();
  w.i64_const(56n);
  w.i64_shl();
  w.local_set(7);

  w.local_get(8);
  w.local_set(9); // j = i
  w.block_void();
  w.loop_void();
  w.local_get(9);
  w.local_get(1);
  w.i32_ge_u();
  w.br_if(1);
  w.local_get(7);
  w.local_get(0);
  w.local_get(9);
  w.i32_add();
  w.i32_load8_u();
  w.i64_extend_i32_u();
  w.local_get(9);
  w.local_get(8);
  w.i32_sub();
  w.i32_const(3);
  w.i32_shl();
  w.i64_extend_i32_u();
  w.i64_shl();
  w.i64_or();
  w.local_set(7);
  w.local_get(9);
  w.i32_const(1);
  w.i32_add();
  w.local_set(9);
  w.br(0);
  w.end();
  w.end();

  // Absorb final block
  w.local_get(6);
  w.local_get(7);
  w.i64_xor();
  w.local_set(6);
  sipRound();
  sipRound();
  w.local_get(3);
  w.local_get(7);
  w.i64_xor();
  w.local_set(3);

  // Finalize: v2 ^= 0xff, 4 rounds
  w.local_get(5);
  w.i64_const(0xffn);
  w.i64_xor();
  w.local_set(5);
  sipRound();
  sipRound();
  sipRound();
  sipRound();

  // Output: v0^v1 at out[0], v2^v3 at out[8]
  w.local_get(2);
  w.local_get(3);
  w.local_get(4);
  w.i64_xor();
  w.i64_store();
  w.local_get(2);
  w.i32_const(8);
  w.i32_add();
  w.local_get(5);
  w.local_get(6);
  w.i64_xor();
  w.i64_store();

  w.end();

  const locals = [3, 5, 0x7e, 1, 0x7f, 1, 0x7f]; // 5 i64, 1 i32, 1 i32
  return [...locals, ...w.buf];
}

function section(id: number, content: number[]): number[] {
  return [id, ...leb128u(content.length), ...content];
}

/** Build a complete WASM module from challenge parameters. */
export function buildChallengeWasm(
  params: ChallengeParams,
): Uint8Array<ArrayBuffer> {
  const out: number[] = [0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00];

  out.push(...section(1, [1, 0x60, 3, 0x7f, 0x7f, 0x7f, 0]));
  out.push(...section(3, [1, 0]));
  out.push(...section(5, [1, 0x00, 1]));

  const enc = new TextEncoder();
  const memName = enc.encode("memory");
  const solveName = enc.encode("solve");
  const exports = [
    2,
    ...leb128u(memName.length),
    ...memName,
    0x02,
    0,
    ...leb128u(solveName.length),
    ...solveName,
    0x00,
    0,
  ];
  out.push(...section(7, exports));

  const body = buildSolve(params);
  out.push(...section(10, [1, ...leb128u(body.length), ...body]));

  return new Uint8Array(out);
}
