// Echelon Analytics — Password Hashing (PBKDF2 via WebCrypto)
//
// Format: pbkdf2$<iterations>$<base64-salt>$<base64-hash>
// Zero external dependencies — uses Web Crypto API only.

const ITERATIONS = 600_000;
const KEY_LENGTH = 32; // 256 bits
const SALT_LENGTH = 16; // 128 bits

function toBase64(buf: ArrayBuffer): string {
  return btoa(String.fromCharCode(...new Uint8Array(buf)));
}

function fromBase64(s: string): Uint8Array {
  const bin = atob(s);
  const buf = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
  return buf;
}

async function deriveKey(
  password: string,
  salt: Uint8Array,
  iterations: number,
): Promise<ArrayBuffer> {
  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(password),
    "PBKDF2",
    false,
    ["deriveBits"],
  );
  return crypto.subtle.deriveBits(
    { name: "PBKDF2", salt, iterations, hash: "SHA-256" },
    keyMaterial,
    KEY_LENGTH * 8,
  );
}

/** Hash a password for storage. Returns `pbkdf2$600000$<salt>$<hash>`. */
export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(SALT_LENGTH));
  const hash = await deriveKey(password, salt, ITERATIONS);
  return `pbkdf2$${ITERATIONS}$${toBase64(salt)}$${toBase64(hash)}`;
}

/** Verify a password against a stored hash. */
export async function verifyPassword(
  password: string,
  stored: string,
): Promise<boolean> {
  const parts = stored.split("$");
  if (parts.length !== 4 || parts[0] !== "pbkdf2") return false;

  const iterations = parseInt(parts[1], 10);
  if (!iterations || iterations < 1 || iterations > 10_000_000) return false;

  // A malformed (non-base64) stored hash must reject cleanly, not throw —
  // otherwise an operator typo in ECHELON_PASSWORD_HASH 500s every login.
  let salt: Uint8Array;
  let expected: Uint8Array;
  try {
    salt = fromBase64(parts[2]);
    expected = fromBase64(parts[3]);
  } catch {
    return false;
  }
  if (salt.byteLength === 0 || expected.byteLength === 0) return false;
  const actual = new Uint8Array(await deriveKey(password, salt, iterations));

  if (expected.byteLength !== actual.byteLength) return false;
  const subtle = crypto.subtle as unknown as {
    timingSafeEqual?(a: BufferSource, b: BufferSource): boolean;
  };
  if (typeof subtle.timingSafeEqual === "function") {
    return subtle.timingSafeEqual(expected, actual);
  }
  let diff = 0;
  for (let i = 0; i < expected.byteLength; i++) {
    diff |= expected[i] ^ actual[i];
  }
  return diff === 0;
}
