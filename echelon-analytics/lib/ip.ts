// Echelon Analytics — Client IP Extraction
//
// Shared utility for extracting the real client IP from a request.
// Only trusts proxy/Cloudflare headers when explicitly configured.

import { BEHIND_CLOUDFLARE, TRUST_PROXY } from "./config.ts";

let warnedProxy = false;

/**
 * Extract the real client IP from a request, respecting proxy trust settings.
 * Returns "unknown" when no trusted source is available.
 */
export function getClientIp(req: Request): string {
  // Cloudflare cf-connecting-ip — only when explicitly behind CF
  if (BEHIND_CLOUDFLARE) {
    const cfIp = req.headers.get("cf-connecting-ip");
    if (cfIp) return cfIp.trim();
  }

  // Diagnose the misconfiguration that silently collapses every client into a
  // single bucket: a proxy is forwarding, but we are not configured to trust
  // it, so every request resolves to the proxy's address. That makes the login
  // limiter instance-wide (5 anonymous failures lock out the administrator)
  // and the tracking limiter instance-wide too. Warn once — it is invisible
  // otherwise, and the shipped Caddyfile puts a proxy in front by default.
  if (!TRUST_PROXY && !warnedProxy && req.headers.get("x-forwarded-for")) {
    warnedProxy = true;
    console.warn(
      "[echelon] WARNING: X-Forwarded-For seen but ECHELON_TRUST_PROXY is not set. " +
        "All clients will share one rate-limit bucket. Set ECHELON_TRUST_PROXY=true " +
        "if a reverse proxy is in front of this instance.",
    );
  }

  // Proxy headers — only when behind a trusted reverse proxy
  if (TRUST_PROXY) {
    const xff = req.headers.get("x-forwarded-for");
    if (xff) return xff.split(",")[0].trim();

    const realIp = req.headers.get("x-real-ip");
    if (realIp) return realIp.trim();
  }

  // Fallback: Deno.serve provides remote address via the request's connection info.
  // When running standalone (no proxy), this is the actual client IP.
  // In proxy setups without TRUST_PROXY, this returns the proxy IP — still useful
  // for per-connection rate limiting rather than collapsing all traffic into "unknown".
  try {
    // @ts-ignore: Deno-specific — remoteAddr attached by Deno.serve
    const addr =
      (req as unknown as { remoteAddr?: { hostname?: string } }).remoteAddr;
    if (addr?.hostname) return addr.hostname;
  } catch { /* not available */ }

  return "unknown";
}
