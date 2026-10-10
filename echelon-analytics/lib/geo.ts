// Echelon Analytics — Geography Helpers
//
// Country → continent, and the two questions the scorer asks about a visitor
// relative to a site's declared home country. Everything here returns the
// conservative answer ("not a mismatch") when either side is unknown: an
// unconfigured site, a missing geo header, or a country this table does not
// classify must never make a visitor look foreign. Concretely, a visitor
// country that is in neither the continent table nor the global-common list
// (XX, T1, a typo, a future code) is never a mismatch and never
// cross-continent. The table covers every assigned ISO 3166-1 alpha-2 code
// plus XK, except RU (transcontinental) and the Antarctic-only codes.
//
// Zero imports on purpose.

const list = (codes: string) => codes.split(" ");

/** Raw per-continent lists; exported so tests can check table integrity. */
export const CONTINENT_TABLE: Record<string, string[]> = {
  europe: list(
    "FI SE NO DK DE NL BE FR ES PT IT AT CH PL CZ SK HU RO BG HR SI EE LV LT " +
      "IE GB GR RS BA ME MK AL XK IS LU MT CY UA MD BY " +
      "AD MC SM LI VA FO GI IM JE GG AX SJ",
  ),
  africa: list(
    "NG KE ZA GH TZ UG ET CM SN CI MA TN DZ EG RW BJ TG BF ML NE CD MZ ZM ZW " +
      "AO MW MG SD SS LY MU NA BW SO GA CG GN SL LR GM MR TD CF GQ BI DJ ER LS " +
      "SZ KM CV ST SC GW RE YT SH EH",
  ),
  "south-america": list("BR AR CL CO PE VE EC BO PY UY GY SR GF FK"),
  "north-america": list(
    "US CA MX GT BZ SV HN NI CR PA CU DO HT JM BS BB TT PR GD LC VC AG DM KN " +
      "KY BM AW CW GL AI BL BQ GP MF MQ MS PM SX TC VG VI",
  ),
  asia: list(
    "CN JP KR KP IN PK BD LK NP BT MV AF IR IQ SA AE QA KW BH OM YE JO LB SY " +
      "IL PS TR GE AM AZ KZ UZ TM KG TJ TH VN LA KH MM MY SG ID PH BN TL MN " +
      "HK MO TW IO",
  ),
  oceania: list(
    "AU NZ FJ PG SB VU NC PF WS TO KI FM MH NR PW TV CK AS GU MP NU TK WF PN " +
      "NF CX CC",
  ),
};

// RU is deliberately absent: it spans two continents, and guessing one would
// make half its visitors "cross-continent" on any European or Asian site.
const CONTINENT_OF = new Map<string, string>();
for (const [continent, codes] of Object.entries(CONTINENT_TABLE)) {
  for (const code of codes) CONTINENT_OF.set(code, continent);
}

// Countries that show up on almost any site: large English-speaking
// populations, tech hubs, VPN exits, big diasporas. On an English-language
// site they are ordinary; on a Finnish- or German-language site, a visitor
// claiming to be in one of them is much less likely to be real.
const GLOBAL_COMMON = new Set(
  list("US CA AU NZ JP KR SG IN TR RU MA AE MX PK"),
);

/** Continent slug for an ISO 3166-1 alpha-2 code, or undefined if unknown. */
export function continentOf(
  countryCode: string | null | undefined,
): string | undefined {
  if (!countryCode) return undefined;
  return CONTINENT_OF.get(countryCode.toUpperCase());
}

/** True for countries whose visitors are routine on any English site. */
export function isGlobalCommon(
  countryCode: string | null | undefined,
): boolean {
  return !!countryCode && GLOBAL_COMMON.has(countryCode.toUpperCase());
}

/**
 * Is this visitor's country implausible for a site whose home is
 * `homeCountry`? False when either is unknown, when they are the same
 * country, or when they share a continent. Global-common countries are
 * exempt on English-language sites only; a site with no language configured
 * is treated as English, the lenient choice.
 */
export function isCountryMismatch(
  visitorCountry: string | null | undefined,
  homeCountry: string | null | undefined,
  homeLanguage?: string | null,
): boolean {
  if (!visitorCountry || !homeCountry) return false;
  const visitor = visitorCountry.toUpperCase();
  const home = homeCountry.toUpperCase();
  if (visitor === home) return false;

  const english = !homeLanguage ||
    homeLanguage.toLowerCase().startsWith("en");
  const visitorContinent = CONTINENT_OF.get(visitor);
  const common = GLOBAL_COMMON.has(visitor);
  // Unknown to us entirely: we cannot call it foreign.
  if (!visitorContinent && !common) return false;
  if (english && common) return false;

  const homeContinent = CONTINENT_OF.get(home);
  return !(homeContinent && visitorContinent === homeContinent);
}

/** True only when both continents are known and they differ. */
export function isCrossContinent(
  visitorCountry: string | null | undefined,
  homeCountry: string | null | undefined,
): boolean {
  const visitor = continentOf(visitorCountry);
  const home = continentOf(homeCountry);
  return !!visitor && !!home && visitor !== home;
}
