// CSRF origin validation.
//
// This check previously existed as four hand-copies — both middlewares plus
// two test files re-implementing it. None was the source of truth, and the one
// place that needed it most (POST /admin/login, whitelisted ahead of both
// middlewares) never got a copy at all.

const MUTATING_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/** True if this method mutates state and therefore needs an origin check. */
export function isMutatingMethod(method: string): boolean {
  return MUTATING_METHODS.has(method);
}

/**
 * Validate a mutating request's Origin (or Referer) against its Host.
 *
 * Compares origin *host* against the Host header rather than the full origin:
 * that works behind any reverse proxy without needing x-forwarded-proto, since
 * a protocol mismatch (http internally, https externally) does not affect the
 * host comparison. It assumes the proxy preserves the external Host header
 * (Caddy and nginx do by default); a proxy that rewrites Host to an internal
 * name would reject legitimate same-origin requests rather than open a bypass.
 *
 * Returns true for non-mutating methods, which need no check.
 */
export function checkCsrf(req: Request, fallbackHost: string): boolean {
  if (!isMutatingMethod(req.method)) return true;

  const requestHost = req.headers.get("host") || fallbackHost;
  // `||` not `??`: an empty Origin header must fall through to Referer, which
  // is what the original inline checks did.
  const source = req.headers.get("origin") || req.headers.get("referer");
  if (!source) return false;

  try {
    return new URL(source).host === requestHost;
  } catch {
    return false;
  }
}
