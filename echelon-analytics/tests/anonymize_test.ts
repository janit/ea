import { assertEquals, assertNotEquals } from "@std/assert";
import {
  anonymizeEvent,
  anonymizeView,
  shouldAnonymize,
} from "@/lib/anonymize.ts";
import type { SemanticEvent, ViewRecord } from "@/types.ts";

function baseView(overrides: Partial<ViewRecord> = {}): ViewRecord {
  return {
    visitor_id: "abc123def456abc0",
    path: "/test",
    site_id: "test-site",
    session_id: "550e8400-e29b-41d4-a716-446655440000",
    interaction_ms: 2000,
    screen_width: 1920,
    screen_height: 1080,
    device_type: "desktop",
    os_name: "Linux",
    browser_name: "Chrome",
    browser_version: "120.0.0.0",
    country_code: "NO",
    is_returning: 0,
    referrer: "https://google.com",
    referrer_type: "search",
    bot_score: 0,
    is_pwa: 0,
    utm_source: "google",
    utm_medium: "cpc",
    utm_campaign: "spring-sale",
    utm_content: "banner-1",
    utm_term: "analytics",
    ...overrides,
  };
}

function baseEvent(overrides: Partial<SemanticEvent> = {}): SemanticEvent {
  return {
    event_type: "click",
    site_id: "test-site",
    session_id: "550e8400-e29b-41d4-a716-446655440000",
    visitor_id: "abc123def456abc0",
    data: '{"target":"button"}',
    experiment_id: "exp-001",
    variant_id: "variant-a",
    utm_campaign: "spring-sale",
    device_type: "desktop",
    referrer: "https://google.com",
    hour: 14,
    month: 3,
    day_of_week: 2,
    is_returning: 0,
    bot_score: 0,
    ...overrides,
  };
}

// ── shouldAnonymize ─────────────────────────────────────────────────────────

Deno.test("shouldAnonymize — false when ANONYMIZE_SITES is empty", () => {
  // Default config has no anonymize sites
  assertEquals(shouldAnonymize("test-site"), false);
  assertEquals(shouldAnonymize("anything"), false);
});

// ── anonymizeView ───────────────────────────────────────────────────────────

Deno.test("anonymizeView — replaces visitor_id with HMAC hash", async () => {
  const original = baseView();
  const anon = await anonymizeView(original);
  assertNotEquals(anon.visitor_id, original.visitor_id);
  assertEquals(anon.visitor_id.length, 16);
  assertEquals(/^[0-9a-f]{16}$/.test(anon.visitor_id), true);
});

Deno.test("anonymizeView — replaces country with planet name", async () => {
  const anon = await anonymizeView(baseView());
  assertNotEquals(anon.country_code, "NO");
  assertEquals(typeof anon.country_code, "string");
});

Deno.test("anonymizeView — replaces referrer with NSA codename URL", async () => {
  const anon = await anonymizeView(baseView());
  assertEquals(
    anon.referrer!.startsWith("https://nsa-intranet.gov/ops/"),
    true,
  );
});

Deno.test("anonymizeView — replaces session_id with fisherman name", async () => {
  const anon = await anonymizeView(baseView());
  assertNotEquals(anon.session_id, baseView().session_id);
  assertEquals(typeof anon.session_id, "string");
});

Deno.test("anonymizeView — replaces UTM fields with operation codenames", async () => {
  const original = baseView();
  const anon = await anonymizeView(original);
  assertNotEquals(anon.utm_source, original.utm_source);
  assertNotEquals(anon.utm_medium, original.utm_medium);
  assertNotEquals(anon.utm_campaign, original.utm_campaign);
  assertNotEquals(anon.utm_content, original.utm_content);
  assertNotEquals(anon.utm_term, original.utm_term);
  assertEquals(anon.utm_source!.startsWith("operation-"), true);
});

Deno.test("anonymizeView — null fields stay null", async () => {
  const anon = await anonymizeView(
    baseView({
      session_id: null,
      country_code: null,
      referrer: null,
      utm_source: null,
    }),
  );
  assertEquals(anon.session_id, null);
  assertEquals(anon.country_code, null);
  assertEquals(anon.referrer, null);
  assertEquals(anon.utm_source, null);
});

Deno.test("anonymizeView — deterministic (same input → same output)", async () => {
  const original = baseView();
  const a = await anonymizeView(original);
  const b = await anonymizeView(original);
  assertEquals(a.visitor_id, b.visitor_id);
  assertEquals(a.session_id, b.session_id);
  assertEquals(a.country_code, b.country_code);
  assertEquals(a.referrer, b.referrer);
});

Deno.test("anonymizeView — preserves non-anonymized fields", async () => {
  const original = baseView();
  const anon = await anonymizeView(original);
  assertEquals(anon.path, original.path);
  assertEquals(anon.site_id, original.site_id);
  assertEquals(anon.interaction_ms, original.interaction_ms);
  assertEquals(anon.bot_score, original.bot_score);
  assertEquals(anon.is_pwa, original.is_pwa);
});

Deno.test("anonymizeView — maps screen size to terminal resolution", async () => {
  const anon = await anonymizeView(
    baseView({ screen_width: 1440, screen_height: 900 }),
  );
  assertNotEquals(anon.screen_width, 1440);
  assertNotEquals(anon.screen_height, 900);
  assertEquals(typeof anon.screen_width, "number");
  assertEquals(typeof anon.screen_height, "number");
  // Deterministic: same input → same terminal
  const anon2 = await anonymizeView(
    baseView({ screen_width: 1440, screen_height: 900 }),
  );
  assertEquals(anon.screen_width, anon2.screen_width);
  assertEquals(anon.screen_height, anon2.screen_height);
});

Deno.test("anonymizeView — maps os_name to tropical bird", async () => {
  const anon = await anonymizeView(baseView({ os_name: "macOS 10.15" }));
  assertNotEquals(anon.os_name, "macOS 10.15");
  assertEquals(typeof anon.os_name, "string");
  // Deterministic: same input → same bird
  const anon2 = await anonymizeView(baseView({ os_name: "macOS 10.15" }));
  assertEquals(anon.os_name, anon2.os_name);
});

Deno.test("anonymizeView — maps browser_name to mammal body part", async () => {
  const anon = await anonymizeView(
    baseView({ browser_name: "Chrome", browser_version: "120.0.0.0" }),
  );
  assertNotEquals(anon.browser_name, "Chrome");
  assertEquals(typeof anon.browser_name, "string");
  // Deterministic: same input → same mammal body part
  const anon2 = await anonymizeView(
    baseView({ browser_name: "Chrome", browser_version: "120.0.0.0" }),
  );
  assertEquals(anon.browser_name, anon2.browser_name);
});

Deno.test("anonymizeView — maps browser_version to deterministic version", async () => {
  const anon = await anonymizeView(
    baseView({ browser_version: "120.0.0.0" }),
  );
  assertNotEquals(anon.browser_version, "120.0.0.0");
  assertEquals(/^\d+\.\d+$/.test(anon.browser_version!), true);
  // Deterministic
  const anon2 = await anonymizeView(
    baseView({ browser_version: "120.0.0.0" }),
  );
  assertEquals(anon.browser_version, anon2.browser_version);
});

Deno.test("anonymizeView — null browser fields stay null", async () => {
  const anon = await anonymizeView(
    baseView({ browser_name: null, browser_version: null }),
  );
  assertEquals(anon.browser_name, null);
  assertEquals(anon.browser_version, null);
});

Deno.test("anonymizeView — maps device_type to vessel class", async () => {
  const anon = await anonymizeView(baseView({ device_type: "desktop" }));
  assertEquals(anon.device_type, "mothership");
});

Deno.test("anonymizeEvent — maps device_type to vessel class", async () => {
  const anon = await anonymizeEvent(baseEvent({ device_type: "mobile" }));
  assertEquals(anon.device_type, "probe");
});

// ── anonymizeEvent ──────────────────────────────────────────────────────────

Deno.test("anonymizeEvent — replaces visitor_id with HMAC hash", async () => {
  const original = baseEvent();
  const anon = await anonymizeEvent(original);
  assertNotEquals(anon.visitor_id, original.visitor_id);
  assertEquals(anon.visitor_id!.length, 16);
});

Deno.test("anonymizeEvent — replaces session_id with fisherman name", async () => {
  const original = baseEvent();
  const anon = await anonymizeEvent(original);
  assertNotEquals(anon.session_id, original.session_id);
});

Deno.test("anonymizeEvent — replaces referrer with NSA codename URL", async () => {
  const anon = await anonymizeEvent(baseEvent());
  assertEquals(
    anon.referrer!.startsWith("https://nsa-intranet.gov/ops/"),
    true,
  );
});

Deno.test("anonymizeEvent — sanitizes data to safe behavioral keys only", async () => {
  // click event: keeps "tag" and "path", strips "target"
  const clickEvent = baseEvent({
    event_type: "click",
    data: '{"target":"button","tag":"A","path":"/about"}',
  });
  const anon = await anonymizeEvent(clickEvent);
  assertEquals(anon.data, '{"tag":"A","path":"/about"}');

  // scroll_depth: keeps "depth" and "path"
  const scrollEvent = baseEvent({
    event_type: "scroll_depth",
    data: '{"depth":75,"path":"/page","secret":"x"}',
  });
  const anonScroll = await anonymizeEvent(scrollEvent);
  assertEquals(anonScroll.data, '{"depth":75,"path":"/page"}');

  // unknown event type: stripped entirely
  const unknownEvent = baseEvent({
    event_type: "custom",
    data: '{"foo":"bar"}',
  });
  const anonUnknown = await anonymizeEvent(unknownEvent);
  assertEquals(anonUnknown.data, "{}");
});

Deno.test("anonymizeEvent — anonymizes experiment and variant IDs", async () => {
  const original = baseEvent();
  const anon = await anonymizeEvent(original);
  assertEquals(anon.experiment_id!.startsWith("experiment-"), true);
  assertEquals(anon.variant_id!.startsWith("variant-"), true);
});

Deno.test("anonymizeEvent — form_blur value is scrambled preserving length and char class", async () => {
  const formBlurEvent = baseEvent({
    event_type: "form_blur",
    data:
      '{"tag":"INPUT","input_type":"text","field_name":"q","value":"hello world","value_length":11,"path":"/search"}',
  });
  const anon = await anonymizeEvent(formBlurEvent);
  const parsed = JSON.parse(anon.data);
  // value is scrambled but preserves length
  assertNotEquals(parsed.value, "hello world");
  assertEquals(parsed.value.length, "hello world".length);
  // space is preserved at original position
  assertEquals(parsed.value[5], " ");
  // all non-space chars are lowercase letters
  for (let i = 0; i < parsed.value.length; i++) {
    if (i === 5) continue; // space
    assertEquals(/[a-z]/.test(parsed.value[i]), true);
  }
  // deterministic
  const anon2 = await anonymizeEvent(formBlurEvent);
  const parsed2 = JSON.parse(anon2.data);
  assertEquals(parsed.value, parsed2.value);
  // other safe keys are preserved
  assertEquals(parsed.field_name, "q");
  assertEquals(parsed.value_length, 11);
  assertEquals(parsed.path, "/search");
});

Deno.test("anonymizeEvent — form_blur null/empty value stays unchanged", async () => {
  const noValue = baseEvent({
    event_type: "form_blur",
    data:
      '{"tag":"INPUT","input_type":"text","field_name":"q","value_length":0}',
  });
  const anon = await anonymizeEvent(noValue);
  const parsed = JSON.parse(anon.data);
  assertEquals(parsed.value, undefined);
});

Deno.test("anonymizeEvent — null fields stay null", async () => {
  const anon = await anonymizeEvent(
    baseEvent({
      visitor_id: null,
      session_id: null,
      referrer: null,
      experiment_id: null,
      variant_id: null,
    }),
  );
  assertEquals(anon.visitor_id, null);
  assertEquals(anon.session_id, null);
  assertEquals(anon.referrer, null);
  assertEquals(anon.experiment_id, null);
  assertEquals(anon.variant_id, null);
});
