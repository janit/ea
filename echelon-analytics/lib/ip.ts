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

export interface IpFlags {
  behindCloudflare: boolean;
  trustProxy: boolean;
}

export interface ResolvedAddr {
  ip: string;
  /** A proxy is forwarding but is not trusted: `ip` is the proxy, not the client. */
  untrustedProxy: boolean;
}

/**
 * The one place the client address is resolved, so getClientIp and
 * hasUnresolvedClientAddr cannot drift apart.
 */
export function resolveClientAddr(
  req: Request,
  flags: IpFlags,
  peer: string | undefined,
): ResolvedAddr {
  // Cloudflare cf-connecting-ip — only when explicitly behind CF
  if (flags.behindCloudflare) {
    const cfIp = req.headers.get("cf-connecting-ip");
    if (cfIp) return { ip: cfIp.trim(), untrustedProxy: false };
  }

  // Proxy headers — only when behind a trusted reverse proxy
  if (flags.trustProxy) {
    const xff = req.headers.get("x-forwarded-for");
    if (xff) return { ip: xff.split(",")[0].trim(), untrustedProxy: false };

    const realIp = req.headers.get("x-real-ip");
    if (realIp) return { ip: realIp.trim(), untrustedProxy: false };
  }

  // A proxy is forwarding, but we are not configured to trust it, so every
  // request resolves to the proxy's address (the TCP peer below).
  const untrustedProxy = !flags.trustProxy &&
    !!req.headers.get("x-forwarded-for");

  // Fallback: the TCP peer. A Request carries no connection info — Deno hands
  // it to the handler separately — so the root middleware records it here.
  // Standalone this is the real client; behind an untrusted proxy it is the
  // proxy.
  return { ip: peer || "unknown", untrustedProxy };
}

const FLAGS: IpFlags = {
  behindCloudflare: BEHIND_CLOUDFLARE,
  trustProxy: TRUST_PROXY,
};

/**
 * Extract the real client IP from a request, respecting proxy trust settings.
 * Returns "unknown" when no trusted source is available.
 */
export function getClientIp(req: Request): string {
  const r = resolveClientAddr(req, FLAGS, peerAddrs.get(req));
  // Diagnose the misconfiguration that silently collapses every client into a
  // single bucket. That makes the login limiter instance-wide (5 anonymous
  // failures lock out the administrator) and the tracking limiter
  // instance-wide too. Warn once — it is invisible otherwise, and the shipped
  // Caddyfile puts a proxy in front by default.
  if (r.untrustedProxy && !warnedProxy) {
    warnedProxy = true;
    console.warn(
      "[echelon] WARNING: X-Forwarded-For seen but ECHELON_TRUST_PROXY is not set. " +
        "All clients will share one rate-limit bucket. Set ECHELON_TRUST_PROXY=true " +
        "if a reverse proxy is in front of this instance.",
    );
  }
  return r.ip;
}

/** Pure form of {@link hasUnresolvedClientAddr}, flags and peer explicit. */
export function isUnresolvedAddr(r: ResolvedAddr): boolean {
  return r.untrustedProxy || r.ip === "unknown";
}

/**
 * True when `getClientIp(req)` did not identify a client: the address fell
 * back to "unknown", or a proxy is forwarding but not trusted, so every client
 * resolves to the proxy. Signals that group requests by address must not fire
 * in either case.
 */
export function hasUnresolvedClientAddr(req: Request): boolean {
  return isUnresolvedAddr(resolveClientAddr(req, FLAGS, peerAddrs.get(req)));
}
