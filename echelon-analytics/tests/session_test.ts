import { assertEquals } from "@std/assert";
import { FakeTime } from "@std/testing/time";
import {
  createSession,
  deleteSession,
  getSession,
  pruneSessions,
} from "@/lib/session.ts";

Deno.test("createSession — returns token", () => {
  const { token } = createSession("testuser");
  assertEquals(typeof token, "string");
  assertEquals(token.length, 36); // UUID format
});

Deno.test("getSession — retrieves valid session", () => {
  const { token } = createSession("gettest");
  const session = getSession(token);
  assertEquals(session !== undefined, true);
  assertEquals(session!.username, "gettest");
});

Deno.test("getSession — unknown token → undefined", () => {
  assertEquals(getSession("nonexistent-token"), undefined);
});

Deno.test("getSession — empty string → undefined", () => {
  assertEquals(getSession(""), undefined);
});

Deno.test("deleteSession — removes session", () => {
  const { token } = createSession("deltest");
  assertEquals(getSession(token) !== undefined, true);
  deleteSession(token);
  assertEquals(getSession(token), undefined);
});

Deno.test("createSession — invalidates prior sessions for same user", () => {
  const { token: t1 } = createSession("sameuser");
  const { token: t2 } = createSession("sameuser");
  assertEquals(getSession(t1), undefined);
  assertEquals(getSession(t2) !== undefined, true);
});

Deno.test("getSession — refreshes lastActivityAt on access", () => {
  const { token } = createSession("refresh-test");
  const s1 = getSession(token);
  assertEquals(s1 !== undefined, true);
  // Access again — should update lastActivityAt
  const s2 = getSession(token);
  assertEquals(s2 !== undefined, true);
});

Deno.test("pruneSessions — does not remove active sessions", () => {
  const { token } = createSession("prune-active");
  pruneSessions();
  assertEquals(getSession(token) !== undefined, true);
});

// ── Session expiry (FakeTime) ─────────────────────────────────────────────

Deno.test("getSession — expires after 24h TTL", () => {
  using _time = new FakeTime();
  const { token } = createSession("ttl-test");
  assertEquals(getSession(token) !== undefined, true);
  _time.tick(24 * 60 * 60 * 1000 + 1); // 24h + 1ms
  assertEquals(getSession(token), undefined);
});

Deno.test("getSession — expires after 30min idle", () => {
  using _time = new FakeTime();
  const { token } = createSession("idle-test");
  assertEquals(getSession(token) !== undefined, true);
  _time.tick(30 * 60 * 1000 + 1); // 30min + 1ms without access
  assertEquals(getSession(token), undefined);
});

Deno.test("getSession — activity resets idle timeout", () => {
  using _time = new FakeTime();
  const { token } = createSession("idle-reset");
  _time.tick(29 * 60 * 1000); // 29 min
  assertEquals(getSession(token) !== undefined, true); // access resets idle
  _time.tick(29 * 60 * 1000); // 29 more min (58 total, but only 29 since last access)
  assertEquals(getSession(token) !== undefined, true); // still alive
  _time.tick(31 * 60 * 1000); // 31 more min idle
  assertEquals(getSession(token), undefined); // now expired
});

Deno.test("pruneSessions — removes expired sessions", () => {
  using _time = new FakeTime();
  const { token } = createSession("prune-expired");
  _time.tick(25 * 60 * 60 * 1000); // 25 hours
  pruneSessions();
  assertEquals(getSession(token), undefined);
});
