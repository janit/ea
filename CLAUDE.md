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
deno check main.ts mcp-server.ts routes/ lib/ islands/ components/

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
and behavioral events to `POST /e` (sendBeacon). The first real gesture on each
pageview sends an `engage` event, which is what later proves the view had a
person behind it. Both endpoints score requests for bot likelihood (0–100), then
push records into in-memory `BufferedWriter` instances that batch-flush to
SQLite every 10–15 seconds.

### Key Directories (`echelon-analytics/`)

- **`routes/`** — File-system routing. Public tracking endpoints (`ea.js.ts`,
  `b.gif.ts`, `e.ts`) at root. Admin UI under `admin/`. REST API under `api/`.
- **`lib/`** — All backend logic: bot scoring (`bot-score.ts`), bot correlator
  (`bot-correlator.ts`), threat feeds (`threat-feeds.ts`), PoW challenge
  generation (`challenge.ts`, `challenge-wasm.ts`), buffered DB writes
  (`buffered-writer.ts`), auth (`auth.ts`, `session.ts`), stats queries
  (`stats.ts`), maintenance/rollups (`maintenance.ts`), session classifier
  (`session-classifier.ts`), pageview beacon dedup (`beacon-dedup.ts`), per-site
  home country/language (`site-home.ts`) and the country-to-continent table
  (`geo.ts`).
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
`visitor_views_daily` and purges old data. Each date is re-rolled from its raw
rows just before they are purged, so the surviving aggregate reflects later
bot-correlator and exclusion corrections; `getOverview` reads raw rows for every
date still in retention and the rollup only for purged dates (90-day default
retention, configurable separately for bot-scored data via
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
3. **Threat intelligence feeds** — `lib/threat-feeds.ts` fetches six community
   and provider feeds every 6 hours: monperrus/crawler-user-agents (600+ regex
   patterns, +30), ai-robots-txt/robots.json (130+ AI bot names, +40), and
   datacenter CIDRs from AWS, GCP, DigitalOcean and Oracle Cloud (IPv4 + IPv6,
   merged for O(log n) lookup, +24). Each provider's ranges are retained
   independently: a refresh that fails, parses to nothing or is under 10% of the
   prior size is discarded and the old ranges stay. Malformed entries and `/0`
   prefixes are skipped. Matchers are synchronous; only the refresh is async.
4. **Bot correlator** — `lib/bot-correlator.ts` runs a background sweep every 2
   minutes. Each beacon request records an ephemeral "print" (IP hash, visitor
   ID, fingerprint: OS/browser/version/screen/country/Accept-Language). The
   sweep clusters identical fingerprints across distinct IPs on the same site.
   Clusters ≥ 6 IPs (≥ 4 if any is confirmed bot) get retroactive bot_score
   updates in the DB (+30 normal, +50 for large/tainted clusters), wrapped in a
   transaction for atomicity across `visitor_views` and `semantic_events`
   (including rows of anonymised sites). Two guards apply before any visitor is
   penalised: their first print must be at least 12 minutes old, and they must
   not be a proven human (`lib/proven-human.ts`: owns a `validated = 1` view
   that is not from a datacenter IP). Only penalised visitors' IPs are fed back
   into the confirmed bot IP map for immediate scoring.
5. **PoW challenges** — `lib/tracker.ts` generates `/ea.js` with an embedded
   WASM blob and a per-minute challenge. The blob rotates every 6 hours on a
   calendar boundary and, when `ECHELON_SECRET` is set, is derived from it, so a
   restart does not invalidate tokens in flight. The tracker re-solves against a
   fresh challenge from `GET /c` once its token is 4 minutes old. A missing
   token adds 30 on both endpoints; an invalid one adds 50 on `/b.gif` and 40 on
   `/e` (`tokenPenalty` in `lib/challenge.ts`). Either is waived, and recorded
   as `pow_ok`, for a session or visitor that presented a valid token on the
   same site within the last hour (`lib/proven-sessions.ts`); `pow_ok_by`
   records which key granted the waiver (`"s"` session, `"v"` visitor). The 30
   for a missing token is lenient at ingest only (a browser without WebAssembly
   looks like a bot): the engagement gate (item 7) raises such a view to the
   threshold if it never interacted. The nonce cache keys on `tok:sid:siteId` to
   prevent cross-site token replay.
6. **Heuristic scoring** — `lib/bot-score.ts` scores every request. Every weight
   lives in `DEFAULT_WEIGHTS` and can be overridden per signal with
   `ECHELON_BOT_SCORE_WEIGHTS` (`key:points,key:points`, 0–100; an unknown key
   or bad value is skipped with one startup warning; 0 switches the signal off).
   Signals: timing, suspect countries, headers, burst, screen dimensions,
   Cloudflare, threat feeds, plus device signals (`win_tablet_mismatch` +34: a
   Windows user agent with a reported `screen.width` of 768–1024 CSS px;
   `linux_desktop` +10, scored on the pageview beacon only: the events endpoint
   passes `surface: "events"`), `cross_site` +34 (one address + user agent on 3+
   of the instance's sites within an hour, scored on the pageview beacon only,
   and never recorded when the client address cannot be resolved), and geography
   signals measured against the site's declared home country and language
   (`lib/site-home.ts`, `lib/geo.ts`): `country_mismatch` +15, `cross_continent`
   +8, `global_common_foreign` +15 (with a Windows tablet), `linux_foreign` +30,
   `stale_android_foreign` +40. The last two need `country_mismatch` too.
   Geography is opt-in per site (`site_settings.home_country`, `home_language`,
   set under Settings → Home Audience or `PATCH /api/sites/:id`) and does
   nothing for a site with no home country. The home country must be a code in
   the continent table or `RU` (`normalizeCountry`); anything else is refused
   with a 400, and a stored one reads as unset (`loadSiteHomes`, which the
   scorer's cache and the session classifier share). `RU` has no continent, so
   on a site whose home is `RU` every visitor from another country is a
   mismatch, bar the global-common exemption on English-language sites. Site
   settings are matched without regard to case, and one rule picks a site's row
   for every reader (home cache, classifier, consent CSS cache, API, settings
   page): the last in `site_id` order among rows with that case-folded id
   (`loadSiteSettings`, `findSiteSettings`). Costs to real visitors: on a
   non-English home language, a Linux desktop or Android 6-or-older visitor from
   a global-common country (US CA AU NZ JP KR SG IN TR RU MA AE MX PK) scores
   over the threshold from these signals alone and is not counted; other foreign
   visitors carry 15–23 points. A Windows laptop with display scaling can report
   a width in the tablet band (1280 at 125 %, 1366 at 150 %) and carry +34.
   Siblings that one person browses together trip `cross_site`, and because
   browsers now send near-identical user agents, people sharing one address
   (office, campus, mobile carrier) pool too; set `cross_site:0` on an instance
   whose sites share an audience. `win_tablet_mismatch`, `cross_site` and
   `datacenter_ip` are 34, 34 and 24 so that one of them plus the gate's
   `no_events` 15 (or `datacenter_ip` + `timing_fast` + `referrer`) stays under
   the threshold; `tests/bot-stacks_test.ts` holds those sums. With the default
   `ECHELON_BOT_DISCARD_THRESHOLD` of 50 a request at or over the threshold at
   write time is not stored; 0 stores everything (still excluded from
   statistics). Scores ≥ 50 are excluded from rollups. The cut-off and its SQL
   predicates (`CLEAN_SQL`, `BOT_SQL`) live in `lib/bot-threshold.ts` — never
   hand-type `BETWEEN 0 AND 49`; the partial index must match the query text
   exactly.
7. **Proof of interaction** — `bot_score` is suspicion; `validated` is proof.
   The tracker sends one `engage` event per pageview on the first trusted
   pointerdown, keydown or touchstart (re-armed on SPA navigation).
   `lib/event-classes.ts` splits every event type into interaction or passive
   (snapshot-tested: classify any new type there; scroll alone is passive).
   `lib/view-validator.ts` (every 60 s, 15 min lookback, matched per session, or
   per visitor when there is no session id) sets `visitor_views.validated = 1`
   when the view is clean, its session has a clean interaction event, and the
   page outlived its load (`session_end` with `dwell_s >= 2`, or an interaction
   at least 10 s after the view plus two distinct interaction types). Each run
   reads the events inside the lookback once (`idx_se_created_bot`) into a
   per-key summary in a temp table and matches fresh views to it by key, so its
   cost does not depend on how many rows one session or visitor has.
   `lib/engagement-gate.ts` runs in each correlator sweep: views aged 5–30
   minutes with no interaction get +15 (`no_events`), or are raised to the
   threshold (`unproven`) if they also carry a PoW penalty or were waived only
   by the visitor key (`pow_ok_by: "v"`). Both marks store the amount they added
   and are provisional: every sweep first forgives views up to 180 minutes old
   whose session has interacted since (the amount is subtracted and the mark
   removed, so the validator can validate the view), unless another job has
   judged the view in the meantime (`correlated`, `classifier`, `no_engagement`)
   or its visitor is in `excluded_visitors`. With
   `ECHELON_REQUIRE_ENGAGEMENT=true` (default off), views and events aged 30–180
   minutes of a session that never interacted are moved to the threshold
   (`no_engagement`); that is not undone. A session that interacted at any time
   is shielded as a whole; validated views are never touched. On anonymised
   sites (`ECHELON_ANONYMIZE_SITES`) the stored session id is one of 50 names
   that unrelated visits share, so the validator and the gate judge those sites'
   rows by the stored visitor id instead: an interaction counts for a row only
   if it has the same visitor id and lies within 30 minutes of the row. The gate
   looks rows up through partial indexes (`idx_se_clean_interaction`,
   `idx_vv_validated`, and the visitor-keyed `idx_se_clean_interaction_visitor`
   and `idx_vv_validated_visitor`); its statements name them with `INDEXED BY`
   and all are ensured in `migrate()`. The overview returns `validated_visitors`
   and the dashboard shows a "Validated Visitors" card. The missing-token score
   of 30 relies on the gate; ship them together.
8. **Session classifier** — `lib/session-classifier.ts` runs two minutes after
   start and then every 15 minutes over the last 30 minutes of `visitor_views`,
   judging an identity once its oldest view in the window is 12 minutes old:
   `session_velocity` (6+ views on 6+ distinct pathnames averaging ≤ 3 s apart,
   taken in time order with each run of consecutive views of one pathname
   counted once, at its first; views differing only in query string or fragment
   are one page), `os_rotation` (3+ OS names in one vendor family),
   `os_family_flip` (2+ families among Apple, Android, Windows on one session or
   visitor) and `burst_cohort` (40+ single-view sessions sharing site, country
   and screen size, from a different continent than the site's home country;
   needs a home country; does nothing when either country has no known
   continent). Flagged rows are stamped `BOT_EXCLUDE_SCORE` (60) with detail key
   `classifier`, and the visitor is added to `excluded_visitors` as
   `auto:<reason>`; daily maintenance removes those after 30 days (by the
   `auto:` label alone; a manual exclude via `POST /api/bots/exclude` replaces
   an `auto:` label and so is permanent). `session_velocity` and `os_rotation`
   skip proven humans; `os_family_flip` and `burst_cohort` apply even to
   visitors with a validated view, because their signatures cannot contain a
   real person (but a DevTools device emulation or user-agent switcher in one
   tab can trip `os_family_flip` on its owner). On anonymised sites
   session-keyed findings are skipped.
9. **Beacon dedup** — `lib/beacon-dedup.ts` answers a pageview beacon normally
   but does not count it when its (site, session, nonce) was already recorded in
   the last 10 minutes. The tracker draws a random 16-hex-character nonce (`_n`,
   `pageviewNonce` in `lib/tracker.ts`) once per landing pageview, so a
   redelivery repeats it and a reload gets a new one. A beacon without a
   well-formed nonce is always counted; SPA navigation beacons and beacons
   without a session id are exempt.

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
IP map, correlator prints, threat feed data, proven-identity store, cross-site
map, beacon dedup map, site home cache) is in-memory. Must run with a single
Deno worker — do not use `--parallel` flag with `deno serve`.

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
