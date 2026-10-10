import { assertEquals } from "@std/assert";
import {
  getSiteHome,
  markSiteHomesStale,
  normalizeCountry,
  normalizeLanguage,
  refreshSiteHomes,
} from "@/lib/site-home.ts";
import { createTestDb } from "./_helpers.ts";

Deno.test("normalizeCountry — accepts two letters, upper-cases, null clears", () => {
  assertEquals(normalizeCountry("fi"), "FI");
  assertEquals(normalizeCountry(" US "), "US");
  assertEquals(normalizeCountry(""), null);
  assertEquals(normalizeCountry(null), null);
});

Deno.test("normalizeCountry — rejects anything else", () => {
  assertEquals(normalizeCountry("FIN"), undefined);
  assertEquals(normalizeCountry("F1"), undefined);
  assertEquals(normalizeCountry(42), undefined);
  assertEquals(normalizeCountry("F'; DROP"), undefined);
});

Deno.test("normalizeLanguage — keeps the primary subtag, lower-cased", () => {
  assertEquals(normalizeLanguage("en"), "en");
  assertEquals(normalizeLanguage("EN-gb"), "en");
  assertEquals(normalizeLanguage("fil"), "fil");
  assertEquals(normalizeLanguage(""), null);
  assertEquals(normalizeLanguage(null), null);
});

Deno.test("normalizeLanguage — rejects anything else", () => {
  assertEquals(normalizeLanguage("english"), undefined);
  assertEquals(normalizeLanguage("e"), undefined);
  assertEquals(normalizeLanguage("e1"), undefined);
  assertEquals(normalizeLanguage({}), undefined);
});

Deno.test("getSiteHome — unknown site has no home", async () => {
  const db = createTestDb();
  markSiteHomesStale();
  await refreshSiteHomes(db);
  assertEquals(getSiteHome("never-configured"), {
    country: null,
    language: null,
  });
  await db.close();
});

Deno.test("getSiteHome — reads configured values after a refresh", async () => {
  const db = createTestDb();
  await db.run(
    "INSERT INTO site_settings (site_id, home_country, home_language) VALUES (?, ?, ?)",
    "home-site",
    "FI",
    "fi",
  );
  markSiteHomesStale();
  await refreshSiteHomes(db);
  assertEquals(getSiteHome("home-site"), { country: "FI", language: "fi" });
  await db.close();
});

Deno.test("getSiteHome — a site with only consent CSS set has no home", async () => {
  const db = createTestDb();
  await db.run(
    "INSERT INTO site_settings (site_id, consent_css) VALUES (?, ?)",
    "css-only-site",
    ".bar{}",
  );
  markSiteHomesStale();
  await refreshSiteHomes(db);
  assertEquals(getSiteHome("css-only-site"), { country: null, language: null });
  await db.close();
});

Deno.test("getSiteHome — lookup is case-insensitive", async () => {
  const db = createTestDb();
  await db.run(
    "INSERT INTO site_settings (site_id, home_country, home_language) VALUES (?, ?, ?)",
    "Example.com",
    "FI",
    "fi",
  );
  markSiteHomesStale();
  await refreshSiteHomes(db);
  const want = { country: "FI", language: "fi" };
  assertEquals(getSiteHome("Example.com"), want);
  assertEquals(getSiteHome("example.com"), want);
  assertEquals(getSiteHome("EXAMPLE.COM"), want);
  await db.close();
});

Deno.test("refreshSiteHomes — fails open: keeps the cache, no retry within 60 s", async () => {
  const db = createTestDb();
  await db.run(
    "INSERT INTO site_settings (site_id, home_country, home_language) VALUES (?, ?, ?)",
    "failopen.example",
    "SE",
    "sv",
  );
  markSiteHomesStale();
  await refreshSiteHomes(db);
  let calls = 0;
  const broken = {
    query: () => {
      calls++;
      return Promise.reject(new Error("db down"));
    },
  } as unknown as typeof db;
  const origErr = console.error;
  const logged: unknown[] = [];
  console.error = (...a: unknown[]) => logged.push(a);
  try {
    markSiteHomesStale();
    await refreshSiteHomes(broken); // must not throw
    await refreshSiteHomes(broken); // backed off
    await refreshSiteHomes(broken);
  } finally {
    console.error = origErr;
  }
  assertEquals(calls, 1);
  assertEquals(logged.length, 1);
  assertEquals(getSiteHome("failopen.example").country, "SE");
  await db.close();
});

Deno.test("normalizeCountry — an unassigned code is rejected", () => {
  // UK is the obvious typo for GB; none of these is in the continent table.
  assertEquals(normalizeCountry("UK"), undefined);
  assertEquals(normalizeCountry("XX"), undefined);
  assertEquals(normalizeCountry("EN"), undefined);
  assertEquals(normalizeCountry("FL"), undefined);
});

Deno.test("normalizeCountry — assigned codes are accepted, RU included", () => {
  assertEquals(normalizeCountry("GB"), "GB");
  assertEquals(normalizeCountry("fi"), "FI");
  assertEquals(normalizeCountry("RU"), "RU"); // no continent, still a country
  assertEquals(normalizeCountry("ru"), "RU");
});

Deno.test("getSiteHome — a stored unassigned country reads as unset", async () => {
  const db = createTestDb();
  await db.run(
    "INSERT INTO site_settings (site_id, home_country, home_language) VALUES (?, ?, ?)",
    "typo-site",
    "UK",
    "en",
  );
  await db.run(
    "INSERT INTO site_settings (site_id, home_country) VALUES (?, ?)",
    "typo-only-site",
    "XX",
  );
  markSiteHomesStale();
  await refreshSiteHomes(db);
  assertEquals(getSiteHome("typo-site"), { country: null, language: "en" });
  assertEquals(getSiteHome("typo-only-site"), {
    country: null,
    language: null,
  });
  await db.close();
});
