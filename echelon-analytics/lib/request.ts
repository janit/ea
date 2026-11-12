// Shared request-parsing helpers.
//
// These exist because every handler previously re-implemented body parsing and
// param decoding, and each copy independently missed the same edge cases:
// `null` is valid JSON but not an object, and `decodeURIComponent` throws on
// malformed percent-escapes. Route handlers must not construct these by hand.

/**
 * Parse a JSON request body that is required to be a plain object.
 *
 * Returns null for malformed JSON, and also for valid JSON that is not a plain
 * object (`null`, arrays, primitives) — callers destructure or property-access
 * the result, which throws on any of those.
 */
export async function readJsonObject(
  req: Request,
): Promise<Record<string, unknown> | null> {
  try {
    const body = await req.json();
    if (body === null || typeof body !== "object" || Array.isArray(body)) {
      return null;
    }
    return body as Record<string, unknown>;
  } catch {
    return null;
  }
}

/**
 * Parse a JSON request body that is required to be an array.
 * Returns null for malformed JSON or any non-array value.
 */
export async function readJsonArray(req: Request): Promise<unknown[] | null> {
  try {
    const body = await req.json();
    return Array.isArray(body) ? body : null;
  } catch {
    return null;
  }
}

/**
 * True if `value` is a plain object — the guard needed before reading
 * properties off elements of a caller-supplied array.
 */
export function isPlainObject(
  value: unknown,
): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * Normalize a route parameter.
 *
 * Fresh's router already applies `decodeURI()` to path groups before a handler
 * sees them, so handlers must NOT decode again: `decodeURIComponent` on an
 * already-decoded value collapses distinct URLs onto one ID (`a%252Fb` and
 * `a%2Fb` both became `a/b`) and throws URIError on leftover stray `%`.
 *
 * IDs in this codebase are hex hashes or `[a-zA-Z0-9._-]`, so a literal `%2F`
 * left undecoded simply fails to match a record — which is the correct answer.
 *
 * Returns null when the value cannot be a valid ID, letting callers answer 400
 * or 404 rather than propagating a throw.
 *
 * Note: a malformed escape in the *path* (`/api/sites/%`) still yields a 500 —
 * Fresh throws inside `UrlPatternRouter.match()`, upstream of all middleware
 * and of `app.onError`, so it cannot be handled here.
 */
export function decodeParam(raw: string): string | null {
  // Reject stray escapes rather than guessing at intent.
  return /%(?![0-9a-fA-F]{2})/.test(raw) ? null : raw;
}

/**
 * Escape a user search term for `LIKE ? ESCAPE '\'` so it matches literally.
 * The escape character itself must be escaped first: escaping only % and _
 * turned a typed `\%` into `\\%` — a literal backslash followed by a live
 * wildcard.
 */
export function escapeLike(term: string): string {
  return term.replace(/[\\%_]/g, "\\$&");
}

/**
 * Read a request body of at most `maxBytes`, or null if it is larger. The
 * declared Content-Length is checked first and the stream is cut off at the
 * cap, so a body with no or a false length is never buffered whole.
 */
export async function readBytesCapped(
  req: Request,
  maxBytes: number,
): Promise<Uint8Array<ArrayBuffer> | null> {
  const declared = parseInt(req.headers.get("content-length") ?? "0", 10);
  if (declared > maxBytes) return null;
  if (!req.body) return new Uint8Array(0);
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        return null;
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.byteLength;
  }
  return out;
}

/**
 * Parse a form body (urlencoded or multipart) of at most `maxBytes`.
 * Returns "too_large" over the cap and null if it does not parse.
 * `req.formData()` on its own buffers whatever is sent.
 */
export async function readFormCapped(
  req: Request,
  maxBytes: number,
): Promise<FormData | "too_large" | null> {
  const bytes = await readBytesCapped(req, maxBytes);
  if (bytes === null) return "too_large";
  try {
    return await new Response(bytes, {
      headers: { "content-type": req.headers.get("content-type") ?? "" },
    }).formData();
  } catch {
    return null;
  }
}
