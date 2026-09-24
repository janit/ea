// Echelon Analytics — Client IP Extraction
//
// Shared utility for extracting the real client IP from a request.
// Only trusts proxy/Cloudflare headers when explicitly configured.

import { BEHIND_CLOUDFLARE, TRUST_PROXY } from "./config.ts";

let warnedProxy = false;

const peerAddrs = new WeakMap<Request, string>();

/** Record the connection's peer address for `req` (from Fresh's `ctx.info`). */
export function setPeerAddr(req: Request, info: Deno.ServeHandlerInfo): void {
  const addr = info.remoteAddr;
  if (addr.transport === "tcp" || addr.transport === "udp") {
    peerAddrs.set(req, addr.hostname);
  }
}

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

  // Fallback: the TCP peer. A Request carries no connection info — Deno hands
  // it to the handler separately — so the root middleware records it here.
  // Standalone this is the real client; behind an untrusted proxy it is the
  // proxy (the warning above covers that case).
  const peer = peerAddrs.get(req);
  if (peer) return peer;

  return "unknown";
}
