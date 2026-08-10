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
