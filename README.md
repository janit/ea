# ea.js — Echelon Analytics 🩺

Privacy-first, self-hosted web analytics. Drop in a single script tag — no cookie banners needed.

The name is a deliberate nod to Google Analytics' legacy `ga.js` tracking script.

## Why?

Google Analytics used to be my go-to for web analytics. Then it became impossible to use — bloated, confusing, way too heavy for what most sites actually need, and full of bot spam that distorts your statistics. Using GA4 feels like opening Microsoft Word when all you want is a text editor.

So I built my own analytics for a hobby project ([afroute.com](https://afroute.com)). It started simple — just pageviews and basic stats — but grew in functionality over time. Eventually I wanted to rip it out into its own project, and figured: why not share it, in case others are equally tired of ga.js?

## Quick Start

```bash
# Start the server
ECHELON_DB_PATH=./echelon.db deno run -A main.ts
```

Add to any site:

```html
<script src="https://your-echelon-host/ea.js" data-site="my-site"></script>
```

That's it. Pageviews, bounces, and sessions are tracked automatically.

## How It Works

Echelon uses a 1x1 pixel beacon (`/b.gif`) for pageview tracking and `sendBeacon` for behavioral events.

**Cookieless by default.** Unique visitors are counted using a daily-rotating HMAC hash of IP + User-Agent + site ID. The hash resets every day — there is no cross-day tracking and no cookies are set. This means no cookie consent banners are needed under GDPR/ePrivacy.

If you need persistent visitor identity (returning visitor detection), opt in with `data-cookie` — this sets an HttpOnly cookie and requires appropriate consent.

All analytics data lives in a single SQLite database with WAL mode for concurrent access.

## Script Tag Options

```html
<script src="https://echelon.example.com/ea.js"
  data-site="my-site"
  data-clicks
  data-scroll
  data-hover
></script>
```

| Attribute | What it tracks |
|-----------|---------------|
| `data-site` | Site identifier (required) |
| `data-cookie` | Enable persistent visitor cookie (requires consent) |
| `data-clicks` | Click events on elements with `data-echelon-click` |
| `data-scroll` | Scroll depth milestones (25/50/75/90/100%) |
| `data-hover` | Hover events (1s dwell threshold) on elements with `data-echelon-hover` |

### Markup for Clicks and Hovers

```html
<button data-echelon-click="signup" data-echelon-plan="pro">Sign Up</button>
<div data-echelon-hover="pricing card" data-echelon-tier="enterprise">...</div>
```

All `data-echelon-*` attributes are collected into the event payload automatically.

## Auto-Captured Events

These fire without any markup:

| Event | Trigger |
|-------|---------|
| Pageview | First real user interaction (800ms gate, `isTrusted` check) |
| Bounce | No interaction for 120s, or page hidden without engagement |
| Session end | Page hidden or `pagehide` |
| Session resume | Tab returns to visible |

## API Endpoints

### Public (no auth, CORS-enabled)

| Endpoint | Purpose |
|----------|---------|
| `GET /ea.js` | Tracker script |
| `GET /b.gif` | Pixel beacon (pageview recording) |
| `POST /e` | Semantic events (sendBeacon receiver) |
| `GET /api/health` | Health check |

### Authenticated (Bearer token)

**Stats:**

| Endpoint | Purpose |
|----------|---------|
| `GET /api/stats/overview?site_id=x&days=30` | Dashboard overview — visits, uniques, top paths, devices, countries, referrers, daily trend |
| `GET /api/stats/realtime?site_id=x` | Active visitors in last 5 minutes |
| `GET /api/stats/experiments` | A/B experiment results |

**Bot Management:**

| Endpoint | Purpose |
|----------|---------|
| `GET /api/bots/suspicious?min_score=25` | List visitors by bot score |
| `GET /api/bots/excluded` | List blocked visitors |
| `POST /api/bots/exclude` | Block a visitor `{visitor_id, label}` |
| `DELETE /api/bots/exclude/:visitor_id` | Unblock a visitor |
| `GET /api/bots/visitor/:visitor_id` | Full visitor history and bot scores |

**Experiments:**

| Endpoint | Purpose |
|----------|---------|
| `GET /api/experiments` | List experiments |
| `POST /api/experiments` | Create experiment |
| `PATCH /api/experiments/:id` | Update experiment status |

**Admin UI** is available at `/admin/` (authenticated via Bearer token or `echelon_token` cookie).

## Bot Scoring

Every request is scored 0-100 based on heuristics:

| Signal | Points |
|--------|--------|
| Interaction time < 850ms | +20 |
| Interaction time 850-999ms | +8 |
| Suspect country (default: CN) | +30 |
| Burst > 15 requests / 5 min | +25 |
| Missing Accept-Language | +10 |
| Missing Sec-CH-UA + Sec-Fetch-Site | +10 |
| Unrealistic screen dimensions | +10 |
| No referrer + deep path | +5 |

Visitors scoring >= 50 are excluded from rollups and blocked from recording at the beacon and events level.

IP addresses are never stored — only ephemeral HMAC hashes with daily key rotation.

## Configuration

| Environment Variable | Default | Purpose |
|---------------------|---------|---------|
| `ECHELON_PORT` | `4100` | Server port |
| `ECHELON_DB_PATH` | `./echelon.db` | SQLite database path |
| `ECHELON_SECRET` | _(empty = no auth)_ | Bearer token for authenticated endpoints |
| `ECHELON_RETENTION_DAYS` | `90` | Raw data retention period |
| `ECHELON_SUSPECT_COUNTRIES` | `CN` | Comma-separated country codes for bot scoring |
| `ECHELON_SUSPECT_POINTS` | `30` | Points added for suspect countries |

## Tech Stack

- **Runtime:** Deno
- **Framework:** Fresh 2.2.0 (Preact)
- **Database:** SQLite (WAL mode) via `@db/sqlite`
- **Frontend:** Preact islands with `@preact/signals`, Bootstrap 5 (admin UI)

## Data Model

- **`visitor_views`** — per-hit pageview data with bot score, device, OS, country, referrer type
- **`semantic_events`** — behavioral events (bounce, scroll, click, hover, session lifecycle)
- **`visitor_views_daily`** — pre-aggregated rollup (runs at 03:00 UTC daily)
- **`excluded_visitors`** — admin blocklist

Raw data is retained for 90 days (configurable). Daily rollups are kept indefinitely.

## Docker

```bash
docker build -t echelon .
docker run -p 4100:4100 -v echelon-data:/data -e ECHELON_DB_PATH=/data/echelon.db echelon
```

## License

AGPL-3.0 — see [LICENSE](LICENSE) for details.

Copyright (C) 2026 Jani Tarvainen
