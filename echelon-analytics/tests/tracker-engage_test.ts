// The tracker sends one `engage` event per pageview on the first real
// gesture. Scrolling is not a gesture for this purpose.

import { assertEquals } from "@std/assert";
import { loadTracker } from "./_tracker_harness.ts";

const settle = () => new Promise((r) => setTimeout(r, 50));

async function engages(h: Awaited<ReturnType<typeof loadTracker>>) {
  return (await h.sentEvents()).filter((e) => e.type === "engage");
}

Deno.test("tracker engage — pointerdown sends one engage with ms and path", async () => {
  const h = await loadTracker({ site: "eng-pointer" });
  await settle();
  const t0 = Date.now();
  h.setNow(t0 + 2500);
  h.fire("pointerdown");
  const evs = await engages(h);
  assertEquals(evs.length, 1);
  assertEquals(evs[0].data?.path, "/page");
  assertEquals(typeof evs[0].data?.ms, "number");
});

Deno.test("tracker engage — fires once per pageview however many gestures", async () => {
  const h = await loadTracker({ site: "eng-once" });
  await settle();
  h.fire("pointerdown");
  h.fire("keydown");
  h.fire("touchstart");
  h.fire("pointerdown");
  assertEquals((await engages(h)).length, 1);
});

Deno.test("tracker engage — keydown and touchstart count", async () => {
  const a = await loadTracker({ site: "eng-key" });
  await settle();
  a.fire("keydown");
  assertEquals((await engages(a)).length, 1);

  const b = await loadTracker({ site: "eng-touch" });
  await settle();
  b.fire("touchstart");
  assertEquals((await engages(b)).length, 1);
});

Deno.test("tracker engage — scroll alone does not send engage", async () => {
  const h = await loadTracker({ site: "eng-scroll" });
  await settle();
  h.fire("scroll");
  assertEquals((await engages(h)).length, 0);
});

Deno.test("tracker engage — re-armed after an SPA navigation", async () => {
  const h = await loadTracker({ site: "eng-spa" });
  await settle();
  h.fire("pointerdown");
  h.navigate("/next");
  await settle();
  h.fire("pointerdown");
  const evs = await engages(h);
  assertEquals(evs.length, 2);
  assertEquals(evs[1].data?.path, "/next");
});

Deno.test("tracker engage — a scripted (untrusted) gesture sends nothing, the next real one sends one", async () => {
  const h = await loadTracker({ site: "eng-untrusted" });
  await settle();
  h.fire("pointerdown", false);
  h.fire("keydown", false);
  h.fire("touchstart", false);
  assertEquals((await engages(h)).length, 0);
  h.fire("pointerdown");
  h.fire("pointerdown");
  assertEquals((await engages(h)).length, 1);
});
