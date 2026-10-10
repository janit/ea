import { assertEquals } from "@std/assert";
import { getBotIpPenalty } from "@/lib/bot-score.ts";
import { createTestDb, insertEvent, insertView } from "./_helpers.ts";
import {
  _eventPenaltySql as eventPenaltySql,
  _sweep as sweep,
  _viewPenaltySql as viewPenaltySql,
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
    // Thirteen minutes old: past the correlator's 12 minute settle time.
    timestamp: Date.now() - 13 * 60_000,
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

Deno.test({
  name:
    "bot-correlator — a proven human in a cluster is spared; the rest are penalised",
  async fn() {
    cleanup();
    const db = createTestDb();
    const site = "corr-proven-site";
    for (let i = 0; i < 8; i++) {
      const vid = `corrproven${i}`.padEnd(16, "0");
      await insertView(db, {
        visitor_id: vid,
        site_id: site,
        bot_score: 0,
        validated: i === 0 ? 1 : 0,
        // Recent, so the engagement gate (also run by sweep) leaves it alone.
        created_at: new Date().toISOString(),
      });
      recordPrint(makePrint(`corr_proven_ip_${i}`, vid, { siteId: site }));
    }

    await sweep(db);

    const rows = await db.query<{ visitor_id: string; bot_score: number }>(
      "SELECT visitor_id, bot_score FROM visitor_views WHERE site_id = ? ORDER BY visitor_id",
      site,
    );
    assertEquals(rows[0].bot_score, 0, "validated visitor untouched");
    for (const r of rows.slice(1)) assertEquals(r.bot_score, 50);
    await db.close();
  },
});

Deno.test({
  name:
    "bot-correlator — a visitor seen less than 12 minutes ago is not penalised yet",
  async fn() {
    cleanup();
    const db = createTestDb();
    const site = "corr-settle-site";
    for (let i = 0; i < 8; i++) {
      const vid = `corrsettle${i}`.padEnd(16, "0");
      await insertView(db, {
        visitor_id: vid,
        site_id: site,
        bot_score: 0,
        created_at: new Date().toISOString(),
      });
      recordPrint(
        makePrint(`corr_settle_ip_${i}`, vid, {
          siteId: site,
          // Visitor 0 arrived eleven minutes ago; the other seven thirteen.
          ...(i === 0 ? { timestamp: Date.now() - 11 * 60_000 } : {}),
        }),
      );
    }

    await sweep(db);

    const rows = await db.query<{ visitor_id: string; bot_score: number }>(
      "SELECT visitor_id, bot_score FROM visitor_views WHERE site_id = ? ORDER BY visitor_id",
      site,
    );
    assertEquals(rows[0].bot_score, 0, "new arrival has time to prove itself");
    for (const r of rows.slice(1)) assertEquals(r.bot_score, 50);
    await db.close();
  },
});

Deno.test({
  name:
    "bot-correlator — only penalised visitors' IPs become confirmed bot IPs",
  async fn() {
    cleanup();
    const db = createTestDb();
    const site = "corr-ip-site";
    for (let i = 0; i < 8; i++) {
      const vid = `corrip${i}`.padEnd(16, "0");
      await insertView(db, {
        visitor_id: vid,
        site_id: site,
        validated: i === 0 ? 1 : 0,
        created_at: new Date().toISOString(),
      });
      recordPrint(makePrint(`corr_ip_hash_${i}`, vid, { siteId: site }));
    }
    await sweep(db);
    assertEquals(getBotIpPenalty("corr_ip_hash_0"), 0, "proven visitor's IP");
    assertEquals(getBotIpPenalty("corr_ip_hash_1"), 50);
    await db.close();
  },
});

Deno.test({
  name:
    "bot-correlator — a visitor skipped as unsettled is penalised by a later sweep, and its IP is confirmed only then",
  async fn() {
    cleanup();
    const db = createTestDb();
    const site = "corr-later-site";
    const now = Date.now();
    for (let i = 0; i < 8; i++) {
      const vid = `corrlater${i}`.padEnd(16, "0");
      await insertView(db, {
        visitor_id: vid,
        site_id: site,
        bot_score: 0,
        created_at: new Date(now).toISOString(),
      });
      recordPrint(
        makePrint(`corr_later_ip_${i}`, vid, {
          siteId: site,
          timestamp: now - (i === 0 ? 11 : 13) * 60_000,
        }),
      );
    }
    const scores = async () =>
      (await db.query<{ bot_score: number }>(
        "SELECT bot_score FROM visitor_views WHERE site_id = ? ORDER BY visitor_id",
        site,
      )).map((r) => r.bot_score);

    await sweep(db, now);
    assertEquals(await scores(), [0, 50, 50, 50, 50, 50, 50, 50]);
    assertEquals(getBotIpPenalty("corr_later_ip_0"), 0, "unsettled: no IP");
    assertEquals(getBotIpPenalty("corr_later_ip_1"), 50);

    // The next sweep, two minutes on: thirteen minutes since first seen.
    await sweep(db, now + 2 * 60_000);
    assertEquals(await scores(), [50, 50, 50, 50, 50, 50, 50, 50]);
    assertEquals(getBotIpPenalty("corr_later_ip_0"), 50);
    await db.close();
  },
});

Deno.test({
  name: "bot-correlator — a failing engagement gate does not cancel clustering",
  async fn() {
    cleanup();
    const db = createTestDb();
    // The gate names this index and fails without it.
    await db.exec("DROP INDEX idx_se_clean_interaction");
    const site = "corr-gate-fails-site";
    for (let i = 0; i < 8; i++) {
      const vid = `corrgatefail${i}`.padEnd(16, "0");
      await insertView(db, { visitor_id: vid, site_id: site, bot_score: 0 });
      recordPrint(makePrint(`corr_gate_fail_ip_${i}`, vid, { siteId: site }));
    }
    const logged: unknown[][] = [];
    const error = console.error;
    console.error = (...args: unknown[]) => logged.push(args);
    try {
      await sweep(db);
    } finally {
      console.error = error;
    }
    assertEquals(logged.length, 1);
    assertEquals(
      String(logged[0][0]).includes("engagement gate failed"),
      true,
      String(logged[0][0]),
    );
    assertEquals(
      String((logged[0][1] as Error).message).includes(
        "idx_se_clean_interaction",
      ),
      true,
    );
    const rows = await db.query<{ bot_score: number }>(
      "SELECT bot_score FROM visitor_views WHERE site_id = ?",
      site,
    );
    assertEquals(rows.map((r) => r.bot_score), Array(8).fill(50));
    await db.close();
  },
});

Deno.test({
  name:
    "bot-correlator — cluster members the gate raised first are still marked, and a late gesture does not release them",
  async fn() {
    cleanup();
    const db = createTestDb();
    const site = "corr-gate-first-site";
    const t0 = Date.now();
    const min = (n: number) => t0 + n * 60_000;
    const seen = new Date(t0).toISOString();
    // One cluster of 8: four sent no token, four did. Plus a tokenless
    // visitor on the same site who is in no cluster.
    const ids = Array.from(
      { length: 8 },
      (_, i) => `corrgate${i}`.padEnd(16, "0"),
    );
    for (const [i, vid] of [...ids, "loner".padEnd(16, "0")].entries()) {
      const tokenless = i < 4 || i === 8;
      await insertView(db, {
        visitor_id: vid,
        site_id: site,
        session_id: `s-${vid}`,
        bot_score: tokenless ? 30 : 0,
        bot_score_detail: tokenless ? '{"pow":30}' : null,
        created_at: seen,
      });
      if (i < 8) {
        recordPrint(
          makePrint(`corr_gate_ip_${i}`, vid, { siteId: site, timestamp: t0 }),
        );
      }
    }
    const rows = async () =>
      (await db.query<
        { visitor_id: string; bot_score: number; bot_score_detail: string }
      >(
        "SELECT visitor_id, bot_score, bot_score_detail FROM visitor_views WHERE site_id = ? ORDER BY id",
        site,
      )).map((r) => ({
        score: r.bot_score,
        keys: Object.keys(JSON.parse(r.bot_score_detail)).sort().join(","),
      }));

    // 6 minutes: the gate judges everyone idle. Nobody is settled yet.
    await sweep(db, min(6));
    assertEquals((await rows()).map((r) => r.score), [
      ...Array(4).fill(50),
      ...Array(4).fill(15),
      50,
    ]);

    // 14 minutes: the cluster is settled. The tokenless half is already at
    // the threshold; it must be judged all the same.
    await sweep(db, min(14));
    const judged = await rows();
    for (const r of judged.slice(0, 4)) {
      assertEquals(r, { score: 100, keys: "correlated,pow,unproven" });
    }
    for (const r of judged.slice(4, 8)) {
      assertEquals(r, { score: 65, keys: "correlated,no_events" });
    }
    assertEquals(judged[8], { score: 50, keys: "pow,unproven" });

    // The same sweep again stamps nothing twice.
    await sweep(db, min(14));
    assertEquals(await rows(), judged);

    // 90 minutes: everyone makes one clean gesture. 92: the next sweep.
    for (const vid of [...ids, "loner".padEnd(16, "0")]) {
      await insertEvent(db, {
        event_type: "engage",
        site_id: site,
        session_id: `s-${vid}`,
        visitor_id: vid,
        created_at: new Date(min(90)).toISOString(),
      });
    }
    await sweep(db, min(92));
    const after = await rows();
    assertEquals(after.slice(0, 8), judged.slice(0, 8));
    // Not in any cluster: the late gesture still forgives it.
    assertEquals(after[8], { score: 30, keys: "pow" });
    await db.close();
  },
});

Deno.test({
  name:
    "bot-correlator — a view over the threshold for its own reasons is still left alone",
  async fn() {
    cleanup();
    const db = createTestDb();
    const site = "corr-own-reasons-site";
    const details = [
      [70, '{"burst":25,"geo":30,"no_events":15}'], // 55 without the mark
      [50, '{"pow":30,"unproven":20,"no_engagement":50}'],
      [60, '{"pow":30,"unproven":20,"classifier":"velocity"}'],
      [50, '{"pow":50}'],
      [50, null],
    ] as const;
    for (let i = 0; i < 8; i++) {
      const vid = `corrown${i}`.padEnd(16, "0");
      const [bot_score, bot_score_detail] = details[i] ?? [0, null];
      await insertView(db, {
        visitor_id: vid,
        site_id: site,
        bot_score,
        bot_score_detail,
        created_at: new Date().toISOString(),
      });
      recordPrint(makePrint(`corr_own_ip_${i}`, vid, { siteId: site }));
    }
    await sweep(db);
    const rows = await db.query<
      { bot_score: number; bot_score_detail: string | null }
    >(
      "SELECT bot_score, bot_score_detail FROM visitor_views WHERE site_id = ? ORDER BY id",
      site,
    );
    details.forEach(([bot_score, bot_score_detail], i) =>
      assertEquals(rows[i], { bot_score, bot_score_detail })
    );
    for (const r of rows.slice(5)) assertEquals(r.bot_score, 50);
    await db.close();
  },
});

Deno.test("bot-correlator — the view penalty reaches rows through the visitor index", async () => {
  const db = createTestDb();
  const plan = (await db.query<{ detail: string }>(
    `EXPLAIN QUERY PLAN ${viewPenaltySql(3)}`,
    30,
    "{}",
    "{}",
    "site",
    "a",
    "b",
    "c",
  )).map((r) => r.detail);
  assertEquals(plan, [
    "SEARCH visitor_views USING INDEX idx_vv_visitor (visitor_id=?)",
  ]);
  await db.close();
});

Deno.test("bot-correlator — the event penalty reaches rows through the visitor index", async () => {
  const db = createTestDb();
  const plan = (await db.query<{ detail: string }>(
    `EXPLAIN QUERY PLAN ${eventPenaltySql(3)}`,
    30,
    "{}",
    "{}",
    "site",
    "a",
    "b",
    "c",
  )).map((r) => r.detail);
  assertEquals(plan, [
    "SEARCH semantic_events USING INDEX idx_se_visitor (visitor_id=?)",
  ]);
  await db.close();
});

Deno.test("bot-correlator — the event penalty touches only the cluster's clean events on its site", async () => {
  const db = createTestDb();
  const at = new Date().toISOString();
  const rows: [string, string, number, string | null][] = [
    ["v1", "site", 0, null], // penalised
    ["v1", "site", 10, '{"burst":10}'], // penalised, detail kept
    ["v1", "other", 0, null], // another site
    ["v2", "site", 0, null], // another visitor
    ["v1", "site", 60, null], // already a bot
    ["v1", "site", 0, '{"correlated":{}}'], // already marked
  ];
  for (const [visitor_id, site_id, bot_score, bot_score_detail] of rows) {
    await db.run(
      `INSERT INTO semantic_events
         (event_type, site_id, visitor_id, bot_score, bot_score_detail, created_at)
       VALUES ('click', ?, ?, ?, ?, ?)`,
      site_id,
      visitor_id,
      bot_score,
      bot_score_detail,
      at,
    );
  }
  const res = await db.run(
    eventPenaltySql(1),
    30,
    '{"correlated":{"penalty":30}}',
    '{"penalty":30}',
    "site",
    "v1",
  );
  assertEquals(res.changes, 2);
  const after = await db.query<{ bot_score: number; d: string | null }>(
    "SELECT bot_score, bot_score_detail AS d FROM semantic_events ORDER BY id",
  );
  assertEquals(after.map((r) => r.bot_score), [30, 40, 0, 0, 60, 0]);
  assertEquals(JSON.parse(after[0].d!), { correlated: { penalty: 30 } });
  assertEquals(JSON.parse(after[1].d!), {
    burst: 10,
    correlated: { penalty: 30 },
  });
  await db.close();
});
