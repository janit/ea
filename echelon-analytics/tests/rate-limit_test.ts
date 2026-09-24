import { assertEquals } from "@std/assert";
import { isRateLimited } from "@/lib/rate-limit.ts";
import { getClientIp, setPeerAddr } from "@/lib/ip.ts";
import { RATE_LIMIT_MAX } from "@/lib/config.ts";

function makeRequest(ip: string): Request {
  const req = new Request("https://analytics.example.com/b.gif");
  setPeerAddr(req, {
    remoteAddr: { transport: "tcp", hostname: ip, port: 40000 },
  } as Deno.ServeHandlerInfo);
  return req;
}

Deno.test("getClientIp — falls back to the recorded peer address", () => {
  assertEquals(getClientIp(makeRequest("203.0.113.7")), "203.0.113.7");
});

Deno.test("getClientIp — real Deno.serve connection resolves to the peer, not 'unknown'", async () => {
  const ac = new AbortController();
  const server = Deno.serve(
    { port: 0, signal: ac.signal, onListen() {} },
    (req, info) => {
      setPeerAddr(req, info);
      return new Response(getClientIp(req));
    },
  );
  try {
    const res = await fetch(`http://127.0.0.1:${server.addr.port}/`);
    assertEquals(await res.text(), "127.0.0.1");
  } finally {
    ac.abort();
    await server.finished;
  }
});

Deno.test("isRateLimited — allows RATE_LIMIT_MAX requests, then drops", () => {
  const ip = "198.51.100.1";
  for (let i = 0; i < RATE_LIMIT_MAX; i++) {
    assertEquals(isRateLimited(makeRequest(ip)), false, `request ${i + 1}`);
  }
  assertEquals(isRateLimited(makeRequest(ip)), true);
});

Deno.test("isRateLimited — clients have separate buckets", () => {
  const noisy = "198.51.100.2";
  for (let i = 0; i <= RATE_LIMIT_MAX; i++) isRateLimited(makeRequest(noisy));
  assertEquals(isRateLimited(makeRequest(noisy)), true);
  assertEquals(isRateLimited(makeRequest("198.51.100.3")), false);
});
