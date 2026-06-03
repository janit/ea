# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with
code in this repository.

## Project Overview

Echelon Analytics (`ea.js`) — a privacy-first, self-hosted, cookieless web
analytics platform. Single SQLite database, single script tag embed, AGPL-3.0
licensed. The application code lives in `echelon-analytics/`.

## Commands

All commands run from `echelon-analytics/`:

```bash
cd echelon-analytics

# Development server (Vite HMR)
deno task dev

# Production build
deno task build

# Start production server (must build first)
deno task start

# Check formatting, lint, type-check, and run tests
deno task check

# Run server-side tests (unit + integration)
deno task test

# Run browser E2E tests (requires Chromium)
deno task test:e2e

# Individual checks
deno fmt --check .
deno lint .
deno check main.ts

# Update Fresh framework
deno task update
```

### Testing

Tests live in `tests/` with shared helpers in `tests/_helpers.ts`. E2E browser
tests (using `@astral/astral`) are in `tests/e2e/` and require Chromium.
`auth/`, `data/`, `tracker/`, `tracking/`). The `check` task includes
server-side tests, and `scripts/tag-release.sh` runs `deno task check` before
tagging — so tests gate every release.

## Architecture

### Runtime & Framework

Deno + Fresh 2.3.3 (file-system routing with Preact islands). Vite 7 for builds.
Tailwind CSS v4 configured via `@tailwindcss/vite` plugin (config lives in
`assets/styles.css`, not a tailwind config file). Dark terminal aesthetic:
Professional palette (navy/white/red), Inter sans-serif font. Alternative themes
available: Commodore 64 (`c64`), Bad Boys (`badboys`).

### Request Flow

Browser loads `/ea.js` which embeds a dynamically-generated WASM proof-of-work
challenge. After solving, the tracker sends pageviews to `/b.gif` (pixel beacon)
and behavioral events to `POST /e` (sendBeacon). Both endpoints score requests
for bot likelihood (0–100), then push records into in-memory `BufferedWriter`
instances that batch-flush to SQLite every 10–15 seconds.

### Key Directories (`echelon-analytics/`)

- **`routes/`** — File-system routing. Public tracking endpoints (`ea.js.ts`,
  `b.gif.ts`, `e.ts`) at root. Admin UI under `admin/`. REST API under `api/`.
- **`lib/`** — All backend logic: bot scoring (`bot-score.ts`), bot correlator
  (`bot-correlator.ts`), threat feeds (`threat-feeds.ts`), PoW challenge
  generation (`challenge.ts`, `challenge-wasm.ts`), buffered DB writes
  (`buffered-writer.ts`), auth (`auth.ts`, `session.ts`), stats queries
  (`stats.ts`), maintenance/rollups (`maintenance.ts`).
- **`lib/db/`** — SQLite layer: `database.ts` (singleton + migrations, error
  retry on init), `schema.ts` (DDL), `sqlite-adapter.ts` (concrete adapter using
  `node:sqlite`, serialized transactions via queue), `adapter.ts` (interface).
- **`islands/`** — Client-hydrated Preact components (charts, forms, realtime
  panel). Use `@preact/signals` for reactivity.
- **`components/`** — Server-only components (admin nav shell with live stats
  bar).

### Data Layer

Single SQLite database (WAL mode). No ORM — raw SQL queries throughout. Writes
are batched via `BufferedWriter` (generic class in `lib/buffered-writer.ts`).
Two writers: one for `visitor_views`, one for `semantic_events`. The `stop()`
method drains any remaining buffered records before shutdown; on total flush
failure it logs a CRITICAL message with the exact record count and clears the
buffer. Daily rollup at 03:00 UTC aggregates raw views into
`visitor_views_daily` (using INSERT OR REPLACE so re-rollups after bot
correlator corrections update stale aggregates) and purges old data (90-day
default retention, configurable separately for bot-scored data via
`ECHELON_BOT_RETENTION_DAYS`). Purge covers all bot_score ranges including
negative values (server-ingested events use bot_score=-1).

### Authentication

Two modes (can coexist): Bearer token (`ECHELON_SECRET` env var) and
username/password (PBKDF2-SHA256, in-memory sessions with 24h TTL). Auth
middleware at `routes/admin/_middleware.ts` and `routes/api/_middleware.ts`.
CSRF protection on cookie-authenticated mutating requests (POST, PUT, PATCH,
DELETE) via Origin/Referer header validation against Host.

### Anti-Bot System

Multi-layer detection with synchronous and asynchronous components:

1. **Known bot UAs** — `isKnownBot()` in `lib/bot-score.ts` drops matching
   requests immediately (Googlebot, GPTBot, HeadlessChrome, Amzn-SearchBot,
   etc.)
2. **Two-tier bot IP map** — ephemeral in-memory maps in `lib/bot-score.ts`.
   _Suspected_ (+20, 30-min TTL): fed by headless UA leaks in the root
   middleware — low penalty to avoid false positives on shared NAT/VPN IPs.
   _Confirmed_ (+50, 1h TTL): fed by correlator-verified clusters — high penalty
   backed by statistical evidence.
3. **Threat intelligence feeds** — `lib/threat-feeds.ts` fetches four community
   feeds every 6 hours: monperrus/crawler-user-agents (600+ regex patterns,
   +30), ai-robots-txt/robots.json (130+ AI bot names, +40), AWS
   ip-ranges.json + GCP cloud.json (IPv4 + IPv6 datacenter CIDRs merged for
   O(log n) lookup, +15). Matchers are synchronous; only the refresh is async.
4. **Bot correlator** — `lib/bot-correlator.ts` runs a background sweep every 2
   minutes. Each beacon request records an ephemeral "print" (IP hash, visitor
   ID, fingerprint: OS/browser/version/screen/country/Accept-Language). The
   sweep clusters identical fingerprints across distinct IPs on the same site.
   Clusters ≥ 6 IPs (≥ 4 if any is confirmed bot) get retroactive bot_score
   updates in the DB (+30 normal, +50 for large/tainted clusters), wrapped in a
   transaction for atomicity across `visitor_views` and `semantic_events`.
   Confirmed IPs are fed back into the confirmed bot IP map for immediate
   scoring.
5. **PoW challenges** — `lib/tracker.ts` generates `/ea.js` with an embedded
   WASM blob (rotates every 6 hours) and per-minute PoW challenges. Missing,
   invalid, or replayed tokens add penalty points. The nonce cache keys on
   `tok:sid:siteId` to prevent cross-site token replay on multi-tenant
   instances.
6. **Heuristic scoring** — `lib/bot-score.ts` scores every request using timing,
   geo, headers, burst detection, screen dimensions, Cloudflare signals. Scores
   ≥ 50 are excluded from rollups.
7. **No-event bounce detection** — during each correlator sweep, `visitor_views`
   records aged 5–30 minutes with zero matching `semantic_events` receive +15
   penalty. Real users trigger scroll, click, hover, or web vital events within
   seconds; bots that hit-and-leave do not.

### API Validation

API endpoints use `validateSiteIdStrict()` which returns null for invalid site
IDs (tracking endpoints use the lenient `validateSiteId()` that falls back to
"default"). Campaign creation validates `site_id` with `validateSiteId()` and
strips control characters from both `name` and `utm_campaign`. Experiments
enforce a state machine: draft → active → paused/completed, paused → active,
completed → archived. Status transitions are atomic (`AND status = ?` in the
UPDATE) to prevent TOCTOU races; concurrent transitions return 409 Conflict.
Variant weights must be finite positive numbers. Error responses follow
`{ error: "code", message: "text" }` format.

### Single-Process Constraint

All state (sessions, rate limiter, burst maps, UTM cache, buffered writers, bot
IP map, correlator prints, threat feed data) is in-memory. Must run with a
single Deno worker — do not use `--parallel` flag with `deno serve`.

### Import Alias

`@/` maps to the `echelon-analytics/` root (configured in `deno.json`).

### MCP Server

A read-only MCP server (`mcp-server.ts`) exposes analytics data to AI agents via
stdio transport. It calls the Echelon REST API over HTTP — works with any
instance (local, remote, Docker, cloud). Requires `ECHELON_URL` env var; uses
`ECHELON_SECRET` as Bearer token for authenticated instances.

```bash
ECHELON_URL=https://ea.islets.app deno task mcp
```

Tools (9 total, all read-only): `analytics_overview`, `analytics_realtime`,
`analytics_campaigns`, `analytics_campaign_detail`, `analytics_experiments`,
`analytics_dashboard`, `analytics_campaign_events`, `list_campaigns`,
`list_experiments`. Auto-discovered by Claude Code via `.claude/settings.json`.
