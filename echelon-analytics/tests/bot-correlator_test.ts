import { assertEquals } from "@std/assert";
import { createTestDb, insertEvent, insertView } from "./_helpers.ts";
import {
  _sweep as sweep,
  type Fingerprint,
  recordPrint,
  type RequestPrint,
  stopBotCorrelator,
} from "@/lib/bot-correlator.ts";

// Clean up correlator state between tests
function cleanup() {
  stopBotCorrelator();
}

function makePrint(
  ipHash: string,
  visitorId: string,
  overrides: Partial<RequestPrint> = {},
): RequestPrint {
  const fp: Fingerprint = {
    osName: "Linux",
    browserName: "Chrome",
    browserVersion: "139.0.0.0",
    screenWidth: 1920,
    screenHeight: 1080,
    countryCode: "US",
    acceptLanguage: "en-US,en;q=0.9",
    ...(overrides.fingerprint ?? {}),
  };
  return {
    ipHash,
    visitorId,
    siteId: "south-africa.afroute.com",
    fingerprint: fp,
    headlessTainted: false,
    timestamp: Date.now(),
    ...overrides,
    // Re-apply fingerprint since overrides spread may clobber it
    ...(overrides.fingerprint ? { fingerprint: fp } : {}),
  };
}

Deno.test({
  name: "bot-correlator — no prints → sweep is a no-op",
  async fn() {
    cleanup();
    const db = createTestDb();
    await sweep(db);
    // No error = success
  },
});

Deno.test({
  name: "bot-correlator — below threshold → no updates",
  async fn() {
    cleanup();
    const db = createTestDb();

    // 5 distinct IPs (below threshold of 6)
    for (let i = 0; i < 5; i++) {
      const vid = `visitor_${i}`.padEnd(16, "0");
      await insertView(db, {
        visitor_id: vid,
        site_id: "south-africa.afroute.com",
        bot_score: 0,
      });
      recordPrint(makePrint(`ip_hash_${i}`, vid));
    }

    await sweep(db);

    // All scores should remain 0
    const rows = await db.query<{ bot_score: number }>(
      "SELECT bot_score FROM visitor_views",
    );
    for (const r of rows) {
      assertEquals(r.bot_score, 0);
    }
  },
});

Deno.test({
  name:
    "bot-correlator — all-unknown fingerprints are NOT clustered (privacy-user false positive)",
  async fn() {
    cleanup();
    const db = createTestDb();

    // 8 unrelated privacy-hardened users (Tor/Lockdown/etc.) whose UA, screen,
    // country and Accept-Language all failed to parse → identical "unknown"
    // fingerprint. They share nothing but absence-of-data and must NOT be
    // flagged as a bot farm.
    const unknownFp: Fingerprint = {
      osName: "unknown",
      browserName: "unknown",
      browserVersion: "unknown",
      screenWidth: 0,
      screenHeight: 0,
      countryCode: "unknown",
      acceptLanguage: "unknown",
    };
    for (let i = 0; i < 8; i++) {
      const vid = `priv_user_${i}`.padEnd(16, "0");
      await insertView(db, {
        visitor_id: vid,
        site_id: "south-africa.afroute.com",
        bot_score: 0,
      });
      recordPrint(
        makePrint(`ip_hash_${i}`, vid, { fingerprint: unknownFp }),
      );
    }

    await sweep(db);

    const rows = await db.query<{ bot_score: number }>(
      "SELECT bot_score FROM visitor_views",
    );
    for (const r of rows) {
      assertEquals(r.bot_score, 0);
    }
  },
});

Deno.test({
  name: "bot-correlator — cluster at threshold → updates bot_score",
  async fn() {
    cleanup();
    const db = createTestDb();

    // 6 distinct IPs with identical fingerprint (threshold = 6)
    for (let i = 0; i < 6; i++) {
      const vid = `visitor_${i}`.padEnd(16, "0");
      await insertView(db, {
        visitor_id: vid,
        site_id: "south-africa.afroute.com",
        bot_score: 0,
      });
      recordPrint(makePrint(`ip_hash_${i}`, vid));
    }

    await sweep(db);

    const rows = await db.query<
      { bot_score: number; bot_score_detail: string }
    >(
      "SELECT bot_score, bot_score_detail FROM visitor_views",
    );
    for (const r of rows) {
      assertEquals(r.bot_score, 30); // PENALTY_NORMAL
      const detail = JSON.parse(r.bot_score_detail);
      assertEquals(detail.correlated.reason, "correlated");
      assertEquals(detail.correlated.cluster_size, 6);
    }
  },
});

Deno.test({
  name: "bot-correlator — tainted cluster uses lower threshold",
  async fn() {
    cleanup();
    const db = createTestDb();

    // 4 IPs, one is headless-tainted (tainted threshold = 4)
    for (let i = 0; i < 4; i++) {
      const vid = `visitor_${i}`.padEnd(16, "0");
      await insertView(db, {
        visitor_id: vid,
        site_id: "south-africa.afroute.com",
        bot_score: 0,
      });
      recordPrint(makePrint(`ip_hash_${i}`, vid, {
        headlessTainted: i === 0, // First IP is tainted
      }));
    }

    await sweep(db);

    const rows = await db.query<
      { bot_score: number; bot_score_detail: string }
    >(
      "SELECT bot_score, bot_score_detail FROM visitor_views",
    );
    for (const r of rows) {
      assertEquals(r.bot_score, 50); // PENALTY_LARGE (tainted)
      const detail = JSON.parse(r.bot_score_detail);
      assertEquals(detail.correlated.tainted, true);
    }
  },
});

Deno.test({
  name: "bot-correlator — large cluster gets higher penalty",
  async fn() {
    cleanup();
    const db = createTestDb();

    // 8 distinct IPs — large cluster
    for (let i = 0; i < 8; i++) {
      const vid = `visitor_${i}`.padEnd(16, "0");
      await insertView(db, {
        visitor_id: vid,
        site_id: "south-africa.afroute.com",
        bot_score: 0,
      });
      recordPrint(makePrint(`ip_hash_${i}`, vid));
    }

    await sweep(db);

    const rows = await db.query<{ bot_score: number }>(
      "SELECT bot_score FROM visitor_views",
    );
    for (const r of rows) {
      assertEquals(r.bot_score, 50); // PENALTY_LARGE
    }
  },
});

Deno.test({
  name: "bot-correlator — different fingerprints don't cluster",
  async fn() {
    cleanup();
    const db = createTestDb();

    // 6 IPs but each has a different browser version
    for (let i = 0; i < 6; i++) {
      const vid = `visitor_${i}`.padEnd(16, "0");
      await insertView(db, {
        visitor_id: vid,
        site_id: "south-africa.afroute.com",
        bot_score: 0,
      });
      recordPrint(makePrint(`ip_hash_${i}`, vid, {
        fingerprint: {
          osName: "Linux",
          browserName: "Chrome",
          browserVersion: `${120 + i}.0.0.0`, // Different versions
          screenWidth: 1920,
          screenHeight: 1080,
          countryCode: "US",
          acceptLanguage: "en-US,en;q=0.9",
        },
      }));
    }

    await sweep(db);

    const rows = await db.query<{ bot_score: number }>(
      "SELECT bot_score FROM visitor_views",
    );
    for (const r of rows) {
      assertEquals(r.bot_score, 0); // Unchanged
    }
  },
});

Deno.test({
  name: "bot-correlator — different Accept-Language prevents false clustering",
  async fn() {
    cleanup();
    const db = createTestDb();

    // 6 IPs with same fingerprint EXCEPT Accept-Language varies
    const langs = [
      "en-US,en;q=0.9",
      "de-DE,de;q=0.9",
      "fr-FR,fr;q=0.9",
      "nl-NL,nl;q=0.9",
      "sv-SE,sv;q=0.9",
      "nb-NO,nb;q=0.9",
    ];
    for (let i = 0; i < 6; i++) {
      const vid = `visitor_${i}`.padEnd(16, "0");
      await insertView(db, {
        visitor_id: vid,
        site_id: "south-africa.afroute.com",
        bot_score: 0,
      });
      recordPrint(makePrint(`ip_hash_${i}`, vid, {
        fingerprint: {
          osName: "Windows 10/11",
          browserName: "Chrome",
          browserVersion: "131.0.0.0",
          screenWidth: 1920,
          screenHeight: 1080,
          countryCode: "US",
          acceptLanguage: langs[i],
        },
      }));
    }

    await sweep(db);

    const rows = await db.query<{ bot_score: number }>(
      "SELECT bot_score FROM visitor_views",
    );
    for (const r of rows) {
      assertEquals(r.bot_score, 0); // No false clustering
    }
  },
});

Deno.test({
  name: "bot-correlator — idempotent: second sweep doesn't double-penalize",
  async fn() {
    cleanup();
    const db = createTestDb();

    for (let i = 0; i < 6; i++) {
      const vid = `visitor_${i}`.padEnd(16, "0");
      await insertView(db, {
        visitor_id: vid,
        site_id: "south-africa.afroute.com",
        bot_score: 0,
      });
      recordPrint(makePrint(`ip_hash_${i}`, vid));
    }

    await sweep(db);
    await sweep(db); // Second sweep

    const rows = await db.query<{ bot_score: number }>(
      "SELECT bot_score FROM visitor_views",
    );
    for (const r of rows) {
      assertEquals(r.bot_score, 30); // Still 30, not 60
    }
  },
});

Deno.test({
  name: "bot-correlator — also updates semantic_events",
  async fn() {
    cleanup();
    const db = createTestDb();

    for (let i = 0; i < 6; i++) {
      const vid = `visitor_${i}`.padEnd(16, "0");
      await insertView(db, {
        visitor_id: vid,
        site_id: "south-africa.afroute.com",
        bot_score: 0,
      });
      await insertEvent(db, {
        visitor_id: vid,
        site_id: "south-africa.afroute.com",
        bot_score: 0,
      });
      recordPrint(makePrint(`ip_hash_${i}`, vid));
    }

    await sweep(db);

    const events = await db.query<{ bot_score: number }>(
      "SELECT bot_score FROM semantic_events",
    );
    for (const e of events) {
      assertEquals(e.bot_score, 30);
    }
  },
});

Deno.test({
  name:
    "bot-correlator — already-flagged views (score >= 50) are not re-updated",
  async fn() {
    cleanup();
    const db = createTestDb();

    for (let i = 0; i < 6; i++) {
      const vid = `visitor_${i}`.padEnd(16, "0");
      await insertView(db, {
        visitor_id: vid,
        site_id: "south-africa.afroute.com",
        bot_score: i === 0 ? 60 : 0, // First one already flagged
      });
      recordPrint(makePrint(`ip_hash_${i}`, vid));
    }

    await sweep(db);

    const rows = await db.query<{ visitor_id: string; bot_score: number }>(
      "SELECT visitor_id, bot_score FROM visitor_views ORDER BY visitor_id",
    );
    // The already-flagged one stays at 60
    assertEquals(rows[0].bot_score, 60);
    // Others get +30
    for (let i = 1; i < rows.length; i++) {
      assertEquals(rows[i].bot_score, 30);
    }
  },
});

Deno.test({
  name: "bot-correlator — different sites don't cross-contaminate",
  async fn() {
    cleanup();
    const db = createTestDb();

    // 3 visitors on site A, 3 on site B — neither reaches threshold of 6
    for (let i = 0; i < 3; i++) {
      const vid = `visitor_a${i}`.padEnd(16, "0");
      await insertView(db, {
        visitor_id: vid,
        site_id: "site-a.com",
        bot_score: 0,
      });
      recordPrint(makePrint(`ip_hash_${i}`, vid, {
        siteId: "site-a.com",
      }));
    }
    for (let i = 0; i < 3; i++) {
      const vid = `visitor_b${i}`.padEnd(16, "0");
      await insertView(db, {
        visitor_id: vid,
        site_id: "site-b.com",
        bot_score: 0,
      });
      recordPrint(makePrint(`ip_hash_${i + 3}`, vid, {
        siteId: "site-b.com",
      }));
    }

    await sweep(db);

    const rows = await db.query<{ bot_score: number }>(
      "SELECT bot_score FROM visitor_views",
    );
    for (const r of rows) {
      assertEquals(r.bot_score, 0); // No updates
    }
  },
});
