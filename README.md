# ea.js — Echelon Analytics 🩺

Privacy-first, self-hosted web analytics with **WebAssembly proof-of-work bot
defense**. Drop in a single script tag — clean data, no cookie banners, no bot
spam.

The name is a deliberate nod to Google Analytics' legacy `ga.js` tracking
script.

## Why?

Google Analytics used to be my go-to for web analytics. Then it became
impossible to use — bloated, confusing, way too heavy for what most sites
actually need, and full of bot spam that distorts your statistics. Using GA4
feels like opening Microsoft Word when all you want is a text editor.

So I built my own analytics for a hobby project
([afroute.com](https://afroute.com)). It started simple — just pageviews and
basic stats — but grew in functionality over time. Eventually I wanted to rip it
out into its own project, and figured: why not share it, in case others are
equally tired of ga.js?

## WASM Proof-of-Work Bot Defense

The core differentiator: every tracker script embeds a **runtime-generated
WebAssembly module** that browsers must solve before pageviews are accepted.

- WASM blob is regenerated from a random seed every **6 hours** — each
  deployment produces unique bytecode
- SipHash-inspired algorithm with randomized constants — bot toolkits can't
  pre-compute solutions
- Per-minute challenge rotation via HMAC-SHA256
- Invisible to users — solves in <150ms in any modern browser
- Missing or invalid tokens add penalty points to the visitor's bot score (0–100)
- Combined with heuristic scoring, Cloudflare integration, burst detection, and
  UA blocklists

The result: **clean analytics data** without CAPTCHAs, JavaScript challenges, or
third-party bot detection services.

## Quick Start

```bash
cd echelon-analytics
deno task dev
```

Add to any site:

```html
<script src="https://your-echelon-host/ea.js" data-site="my-site"></script>
```

That's it. Pageviews, bounces, and sessions are tracked automatically.

## Development

The application code lives in `echelon-analytics/`. All commands run from there:

```bash
cd echelon-analytics

# Development server with hot reload (Vite)
deno task dev

# Production build
deno task build

# Start production server (must build first)
deno task start

# Check formatting, lint, and type-check
deno task check

# Update Fresh framework
deno task update
```

### Generating a Password Hash

```bash
deno eval "import{hashPassword}from'./lib/auth.ts';console.log(await hashPassword('yourpassword'))"
```

Use the output as `ECHELON_PASSWORD_HASH`.

## How It Works

Echelon uses a 1x1 pixel beacon (`/b.gif`) for pageview tracking and
`sendBeacon` for behavioral events.

**Cookieless by default.** Unique visitors are counted using a daily-rotating
HMAC hash of IP + User-Agent + site ID. The hash resets every day — there is no
cross-day tracking and no cookies are set. This means no cookie consent banners
are needed under GDPR/ePrivacy.

If you need persistent visitor identity (returning visitor detection), opt in
with `data-cookie` — this sets an HttpOnly cookie and requires appropriate
consent.

All analytics data lives in a single SQLite database with WAL mode for
concurrent access.

### SPA Support

Single-page applications are supported automatically. The tracker patches
`history.pushState` and `history.replaceState` and listens to `popstate`,
firing new pageview beacons on route changes.

## Script Tag Options

```html
<script
  src="https://echelon.example.com/ea.js"
  data-site="my-site"
  data-clicks
  data-scroll
  data-hover
  data-outbound
  data-downloads
  data-forms
  data-vitals
></script>
```

| Attribute        | What it tracks                                                          |
| ---------------- | ----------------------------------------------------------------------- |
| `data-site`      | Site identifier (required)                                              |
| `data-cookie`    | Enable persistent visitor cookie (requires consent)                     |
| `data-clicks`    | Click events on elements with `data-echelon-click`                      |
| `data-scroll`    | Scroll depth milestones (25/50/75/90/100%)                              |
| `data-hover`     | Hover events (1s dwell threshold) on elements with `data-echelon-hover` |
| `data-outbound`  | Outbound link click tracking                                            |
| `data-downloads` | File download click tracking (pdf, zip, exe, mp3, mp4, etc.)            |
| `data-forms`     | Form submission tracking                                                |
| `data-vitals`    | Core Web Vitals (LCP, CLS, INP) via PerformanceObserver                |

### Markup for Clicks and Hovers

```html
<button data-echelon-click="signup" data-echelon-plan="pro">Sign Up</button>
<div data-echelon-hover="pricing card" data-echelon-tier="enterprise">...</div>
```

All `data-echelon-*` attributes are collected into the event payload
automatically.

### JavaScript API

Track custom events programmatically:

```js
window.echelon.track("event_name", { key: "value" });
```

Event names are truncated to 128 characters. Property objects support up to 16
keys (keys max 64 chars, values max 512 chars).

## Auto-Captured Events

These fire without any markup:

| Event          | Trigger                                                     |
| -------------- | ----------------------------------------------------------- |
| Pageview       | First real user interaction (800ms gate, `isTrusted` check) |
| Bounce         | No interaction for 120s, or page hidden without engagement  |
| Session end    | Page hidden or `pagehide`                                   |
| Session resume | Tab returns to visible                                      |

## API Endpoints

### Public (no auth, CORS-enabled)

| Endpoint          | Purpose                               |
| ----------------- | ------------------------------------- |
| `GET /ea.js`      | Tracker script (with embedded PoW)    |
| `GET /b.gif`      | Pixel beacon (pageview recording)     |
| `POST /e`         | Semantic events (sendBeacon receiver) |
| `GET /api/health` | Health check                          |

### Authenticated (Bearer token or session cookie)

**Stats:**

| Endpoint                                       | Purpose                                                                                    |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------ |
| `GET /api/stats/overview?site_id=x&days=30`    | Dashboard overview — visits, uniques, top paths, devices, countries, referrers, daily trend |
| `GET /api/stats/realtime?site_id=x`            | Active visitors in last 5 minutes                                                          |
| `GET /api/stats/summary`                       | Buffer sizes + last 24h view/visitor counts                                                |
| `GET /api/stats/vitals`                        | Live request statistics                                                                    |
| `GET /api/stats/experiments`                   | A/B experiment results                                                                     |
| `GET /api/stats/campaigns?days=30`             | UTM campaign stats                                                                         |
| `GET /api/stats/campaigns?id=x&days=30`        | Single campaign detail with source/medium breakdown                                        |

**Bot Management:**

| Endpoint                               | Purpose                               |
| -------------------------------------- | ------------------------------------- |
| `GET /api/bots/suspicious?min_score=25`| List visitors by bot score            |
| `GET /api/bots/excluded`               | List blocked visitors                 |
| `POST /api/bots/exclude`               | Block a visitor `{visitor_id, label}`  |
| `DELETE /api/bots/exclude/:visitor_id` | Unblock a visitor                     |
| `GET /api/bots/visitor/:visitor_id`    | Full visitor history and bot scores   |

**Experiments:**

| Endpoint                     | Purpose                  |
| ---------------------------- | ------------------------ |
| `GET /api/experiments`       | List experiments         |
| `POST /api/experiments`      | Create experiment        |
| `PATCH /api/experiments/:id` | Update experiment status |

**UTM Campaigns:**

| Endpoint                    | Purpose                |
| --------------------------- | ---------------------- |
| `GET /api/campaigns`        | List campaigns         |
| `POST /api/campaigns`       | Create campaign        |
| `GET /api/campaigns/:id`    | Campaign detail        |
| `PATCH /api/campaigns/:id`  | Update campaign status |

**Performance Metrics:**

| Endpoint                | Purpose                                        |
| ----------------------- | ---------------------------------------------- |
| `GET /api/perf`         | Query stored metrics (category, metric, limit)  |
| `POST /api/perf`        | Ingest metric array (for CI/CD benchmarks)     |
| `GET /api/perf/trends`  | Metric trend data                              |

**Batch Ingest:**

| Endpoint            | Purpose                                    |
| ------------------- | ------------------------------------------ |
| `POST /api/ingest`  | Batch event ingestion (v1 protocol, 1MB max)|

**Site Settings:**

| Endpoint               | Purpose                           |
| ---------------------- | --------------------------------- |
| `PATCH /api/sites/:id` | Update per-site settings (consent CSS) |

**Admin UI** is available at `/admin/` with pages for dashboard, realtime
visitors, bot management, A/B experiments, UTM campaigns, performance metrics,
and per-site settings.

## Bot Scoring

Every request is scored 0–100 based on heuristics:

| Signal                             | Points |
| ---------------------------------- | ------ |
| Cloudflare bot score ≤ 2           | +50    |
| Cloudflare bot score 3–29          | +30    |
| Cloudflare bot score 30–50         | +10    |
| Cloudflare verified bot            | +15    |
| PoW token invalid                  | +25    |
| PoW token missing                  | +15    |
| Interaction time < 850ms           | +20    |
| Interaction time 850–999ms         | +8     |
| Suspect country (configurable)     | +30    |
| Burst > 15 requests / 5 min        | +25    |
| Missing Accept-Language            | +10    |
| Missing Sec-CH-UA + Sec-Fetch-Site | +10    |
| Unrealistic screen dimensions      | +10    |
| No referrer + deep path            | +5     |

Visitors scoring ≥ 50 are excluded from daily rollups. Known bot User-Agents
(Googlebot, GPTBot, ClaudeBot, curl, etc.) are dropped immediately before
scoring.

Referrer traffic is classified as `ai` (ChatGPT, Claude, Perplexity, Gemini),
`search` (Google, Bing, DuckDuckGo, etc.), `social` (Facebook, X, Reddit,
LinkedIn), or `direct_or_unknown`.

IP addresses are never stored — only ephemeral HMAC hashes with daily key
rotation.

## Authentication

Two independent auth modes (can be used simultaneously):

- **Bearer token**: Set `ECHELON_SECRET` — used in `Authorization: Bearer <token>` header.
- **Username + password**: Set `ECHELON_USERNAME` and `ECHELON_PASSWORD_HASH` (PBKDF2-SHA256, 600k iterations). Login form at `/admin/login` creates a 24h session cookie. Login attempts are rate-limited per IP (5 attempts / 15 min).

## Configuration

| Environment Variable              | Default             | Purpose                                                    |
| --------------------------------- | ------------------- | ---------------------------------------------------------- |
| `ECHELON_PORT`                    | `1947`              | Server port                                                |
| `ECHELON_DB_PATH`                 | `./echelon.db`      | SQLite database path                                       |
| `ECHELON_SECRET`                  | _(empty = no auth)_ | Bearer token for authenticated endpoints                   |
| `ECHELON_USERNAME`                | _(empty)_           | Username for admin login                                   |
| `ECHELON_PASSWORD_HASH`           | _(empty)_           | PBKDF2 password hash for admin login                       |
| `ECHELON_RETENTION_DAYS`          | `90`                | Raw data retention period (days)                           |
| `ECHELON_SUSPECT_COUNTRIES`       | `CN`                | Comma-separated country codes for bot scoring              |
| `ECHELON_SUSPECT_POINTS`          | `30`                | Points added for suspect countries                         |
| `ECHELON_BOT_DISCARD_THRESHOLD`   | `0`                 | Bot score at which to drop requests entirely (0 = store all)|
| `ECHELON_BOT_UA_PATTERNS`         | _(long default)_    | Comma-separated bot UA substrings to drop silently         |
| `ECHELON_ALLOWED_ORIGINS`         | _(empty = open)_    | Restrict which domains can send tracking data              |
| `ECHELON_RATE_LIMIT_MAX`          | `100`               | Max requests per IP per window on tracking endpoints       |
| `ECHELON_RATE_LIMIT_WINDOW_MS`    | `60000`             | Rate limit window in ms                                    |
| `ECHELON_VIEW_FLUSH_MS`           | `15000`             | Beacon write buffer flush interval (ms)                    |
| `ECHELON_EVENT_FLUSH_MS`          | `10000`             | Event write buffer flush interval (ms)                     |
| `ECHELON_TRUST_PROXY`             | `false`             | Trust X-Forwarded-For / X-Real-IP headers                  |
| `ECHELON_BEHIND_CLOUDFLARE`       | `false`             | Trust Cloudflare headers (bot score, IP, country)          |
| `ECHELON_TRUST_GEO_HEADERS`       | `false`             | Trust CloudFront/generic geo headers                       |
| `ECHELON_COOKIE_CONSENT`          | `false`             | Show consent banner before setting visitor cookie          |
| `ECHELON_IGNORED_SITES`           | _(empty)_           | Site IDs to silently discard (+ always `smoke-test`)       |
| `ECHELON_SITE_SUSPECT_COUNTRIES`  | _(empty)_           | Per-site suspect countries (`site:CC,CC;site:CC`)          |
| `ECHELON_CHALLENGE_WINDOW_MINUTES`| `10`                | PoW challenge validity window (minutes)                    |

## Tech Stack

- **Runtime:** Deno
- **Framework:** Fresh 2.2.0 (Preact)
- **Database:** SQLite (WAL mode) via Deno's built-in `node:sqlite`
- **Frontend:** Preact islands with `@preact/signals`, Tailwind CSS v4
- **Build:** Vite 7

## Data Model

- **`visitor_views`** — per-hit pageview data with bot score, device, OS,
  country, referrer type, UTM parameters
- **`semantic_events`** — behavioral events (bounce, scroll, click, hover,
  session lifecycle, web vitals, custom events) with experiment/campaign linkage
- **`visitor_views_daily`** — pre-aggregated daily rollup (runs at 03:00 UTC)
- **`excluded_visitors`** — admin blocklist
- **`experiments`** / **`experiment_variants`** — A/B experiment definitions
  with weighted variant allocation
- **`utm_campaigns`** — registered UTM campaign definitions per site
- **`perf_metrics`** — CI/CD performance benchmark records
- **`site_settings`** — per-site configuration (consent CSS)
- **`maintenance_log`** — daily rollup run records

Raw data is retained for 90 days (configurable). Daily rollups are kept for 2
years.

## Docker

```bash
docker build -f confs/Dockerfile -t echelon .
docker run -p 1947:1947 -v echelon-data:/app/data echelon
```

The Dockerfile uses a multi-stage build (Deno 2.7.1), runs as a non-root
`echelon` user, and includes a health check. Mount a volume at `/app/data` for
the SQLite database.

A Caddy reverse proxy config is provided in `confs/Caddyfile.example`.

**Important:** The server must run with a single worker (do not use
`--parallel` with `deno serve`) because sessions, rate limits, buffered
writers, and caches are held in-memory.

## License

AGPL-3.0 — see [LICENSE](LICENSE) for details.

Copyright (C) 2026 Jani Tarvainen
