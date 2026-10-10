# Privacy Policy Template — Echelon Analytics

> **Instructions**: Replace all `[bracketed placeholders]` with your values.
> Delete any optional sections that don't apply to your deployment.

---

## Privacy Policy

**Last updated**: [DATE]

[YOUR COMPANY/PROJECT NAME] ("we", "us", "our") operates [YOUR WEBSITE URL] (the
"Service"). This policy describes what data we collect, why we collect it, how
we process it, and your rights regarding that data.

We use [Echelon Analytics](https://ea.js.org) for self-hosted web analytics. All
analytics data is processed and stored on our own infrastructure — it is never
sent to third-party analytics services.

### 1. Data We Collect

#### 1.1 Analytics Data (Collected Automatically)

When you visit our Service, we collect anonymous usage data to understand how
people use the site and to improve the experience. This data **cannot identify
you personally**.

| Data                 | Purpose                     | Example                      |
| -------------------- | --------------------------- | ---------------------------- |
| Pages visited        | Understand popular content  | `/about`                     |
| Device type          | Optimize for mobile/desktop | `mobile`, `desktop`          |
| Screen resolution    | Responsive design testing   | `375x812`                    |
| Operating system     | Browser compatibility       | `iOS`, `Android`             |
| Country              | Regional content relevance  | `FI`, `US`                   |
| Referrer origin      | Understand traffic sources  | `google.com`                 |
| Interaction time     | Measure engagement quality  | `4200ms`                     |
| Scroll depth         | Understand reading behavior | `75%`                        |
| Anonymous visitor ID | Distinguish unique visits   | Random 16-character hex code |

**What we do NOT collect:**

- Your name, email address, or any account information
- Your IP address (used transiently for visitor hashing and rate limiting —
  never stored in our database)
- Precise geolocation (country is derived from request headers, not GPS)
- Browser fingerprints
- Cross-site tracking data

#### 1.2 Behavioral Events

We record anonymous interactions such as clicks, outbound link clicks, file
downloads, and form interactions (focus/edit/submit — not form content). Each
event records:

- The type of action (e.g., "click", "outbound", "download", "scroll_depth")
- Contextual metadata (e.g., link URL, file extension, scroll percentage)
- The anonymous visitor ID and session ID
- Device type and country

These events help us understand which features are useful and where users
encounter friction.

> [DELETE section 1.2 if you disable event tracking with `data-no-clicks`,
> `data-no-scroll`, `data-no-outbound`, `data-no-downloads`, `data-no-forms`]

#### 1.3 Performance Metrics

We collect anonymous Core Web Vitals (LCP, CLS, INP) to monitor page load
performance and user experience quality. These measurements contain no personal
data — only metric name, value, and rating (good/needs-improvement/poor).

> [DELETE section 1.3 if you disable vitals with `data-no-vitals`]

#### 1.4 UTM Campaign Data

If you arrive via a link containing UTM parameters (e.g., `utm_source`,
`utm_campaign`), we record those marketing attribution values alongside your
anonymous visit. This helps us understand which campaigns drive traffic.

#### 1.5 A/B Experiment Data

We may run anonymous split tests to measure the impact of changes to the
Service. If you are part of an experiment, we record which variant you saw and
whether a conversion event occurred. Variant assignment is random and anonymous.

> [DELETE sections 1.4 and/or 1.5 if you don't use campaigns or experiments]

#### 1.6 Bot Detection

To protect the Service from automated abuse, we score each request using
multiple detection methods including interaction timing, request frequency,
header analysis, and comparison against publicly-available lists of known
crawler user-agents and cloud provider IP ranges. This system:

- Uses a one-way hash of your IP address that rotates every 24 hours
- Does not store your IP address — hashes are held in memory temporarily (up to
  1 hour) and are lost on server restart
- Compares your IP against known cloud provider address ranges (AWS, Google
  Cloud, DigitalOcean, Oracle Cloud) to identify datacenter traffic
- Does not affect legitimate users — it only filters automated traffic

### 2. Visitor Identity

By default, visitors are identified using a daily-rotating one-way hash of IP
address + User-Agent + site ID + date. This means:

- Your identity resets every day — no cross-day tracking
- The hash cannot be reversed to recover your IP address
- No cookie consent is required (GDPR/ePrivacy compliant)

**If persistent cookies are enabled** (`data-cookie` attribute), we set a single
cookie:

| Cookie | Purpose                           | Duration | Attributes                                   |
| ------ | --------------------------------- | -------- | -------------------------------------------- |
| `_ev`  | Anonymous visitor ID (random hex) | 30 days  | HttpOnly, Secure, SameSite=None, Partitioned |

This cookie contains a random 16-character identifier that cannot be linked to
your identity. We do not use advertising cookies, tracking pixels, or
third-party cookie services.

Session data is stored in your browser's sessionStorage and is automatically
cleared when you close the tab.

### 3. Third-Party Data Sharing

We do not share your data with any third parties. All analytics data is
processed and stored on our own infrastructure.

[IF YOU USE A CDN, ADD: "We use [CDN PROVIDER] as a CDN, which processes
requests in accordance with their privacy policy: [CDN PRIVACY POLICY URL].
Analytics data itself is stored exclusively on our servers."]

### 4. Data Storage and Security

- Analytics data is stored in an SQLite database on servers located in
  [COUNTRY/REGION]
- Data is transmitted over HTTPS (TLS encryption in transit)
- Database access is restricted to authenticated application processes
- Administrative access requires authentication and is rate-limited
- Proof-of-work challenges protect tracking endpoints from abuse

### 5. Data Retention

| Data type                        | Retention period                                         |
| -------------------------------- | -------------------------------------------------------- |
| Raw page views                   | [DEFAULT: 90 days]                                       |
| Raw behavioral events            | [DEFAULT: 90 days]                                       |
| Aggregated daily summaries       | [DEFAULT: 2 years]                                       |
| Bot detection IP hashes          | Up to 30 min or 1 hour (in memory only, lost on restart) |
| Bot fingerprint correlation data | Up to 20 minutes (in memory only)                        |
| Rate limiting data               | 60 seconds (in memory only)                              |

After the retention period, raw data is automatically purged. Aggregated
summaries contain no visitor-level data.

[ADJUST RETENTION PERIODS TO MATCH YOUR `ECHELON_RETENTION_DAYS` SETTING]

### 6. Your Rights

Since we collect only anonymous data with no account system, most requests
require you to provide your anonymous visitor ID (found in the `_ev` cookie via
your browser's developer tools, or not available if cookies are disabled).

**Under GDPR (EU/EEA residents):**

- **Right to access** — Request a copy of data associated with your visitor ID
- **Right to erasure** — Request deletion of data associated with your visitor
  ID
- **Right to object** — Object to processing of your data
- **Right to restriction** — Request limitation of processing
- **Right to data portability** — Receive your data in a machine-readable format

**Under CCPA (California residents):**

- You have the right to know what data we collect (described above)
- You have the right to request deletion of your data
- We do not sell personal information

**To exercise any of these rights**, contact us at [CONTACT EMAIL].

### 7. Legal Basis for Processing (GDPR)

We process anonymous analytics data under **legitimate interest** (Article
6(1)(f) GDPR). Our legitimate interest is understanding how the Service is used
so we can improve it. We have assessed that this processing does not override
your rights because:

- All data is anonymous — it cannot identify you
- No sensitive personal data is processed
- Visitor identity resets daily (or you can clear the cookie at any time)
- The processing has minimal impact on your privacy

### 8. Children's Privacy

We do not knowingly collect data from children under 13 (or under 16 in the EU).
The Service is not directed at children. If you believe a child has provided us
with personal data, contact us at [CONTACT EMAIL].

### 9. International Data Transfers

Our servers are located in [COUNTRY]. If you access the Service from outside
[COUNTRY], your anonymous analytics data will be transferred to and processed in
[COUNTRY].

[FOR EU RESIDENTS, ADD IF APPLICABLE: "We rely on [Standard Contractual Clauses
/ adequacy decisions / other legal mechanism] for this transfer."]

### 10. Changes to This Policy

We may update this policy from time to time. We will notify you of significant
changes by updating the "Last updated" date above. Continued use of the Service
after changes constitutes acceptance.

### 11. Contact

For privacy-related questions or to exercise your rights:

- Email: [CONTACT EMAIL]

---

> **Template version**: 2.0 **Covers**: Echelon Analytics self-hosted analytics
> — pageview tracking, behavioral events (clicks, scroll depth, outbound links,
> downloads, form interactions), Core Web Vitals, bot scoring, UTM campaign
> tracking, A/B experiment tracking.
