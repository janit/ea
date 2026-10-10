import { assertEquals } from "@std/assert";
import {
  corsHeaders,
  isAllowedOrigin,
  isAllowedReferer,
} from "@/routes/_middleware.ts";

// ── isAllowedOrigin ─────────────────────────────────────────────────────────
// Default config: ALLOWED_ORIGINS is empty (open mode) → all origins allowed

Deno.test("isAllowedOrigin — open mode: all origins allowed", () => {
  assertEquals(isAllowedOrigin("https://example.com"), true);
  assertEquals(isAllowedOrigin("https://anything.com"), true);
});

Deno.test("isAllowedOrigin — null origin → true in open mode", () => {
  assertEquals(isAllowedOrigin(null), true);
});

Deno.test("isAllowedOrigin — invalid URL → true in open mode (size=0 short-circuits)", () => {
  // When ALLOWED_ORIGINS is empty, the function returns true before parsing
  assertEquals(isAllowedOrigin("not-a-url"), true);
});

// ── isAllowedReferer ────────────────────────────────────────────────────────

Deno.test("isAllowedReferer — null referer → false", () => {
  assertEquals(isAllowedReferer(null), false);
});

Deno.test("isAllowedReferer — invalid URL → false", () => {
  assertEquals(isAllowedReferer("not-a-url"), false);
});

// ── corsHeaders ─────────────────────────────────────────────────────────────

Deno.test("corsHeaders — tracking paths reflect origin", () => {
  const req = new Request("https://analytics.example.com/b.gif", {
    headers: { origin: "https://mysite.com" },
  });
  const headers = corsHeaders(req);
  assertEquals(
    headers.get("Access-Control-Allow-Origin"),
    "https://mysite.com",
  );
  assertEquals(headers.get("Access-Control-Allow-Credentials"), "true");
});

Deno.test("corsHeaders — tracking path /e reflects origin", () => {
  const req = new Request("https://analytics.example.com/e", {
    headers: { origin: "https://mysite.com" },
  });
  const headers = corsHeaders(req);
  assertEquals(
    headers.get("Access-Control-Allow-Origin"),
    "https://mysite.com",
  );
});

Deno.test("corsHeaders — tracking path /ea.js reflects origin", () => {
  const req = new Request("https://analytics.example.com/ea.js", {
    headers: { origin: "https://mysite.com" },
  });
  const headers = corsHeaders(req);
  assertEquals(
    headers.get("Access-Control-Allow-Origin"),
    "https://mysite.com",
  );
});

Deno.test("corsHeaders — tracking path no origin → wildcard", () => {
  const req = new Request("https://analytics.example.com/b.gif");
  const headers = corsHeaders(req);
  assertEquals(headers.get("Access-Control-Allow-Origin"), "*");
});

Deno.test("corsHeaders — non-tracking paths → null origin", () => {
  const req = new Request("https://analytics.example.com/admin", {
    headers: { origin: "https://mysite.com" },
  });
  const headers = corsHeaders(req);
  assertEquals(headers.get("Access-Control-Allow-Origin"), "null");
});

Deno.test("corsHeaders — includes standard CORS headers", () => {
  const req = new Request("https://analytics.example.com/b.gif");
  const headers = corsHeaders(req);
  assertEquals(
    headers.get("Access-Control-Allow-Methods"),
    "GET, POST, PATCH, DELETE, OPTIONS",
  );
  assertEquals(
    headers.get("Access-Control-Allow-Headers"),
    "Content-Type, Authorization",
  );
  assertEquals(headers.get("Access-Control-Max-Age"), "86400");
});

Deno.test("corsHeaders — tracking path /c reflects origin", () => {
  const req = new Request("https://analytics.example.com/c", {
    headers: { origin: "https://mysite.com" },
  });
  const headers = corsHeaders(req);
  assertEquals(
    headers.get("Access-Control-Allow-Origin"),
    "https://mysite.com",
  );
});
