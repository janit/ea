// Test helpers — shared utilities for the Echelon Analytics test suite.

import { DatabaseSync } from "node:sqlite";
import { SqliteAdapter } from "@/lib/db/sqlite-adapter.ts";
import { SCHEMA_SQL } from "@/lib/db/schema.ts";
import type { DbAdapter } from "@/lib/db/adapter.ts";

/** Create an in-memory SQLite database with the full schema applied. */
export function createTestDb(): DbAdapter {
  const raw = new DatabaseSync(":memory:");
  raw.exec("PRAGMA journal_mode = WAL");
  raw.exec("PRAGMA foreign_keys = ON");
  const db = new SqliteAdapter(raw);
  raw.exec(SCHEMA_SQL);
  return db;
}

// ── Date constants ──────────────────────────────────────────────────────────

const _now = new Date();
export const TODAY = _now.toISOString().slice(0, 10);

const _yesterday = new Date(_now);
_yesterday.setUTCDate(_yesterday.getUTCDate() - 1);
export const YESTERDAY = _yesterday.toISOString().slice(0, 10);

const _weekAgo = new Date(_now);
_weekAgo.setUTCDate(_weekAgo.getUTCDate() - 7);
export const WEEK_AGO = _weekAgo.toISOString().slice(0, 10);

// ── Fixture inserters ───────────────────────────────────────────────────────

export interface ViewOverrides {
  visitor_id?: string;
  path?: string;
  site_id?: string;
  session_id?: string | null;
  interaction_ms?: number | null;
  screen_width?: number | null;
  screen_height?: number | null;
  device_type?: string | null;
  os_name?: string | null;
  browser_name?: string | null;
  browser_version?: string | null;
  country_code?: string | null;
  is_returning?: number;
  referrer?: string | null;
  referrer_type?: string;
  bot_score?: number;
  is_pwa?: number;
  utm_source?: string | null;
  utm_medium?: string | null;
  utm_campaign?: string | null;
  utm_content?: string | null;
  utm_term?: string | null;
  created_at?: string;
}

export async function insertView(
  db: DbAdapter,
  overrides: ViewOverrides = {},
): Promise<void> {
  const v = {
    visitor_id: "abc123def456abc0",
    path: "/",
    site_id: "test-site",
    session_id: null,
    interaction_ms: 1500,
    screen_width: 1920,
    screen_height: 1080,
    device_type: "desktop",
    os_name: "Linux",
    browser_name: "Chrome",
    browser_version: "120.0.0.0",
    country_code: "NO",
    is_returning: 0,
    referrer: null,
    referrer_type: "direct_or_unknown",
    bot_score: 0,
    is_pwa: 0,
    utm_source: null,
    utm_medium: null,
    utm_campaign: null,
    utm_content: null,
    utm_term: null,
    created_at: new Date().toISOString(),
    ...overrides,
  };
  await db.run(
    `INSERT INTO visitor_views
      (visitor_id, path, site_id, session_id, interaction_ms,
       screen_width, screen_height, device_type, os_name, browser_name, browser_version,
       country_code,
       is_returning, referrer, referrer_type, bot_score, is_pwa,
       utm_source, utm_medium, utm_campaign, utm_content, utm_term, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    v.visitor_id,
    v.path,
    v.site_id,
    v.session_id,
    v.interaction_ms,
    v.screen_width,
    v.screen_height,
    v.device_type,
    v.os_name,
    v.browser_name,
    v.browser_version,
    v.country_code,
    v.is_returning,
    v.referrer,
    v.referrer_type,
    v.bot_score,
    v.is_pwa,
    v.utm_source,
    v.utm_medium,
    v.utm_campaign,
    v.utm_content,
    v.utm_term,
    v.created_at,
  );
}

export interface EventOverrides {
  event_type?: string;
  site_id?: string;
  session_id?: string | null;
  visitor_id?: string | null;
  data?: string | null;
  experiment_id?: string | null;
  variant_id?: string | null;
  utm_campaign?: string | null;
  device_type?: string;
  referrer?: string | null;
  hour?: number;
  month?: number;
  day_of_week?: number;
  is_returning?: number;
  bot_score?: number;
  created_at?: string;
}

export async function insertEvent(
  db: DbAdapter,
  overrides: EventOverrides = {},
): Promise<void> {
  const e = {
    event_type: "click",
    site_id: "test-site",
    session_id: null,
    visitor_id: "abc123def456abc0",
    data: "{}",
    experiment_id: null,
    variant_id: null,
    utm_campaign: null,
    device_type: "desktop",
    referrer: null,
    hour: 12,
    month: 3,
    day_of_week: 1,
    is_returning: 0,
    bot_score: 0,
    created_at: new Date().toISOString(),
    ...overrides,
  };
  await db.run(
    `INSERT INTO semantic_events
      (event_type, site_id, session_id, visitor_id, data,
       experiment_id, variant_id, utm_campaign,
       device_type, referrer, hour, month, day_of_week,
       is_returning, bot_score, created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    e.event_type,
    e.site_id,
    e.session_id,
    e.visitor_id,
    e.data,
    e.experiment_id,
    e.variant_id,
    e.utm_campaign,
    e.device_type,
    e.referrer,
    e.hour,
    e.month,
    e.day_of_week,
    e.is_returning,
    e.bot_score,
    e.created_at,
  );
}

export interface DailyOverrides {
  site_id?: string;
  date?: string;
  device_type?: string;
  country_code?: string;
  is_returning?: number;
  visits?: number;
  unique_visitors?: number;
  avg_interaction_ms?: number;
}

export async function insertDailyRollup(
  db: DbAdapter,
  overrides: DailyOverrides = {},
): Promise<void> {
  const d = {
    site_id: "test-site",
    date: YESTERDAY,
    device_type: "desktop",
    country_code: "NO",
    is_returning: 0,
    visits: 100,
    unique_visitors: 80,
    avg_interaction_ms: 2000,
    ...overrides,
  };
  await db.run(
    `INSERT OR REPLACE INTO visitor_views_daily
      (site_id, date, device_type, country_code, is_returning,
       visits, unique_visitors, avg_interaction_ms)
     VALUES (?,?,?,?,?,?,?,?)`,
    d.site_id,
    d.date,
    d.device_type,
    d.country_code,
    d.is_returning,
    d.visits,
    d.unique_visitors,
    d.avg_interaction_ms,
  );
}

/** Build a Request with sensible defaults. */
export function fakeRequest(
  path: string,
  init?: RequestInit & { host?: string },
): Request {
  const host = init?.host ?? "analytics.example.com";
  const url = `https://${host}${path}`;
  const headers = new Headers(init?.headers);
  if (!headers.has("host")) headers.set("host", host);
  if (!headers.has("user-agent")) {
    headers.set(
      "user-agent",
      "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/120.0.0.0",
    );
  }
  return new Request(url, { ...init, headers });
}

/** Mock FreshContext for testing middleware/handlers. */
export function mockFreshCtx(
  req: Request,
  stateOverrides: Record<string, unknown> = {},
) {
  const state: Record<string, unknown> = {
    isAuthenticated: false,
    ...stateOverrides,
  };
  return {
    req,
    state,
    url: new URL(req.url),
    next: () => Promise.resolve(new Response("OK", { status: 200 })),
  };
}

/** Solve the current PoW challenge the way ea.js does, for `site` + `sid`. */
export async function solvePow(site: string, sid: string): Promise<string> {
  const { generateChallenge, getWasmBase64 } = await import(
    "@/lib/challenge.ts"
  );
  const challenge = await generateChallenge();
  const bin = atob(await getWasmBase64());
  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  const { instance } = await WebAssembly.instantiate(bytes);
  const memory = instance.exports.memory as WebAssembly.Memory;
  const solve = instance.exports.solve as (
    ptr: number,
    len: number,
    out: number,
  ) => void;
  const input = new TextEncoder().encode(challenge + ":" + sid + ":" + site);
  const mem = new Uint8Array(memory.buffer);
  mem.set(input, 0);
  solve(0, input.length, 2048);
  return Array.from(mem.slice(2048, 2064))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** Run the real /api auth middleware in a subprocess with `env` set. */
export async function probeApiAuth(
  env: Record<string, string>,
  cases: {
    method: string;
    path: string;
    headers?: Record<string, string>;
    session?: boolean;
  }[],
): Promise<{ status: number; authenticated: boolean }[]> {
  const probe = new URL("./_api-auth-probe.ts", import.meta.url).pathname;
  const config = new URL("../deno.json", import.meta.url).pathname;
  const out = await new Deno.Command(Deno.execPath(), {
    args: [
      "run",
      "-A",
      "--no-check",
      "--config",
      config,
      probe,
      JSON.stringify(cases),
    ],
    env: {
      ECHELON_PUBLIC_MODE: "",
      ECHELON_SECRET: "",
      ECHELON_USERNAME: "",
      ...env,
    },
    stdout: "piped",
    stderr: "piped",
  }).output();
  if (!out.success) throw new Error(new TextDecoder().decode(out.stderr));
  const lines = new TextDecoder().decode(out.stdout).trim().split("\n");
  return JSON.parse(lines[lines.length - 1]);
}
