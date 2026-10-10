import { assertEquals } from "@std/assert";
import { formatFactor } from "@/lib/score-factor.ts";

Deno.test("formatFactor — points, strings, cluster objects and bare marks", () => {
  assertEquals(formatFactor(15), "+15");
  assertEquals(formatFactor(0), "+0");
  assertEquals(formatFactor("missing"), "missing");
  // What the correlator stores under `correlated`.
  assertEquals(
    formatFactor({
      reason: "correlated",
      penalty: 30,
      cluster_size: 6,
      tainted: false,
      fingerprint: "Linux|Chrome",
    }),
    "+30",
  );
  // An object with no numeric penalty, and marks older versions stored as
  // booleans (`no_events: true`): the label alone.
  assertEquals(formatFactor({ reason: "correlated" }), "");
  assertEquals(formatFactor({ penalty: "30" }), "");
  assertEquals(formatFactor(true), "");
  assertEquals(formatFactor(false), "");
  assertEquals(formatFactor(null), "");
  assertEquals(formatFactor([30]), "");
});
