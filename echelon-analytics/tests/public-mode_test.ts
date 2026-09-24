// PUBLIC_MODE: the real /api auth middleware, loaded with
// ECHELON_PUBLIC_MODE=true, must be read-only for everyone.

import { assertEquals } from "@std/assert";
import { probeApiAuth } from "./_helpers.ts";

const PUBLIC = { ECHELON_PUBLIC_MODE: "true" };

Deno.test("PUBLIC_MODE — safe methods are allowed without auth", async () => {
  const results = await probeApiAuth(PUBLIC, [
    { method: "GET", path: "/api/stats/overview" },
    { method: "HEAD", path: "/api/stats/overview" },
    { method: "OPTIONS", path: "/api/campaigns" },
  ]);
  for (const r of results) {
    assertEquals(r, { status: 200, authenticated: true });
  }
});

Deno.test("PUBLIC_MODE — every mutating method is refused with 403", async () => {
  const results = await probeApiAuth(
    PUBLIC,
    ["POST", "PUT", "PATCH", "DELETE"].map((method) => ({
      method,
      path: "/api/campaigns",
    })),
  );
  for (const r of results) assertEquals(r.status, 403);
});

Deno.test("PUBLIC_MODE — /api/telemetry writes are refused (no self-config exemption)", async () => {
  const [r] = await probeApiAuth(PUBLIC, [
    { method: "POST", path: "/api/telemetry" },
  ]);
  assertEquals(r.status, 403);
});

Deno.test("PUBLIC_MODE — a valid bearer token does not unlock writes", async () => {
  const [r] = await probeApiAuth({ ...PUBLIC, ECHELON_SECRET: "s3cret" }, [
    {
      method: "POST",
      path: "/api/campaigns",
      headers: { authorization: "Bearer s3cret" },
    },
  ]);
  assertEquals(r.status, 403);
});

Deno.test("PUBLIC_MODE — /api/health stays reachable", async () => {
  const [r] = await probeApiAuth(PUBLIC, [
    { method: "GET", path: "/api/health" },
  ]);
  assertEquals(r.status, 200);
});
