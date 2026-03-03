# Echelon Analytics 🩺

🛢️ "Data er den nye oljen!" -🦭

Privacy-first, self-hosted web analytics with **WebAssembly proof-of-work bot
defense**. Drop in a single script tag — clean data, no cookie banners, no bot
spam.

## Why?

Google Analytics used to be my go-to for web analytics. Then it became
impossible to use — bloated, confusing, way too heavy for what most sites
actually need, and full of bot spam that distorts your statistics. Using GA4
feels like opening Microsoft Word when all you want is a text editor.

So I built my own analytics for a hobby project
([afroute.com](https://afroute.com)). It started simple — just pageviews and
basic stats — but grew in functionality over time. Eventually I wanted to rip it
out into its own project, and figured: why not share it?

## WASM Proof-of-Work Bot Defense

The core differentiator: every tracker script embeds a **runtime-generated
WebAssembly module** that browsers must solve before pageviews are accepted.

- WASM blob is regenerated from a random seed every **6 hours** — each
  deployment produces unique bytecode
- SipHash-inspired algorithm with randomized constants — bot toolkits can't
  pre-compute solutions
- Per-minute challenge rotation via HMAC-SHA256
- Invisible to users — solves in <150ms in any modern browser
- Missing or invalid tokens add penalty points to the visitor's bot score
  (0–100)
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

# Check formatting, lint, type-check, and run tests
deno task check

# Run server-side tests only
deno task test

# Run browser E2E tests (requires Chromium)
deno task test:e2e

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
`history.pushState` and `history.replaceState` and listens to `popstate`, firing
new pageview beacons on route changes.

## Script Tag Options

All behavioral tracking (clicks, scroll, hover, outbound, downloads, forms,
vitals) is **enabled by default**. Use `data-no-*` attributes to opt out of
specific features:

```html
<script
  src="https://echelon.example.com/ea.js"
  data-site="my-site"
  data-no-hover
  data-no-vitals
></script>
```

| Attribute           | Effect                                                                   |
| ------------------- | ------------------------------------------------------------------------ |
| `data-site`         | Site identifier (required)                                               |
| `data-cookie`       | Enable persistent visitor cookie (opt-in, requires consent)              |
| `data-no-clicks`    | Disable click events on elements with `data-echelon-click`               |
| `data-no-scroll`    | Disable scroll depth milestones (25/50/75/90/100%)                       |
| `data-no-hover`     | Disable hover events (1s dwell) on elements with `data-echelon-hover`    |
| `data-no-outbound`  | Disable outbound link click tracking                                     |
| `data-no-downloads` | Disable file download click tracking (pdf, zip, exe, mp3, mp4, etc.)     |
| `data-no-forms`     | Disable form tracking (field focus, edits, submissions)                  |
| `data-no-vitals`    | Disable Core Web Vitals (LCP, CLS, INP) via PerformanceObserver         |

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
| Form focus     | User focuses a form field (input, select, textarea)         |
| Form edit      | User edits a form field (fires on change/blur)              |
| Form submit    | Form submission                                             |

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

| Endpoint                                    | Purpose                                                                                     |
| ------------------------------------------- | ------------------------------------------------------------------------------------------- |
| `GET /api/stats/overview?site_id=x&days=30` | Dashboard overview — visits, uniques, top paths, devices, countries, referrers, daily trend |
| `GET /api/stats/dashboard?site_id=x`        | Live dashboard — now, 60-min/24h trends, recent visitors/events                             |
| `GET /api/stats/realtime?site_id=x`         | Active visitors in last 5 minutes                                                           |
| `GET /api/stats/summary`                    | Buffer sizes + last 24h view/visitor counts                                                 |
| `GET /api/stats/vitals`                     | Live request statistics                                                                     |
| `GET /api/stats/experiments`                | A/B experiment results                                                                      |
| `GET /api/stats/campaigns?days=30`          | UTM campaign stats                                                                          |
| `GET /api/stats/campaigns?id=x&days=30`     | Single campaign detail with source/medium breakdown                                         |

**Bot Management:**

| Endpoint                                | Purpose                               |
| --------------------------------------- | ------------------------------------- |
| `GET /api/bots/suspicious?min_score=25` | List visitors by bot score            |
| `GET /api/bots/excluded`                | List blocked visitors                 |
| `POST /api/bots/exclude`                | Block a visitor `{visitor_id, label}` |
| `DELETE /api/bots/exclude/:visitor_id`  | Unblock a visitor                     |
| `GET /api/bots/visitor/:visitor_id`     | Full visitor history and bot scores   |

**Experiments:**

| Endpoint                     | Purpose                  |
| ---------------------------- | ------------------------ |
| `GET /api/experiments`       | List experiments         |
| `POST /api/experiments`      | Create experiment        |
| `PATCH /api/experiments/:id` | Update experiment status |

**UTM Campaigns:**

| Endpoint                   | Purpose                |
| -------------------------- | ---------------------- |
| `GET /api/campaigns`       | List campaigns         |
| `POST /api/campaigns`      | Create campaign        |
| `GET /api/campaigns/:id`   | Campaign detail        |
| `PATCH /api/campaigns/:id` | Update campaign status |

**Performance Metrics:**

| Endpoint               | Purpose                                        |
| ---------------------- | ---------------------------------------------- |
| `GET /api/perf`        | Query stored metrics (category, metric, limit) |
| `POST /api/perf`       | Ingest metric array (for CI/CD benchmarks)     |
| `GET /api/perf/trends` | Metric trend data                              |

**Batch Ingest:**

| Endpoint           | Purpose                                      |
| ------------------ | -------------------------------------------- |
| `POST /api/ingest` | Batch event ingestion (v1 protocol, 1MB max) |

**Site Settings:**

| Endpoint               | Purpose                                |
| ---------------------- | -------------------------------------- |
| `PATCH /api/sites/:id` | Update per-site settings (consent CSS) |

**Admin UI** is available at `/admin/` with a persistent site/days selector in
the nav header. Pages: live dashboard (Now gauge, 60-min/24h SVG charts, recent
visitors/events), realtime active pages, visitor views listing (filterable,
sortable, paginated), visitor detail with full history, semantic events listing
with type badges, bot management, A/B experiments, UTM campaigns, performance
metrics, and per-site settings.

## Bot Scoring

Every request is scored 0–100 based on heuristics:

| Signal                             | Points |
| ---------------------------------- | ------ |
| Cloudflare bot score ≤ 2           | +50    |
| Cloudflare bot score 3–29          | +30    |
| Cloudflare bot score 30–50         | +10    |
| Cloudflare verified bot            | +15    |
| PoW token invalid                  | +25    |
| PoW token replayed                 | +40    |
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

## Public Mode

Run a read-only public dashboard with `ECHELON_PUBLIC_MODE=true`. This:

- Disables authentication — anyone can view the admin dashboard
- Blocks all mutations — `POST`, `PATCH`, `DELETE` requests return
  `403 read_only`
- Hides mutation controls (forms, delete buttons) in the admin UI
- Redacts internal stats (buffer sizes, RPS, uptime) from API responses
- Generates a proper `robots.txt` with `Allow` and `Sitemap` directives
- Telemetry (`POST /api/telemetry`) and health (`GET /api/health`) remain open

Use this for public demo dashboards. The live instance at
[ea.islets.app](https://ea.islets.app/admin) runs in public mode with anonymized
data.

## Security

### CSRF Protection

Cookie-authenticated mutating requests (`POST`, `PATCH`, `DELETE`) require the
`Origin` or `Referer` header's host to match the request `Host`. Works behind
reverse proxies (compares hosts, not full origins).

### PoW Nonce Tracking

Solved proof-of-work tokens are tracked in memory. Replaying a previously-used
token adds penalty points to the bot score instead of passing verification.
Nonces expire with the challenge window (default 10 minutes).

### Response Headers

All HTML responses include:

- `Content-Security-Policy` — script-src, style-src, connect-src, img-src
- `X-Frame-Options: DENY`
- `X-Content-Type-Options: nosniff`
- `Referrer-Policy: strict-origin-when-cross-origin`

### Session Security

- PBKDF2-SHA256 with 600k iterations
- Random session tokens (not deterministic)
- 24-hour TTL with 30-minute idle timeout
- Sessions pruned every 30 minutes
- Login rate-limited per IP (5 attempts / 15 min)

## Anonymization

Sites listed in `ECHELON_ANONYMIZE_SITES` get deterministic anonymization
**before storage** — original values never touch disk:

- **Visitor IDs** — HMAC-SHA256 hashed with a daily-rotating key
- **Session IDs** — mapped to Norwegian fisherman names
- **Country codes** — replaced with fictional exoplanet names
- **Screen sizes** — mapped to classic terminal resolutions (e.g. 80x25 IBM PC)
- **OS names** — mapped to tropical bird names
- **Device types** — mapped to sci-fi vessel classes (mothership/shuttle/probe)
- **Referrers** — replaced with fictional NSA intranet URLs
- **UTM params** — mapped to military operation codenames
- **Event data** — sanitized to safe behavioral keys only (scroll depth, dwell
  time, HTML tag names). URLs, user text, and custom attributes are stripped.
- **Form field values** — scrambled client-side (each letter/digit replaced with
  a random one of the same type) before transmission
- **URL query parameters** — query param values scrambled client-side to prevent
  search text and other user input from appearing in page paths

All mappings are deterministic within a day (same input produces same output) so
analytics aggregation still works. Mappings rotate daily and are not reversible.

## Telemetry

Opt-in anonymous usage tracking helps improve Echelon Analytics. No visitor
data, PII, or page content is ever sent. A banner in the admin UI lets you opt
in or out. Override with `ECHELON_TELEMETRY=true` or `ECHELON_TELEMETRY=false`.

See [telemetry documentation](https://ea.js.org/telemetry.html) for details on
what is collected.

## Authentication

Two independent auth modes (can be used simultaneously):

- **Bearer token**: Set `ECHELON_SECRET` — used in
  `Authorization: Bearer <token>` header.
- **Username + password**: Set `ECHELON_USERNAME` and `ECHELON_PASSWORD_HASH`
  (PBKDF2-SHA256, 600k iterations). Login form at `/admin/login` creates a 24h
  session cookie. Login attempts are rate-limited per IP (5 attempts / 15 min).

## Configuration

| Environment Variable               | Default             | Purpose                                                      |
| ---------------------------------- | ------------------- | ------------------------------------------------------------ |
| `ECHELON_PORT`                     | `1947`              | Server port                                                  |
| `ECHELON_DB_PATH`                  | `./echelon.db`      | SQLite database path                                         |
| `ECHELON_SECRET`                   | _(empty = no auth)_ | Bearer token for authenticated endpoints                     |
| `ECHELON_USERNAME`                 | _(empty)_           | Username for admin login                                     |
| `ECHELON_PASSWORD_HASH`            | _(empty)_           | PBKDF2 password hash for admin login                         |
| `ECHELON_RETENTION_DAYS`           | `90`                | Raw data retention period (days)                             |
| `ECHELON_SUSPECT_COUNTRIES`        | `CN`                | Comma-separated country codes for bot scoring                |
| `ECHELON_SUSPECT_POINTS`           | `30`                | Points added for suspect countries                           |
| `ECHELON_BOT_DISCARD_THRESHOLD`    | `0`                 | Bot score at which to drop requests entirely (0 = store all) |
| `ECHELON_BOT_UA_PATTERNS`          | _(long default)_    | Comma-separated bot UA substrings to drop silently           |
| `ECHELON_ALLOWED_ORIGINS`          | _(empty = open)_    | Restrict which domains can send tracking data                |
| `ECHELON_RATE_LIMIT_MAX`           | `100`               | Max requests per IP per window on tracking endpoints         |
| `ECHELON_RATE_LIMIT_WINDOW_MS`     | `60000`             | Rate limit window in ms                                      |
| `ECHELON_VIEW_FLUSH_MS`            | `15000`             | Beacon write buffer flush interval (ms)                      |
| `ECHELON_EVENT_FLUSH_MS`           | `10000`             | Event write buffer flush interval (ms)                       |
| `ECHELON_TRUST_PROXY`              | `false`             | Trust X-Forwarded-For / X-Real-IP headers                    |
| `ECHELON_BEHIND_CLOUDFLARE`        | `false`             | Trust Cloudflare headers (bot score, IP, country)            |
| `ECHELON_TRUST_GEO_HEADERS`        | `false`             | Trust CloudFront/generic geo headers                         |
| `ECHELON_COOKIE_CONSENT`           | `false`             | Show consent banner before setting visitor cookie            |
| `ECHELON_IGNORED_SITES`            | _(empty)_           | Site IDs to silently discard (+ always `smoke-test`)         |
| `ECHELON_SITE_SUSPECT_COUNTRIES`   | _(empty)_           | Per-site suspect countries (`site:CC,CC;site:CC`)            |
| `ECHELON_CHALLENGE_WINDOW_MINUTES` | `10`                | PoW challenge validity window (minutes)                      |
| `ECHELON_LIVE_STATS_MINUTES`       | `10`                | Admin nav live stats window (minutes)                        |
| `ECHELON_DISPLAY_TIMEZONE`         | `UTC`               | IANA timezone for admin UI timestamps (data stored in UTC)   |
| `ECHELON_PUBLIC_MODE`              | `false`             | Read-only public dashboard (no auth, mutations blocked)      |
| `ECHELON_ANONYMIZE_SITES`          | _(empty)_           | Comma-separated site IDs to anonymize in responses           |
| `ECHELON_TELEMETRY`                | _(per-instance)_    | Override telemetry opt-in (`true`/`false`)                   |
| `ECHELON_SHUTDOWN_TIMEOUT_MS`      | `60000`             | Graceful shutdown timeout (ms) for flushing buffers          |

## Testing

217 server-side tests cover bot scoring, PoW challenges, sessions, rate
limiting, buffered writes, DB operations, stats queries, middleware (auth, CSRF,
CORS, CSP), beacon/event endpoints, public mode lockdown, and maintenance
rollups. Browser E2E tests (14 cases) use headless Chromium via
[Astral](https://jsr.io/@astral/astral).

```bash
cd echelon-analytics

# Server-side tests (included in `deno task check`)
deno task test

# Browser E2E tests (requires Chromium)
deno task test:e2e
```

Tests run automatically before every tagged release via
`scripts/tag-release.sh`. E2E tests are excluded from the default test task
since they require Chromium.

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

## MCP Server

A [Model Context Protocol](https://modelcontextprotocol.io/) server lets AI
agents (Claude Code, Claude Desktop, etc.) query your analytics via the REST
API. Point it at any Echelon instance — local or remote, public or
authenticated. 9 read-only tools, no database access needed. The server only
calls GET endpoints — it cannot create, modify, or delete any data even if the
token has write privileges.

```bash
# Query the public demo
ECHELON_URL=https://ea.islets.app deno task mcp

# Query your own instance
ECHELON_URL=http://localhost:1947 ECHELON_SECRET=your-token deno task mcp
```

### Tools

| Tool                        | API Endpoint                | Description                           |
| --------------------------- | --------------------------- | ------------------------------------- |
| `analytics_overview`        | `/api/stats/overview`       | Visits, uniques, top paths, devices   |
| `analytics_realtime`        | `/api/stats/realtime`       | Active visitors in last 5 minutes     |
| `analytics_campaigns`       | `/api/stats/campaigns`      | UTM campaign stats                    |
| `analytics_campaign_detail` | `/api/stats/campaigns?id=x` | Campaign breakdown by source/medium   |
| `analytics_experiments`     | `/api/stats/experiments`    | A/B experiment results                |
| `analytics_campaign_events` | `/api/stats/campaign-events` | Campaign-to-event correlation         |
| `analytics_dashboard`       | `/api/stats/dashboard`      | Live dashboard with trends            |
| `list_campaigns`            | `/api/campaigns`            | All UTM campaigns with metadata       |
| `list_experiments`          | `/api/experiments`          | All A/B experiments with variants     |

### Claude Code (auto-discovery)

The repo includes `.claude/settings.json` which registers the MCP server. Edit
`ECHELON_URL` there to point at your instance:

```json
{
  "mcpServers": {
    "echelon-analytics": {
      "command": "deno",
      "args": ["task", "mcp"],
      "cwd": "echelon-analytics",
      "env": {
        "ECHELON_URL": "https://your-instance.example.com",
        "ECHELON_SECRET": "your-api-token"
      }
    }
  }
}
```

### Claude Desktop

Add to your config
(`~/Library/Application Support/Claude/claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "echelon-analytics": {
      "command": "deno",
      "args": ["task", "mcp"],
      "cwd": "/path/to/echelon-analytics",
      "env": {
        "ECHELON_URL": "https://your-instance.example.com",
        "ECHELON_SECRET": "your-api-token"
      }
    }
  }
}
```

### Environment Variables

| Variable          | Required | Purpose                                              |
| ----------------- | -------- | ---------------------------------------------------- |
| `ECHELON_URL`     | Yes      | Base URL of the Echelon instance to query             |
| `ECHELON_SECRET`  | No       | Bearer token (not needed for `PUBLIC_MODE` instances) |

## Docker

```bash
docker build -f confs/Dockerfile -t echelon .
docker run -p 1947:1947 -v echelon-data:/app/data echelon
```

The Dockerfile uses a multi-stage build (Deno 2.7.1), runs as a non-root
`echelon` user, and includes a health check. Mount a volume at `/app/data` for
the SQLite database.

### Reverse Proxy

A Caddy example is in `confs/Caddyfile.example`. Any reverse proxy (Caddy,
Nginx, etc.) works. Set `ECHELON_TRUST_PROXY=true` to trust `X-Forwarded-For` /
`X-Real-IP` headers. For Cloudflare, also set `ECHELON_BEHIND_CLOUDFLARE=true`.

The application already sets security headers on HTML responses (CSP,
`X-Frame-Options`, `X-Content-Type-Options`), so the proxy should **not**
duplicate those — it would cause double headers. The proxy should add headers
the app doesn't set: `Strict-Transport-Security`, `Permissions-Policy`, and
strip the `Server` header.

**Important:** The server must run with a single worker (do not use `--parallel`
with `deno serve`) because sessions, rate limits, buffered writers, and caches
are held in-memory.

## Documentation

Full documentation at [ea.js.org](https://ea.js.org/) including
[installation](https://ea.js.org/installation.html),
[features](https://ea.js.org/features.html),
[API reference](https://ea.js.org/api.html),
[bot defense](https://ea.js.org/bot-defense.html),
[configuration](https://ea.js.org/configuration.html),
[architecture](https://ea.js.org/architecture.html),
[portable data](https://ea.js.org/portable-data.html), and
[MCP server](https://ea.js.org/mcp.html).

## Acknowledgments

Built with [Deno](https://deno.com/) and [Fresh](https://fresh.deno.dev/) —
thanks to the Deno team for creating a runtime and framework that made this
project a joy to build. And to [Claude Code](https://claude.ai/code) for being
the tireless pair programmer that brought it all together.

## License

AGPL-3.0 — see [LICENSE](LICENSE) for details.

Copyright (C) 2026 Jani Tarvainen

🛢️ "Data er den nye oljen!" -🦭
