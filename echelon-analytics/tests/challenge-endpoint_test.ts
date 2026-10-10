import { assertEquals, assertMatch } from "@std/assert";
import { handleChallenge } from "@/lib/tracker.ts";
import { generateChallenge } from "@/lib/challenge.ts";

Deno.test("handleChallenge — returns the current challenge as plain text", async () => {
  const resp = await handleChallenge();
  assertEquals(resp.status, 200);
  assertEquals(
    resp.headers.get("Content-Type"),
    "text/plain; charset=utf-8",
  );
  const body = await resp.text();
  assertMatch(body, /^[0-9a-f]{32}$/);
  assertEquals(body, await generateChallenge());
});

Deno.test("handleChallenge — is never cached", async () => {
  const resp = await handleChallenge();
  assertEquals(resp.headers.get("Cache-Control"), "no-store");
  await resp.body?.cancel();
});
