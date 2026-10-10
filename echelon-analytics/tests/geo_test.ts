import { assertEquals } from "@std/assert";
import {
  CONTINENT_TABLE,
  continentOf,
  isCountryMismatch,
  isCrossContinent,
  isGlobalCommon,
} from "@/lib/geo.ts";

Deno.test("continentOf — known codes, any case", () => {
  assertEquals(continentOf("FI"), "europe");
  assertEquals(continentOf("fi"), "europe");
  assertEquals(continentOf("NG"), "africa");
  assertEquals(continentOf("BR"), "south-america");
  assertEquals(continentOf("US"), "north-america");
  assertEquals(continentOf("PH"), "asia");
  assertEquals(continentOf("NZ"), "oceania");
});

Deno.test("continentOf — unknown continent: unclassified and empty codes are undefined", () => {
  assertEquals(continentOf("RU"), undefined); // transcontinental, left out
  assertEquals(continentOf("ZZ"), undefined);
  assertEquals(continentOf(""), undefined);
  assertEquals(continentOf(null), undefined);
  assertEquals(continentOf(undefined), undefined);
});

Deno.test("isGlobalCommon — diaspora and tech-hub countries", () => {
  assertEquals(isGlobalCommon("US"), true);
  assertEquals(isGlobalCommon("in"), true);
  assertEquals(isGlobalCommon("FI"), false);
  assertEquals(isGlobalCommon(null), false);
});

Deno.test("isCountryMismatch — no home country means never a mismatch", () => {
  assertEquals(isCountryMismatch("CN", null), false);
  assertEquals(isCountryMismatch("CN", ""), false);
  assertEquals(isCountryMismatch("CN", undefined), false);
});

Deno.test("isCountryMismatch — unknown visitor country is never a mismatch", () => {
  assertEquals(isCountryMismatch(undefined, "FI"), false);
  assertEquals(isCountryMismatch("", "FI"), false);
});

Deno.test("isCountryMismatch — same country and same continent are not mismatches", () => {
  assertEquals(isCountryMismatch("FI", "FI", "fi"), false);
  assertEquals(isCountryMismatch("fi", "FI", "fi"), false);
  assertEquals(isCountryMismatch("SE", "FI", "fi"), false);
});

Deno.test("isCountryMismatch — another continent is a mismatch", () => {
  assertEquals(isCountryMismatch("CN", "FI", "fi"), true);
  assertEquals(isCountryMismatch("BR", "FI", "fi"), true);
});

Deno.test("isCountryMismatch — global-common countries are exempt only on English sites", () => {
  assertEquals(isCountryMismatch("US", "IE", "en"), false);
  assertEquals(isCountryMismatch("US", "IE", "en-GB"), false);
  assertEquals(isCountryMismatch("US", "FI", "fi"), true);
  assertEquals(isCountryMismatch("US", "DE", "de"), true);
});

Deno.test("isCountryMismatch — no language configured is treated as English", () => {
  assertEquals(isCountryMismatch("US", "FI"), false);
  assertEquals(isCountryMismatch("US", "FI", null), false);
  assertEquals(isCountryMismatch("CN", "FI"), true);
});

Deno.test("isCountryMismatch — unclassified home country falls back to exact comparison", () => {
  assertEquals(isCountryMismatch("RU", "RU", "ru"), false);
  assertEquals(isCountryMismatch("KZ", "RU", "ru"), true);
});

Deno.test("isCrossContinent — true only when both continents are known and differ", () => {
  assertEquals(isCrossContinent("PH", "US"), true);
  assertEquals(isCrossContinent("CA", "US"), false);
  assertEquals(isCrossContinent("PH", null), false);
  assertEquals(isCrossContinent(undefined, "US"), false);
  assertEquals(
    isCrossContinent("RU", "US"),
    false,
    "unknown visitor continent",
  );
  assertEquals(isCrossContinent("US", "RU"), false, "unknown home continent");
});

Deno.test("isCountryMismatch — countries once missing from the table share their continent", () => {
  assertEquals(isCountryMismatch("NA", "KE", "en"), false);
  assertEquals(isCountryMismatch("BW", "KE", "sw"), false);
  assertEquals(isCountryMismatch("MC", "FI", "fi"), false);
  assertEquals(isCountryMismatch("KY", "US", "en"), false);
  assertEquals(isCountryMismatch("GF", "BR", "pt"), false);
});

Deno.test("isCountryMismatch — a visitor country the table does not know is never a mismatch", () => {
  assertEquals(isCountryMismatch("XX", "FI", "fi"), false);
  assertEquals(isCountryMismatch("T1", "FI", "fi"), false);
  assertEquals(isCountryMismatch("xx", "FI"), false);
  // RU is global-common, so it keeps its existing behaviour.
  assertEquals(isCountryMismatch("RU", "FI", "fi"), true);
  assertEquals(isCountryMismatch("RU", "FI", "en"), false);
});

Deno.test("isCrossContinent — unknown visitor country is never cross-continent", () => {
  assertEquals(isCrossContinent("XX", "FI"), false);
  assertEquals(isCrossContinent("T1", "FI"), false);
});

Deno.test("continent table — integrity", () => {
  const seen = new Map<string, string>();
  for (const [continent, codes] of Object.entries(CONTINENT_TABLE)) {
    for (const code of codes) {
      assertEquals(/^[A-Z]{2}$/.test(code), true, `bad code ${code}`);
      assertEquals(
        seen.get(code),
        undefined,
        `${code} in both ${seen.get(code)} and ${continent}`,
      );
      seen.set(code, continent);
    }
  }
  assertEquals(seen.size >= 240, true, `only ${seen.size} entries`);
});

Deno.test("continentOf — spot checks across continents", () => {
  const expected: Record<string, string> = {
    NA: "africa",
    RE: "africa",
    SC: "africa",
    MC: "europe",
    GI: "europe",
    XK: "europe",
    TR: "asia",
    HK: "asia",
    PS: "asia",
    KY: "north-america",
    GL: "north-america",
    PR: "north-america",
    GF: "south-america",
    FK: "south-america",
    GU: "oceania",
    PF: "oceania",
  };
  for (const [code, continent] of Object.entries(expected)) {
    assertEquals(continentOf(code), continent, code);
  }
});
