// Echelon Analytics — Client IP Extraction
//
// Shared utility for extracting the real client IP from a request.
// Only trusts proxy/Cloudflare headers when explicitly configured.

import {
  BEHIND_CLOUDFLARE,
  TRUST_PROXY,
  TRUSTED_PROXY_HOPS,
} from "./config.ts";

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
  /** Trusted proxies in front of us; 1 when omitted. */
  proxyHops?: number;
}

/**
 * The client's entry in an X-Forwarded-For value, given `hops` trusted
 * proxies. Each proxy appends the address that connected to it, so the entry
 * `hops` from the right is the one the outermost trusted proxy wrote. Entries
 * further left came from the client and are not evidence of anything: with
 * nginx's `$proxy_add_x_forwarded_for`, a client that sends
 * `X-Forwarded-For: 8.8.8.8` arrives as `8.8.8.8, <its real address>`.
 * A shorter list than `hops` (a proxy that replaces the header) yields its
 * leftmost entry.
 */
export function forwardedClient(xff: string, hops = 1): string {
  const parts = xff.split(",");
  const idx = Math.max(0, parts.length - Math.max(1, hops));
  return parts[idx].trim();
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
    if (xff) {
      const ip = forwardedClient(xff, flags.proxyHops ?? 1);
      if (ip) return { ip, untrustedProxy: false };
    }

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
  proxyHops: TRUSTED_PROXY_HOPS,
};

/**
 * The address as a network: an IPv4 address as it is, an IPv6 address cut to
 * its /64. One subscriber is routed a whole /64 and can source a request from
 * any of its 2^64 addresses, so anything that counts or limits "addresses"
 * (the rate limiter, the burst and bot-address maps, the correlator's
 * distinct-address count) must count the /64 once. IPv4-mapped IPv6
 * (::ffff:a.b.c.d) is its IPv4 address.
 */
export function networkKey(ip: string): string {
  if (!ip.includes(":")) return ip;
  let addr = ip.toLowerCase();
  const zone = addr.indexOf("%");
  if (zone >= 0) addr = addr.slice(0, zone);
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(addr);
  if (mapped) return mapped[1];
  const halves = addr.split("::");
  if (halves.length > 2) return ip;
  const head = halves[0] ? halves[0].split(":") : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  // A trailing dotted quad stands for two groups.
  const tailGroups = tail.length +
    (tail.length > 0 && tail[tail.length - 1].includes(".") ? 1 : 0);
  let groups: string[];
  if (halves.length === 2) {
    const fill = 8 - head.length - tailGroups;
    if (fill < 0) return ip;
    groups = [...head, ...Array(fill).fill("0"), ...tail];
  } else {
    groups = head;
    if (groups.length !== 8) return ip;
  }
  const first = groups.slice(0, 4);
  if (first.some((g) => !/^[0-9a-f]{1,4}$/.test(g))) return ip;
  return first.map((g) => g.replace(/^0+(?=.)/, "")).join(":") + "::/64";
}

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
