// The real /api auth middleware under each auth configuration.

import { assertEquals } from "@std/assert";
import { probeApiAuth } from "./_helpers.ts";

Deno.test("API auth — nothing configured: 401 except /api/health", async () => {
  const results = await probeApiAuth({}, [
    { method: "GET", path: "/api/stats/overview" },
    { method: "GET", path: "/api/health" },
  ]);
  assertEquals(results.map((r) => r.status), [401, 200]);
});

Deno.test("API auth — bearer token: right token passes, wrong or missing does not", async () => {
  const env = { ECHELON_SECRET: "s3cret-token" };
  const results = await probeApiAuth(env, [
    {
      method: "GET",
      path: "/api/stats/overview",
      headers: { authorization: "Bearer s3cret-token" },
    },
    {
      method: "GET",
      path: "/api/stats/overview",
      headers: { authorization: "Bearer s3cret-tokeN" },
    },
    { method: "GET", path: "/api/stats/overview" },
    {
      method: "GET",
      path: "/api/stats/overview",
      headers: { authorization: "s3cret-token" },
    },
  ]);
  assertEquals(results.map((r) => r.status), [200, 401, 401, 401]);
});

Deno.test("API auth — bearer auth is exempt from CSRF (no cookie involved)", async () => {
  const [r] = await probeApiAuth({ ECHELON_SECRET: "s3cret-token" }, [
    {
      method: "POST",
      path: "/api/campaigns",
      headers: {
        authorization: "Bearer s3cret-token",
        origin: "https://evil.example",
      },
    },
  ]);
  assertEquals(r.status, 200);
});

Deno.test("API auth — session cookie: reads pass, forged session fails", async () => {
  const env = { ECHELON_USERNAME: "admin" };
  const results = await probeApiAuth(env, [
    { method: "GET", path: "/api/stats/overview", session: true },
    {
      method: "GET",
      path: "/api/stats/overview",
      headers: { cookie: "echelon_session=forged" },
    },
  ]);
  assertEquals(results.map((r) => r.status), [200, 401]);
});

Deno.test("API auth — session cookie writes are CSRF-checked", async () => {
  const env = { ECHELON_USERNAME: "admin" };
  const results = await probeApiAuth(env, [
    {
      method: "POST",
      path: "/api/campaigns",
      session: true,
      headers: { origin: "https://analytics.example.com" },
    },
    {
      method: "POST",
      path: "/api/campaigns",
      session: true,
      headers: { origin: "https://evil.example" },
    },
    { method: "POST", path: "/api/campaigns", session: true },
    {
      method: "DELETE",
      path: "/api/campaigns/x",
      session: true,
      headers: { referer: "https://analytics.example.com/admin" },
    },
  ]);
  assertEquals(results.map((r) => r.status), [200, 403, 403, 200]);
});
