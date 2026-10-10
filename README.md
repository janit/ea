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

- WASM blob is regenerated every **6 hours** from a seed derived from
  `ECHELON_SECRET` (random per process if no secret is set) — each cycle
  produces unique bytecode
- SipHash-inspired algorithm with randomized constants — bot toolkits can't
  pre-compute solutions
- Per-minute challenge rotation via HMAC-SHA256
- Invisible to users — solves in <150ms in any modern browser
- Missing or invalid tokens add penalty points to the visitor's bot score
  (0–100); a view that sent no valid token and never interacted is later raised
  to the bot threshold
- Combined with heuristic scoring, Cloudflare integration, burst detection, UA
  blocklists, threat intelligence feeds (crawler UAs, AI bots, datacenter IPs),
  and async fingerprint clustering that detects coordinated bot farms

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

The no-consent point applies to cookieless mode only. If you need persistent
visitor identity (returning visitor detection), opt in with `data-cookie` — this
sets a 30-day cookie and requires visitor consent. Set
`ECHELON_COOKIE_CONSENT=true` so the tracker shows a consent banner before
setting it; without that flag, `data-cookie` sets the cookie immediately.

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

| Attribute           | Effect                                                                |
| ------------------- | --------------------------------------------------------------------- |
| `data-site`         | Site identifier (required)                                            |
| `data-cookie`       | Enable persistent visitor cookie (opt-in, requires consent)           |
| `data-no-clicks`    | Disable click events on elements with `data-echelon-click`            |
| `data-no-scroll`    | Disable scroll depth milestones (25/50/75/90/100%)                    |
| `data-no-hover`     | Disable hover events (1s dwell) on elements with `data-echelon-hover` |
| `data-no-outbound`  | Disable outbound link click tracking                                  |
| `data-no-downloads` | Disable file download click tracking (pdf, zip, exe, mp3, mp4, etc.)  |
| `data-no-forms`     | Disable form tracking (field focus, edits, submissions)               |
| `data-no-vitals`    | Disable Core Web Vitals (LCP, CLS, INP) via PerformanceObserver       |

### Content Security Policy on the Host Site

If the site embedding the tracker sends a `Content-Security-Policy` header, it
must let the tracker reach your Echelon host: the host in `script-src` (to load
`/ea.js`), in `img-src` (the `/b.gif` pixel) and in `connect-src` (for `/c` and
`/e`), plus `'wasm-unsafe-eval'` in `script-src` so the proof-of-work module can
run:

```
script-src 'self' https://echelon.example.com 'wasm-unsafe-eval';
connect-src 'self' https://echelon.example.com;
img-src 'self' https://echelon.example.com
```

Without `'wasm-unsafe-eval'` the tracker still works but sends no token, so its
requests carry the +30 missing-token penalty instead of being discarded at
ingest. A view with no token and no interaction is later raised to the bot
threshold by the engagement gate (see Bot Scoring).

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

| Endpoint          | Purpose                                                                        |
| ----------------- | ------------------------------------------------------------------------------ |
| `GET /ea.js`      | Tracker script (with embedded PoW)                                             |
| `GET /b.gif`      | Pixel beacon (pageview recording)                                              |
| `POST /e`         | Semantic events (sendBeacon receiver)                                          |
| `GET /c`          | Current PoW challenge, used by the tracker to refresh its token (rate-limited) |
| `GET /api/health` | Health check                                                                   |

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

| Endpoint               | Purpose                                                                                                 |
| ---------------------- | ------------------------------------------------------------------------------------------------------- |
| `GET /api/sites/:id`   | Read per-site settings                                                                                  |
| `PATCH /api/sites/:id` | Update per-site settings (consent CSS, home country and language); fields not sent are left as they are |

**Admin UI** is available at `/admin/` with a persistent site/days selector in
the nav header. Pages: live dashboard (Now gauge, 60-min/24h SVG charts, recent
visitors/events), realtime active pages, visitor views listing (filterable,
sortable, paginated), visitor detail with full history, semantic events listing
with type badges, bot management, A/B experiments, UTM campaigns, performance
metrics, and per-site settings.

## Bot Scoring

Every request is scored 0–100 using multiple detection layers:

### Per-Request Heuristics

| Signal                             | Points |
| ---------------------------------- | ------ |
| Cloudflare bot score ≤ 2           | +50    |
| Cloudflare bot score 3–29          | +30    |
| Cloudflare bot score 30–50         | +10    |
| Cloudflare verified bot            | +15    |
| Suspected bot IP (UA leak)         | +20    |
| Confirmed bot IP (correlated)      | +50    |
| PoW token missing                  | +30    |
| PoW token invalid (pageview)       | +50    |
| PoW token invalid (events)         | +40    |
| Interaction time < 850ms           | +20    |
| Interaction time 850–999ms         | +8     |
| Suspect country (configurable)     | +30    |
| Burst > 15 requests / 5 min        | +25    |
| Missing Accept-Language            | +10    |
| Missing Sec-CH-UA + Sec-Fetch-Site | +10    |
| Unrealistic screen dimensions      | +10    |
| No referrer + deep path            | +5     |
| Windows UA at tablet screen width  | +34    |
| Linux desktop (pageviews only)     | +10    |
| One IP on 3+ sites within an hour  | +34    |
| Country unlike site home           | +15    |
| Visitor on another continent       | +8     |
| Windows tablet, foreign            | +15    |
| Linux desktop, foreign             | +30    |
| Android 6 or older, foreign        | +40    |

### Threat Intelligence Feeds (async refresh every 6 hours)

| Feed                                                                    | Points |
| ----------------------------------------------------------------------- | ------ |
| Crawler UA match (monperrus/crawler-user-agents)                        | +30    |
| AI bot UA match (ai-robots-txt/robots.json)                             | +40    |
| Datacenter IP (AWS, GCP, DigitalOcean, Oracle Cloud; IPv4 + IPv6 CIDRs) | +24    |

Each provider's ranges are kept independently: a refresh that fails, is empty or
shrinks to under 10% of the previous size is discarded.

The Windows tablet, cross-site and datacenter weights are 34, 34 and 24 rather
than round numbers on purpose. A real visitor can carry any one of them, and one
who then reads without clicking gets +15 from the engagement gate; the sums stay
under the threshold of 50. The Linux desktop +10 is scored on pageviews only,
not on the events endpoint, where an invalid token is already +40.

### Async Bot Correlator (background sweep every 2 min)

| Signal                                               | Points |
| ---------------------------------------------------- | ------ |
| Fingerprint cluster ≥ 6 distinct IPs                 | +30    |
| Fingerprint cluster ≥ 8 IPs or confirmed-bot-tainted | +50    |

The correlator groups beacon requests by device fingerprint (OS, browser,
version, screen size, country, Accept-Language) per site. Bot farms running
identical headless Chrome configs produce many distinct IPs with the same
fingerprint — real users have varied configurations (especially
Accept-Language). Confirmed cluster IPs are fed back into the confirmed bot IP
map for immediate scoring of future requests.

Before penalising a visitor, the correlator requires their first print to be at
least 12 minutes old and skips proven humans (a validated view that is not from
a datacenter IP). Only penalised visitors' IPs are fed back into the confirmed
bot IP map. Its updates also reach the rows of anonymized sites.

Visitors scoring ≥ 50 are excluded from daily rollups. Known bot User-Agents
(Googlebot, GPTBot, ClaudeBot, HeadlessChrome, curl, etc.) are dropped
immediately before scoring.

### Engagement Gate (same sweep)

| Signal                                                            | Points |
| ----------------------------------------------------------------- | ------ |
| No interaction within 5–30 min                                    | +15    |
| No interaction, and a PoW penalty or a waiver by visitor key only | → 50   |
| No interaction, strict mode (30–180 min)                          | → 50   |

A view aged 5–30 minutes whose session produced no interaction event gets +15.
If it also carries any PoW penalty (missing or invalid token), or its PoW was
waived only by the visitor key (`pow_ok_by: "v"`), it is raised to the threshold
instead. Passive events (bounce, session end, web vitals, scroll) do not count
as interaction. A session that interacted at any time is shielded as a whole,
and validated views are never touched.

Both penalties are provisional. Someone who reads with a mouse wheel or trackpad
may not click or press a key until after their view was judged, so each sweep
first looks back 180 minutes: if the session has interacted since, exactly what
was added is taken off again and the view can be validated. Each mark
(`no_events`, `unproven`) stores the points it added for this purpose.

In strict mode (below), views and events of a session that never interacted are
raised to the threshold once they are 30–180 minutes old. That is not undone by
a later interaction.

On anonymized sites (`ECHELON_ANONYMIZE_SITES`) the stored session id is one of
50 names shared by unrelated visits, so there the gate and the validator match
by the stored visitor id instead: an interaction counts for a view or event only
if it has the same visitor id and happened within 30 minutes of it.

### Validated Visitors

A bot score says how suspicious a request looked. `validated` says something
stronger: the session did something only a person does. The tracker reports the
first click, key press or tap on each page as an `engage` event, and a
background validator (every 60 seconds) marks a view validated once its session
has such an event and stayed on the page for at least two seconds (or showed a
later interaction plus two distinct interaction types). Scrolling and automatic
events (bounce, session end, web vitals, custom events) never validate a view.

The dashboard shows validated visitors next to unique visitors, and the overview
API returns `validated_visitors`. Retroactive penalties, such as the
fingerprint-cluster correlator, never touch a validated visitor.

Set `ECHELON_REQUIRE_ENGAGEMENT=true` to count only sessions that interacted. It
is off by default because, on a content site, people who read and leave are real
visitors.

### Home Audience

Under **Settings → Home Audience** each site can declare a home country (ISO
alpha-2) and language, or set `home_country` and `home_language` with
`PATCH /api/sites/:id`. The home country must be an assigned code that Echelon
can place on a continent, or `RU`; anything else (`UK` for `GB`, `EN`, `XX`) is
refused with a 400, and a code of that kind already stored is treated as not
set. Russia spans two continents and has none in the table, so with a home of
`RU` no visitor shares its continent: every visitor from another country is a
mismatch, neighbours included (the exemption below for countries that show up
everywhere still holds). The geography rows in the table above (country unlike
site home, another continent, and the three "foreign" device rows) only apply to
sites that have done so; a visitor is "foreign" relative to that home. It needs
a visitor country, which comes from `ECHELON_BEHIND_CLOUDFLARE` or
`ECHELON_TRUST_GEO_HEADERS`. Visitors from the same continent are never a
mismatch, a country the continent table does not know (`XX`, `T1`) is never
foreign, and on English-language sites (or with no language set) visitors from
countries that show up everywhere (US, CA, AU, NZ, JP, KR, SG, IN, TR, RU, MA,
AE, MX, PK) are exempt from the +15. The three "foreign" device rows need one of
those countries that is not the site's own: Windows tablet, foreign applies on
any site; Linux desktop, foreign and Android 6 or older, foreign also need the
country mismatch, so they apply only where the home language is not English.
Leave it empty for a worldwide audience.

Opting in has a cost for real visitors, so decide per site:

- On a site whose home language is not English, a Linux desktop or an Android 6
  or older visitor from one of those countries scores 63 from these signals
  alone, which is over the threshold of 50, and is not counted. Other foreign
  visitors carry 15 to 23 points; they are not dropped, but they sit closer to
  the threshold when anything else is off.
- Windows tablet rows use the screen width the tracker reports in CSS pixels. A
  real Windows laptop with display scaling can land in the 768 to 1024 band (for
  example 1280 wide at 125% or 1366 at 150%) and carry +34. Lower
  `win_tablet_mismatch`, or set it to 0, if your audience uses such displays.
- "One IP on 3+ sites" counts an address and browser seen on three or more of
  this instance's sites within an hour. A person who browses sibling sites you
  run together will trip it. Browsers now send nearly identical user agents, so
  people who share one address (an office, a campus, a mobile carrier) pool into
  one count as well. Set `cross_site:0` on an instance whose sites share an
  audience. It is scored on the pageview beacon only, and never when the client
  address cannot be resolved (no peer address, or a forwarded header arriving
  without `ECHELON_TRUST_PROXY`).

### Session classifier

Every 15 minutes Echelon looks over the last 30 minutes for bots that only show
across requests, judging an identity once its oldest view is 12 minutes old:

- `session_velocity`: six or more page visits, to six or more different pages,
  averaging 3 seconds or less apart. Pages are told apart by pathname, and
  consecutive views of one page count once: views that differ only in query
  string or fragment (pagination, a carousel or a map that keeps its state in
  the URL) are one visit
- `os_rotation`: three or more operating-system names in one vendor family
- `os_family_flip`: two or more of Apple, Android and Windows on one session or
  visitor
- `burst_cohort`: 40 or more single-view sessions on one site with the same
  country and screen size, from a different continent than the site's home
  country (needs a home country; does nothing when either country has no known
  continent)

The first run is two minutes after start. Flagged rows are scored 60 and the
visitor is excluded automatically as `auto:<reason>`; daily maintenance removes
those exclusions after 30 days. A manual un-exclude on the admin bots page
reverses a wrong one, and excluding such a visitor by hand replaces the `auto:`
label, which makes the exclusion permanent. Visitors who have been validated are
spared by `session_velocity` and `os_rotation`, but not by `os_family_flip` and
`burst_cohort`, whose patterns cannot be one real person. That has a side
effect: using browser DevTools device emulation or a user-agent switcher in one
tab can trip `os_family_flip` on yourself. On anonymized sites session-keyed
findings are skipped.

### Duplicate beacons

Mobile networks and service workers sometimes deliver the same pageview request
more than once. The tracker puts a random per-pageview nonce on the landing
pageview beacon; a beacon with the same site, session and nonce as one recorded
in the last 10 minutes is answered normally but not counted. A reload or new
page load gets a new nonce and is counted. A beacon without a well-formed nonce
is always counted, and SPA navigation beacons and beacons with no session id are
exempt.

### Tuning weights

Every weight in the tables above can be changed with
`ECHELON_BOT_SCORE_WEIGHTS`, for example `linux_desktop:0` for a developer
audience. Keys: `timing_fast`, `timing_quick`, `burst`, `no_accept_language`,
`no_sec_headers`, `screen`, `referrer`, `crawler_feed`, `ai_crawler_feed`,
`datacenter_ip`, `win_tablet_mismatch`, `linux_desktop`, `cross_site`,
`country_mismatch`, `cross_continent`, `global_common_foreign`, `linux_foreign`,
`stale_android_foreign`. Values are 0 to 100; an unknown key or bad value is
ignored with a warning at startup, and 0 turns that signal off.

### Referrers and IP privacy

Referrer traffic is classified as `ai` (ChatGPT, Claude, Perplexity, Gemini),
`search` (Google, Bing, DuckDuckGo, etc.), `social` (Facebook, X, Reddit,
LinkedIn), or `direct_or_unknown`.

IP addresses are never stored — only ephemeral HMAC hashes with daily key
rotation. Bot IP state is held in memory (suspected: 30-min TTL, confirmed:
1-hour TTL) and lost on restart.

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

A solved token is bound to its session and site and is accepted for the
challenge window (10 minutes by default). The tracker fetches a fresh challenge
from `/c` and re-solves before that window closes, so long-lived tabs keep
sending valid tokens. A session or visitor that has presented a valid token is
not penalised for a missing or stale one during the following hour; the waived
amount is recorded as `pow_ok` in the score breakdown, and `pow_ok_by` records
which key granted it (`s` session, `v` visitor). A waiver granted by the visitor
key alone does not protect a view from the engagement gate's `unproven` rule.

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

Session names come from a small list, so unrelated sessions on an anonymized
site can share one. Interaction validation and the engagement gate therefore
ignore the session id on such sites and match views to interactions by the
anonymized visitor id, within 30 minutes (see Engagement Gate).

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

| Environment Variable               | Default              | Purpose                                                      |
| ---------------------------------- | -------------------- | ------------------------------------------------------------ |
| `ECHELON_PORT`                     | `1947`               | Server port                                                  |
| `ECHELON_DB_PATH`                  | `./echelon.db`       | SQLite database path                                         |
| `ECHELON_SECRET`                   | _(empty = no auth)_  | Bearer token for authenticated endpoints                     |
| `ECHELON_USERNAME`                 | _(empty)_            | Username for admin login                                     |
| `ECHELON_PASSWORD_HASH`            | _(empty)_            | PBKDF2 password hash for admin login                         |
| `ECHELON_RETENTION_DAYS`           | `90`                 | Raw data retention period (days)                             |
| `ECHELON_BOT_RETENTION_DAYS`       | _(= RETENTION_DAYS)_ | Bot-scored data retention (days, defaults to RETENTION_DAYS) |
| `ECHELON_SUSPECT_COUNTRIES`        | `CN`                 | Comma-separated country codes for bot scoring                |
| `ECHELON_SUSPECT_POINTS`           | `30`                 | Points added for suspect countries                           |
| `ECHELON_BOT_DISCARD_THRESHOLD`    | `50`                 | Bot score at which to drop requests entirely (0 = store all) |
| `ECHELON_REQUIRE_ENGAGEMENT`       | `false`              | Raise sessions that never interact to the bot threshold      |
| `ECHELON_BOT_SCORE_WEIGHTS`        | _(empty)_            | Per-signal weight overrides, `key:points,key:points`         |
| `ECHELON_BOT_UA_PATTERNS`          | _(long default)_     | Comma-separated bot UA substrings to drop silently           |
| `ECHELON_ALLOWED_ORIGINS`          | _(empty = open)_     | Restrict which domains can send tracking data                |
| `ECHELON_RATE_LIMIT_MAX`           | `100`                | Max requests per IP per window on tracking endpoints         |
| `ECHELON_RATE_LIMIT_WINDOW_MS`     | `60000`              | Rate limit window in ms                                      |
| `ECHELON_VIEW_FLUSH_MS`            | `15000`              | Beacon write buffer flush interval (ms)                      |
| `ECHELON_EVENT_FLUSH_MS`           | `10000`              | Event write buffer flush interval (ms)                       |
| `ECHELON_TRUST_PROXY`              | `false`              | Trust X-Forwarded-For / X-Real-IP headers                    |
| `ECHELON_BEHIND_CLOUDFLARE`        | `false`              | Trust Cloudflare headers (bot score, IP, country)            |
| `ECHELON_TRUST_GEO_HEADERS`        | `false`              | Trust CloudFront/generic geo headers                         |
| `ECHELON_COOKIE_CONSENT`           | `false`              | Show consent banner before setting visitor cookie            |
| `ECHELON_IGNORED_SITES`            | _(empty)_            | Site IDs to silently discard (+ always `smoke-test`)         |
| `ECHELON_ALLOWED_SITES`            | _(empty = all)_      | Site IDs to accept; tracking for any other site is dropped   |
| `ECHELON_DEBUG`                    | `false`              | Verbose debug logging (PoW, scoring, events)                 |
| `ECHELON_SITE_SUSPECT_COUNTRIES`   | _(empty)_            | Per-site suspect countries (`site:CC,CC;site:CC`)            |
| `ECHELON_CHALLENGE_WINDOW_MINUTES` | `10`                 | PoW challenge validity window (minutes)                      |
| `ECHELON_LIVE_STATS_MINUTES`       | `10`                 | Admin nav live stats window (minutes)                        |
| `ECHELON_DISPLAY_TIMEZONE`         | `UTC`                | IANA timezone for admin UI timestamps (data stored in UTC)   |
| `ECHELON_PUBLIC_MODE`              | `false`              | Read-only public dashboard (no auth, mutations blocked)      |
| `ECHELON_ANONYMIZE_SITES`          | _(empty)_            | Comma-separated site IDs to anonymize in responses           |
| `ECHELON_TELEMETRY`                | _(per-instance)_     | Override telemetry opt-in (`true`/`false`)                   |
| `ECHELON_SHUTDOWN_TIMEOUT_MS`      | `60000`              | Graceful shutdown timeout (ms) for flushing buffers          |

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
- **Framework:** Fresh 2.3.3 (Preact)
- **Database:** SQLite (WAL mode) via Deno's built-in `node:sqlite`
- **Frontend:** Preact islands with `@preact/signals`, Tailwind CSS v4
- **Build:** Vite 7

## Data Model

- **`visitor_views`** — per-hit pageview data with bot score, device, OS,
  country, referrer type, UTM parameters
- **`semantic_events`** — behavioral events (bounce, scroll, click, hover,
  session lifecycle, web vitals, custom events) with experiment/campaign linkage
- **`visitor_views_daily`** — pre-aggregated daily rollup (runs at 03:00 UTC)
- **`excluded_visitors`** — admin blocklist, plus `auto:<reason>` entries from
  the session classifier
- **`experiments`** / **`experiment_variants`** — A/B experiment definitions
  with weighted variant allocation
- **`utm_campaigns`** — registered UTM campaign definitions per site
- **`perf_metrics`** — CI/CD performance benchmark records
- **`site_settings`** — per-site configuration (consent CSS, home country and
  language)
- **`maintenance_log`** — daily rollup run records

Raw data is retained for 90 days (configurable via `ECHELON_RETENTION_DAYS`).
Bot-scored data can have independent retention via `ECHELON_BOT_RETENTION_DAYS`
(defaults to the same as clean data). Daily rollups are kept for 2 years.

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

| Tool                        | API Endpoint                 | Description                         |
| --------------------------- | ---------------------------- | ----------------------------------- |
| `analytics_overview`        | `/api/stats/overview`        | Visits, uniques, top paths, devices |
| `analytics_realtime`        | `/api/stats/realtime`        | Active visitors in last 5 minutes   |
| `analytics_campaigns`       | `/api/stats/campaigns`       | UTM campaign stats                  |
| `analytics_campaign_detail` | `/api/stats/campaigns?id=x`  | Campaign breakdown by source/medium |
| `analytics_experiments`     | `/api/stats/experiments`     | A/B experiment results              |
| `analytics_campaign_events` | `/api/stats/campaign-events` | Campaign-to-event correlation       |
| `analytics_dashboard`       | `/api/stats/dashboard`       | Live dashboard with trends          |
| `list_campaigns`            | `/api/campaigns`             | All UTM campaigns with metadata     |
| `list_experiments`          | `/api/experiments`           | All A/B experiments with variants   |

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

| Variable         | Required | Purpose                                               |
| ---------------- | -------- | ----------------------------------------------------- |
| `ECHELON_URL`    | Yes      | Base URL of the Echelon instance to query             |
| `ECHELON_SECRET` | No       | Bearer token (not needed for `PUBLIC_MODE` instances) |

## Docker

```bash
docker build -f confs/Dockerfile -t echelon .
docker run -p 1947:1947 -v echelon-data:/app/data echelon
```

The Dockerfile uses a multi-stage build (Deno 2.9.5), runs as a non-root
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

### Upgrading

Upgrading to a version with validated visitors and the engagement gate (from one
without them) changes three things on the first start:

- New indexes are built over `semantic_events` before the server starts
  listening. Allow a few seconds per million stored events; requests are not
  answered until it finishes.
- The first sweep after the start adds +15 to views from the last 30 minutes
  whose session sent only automatic events (bounce, session end, web vitals,
  scroll). Those events used to shield a view from the no-interaction penalty
  and no longer do.
- Do not turn on `ECHELON_REQUIRE_ENGAGEMENT` in the same deploy. Run the new
  version in its default mode first and compare validated visitors with unique
  visitors; strict mode then removes every visit that did not interact, going
  back three hours, on its first sweep.

Upgrading to a version with the device, cross-site and geography signals:

- From the first request after the upgrade, with no opt-in, the Windows tablet,
  Linux desktop and cross-site signals and the larger datacenter list (now also
  DigitalOcean and Oracle Cloud) apply on every site. Only the geography signals
  wait for a home country.
- A request that scores at or over `ECHELON_BOT_DISCARD_THRESHOLD` (default 50)
  when it arrives is not stored, so a wrong drop cannot be recovered or even
  seen. To audit the new signals, run the first days with
  `ECHELON_BOT_DISCARD_THRESHOLD=0`, which turns write-time discarding off: no
  request is then dropped for its score, and each is stored with its score and
  score detail (known-bot user agents, excluded visitors, rate-limited requests
  and duplicate beacons are still not stored). Rows scoring 50 or more are still
  left out of all statistics and rollups; they show on the admin bots pages and
  are purged on the bot retention schedule (`ECHELON_BOT_RETENTION_DAYS`). Set
  the threshold back once the scores look right.
- The first start drops an unused index on `semantic_events` (`idx_se_session`);
  no action is needed.

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
