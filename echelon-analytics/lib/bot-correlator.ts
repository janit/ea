// Echelon Analytics — Async Bot Correlator
//
// Background process that detects coordinated bot activity by correlating
// ephemeral request signals across IPs. Runs periodically, keeps all
// state in memory (IP hashes, fingerprints, taint markers), and
// retroactively updates bot_score in the DB when clusters are found.
//
// Privacy: uses the same daily-rotating HMAC hashes as the rest of
// Echelon — no raw IPs stored. Ephemeral state is pruned every sweep.
//
// Detection strategy:
// 1. Each beacon request records a "request print" in memory: IP hash,
//    visitor_id, UA fingerprint (os, browser, version, screen, country),
//    and whether the IP is headless-tainted.
// 2. Every SWEEP_INTERVAL, the correlator groups prints by fingerprint
//    and site. Clusters with many distinct IP hashes sharing an identical
//    fingerprint are almost certainly bot farms (real users have varied
//    browser versions, OSes, screen sizes).
// 3. Confirmed clusters get their bot_score bumped in the DB, which
//    excludes them from rollups (score ≥ 50).

import type { DbAdapter } from "./db/adapter.ts";
import { recordConfirmedBotIp } from "./bot-score.ts";

// ── Configuration ───────────────────────────────────────────────────────────

const SWEEP_INTERVAL_MS = 2 * 60 * 1000; // Run every 2 minutes
const PRINT_TTL_MS = 20 * 60 * 1000; // Keep prints for 20 minutes
const MAX_PRINTS = 200_000; // Memory cap

// Cluster thresholds — distinct IP hashes sharing a fingerprint on one site.
// Set high enough to avoid false positives on common fingerprints
// (e.g. Chrome/Windows/1080p/US). Accept-Language in the fingerprint
// provides additional differentiation.
const CLUSTER_THRESHOLD = 6; // ≥ 6 distinct IPs = flag
const CLUSTER_THRESHOLD_TAINTED = 4; // ≥ 4 when any IP is confirmed bot
const LARGE_CLUSTER = 8; // ≥ 8 = high-confidence bot farm

// Score penalties applied retroactively
const PENALTY_NORMAL = 30; // Moderate cluster
const PENALTY_LARGE = 50; // Large cluster or headless-confirmed

// No-event bounce detection: visits with zero semantic_events after a
// settling window are likely bots. Real users trigger scroll_depth,
// hover, click, or web_vital events within seconds of page load.
const NO_EVENTS_MIN_AGE_MS = 5 * 60 * 1000; // Wait 5 min before judging
const NO_EVENTS_MAX_AGE_MS = 30 * 60 * 1000; // Only check recent visits
const NO_EVENTS_PENALTY = 15; // Moderate — won't cross 50 alone

// ── Ephemeral request print store ───────────────────────────────────────────

/** A fingerprint captures the browser/device identity — fields a bot farm can't easily vary. */
interface Fingerprint {
  osName: string; // e.g. "Linux", "Windows 10/11"
  browserName: string; // e.g. "Chrome"
  browserVersion: string; // e.g. "139.0.0.0"
  screenWidth: number; // e.g. 1920
  screenHeight: number; // e.g. 1080
  countryCode: string; // e.g. "US"
  acceptLanguage: string; // e.g. "en-US,en;q=0.9" — differentiates real users
}

/** One recorded beacon request. */
interface RequestPrint {
  ipHash: string;
  visitorId: string;
  siteId: string;
  fingerprint: Fingerprint;
  headlessTainted: boolean; // IP was seen with HeadlessChrome or similar
  timestamp: number;
}

// All prints, keyed by a unique request ID (visitor_id + timestamp)
const prints: RequestPrint[] = [];

/** Compute a string key from a fingerprint for grouping. */
function fpKey(fp: Fingerprint): string {
  return `${fp.osName}|${fp.browserName}|${fp.browserVersion}|${fp.screenWidth}x${fp.screenHeight}|${fp.countryCode}|${fp.acceptLanguage}`;
}

/**
 * A fingerprint with no parseable browser/OS identity and no screen dimensions
 * carries no distinguishing signal — it's just "absence of data", which is the
 * most easily-shared key of all. Privacy-hardened browsers (Tor, Lockdown Mode,
 * header-stripping proxies) all collapse to this. Clustering on it would flag
 * unrelated real users as a bot farm, so such prints are excluded from
 * correlation (other layers — burst, threat feeds, PoW, no-event — still cover
 * them).
 */
function isUninformativeFingerprint(fp: Fingerprint): boolean {
  return fp.osName === "unknown" &&
    fp.browserName === "unknown" &&
    fp.screenWidth === 0 &&
    fp.screenHeight === 0;
}

/**
 * Record a beacon request for correlation.
 * Called from the beacon handler after computing bot score signals.
 */
export function recordPrint(print: RequestPrint): void {
  if (prints.length >= MAX_PRINTS) {
    // Emergency prune: drop oldest half
    prints.splice(0, prints.length >> 1);
  }
  prints.push(print);
}

// ── Sweep logic ─────────────────────────────────────────────────────────────

interface ClusterMatch {
  siteId: string;
  fpKeyStr: string;
  fingerprint: Fingerprint;
  ipHashes: Set<string>;
  visitorIds: Set<string>;
  hasTainted: boolean;
}

/** Run one correlation sweep. Finds clusters and updates the DB. */
async function sweep(db: DbAdapter): Promise<void> {
  const now = Date.now();

  // Prune expired prints
  let pruneIdx = 0;
  while (
    pruneIdx < prints.length && now - prints[pruneIdx].timestamp > PRINT_TTL_MS
  ) {
    pruneIdx++;
  }
  if (pruneIdx > 0) prints.splice(0, pruneIdx);

  // No-event bounce detection runs independently of live prints — quiet
  // periods are exactly when hit-and-leave bots need to be caught.
  await penalizeNoEventBounces(db);

  if (prints.length === 0) return;

  // Group by (siteId, fingerprint)
  const groups = new Map<string, ClusterMatch>();

  for (const p of prints) {
    if (isUninformativeFingerprint(p.fingerprint)) continue;
    const fk = fpKey(p.fingerprint);
    const groupKey = `${p.siteId}||${fk}`;
    let group = groups.get(groupKey);
    if (!group) {
      group = {
        siteId: p.siteId,
        fpKeyStr: fk,
        fingerprint: p.fingerprint,
        ipHashes: new Set(),
        visitorIds: new Set(),
        hasTainted: false,
      };
      groups.set(groupKey, group);
    }
    group.ipHashes.add(p.ipHash);
    group.visitorIds.add(p.visitorId);
    if (p.headlessTainted) group.hasTainted = true;
  }

  // Find clusters that exceed the threshold
  const clusters: ClusterMatch[] = [];
  for (const group of groups.values()) {
    const threshold = group.hasTainted
      ? CLUSTER_THRESHOLD_TAINTED
      : CLUSTER_THRESHOLD;
    if (group.ipHashes.size >= threshold) {
      clusters.push(group);
    }
  }

  if (clusters.length === 0) return;

  // Apply penalties to the DB
  for (const cluster of clusters) {
    const penalty =
      (cluster.hasTainted || cluster.ipHashes.size >= LARGE_CLUSTER)
        ? PENALTY_LARGE
        : PENALTY_NORMAL;

    const visitorIds = [...cluster.visitorIds];
    const detail = JSON.stringify({
      reason: "correlated",
      penalty,
      cluster_size: cluster.ipHashes.size,
      tainted: cluster.hasTainted,
      fingerprint: cluster.fpKeyStr,
    });

    // Chunk visitor_ids: SQLite's SQLITE_MAX_VARIABLE_NUMBER is 32766 on
    // node:sqlite. The UPDATE uses 4 non-IN params, so stay well under.
    const UPDATE_CHUNK_SIZE = 500;

    // Update both tables atomically so a crash between them can't leave
    // visitor_views and semantic_events with inconsistent bot scores.
    let totalUpdated = 0;
    try {
      totalUpdated = await db.transaction(async (tx) => {
        let changes = 0;
        for (let i = 0; i < visitorIds.length; i += UPDATE_CHUNK_SIZE) {
          const chunk = visitorIds.slice(i, i + UPDATE_CHUNK_SIZE);
          const placeholders = chunk.map(() => "?").join(",");

          const viewResult = await tx.run(
            `UPDATE visitor_views
             SET bot_score = MIN(bot_score + ?, 100),
                 bot_score_detail = CASE
                   WHEN bot_score_detail IS NULL THEN ?
                   ELSE json_set(bot_score_detail, '$.correlated', json(?))
                 END
             WHERE site_id = ?
               AND visitor_id IN (${placeholders})
               AND bot_score BETWEEN 0 AND 49
               AND (bot_score_detail IS NULL OR bot_score_detail NOT LIKE '%"correlated"%')`,
            penalty,
            `{"correlated":${detail}}`,
            detail,
            cluster.siteId,
            ...chunk,
          );

          const eventResult = await tx.run(
            `UPDATE semantic_events
             SET bot_score = MIN(bot_score + ?, 100),
                 bot_score_detail = CASE
                   WHEN bot_score_detail IS NULL THEN ?
                   ELSE json_set(bot_score_detail, '$.correlated', json(?))
                 END
             WHERE site_id = ?
               AND visitor_id IN (${placeholders})
               AND bot_score BETWEEN 0 AND 49
               AND (bot_score_detail IS NULL OR bot_score_detail NOT LIKE '%"correlated"%')`,
            penalty,
            `{"correlated":${detail}}`,
            detail,
            cluster.siteId,
            ...chunk,
          );

          changes += viewResult.changes + eventResult.changes;
        }
        return changes;
      });
    } catch (e) {
      console.error(
        `[echelon] bot-correlator: transaction failed for cluster on ${cluster.siteId}`,
        e,
      );
      // Skip the confirmed-IP map update on failure — keeping in-memory
      // and DB state consistent is more valuable than penalising the IPs
      // now. The next sweep will try again.
      continue;
    }

    // Only after the DB has been successfully updated do we record the
    // IPs as confirmed bots in the fast-path map. This keeps in-memory
    // state and DB rows in sync across restarts.
    for (const ipHash of cluster.ipHashes) {
      recordConfirmedBotIp(ipHash);
    }

    if (totalUpdated > 0) {
      console.log(
        `[echelon] bot-correlator: flagged cluster on ${cluster.siteId} ` +
          `(${cluster.ipHashes.size} IPs, ${cluster.visitorIds.size} visitors, ` +
          `fp=${cluster.fingerprint.osName}/${cluster.fingerprint.browserName} ` +
          `${cluster.fingerprint.browserVersion}/${cluster.fingerprint.screenWidth}x` +
          `${cluster.fingerprint.screenHeight}/${cluster.fingerprint.countryCode}, ` +
          `tainted=${cluster.hasTainted}, penalty=+${penalty}, ` +
          `updated=${totalUpdated} records)`,
      );
    }
  }
}

/**
 * Find visitor_views that are 5–30 minutes old with zero semantic_events
 * and apply a moderate bot score penalty. Idempotent via the
 * bot_score_detail "no_events" marker.
 */
async function penalizeNoEventBounces(db: DbAdapter): Promise<void> {
  const now = new Date();
  // Window of views eligible for judging: old enough to have settled (≥ 5 min)
  // but still recent (≤ 30 min). windowStart is the older bound (now − 30 min),
  // windowEnd the newer bound (now − 5 min).
  const windowStart = new Date(now.getTime() - NO_EVENTS_MAX_AGE_MS)
    .toISOString();
  const windowEnd = new Date(now.getTime() - NO_EVENTS_MIN_AGE_MS)
    .toISOString();

  const result = await db.run(
    `UPDATE visitor_views
     SET bot_score = MIN(bot_score + ?, 100),
         bot_score_detail = CASE
           WHEN bot_score_detail IS NULL THEN '{"no_events":true}'
           ELSE json_set(bot_score_detail, '$.no_events', json('true'))
         END
     WHERE created_at >= ? AND created_at <= ?
       AND bot_score BETWEEN 0 AND 49
       AND (bot_score_detail IS NULL OR bot_score_detail NOT LIKE '%"no_events"%')
       AND NOT EXISTS (
         SELECT 1 FROM semantic_events se
         WHERE se.visitor_id = visitor_views.visitor_id
           AND se.site_id = visitor_views.site_id
       )`,
    NO_EVENTS_PENALTY,
    windowStart,
    windowEnd,
  );

  if (result.changes > 0) {
    console.log(
      `[echelon] bot-correlator: no-event bounce penalty (+${NO_EVENTS_PENALTY}) applied to ${result.changes} views`,
    );
  }
}

// ── Lifecycle ───────────────────────────────────────────────────────────────

let sweepTimer: ReturnType<typeof setInterval> | null = null;

/** Start the background correlator. */
export function startBotCorrelator(db: DbAdapter): void {
  if (sweepTimer) return;
  sweepTimer = setInterval(() => {
    sweep(db).catch((e) =>
      console.error("[echelon] bot-correlator: sweep error", e)
    );
  }, SWEEP_INTERVAL_MS);
  console.log(
    `[echelon] bot-correlator: started (sweep every ${
      SWEEP_INTERVAL_MS / 1000
    }s, ` +
      `window ${PRINT_TTL_MS / 1000}s, cluster threshold ${CLUSTER_THRESHOLD})`,
  );
}

/** Stop the correlator and clear ephemeral state. */
export function stopBotCorrelator(): void {
  if (sweepTimer) {
    clearInterval(sweepTimer);
    sweepTimer = null;
  }
  prints.length = 0;
}

// ── Exported for testing ────────────────────────────────────────────────────
export { sweep as _sweep };
export type { Fingerprint, RequestPrint };
