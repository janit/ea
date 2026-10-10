import { assertEquals } from "@std/assert";
import {
  ALLOWED_EVENT_TYPES,
  INTERACTION_EVENTS,
  INTERACTION_SQL_LIST,
  isInteractionEvent,
  PASSIVE_EVENTS,
} from "@/lib/event-classes.ts";

Deno.test("event classes — interaction and passive sets are disjoint", () => {
  for (const t of INTERACTION_EVENTS) {
    assertEquals(PASSIVE_EVENTS.has(t), false, `${t} is in both sets`);
  }
});

Deno.test("event classes — allowed types are exactly the union", () => {
  assertEquals(
    [...ALLOWED_EVENT_TYPES].sort(),
    [...PASSIVE_EVENTS, ...INTERACTION_EVENTS].sort(),
  );
});

// A snapshot on purpose. Moving a type between the sets changes what counts
// as proof of a human; that must be a deliberate edit of this test, with the
// answer to "can a page load emit this without a gesture?" in the commit.
Deno.test("event classes — the partition is exactly this", () => {
  assertEquals([...PASSIVE_EVENTS].sort(), [
    "bounce",
    "custom",
    "scroll_depth",
    "session_end",
    "session_resume",
    "web_vital",
  ]);
  assertEquals([...INTERACTION_EVENTS].sort(), [
    "ad_click",
    "click",
    "download",
    "engage",
    "form_blur",
    "form_focus",
    "form_submit",
    "hover",
    "outbound",
  ]);
});

Deno.test("event classes — SQL list is quoted, sorted and comma-joined", () => {
  assertEquals(
    INTERACTION_SQL_LIST,
    "'ad_click', 'click', 'download', 'engage', 'form_blur', 'form_focus', 'form_submit', 'hover', 'outbound'",
  );
});

Deno.test("isInteractionEvent — true only for the interaction set", () => {
  assertEquals(isInteractionEvent("engage"), true);
  assertEquals(isInteractionEvent("session_end"), false);
  assertEquals(isInteractionEvent("made_up"), false);
});
