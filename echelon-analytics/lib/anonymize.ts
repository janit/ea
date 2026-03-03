// Echelon Analytics — Pre-storage Anonymization
//
// Deterministic transforms so analytics aggregation still works
// (same visitor → same anonymous ID within a day) but nothing
// about tracked instances is identifiable.

import type { SemanticEvent, ViewRecord } from "../types.ts";
import { ANONYMIZE_SITES, SECRET } from "./config.ts";

// ── HMAC key: daily-rotating seed + server secret ────────────────────────────
// The secret prevents anyone from reversing the anonymization without access
// to the server's ECHELON_SECRET. Without a secret, a random 32-byte key is
// generated at startup (anonymization is still irreversible across restarts).

const fallbackSecret = crypto.getRandomValues(new Uint8Array(32));

let hmacKeyDate = "";
let hmacKey: CryptoKey | null = null;

async function getHmacKey(): Promise<CryptoKey> {
  const today = new Date().toISOString().slice(0, 10);
  if (hmacKey && hmacKeyDate === today) return hmacKey;
  const salt = SECRET ? new TextEncoder().encode(SECRET) : fallbackSecret;
  const dateBytes = new TextEncoder().encode(`echelon-anon-${today}`);
  const seed = new Uint8Array(salt.length + dateBytes.length);
  seed.set(salt);
  seed.set(dateBytes, salt.length);
  hmacKey = await crypto.subtle.importKey(
    "raw",
    seed,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  hmacKeyDate = today;
  return hmacKey;
}

async function hmacHex(input: string): Promise<string> {
  const key = await getHmacKey();
  const data = new TextEncoder().encode(input);
  const sig = await crypto.subtle.sign("HMAC", key, data);
  return Array.from(new Uint8Array(sig))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** Deterministic index into an array from a string input. */
function pickIndex(hex: string, len: number): number {
  // Use first 8 hex chars as a 32-bit number
  return parseInt(hex.slice(0, 8), 16) % len;
}

// ── Lookup tables ────────────────────────────────────────────────────────────

const PLANETS = [
  "Kepler-442b",
  "Proxima-b",
  "TRAPPIST-1e",
  "Gliese-667Cc",
  "HD-40307g",
  "Kepler-62f",
  "Kepler-186f",
  "Wolf-1061c",
  "LHS-1140b",
  "Ross-128b",
  "Tau-Ceti-e",
  "Teegarden-b",
  "GJ-357d",
  "K2-18b",
  "TOI-700d",
  "Kepler-22b",
  "Kepler-452b",
  "Kepler-1649c",
  "GJ-1002b",
  "Proxima-d",
  "TRAPPIST-1f",
  "TRAPPIST-1g",
  "Kepler-438b",
  "Kepler-296e",
  "HD-85512b",
  "Gliese-581g",
  "55-Cancri-e",
  "CoRoT-7b",
  "Kepler-69c",
  "Kepler-62e",
  "Barnard-b",
  "LP-890-9c",
];

const FISHERMEN = [
  "Torstein Sjømann",
  "Bjørn Havblikk",
  "Olav Sildekong",
  "Knut Garndrager",
  "Einar Tråler",
  "Sigurd Fjordmann",
  "Harald Bølge",
  "Ragnar Snørekaster",
  "Leif Tangansen",
  "Gunnar Strømvik",
  "Magnus Kveitefisker",
  "Arne Juksafisker",
  "Trygve Notmann",
  "Per Loddefanger",
  "Sverre Brosme",
  "Ivar Djuphavsmann",
  "Nils Stormfugl",
  "Oddvar Sjøsprøyt",
  "Rolf Skjæansen",
  "Terje Havøransen",
  "Kristoffer Torsken",
  "Halvor Krabben",
  "Ottar Steinbitansen",
  "Thoralf Makkansen",
  "Asbjørn Pilken",
  "Fritjof Hummeransen",
  "Geir Flyndansen",
  "Steinar Laksen",
  "Vidar Reketansen",
  "Håkon Blåskjelansen",
  "Yngve Sjøstjernansen",
  "Dagfinn Brislingansen",
  "Petter Seifisker",
  "Jostein Breiflabb",
  "Morten Havabbansen",
  "Sondre Blåkveiten",
  "Øystein Lusufiskansen",
  "Torbjørn Steinkobbe",
  "Arvid Sjøpølsen",
  "Kolbjørn Brugden",
  "Anfinn Leppefisker",
  "Birger Trollgansen",
  "Erling Rypen",
  "Guttorm Småsild",
  "Helge Dorgansen",
  "Jarle Havmusen",
  "Kåre Teinansen",
  "Lauritz Åleransen",
  "Mathias Fjordansen",
  "Nikolai Blåstålansen",
];

const NSA_CODENAMES = [
  "STELLAR-WIND",
  "PRISM",
  "XKEYSCORE",
  "MUSCULAR",
  "BULLRUN",
  "BOUNDLESS-INFORMANT",
  "TEMPORA",
  "UPSTREAM",
  "PINWALE",
  "MARINA",
  "MAINWAY",
  "NUCLEON",
  "TURBULENCE",
  "TURMOIL",
  "TUMULT",
  "DISHFIRE",
  "MYSTIC",
  "SOMALGET",
  "DIRTBOX",
  "STINGRAY",
  "FAIRVIEW",
  "STORMBREW",
  "BLARNEY",
  "OAKSTAR",
  "LITHIUM",
  "SENTRY-EAGLE",
  "TREASURE-MAP",
  "AURORAGOLD",
  "COTTONMOUTH",
  "QUANTUM-INSERT",
  "FOXACID",
  "EGOTISTICAL-GIRAFFE",
  "FLYING-PIG",
  "HAPPY-FOOT",
  "JUGGERNAUT",
  "RAGE-MASTER",
  "SWAP",
  "DROPOUT-JEEP",
  "MONKEYROCKET",
  "OLYMPIA",
];

const OPERATION_CODENAMES = [
  "operation-mockingbird",
  "operation-paperclip",
  "operation-gladio",
  "operation-condor",
  "operation-cyclone",
  "operation-ajax",
  "operation-northwoods",
  "operation-chaos",
  "operation-mongoose",
  "operation-overlord",
  "operation-valkyrie",
  "operation-barbarossa",
  "operation-market-garden",
  "operation-sea-lion",
  "operation-fortitude",
  "operation-mincemeat",
  "operation-crossbow",
  "operation-dragoon",
  "operation-dynamo",
  "operation-torch",
  "operation-husky",
  "operation-avalanche",
  "operation-shingle",
  "operation-anvil",
  "operation-plunder",
  "operation-varsity",
  "operation-grenade",
  "operation-veritable",
  "operation-lumberjack",
  "operation-undertone",
  "operation-iceberg",
  "operation-downfall",
  "operation-coronet",
  "operation-olympic",
  "operation-magic-carpet",
  "operation-paperback",
  "operation-ivy-bells",
  "operation-gold",
  "operation-stopwatch",
  "operation-wrath-of-god",
];

// ── Screen / OS anonymization ─────────────────────────────────────────────
// Map screen dimensions to classic computer terminal resolutions via
// deterministic HMAC hash so the original values are not recoverable.

const TERMINAL_RESOLUTIONS: [number, number, string][] = [
  [40, 24, "Commodore 64"],
  [80, 24, "VT100"],
  [80, 25, "IBM PC"],
  [80, 43, "EGA"],
  [80, 50, "VGA"],
  [132, 24, "VT100 wide"],
  [132, 43, "VT220 wide"],
  [128, 48, "Wyse 60"],
  [160, 50, "Sun console"],
  [80, 34, "Atari ST"],
  [64, 32, "ZX Spectrum"],
  [40, 25, "Apple II"],
  [80, 48, "Amiga"],
  [80, 60, "SVGA"],
  [120, 50, "DEC VT320"],
  [80, 30, "xterm"],
];

/** Lookup map: "WxH" → "W×H (Terminal Name)" for display in the admin UI. */
const TERMINAL_DISPLAY: Map<string, string> = new Map(
  TERMINAL_RESOLUTIONS.map(([w, h, name]) => [
    `${w}x${h}`,
    `${w}\u00d7${h} (${name})`,
  ]),
);

/** Format a resolution string with terminal name if it matches a known terminal. */
export function terminalDisplayName(resolution: string): string {
  return TERMINAL_DISPLAY.get(resolution) ?? resolution;
}

async function anonymizeScreenSize(
  w: number | null,
  h: number | null,
): Promise<[number | null, number | null]> {
  if (w == null && h == null) return [null, null];
  const input = `${w ?? 0}x${h ?? 0}`;
  const hash = await hmacHex(input);
  const term = TERMINAL_RESOLUTIONS[
    pickIndex(hash, TERMINAL_RESOLUTIONS.length)
  ];
  return [term[0], term[1]];
}

const TROPICAL_BIRDS = [
  "Hoatzin",
  "Paradise Tanager",
  "Flamingo",
  "Harpy Eagle",
  "Blue-crowned Motmot",
  "Crimson Rosella",
  "Keel-billed Toucan",
  "Sun Conure",
  "King Vulture",
  "Mandarin Duck",
  "Painted Bunting",
  "Cock-of-the-rock",
  "Eclectus Parrot",
  "Lilac-breasted Roller",
  "Jabiru Stork",
  "Resplendent Quetzal",
  "Red-legged Honeycreeper",
  "Rainbow Lorikeet",
  "Blue-and-yellow Macaw",
  "Golden Pheasant",
  "Superb Bird-of-Paradise",
  "Hyacinth Macaw",
  "Turquoise-browed Motmot",
  "Scarlet Macaw",
];

/** Map OS name to a tropical bird via deterministic HMAC hash */
async function anonymizeOsName(os: string | null): Promise<string | null> {
  if (!os) return null;
  const hash = await hmacHex(os);
  return TROPICAL_BIRDS[pickIndex(hash, TROPICAL_BIRDS.length)];
}

// ── Browser anonymization ────────────────────────────────────────────────
// Map browser name to "{Mammal}{BodyPart}" and version to a deterministic
// "major.minor" number (e.g. "Badgerhead 49.1").

const MAMMALS = [
  "Badger",
  "Fox",
  "Wolf",
  "Bear",
  "Otter",
  "Elk",
  "Lynx",
  "Hare",
  "Mink",
  "Seal",
  "Moose",
  "Stoat",
  "Beaver",
  "Marten",
  "Hedgehog",
  "Wolverine",
  "Boar",
  "Deer",
  "Squirrel",
  "Reindeer",
  "Weasel",
  "Polecat",
  "Vole",
  "Shrew",
];

const BODY_PARTS = [
  "head",
  "paw",
  "snout",
  "ear",
  "claw",
  "tail",
  "jaw",
  "fang",
  "horn",
  "hoof",
  "mane",
  "whisker",
  "haunch",
  "flank",
  "rump",
  "hide",
];

/** Map browser name to a mammal + body part combo (e.g. "Badgerhead") */
async function anonymizeBrowserName(
  name: string | null,
): Promise<string | null> {
  if (!name) return null;
  const hash = await hmacHex(name);
  const mammal = MAMMALS[pickIndex(hash, MAMMALS.length)];
  const part = BODY_PARTS[pickIndex(hash.slice(8), BODY_PARTS.length)];
  return `${mammal}${part}`;
}

/** Map browser version to a deterministic "major.minor" number (e.g. "49.1") */
async function anonymizeBrowserVersion(
  version: string | null,
): Promise<string | null> {
  if (!version) return null;
  const hash = await hmacHex(version);
  const major = (parseInt(hash.slice(0, 4), 16) % 150) + 1;
  const minor = parseInt(hash.slice(4, 6), 16) % 10;
  return `${major}.${minor}`;
}

/** Map device types to sci-fi vessel classes */
const DEVICE_TYPE_MAP: Record<string, string> = {
  desktop: "mothership",
  tablet: "shuttle",
  mobile: "probe",
};

function anonymizeDeviceType(dt: string | null): string | null {
  if (!dt) return null;
  return DEVICE_TYPE_MAP[dt.toLowerCase()] ?? "unknown-vessel";
}

// ── Form value anonymization ─────────────────────────────────────────────
// Scramble user-typed text to random characters preserving character class
// and length: letters→letters, digits→digits, spaces/punctuation→preserved.

const LOWER = "abcdefghijklmnopqrstuvwxyz";
const UPPER = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
const DIGITS = "0123456789";

async function anonymizeFormValue(
  value: string | null,
): Promise<string | null> {
  if (!value || value.length === 0) return value;
  // Get enough hash bytes to cover the entire string
  const hash = await hmacHex(value);
  const chars: string[] = [];
  for (let i = 0; i < value.length; i++) {
    const ch = value[i];
    // Use two hex chars per character position (wrapping around the hash)
    const byte = parseInt(
      hash.slice((i * 2) % hash.length, (i * 2) % hash.length + 2),
      16,
    );
    if (/[a-z]/.test(ch)) {
      chars.push(LOWER[byte % LOWER.length]);
    } else if (/[A-Z]/.test(ch)) {
      chars.push(UPPER[byte % UPPER.length]);
    } else if (/[0-9]/.test(ch)) {
      chars.push(DIGITS[byte % DIGITS.length]);
    } else {
      // Preserve spaces, punctuation, etc.
      chars.push(ch);
    }
  }
  return chars.join("");
}

// ── Event data sanitization ───────────────────────────────────────────────
// Per-event-type allowlists of data keys that are safe to keep (behavioral
// metrics only — no URLs, no user-supplied text, no custom attributes).

const SAFE_EVENT_KEYS: Record<string, Set<string>> = {
  scroll_depth: new Set(["depth", "path"]),
  bounce: new Set(["dwell", "trigger", "path"]),
  session_end: new Set(["dwell_s", "path"]),
  session_resume: new Set(["path"]),
  web_vital: new Set(["metric", "value", "rating", "path"]),
  click: new Set(["tag", "path"]),
  ad_click: new Set(["tag", "path"]),
  hover: new Set(["tag", "path"]),
  form_focus: new Set([
    "tag",
    "input_type",
    "field_name",
    "form_id",
    "form_name",
    "path",
  ]),
  form_blur: new Set([
    "tag",
    "input_type",
    "field_name",
    "form_id",
    "form_name",
    "value",
    "value_length",
    "path",
  ]),
  form_submit: new Set(["method", "id", "name", "label", "path"]),
  outbound: new Set(["host", "path"]),
  download: new Set(["ext", "path"]),
};

/** Strip event data to only safe behavioral keys for the given event type. */
function sanitizeEventData(eventType: string, dataStr: string): string {
  const allowed = SAFE_EVENT_KEYS[eventType];
  if (!allowed) return "{}";
  try {
    const parsed = JSON.parse(dataStr);
    if (typeof parsed !== "object" || parsed === null) return "{}";
    const clean: Record<string, unknown> = {};
    for (const key of allowed) {
      if (key in parsed) clean[key] = parsed[key];
    }
    return JSON.stringify(clean);
  } catch {
    return "{}";
  }
}

// Keys in sanitized event data that contain user-typed text and must be scrambled
const USER_INPUT_KEYS: Record<string, Set<string>> = {
  form_blur: new Set(["value"]),
};

/** Sanitize event data then anonymize any user-typed text fields. */
async function anonymizeEventData(
  eventType: string,
  dataStr: string,
): Promise<string> {
  const sanitized = sanitizeEventData(eventType, dataStr);
  const scrambleKeys = USER_INPUT_KEYS[eventType];
  if (!scrambleKeys) return sanitized;
  try {
    const parsed = JSON.parse(sanitized);
    if (typeof parsed !== "object" || parsed === null) return sanitized;
    for (const key of scrambleKeys) {
      if (key in parsed && typeof parsed[key] === "string") {
        parsed[key] = await anonymizeFormValue(parsed[key]);
      }
    }
    return JSON.stringify(parsed);
  } catch {
    return sanitized;
  }
}

// ── Public API ───────────────────────────────────────────────────────────────

export function shouldAnonymize(siteId: string): boolean {
  return ANONYMIZE_SITES.has(siteId.toLowerCase());
}

export async function anonymizeView(record: ViewRecord): Promise<ViewRecord> {
  const vidHash = await hmacHex(record.visitor_id);
  const sidHash = record.session_id ? await hmacHex(record.session_id) : null;
  const refHash = record.referrer ? await hmacHex(record.referrer) : null;
  const [anonWidth, anonHeight] = await anonymizeScreenSize(
    record.screen_width,
    record.screen_height,
  );

  return {
    ...record,
    visitor_id: vidHash.slice(0, 16),
    session_id: sidHash
      ? FISHERMEN[pickIndex(sidHash, FISHERMEN.length)]
      : null,
    country_code: record.country_code
      ? PLANETS[pickIndex(await hmacHex(record.country_code), PLANETS.length)]
      : null,
    screen_width: anonWidth,
    screen_height: anonHeight,
    device_type: anonymizeDeviceType(record.device_type),
    os_name: await anonymizeOsName(record.os_name),
    browser_name: await anonymizeBrowserName(record.browser_name),
    browser_version: await anonymizeBrowserVersion(record.browser_version),
    referrer: refHash
      ? `https://nsa-intranet.gov/ops/${
        NSA_CODENAMES[pickIndex(refHash, NSA_CODENAMES.length)]
      }-${refHash.slice(0, 4)}`
      : null,
    utm_source: record.utm_source
      ? OPERATION_CODENAMES[
        pickIndex(await hmacHex(record.utm_source), OPERATION_CODENAMES.length)
      ]
      : record.utm_source,
    utm_medium: record.utm_medium
      ? OPERATION_CODENAMES[
        pickIndex(await hmacHex(record.utm_medium), OPERATION_CODENAMES.length)
      ]
      : record.utm_medium,
    utm_campaign: record.utm_campaign
      ? OPERATION_CODENAMES[
        pickIndex(
          await hmacHex(record.utm_campaign),
          OPERATION_CODENAMES.length,
        )
      ]
      : record.utm_campaign,
    utm_content: record.utm_content
      ? OPERATION_CODENAMES[
        pickIndex(await hmacHex(record.utm_content), OPERATION_CODENAMES.length)
      ]
      : record.utm_content,
    utm_term: record.utm_term
      ? OPERATION_CODENAMES[
        pickIndex(await hmacHex(record.utm_term), OPERATION_CODENAMES.length)
      ]
      : record.utm_term,
  };
}

export async function anonymizeEvent(
  record: SemanticEvent,
): Promise<SemanticEvent> {
  const vidHash = record.visitor_id ? await hmacHex(record.visitor_id) : null;
  const sidHash = record.session_id ? await hmacHex(record.session_id) : null;
  const refHash = record.referrer ? await hmacHex(record.referrer) : null;

  return {
    ...record,
    visitor_id: vidHash ? vidHash.slice(0, 16) : null,
    session_id: sidHash
      ? FISHERMEN[pickIndex(sidHash, FISHERMEN.length)]
      : null,
    device_type: anonymizeDeviceType(record.device_type) ?? "unknown-vessel",
    referrer: refHash
      ? `https://nsa-intranet.gov/ops/${
        NSA_CODENAMES[pickIndex(refHash, NSA_CODENAMES.length)]
      }-${refHash.slice(0, 4)}`
      : null,
    data: await anonymizeEventData(record.event_type, record.data ?? "{}"),
    experiment_id: record.experiment_id
      ? `experiment-${(await hmacHex(record.experiment_id)).slice(0, 8)}`
      : record.experiment_id,
    variant_id: record.variant_id
      ? `variant-${(await hmacHex(record.variant_id)).slice(0, 8)}`
      : record.variant_id,
    utm_campaign: record.utm_campaign
      ? OPERATION_CODENAMES[
        pickIndex(
          await hmacHex(record.utm_campaign),
          OPERATION_CODENAMES.length,
        )
      ]
      : record.utm_campaign,
  };
}
