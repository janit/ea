import { assertEquals } from "@std/assert";
import { FakeTime } from "@std/testing/time";
import {
  classifySessions,
  FIRST_RUN_MS,
  FLAGGED_EVENTS_SQL,
  INTERVAL_MS,
  osFamily,
  pathnameOf,
  SETTLE_MS,
  stampSql,
  startSessionClassifier,
  stopSessionClassifier,
  WINDOW_VIEWS_SQL,
} from "@/lib/session-classifier.ts";
import { ANONYMIZE_SITES } from "@/lib/config.ts";
import { VALIDATED_VISITOR_INDEX_SQL } from "@/lib/db/schema.ts";
import { provenHumanSql } from "@/lib/proven-human.ts";
import {
  getSiteHome,
  markSiteHomesStale,
  refreshSiteHomes,
} from "@/lib/site-home.ts";
import { createTestDb, insertEvent, insertView } from "./_helpers.ts";
import type { DbAdapter } from "@/lib/db/adapter.ts";

const NOW = Date.parse("2026-10-09T12:00:00.000Z");
const at = (secAgo: number) => new Date(NOW - secAgo * 1000).toISOString();
// Fixtures are written as ages at NOW; the classifier is run 12 minutes later,
// when every one of them has settled (SETTLE_MS) and is still in the window.
const RUN = NOW + SETTLE_MS;

async function scores(db: DbAdapter, site: string): Promise<number[]> {
  const rows = await db.query<{ bot_score: number }>(
    "SELECT bot_score FROM visitor_views WHERE site_id = ? ORDER BY id",
    site,
  );
  return rows.map((r) => r.bot_score);
}

async function excluded(db: DbAdapter, visitor: string) {
  return await db.queryOne<{ label: string }>(
    "SELECT label FROM excluded_visitors WHERE visitor_id = ?",
    visitor,
  );
}

// ── osFamily ────────────────────────────────────────────────────────────────

Deno.test("osFamily — vendor families, with Linux and ChromeOS left out", () => {
  assertEquals(osFamily("iOS 17.4"), "Apple");
  assertEquals(osFamily("macOS 14"), "Apple");
  assertEquals(osFamily("Android 13"), "Android");
  assertEquals(osFamily("Windows 10/11"), "Windows");
  assertEquals(osFamily("Linux"), null);
  assertEquals(osFamily("ChromeOS"), null);
  assertEquals(osFamily(""), null);
});

// ── session_velocity ────────────────────────────────────────────────────────

Deno.test("pathnameOf — the stored path without query string or fragment", () => {
  assertEquals(pathnameOf("/list?page=2"), "/list");
  assertEquals(pathnameOf("/list#top"), "/list");
  assertEquals(pathnameOf("/list?a=1#b?c"), "/list");
  assertEquals(pathnameOf("/a/b"), "/a/b");
  assertEquals(pathnameOf("/"), "/");
  assertEquals(pathnameOf("?q=1"), "");
});

Deno.test("classifier — six views two seconds apart is a bot session", async () => {
  const db = createTestDb();
  const site = "cls-velocity";
  for (let i = 0; i < 6; i++) {
    await insertView(db, {
      visitor_id: "fastvisitor",
      site_id: site,
      session_id: "fast-session",
      path: `/p${i}`,
      created_at: at(600 - i * 2),
    });
  }
  await insertEvent(db, {
    site_id: site,
    session_id: "fast-session",
    visitor_id: "fastvisitor",
    event_type: "web_vital",
    created_at: at(600),
  });

  const r = await classifySessions(db, RUN);
  assertEquals(r.session_velocity, 1);
  assertEquals(await scores(db, site), [60, 60, 60, 60, 60, 60]);
  const row = await db.queryOne<{ bot_score_detail: string }>(
    "SELECT bot_score_detail FROM visitor_views WHERE site_id = ? LIMIT 1",
    site,
  );
  assertEquals(
    JSON.parse(row!.bot_score_detail).classifier,
    "session_velocity",
  );
  const ev = await db.queryOne<{ bot_score: number }>(
    "SELECT bot_score FROM semantic_events WHERE site_id = ?",
    site,
  );
  assertEquals(ev?.bot_score, 60);
  assertEquals(
    (await excluded(db, "fastvisitor"))?.label,
    "auto:session_velocity",
  );
  await db.close();
});

Deno.test("classifier — six URL-state changes on one page in 15 seconds is not a fast session", async () => {
  // Pagination, a carousel or a map that syncs its state to the URL: the
  // tracker sends a view for each change, all on one pathname.
  const db = createTestDb();
  const site = "cls-url-state";
  for (let i = 0; i < 6; i++) {
    await insertView(db, {
      visitor_id: "pager",
      site_id: site,
      session_id: "pager-session",
      path: i === 5 ? "/list#top" : `/list?page=${i + 1}`,
      created_at: at(600 - i * 3),
    });
  }
  const r = await classifySessions(db, RUN);
  assertEquals(r.session_velocity, 0);
  assertEquals(await scores(db, site), [0, 0, 0, 0, 0, 0]);
  assertEquals(await excluded(db, "pager"), undefined);
  await db.close();
});

Deno.test("classifier — six different pathnames in 15 seconds is a fast session, whatever their query strings", async () => {
  const db = createTestDb();
  const site = "cls-six-paths";
  for (let i = 0; i < 6; i++) {
    await insertView(db, {
      visitor_id: "crawler",
      site_id: site,
      session_id: "crawler-session",
      path: `/item/${i}?ref=list#photos`,
      created_at: at(600 - i * 3),
    });
  }
  const r = await classifySessions(db, RUN);
  assertEquals(r.session_velocity, 1);
  assertEquals(await scores(db, site), [60, 60, 60, 60, 60, 60]);
  assertEquals(
    (await excluded(db, "crawler"))?.label,
    "auto:session_velocity",
  );
  await db.close();
});

Deno.test("classifier — five pathnames is under the minimum however many views they carry", async () => {
  const db = createTestDb();
  const site = "cls-five-paths";
  for (let i = 0; i < 12; i++) {
    await insertView(db, {
      visitor_id: "fivepaths",
      site_id: site,
      session_id: "fivepaths-session",
      path: `/p${i % 5}?n=${i}`,
      created_at: at(600 - i),
    });
  }
  assertEquals((await classifySessions(db, RUN)).session_velocity, 0);
  await db.close();
});

/** `pages` pages 90 s apart, the last a map that then writes 200 URL states. */
async function mapSession(db: DbAdapter, site: string, pages: number) {
  const row = { visitor_id: "mapuser", site_id: site, session_id: "map-s" };
  await db.exec("BEGIN");
  for (let i = 0; i < pages; i++) {
    await insertView(db, {
      ...row,
      path: i === pages - 1 ? "/map" : `/page/${i}`,
      created_at: at(900 - i * 90),
    });
  }
  for (let i = 0; i < 200; i++) {
    await insertView(db, {
      ...row,
      path: `/map?lat=60.${i}&lng=24.${i}`,
      created_at: at(440 - i / 10),
    });
  }
  await db.exec("COMMIT");
}

Deno.test("classifier — URL-state churn on one page does not make a fast session of five pages", async () => {
  // Five pages, a minute and a half each; on the last, a map writes its
  // position to the URL two hundred times. 205 views average well under
  // 3 s apart, but they are of five pathnames.
  const db = createTestDb();
  const site = "cls-map";
  await mapSession(db, site, 5);
  assertEquals((await classifySessions(db, RUN)).session_velocity, 0);
  assertEquals(await excluded(db, "mapuser"), undefined);
  await db.close();
});

Deno.test("classifier — the same churn after six pages is not a fast session either: consecutive views of one page count once", async () => {
  // 206 views averaging 2.3 s apart on six pathnames, but the 201 views of
  // /map are one visit to one page: six pages, 90 s apart.
  const db = createTestDb();
  const site = "cls-map-six";
  await mapSession(db, site, 6);
  assertEquals((await classifySessions(db, RUN)).session_velocity, 0);
  assertEquals((await scores(db, site)).every((s) => s === 0), true);
  assertEquals(await excluded(db, "mapuser"), undefined);
  await db.close();
});

Deno.test("classifier — alternating fast between two pages is not a fast session", async () => {
  const db = createTestDb();
  const site = "cls-alternate";
  for (let i = 0; i < 20; i++) {
    await insertView(db, {
      visitor_id: "alternator",
      site_id: site,
      session_id: "alternate-s",
      path: i % 2 ? "/b?tab=2" : "/a",
      created_at: at(600 - i),
    });
  }
  assertEquals((await classifySessions(db, RUN)).session_velocity, 0);
  await db.close();
});

Deno.test("classifier — six pages fast with a repeated view in the middle is still a fast session, stamped whole", async () => {
  const db = createTestDb();
  const site = "cls-repeat-mid";
  const paths = ["/p0", "/p1", "/p2", "/p2?again=1", "/p3", "/p4", "/p5"];
  // Inserted out of order: the pace is taken in time order, not row order.
  for (const i of [3, 0, 6, 1, 5, 2, 4]) {
    await insertView(db, {
      visitor_id: "repeater",
      site_id: site,
      session_id: "repeat-s",
      path: paths[i],
      created_at: at(600 - i * 3),
    });
  }
  // Seven views, six after collapsing, spanning 18 s: 3.6 s apart.
  assertEquals((await classifySessions(db, RUN)).session_velocity, 0);
  await db.run(
    "UPDATE visitor_views SET created_at = ? WHERE site_id = ? AND path = '/p5'",
    at(600 - 15),
    site,
  );
  // Now 15 s over five gaps: 3 s.
  assertEquals((await classifySessions(db, RUN)).session_velocity, 1);
  assertEquals(await scores(db, site), Array(7).fill(60));
  await db.close();
});

Deno.test("classifier — six pages opened fast, then slow revisits of them, is not a fast session", async () => {
  // Nine views over eleven and a half minutes average 86 s apart. The six
  // pathnames were first opened 3 s apart, but the pace is taken over every
  // view, as it was before pathnames were counted.
  const db = createTestDb();
  const site = "cls-revisit";
  const row = {
    visitor_id: "revisitor",
    site_id: site,
    session_id: "revisit-session",
  };
  for (let i = 0; i < 6; i++) {
    await insertView(db, {
      ...row,
      path: `/p${i}`,
      created_at: at(25 * 60 - i * 3),
    });
  }
  for (const [minAgo, path] of [[20, "/p0"], [17, "/p1?x=1"], [13.5, "/p2"]]) {
    await insertView(db, {
      ...row,
      path: path as string,
      created_at: at((minAgo as number) * 60),
    });
  }
  assertEquals((await classifySessions(db, NOW)).session_velocity, 0);
  assertEquals(await scores(db, site), Array(9).fill(0));
  assertEquals(await excluded(db, "revisitor"), undefined);
  await db.close();
});

Deno.test("classifier — six views twenty seconds apart is a person", async () => {
  const db = createTestDb();
  const site = "cls-slow";
  for (let i = 0; i < 6; i++) {
    await insertView(db, {
      visitor_id: "slowvisitor",
      site_id: site,
      session_id: "slow-session",
      path: `/p${i}`,
      created_at: at(900 - i * 20),
    });
  }
  const r = await classifySessions(db, RUN);
  assertEquals(r.session_velocity, 0);
  assertEquals(await scores(db, site), [0, 0, 0, 0, 0, 0]);
  await db.close();
});

Deno.test("classifier — five fast views is under the minimum", async () => {
  const db = createTestDb();
  const site = "cls-five";
  for (let i = 0; i < 5; i++) {
    await insertView(db, {
      visitor_id: "fivevisitor",
      site_id: site,
      session_id: "five-session",
      path: `/p${i}`,
      created_at: at(600 - i),
    });
  }
  assertEquals((await classifySessions(db, RUN)).session_velocity, 0);
  await db.close();
});

Deno.test("classifier — a fast session owned by a proven human is spared", async () => {
  const db = createTestDb();
  const site = "cls-proven-fast";
  for (let i = 0; i < 6; i++) {
    await insertView(db, {
      visitor_id: "provenfast",
      site_id: site,
      session_id: "proven-fast-s",
      path: `/p${i}`,
      validated: i === 0 ? 1 : 0,
      created_at: at(600 - i * 2),
    });
  }
  const r = await classifySessions(db, RUN);
  assertEquals(r.session_velocity, 0);
  assertEquals(await scores(db, site), [0, 0, 0, 0, 0, 0]);
  assertEquals(await excluded(db, "provenfast"), undefined);
  await db.close();
});

// ── OS rotation / family flip ───────────────────────────────────────────────

Deno.test("classifier — one session on Android and Windows is flagged even when validated", async () => {
  const db = createTestDb();
  const site = "cls-flip";
  await insertView(db, {
    visitor_id: "flipper",
    site_id: site,
    session_id: "flip-s",
    os_name: "Android 13",
    validated: 1,
    created_at: at(300),
  });
  await insertView(db, {
    visitor_id: "flipper",
    site_id: site,
    session_id: "flip-s",
    os_name: "Windows 10/11",
    validated: 1,
    created_at: at(200),
  });
  const r = await classifySessions(db, RUN);
  assertEquals(r.os_family_flip, 1);
  assertEquals(await scores(db, site), [60, 60]);
  assertEquals((await excluded(db, "flipper"))?.label, "auto:os_family_flip");
  await db.close();
});

Deno.test("classifier — iPad desktop mode: iOS and macOS on one visitor is never flagged", async () => {
  const db = createTestDb();
  const site = "cls-ipad";
  await insertView(db, {
    visitor_id: "ipaduser",
    site_id: site,
    session_id: "ipad-s",
    os_name: "iOS 17.4",
    created_at: at(300),
  });
  await insertView(db, {
    visitor_id: "ipaduser",
    site_id: site,
    session_id: "ipad-s",
    os_name: "macOS 14",
    created_at: at(200),
  });
  const r = await classifySessions(db, RUN);
  assertEquals(r.os_family_flip, 0);
  assertEquals(r.os_rotation, 0);
  assertEquals(await scores(db, site), [0, 0]);
  await db.close();
});

Deno.test("classifier — Android plus bare Linux is a parse quirk, not a flip", async () => {
  const db = createTestDb();
  const site = "cls-linux";
  await insertView(db, {
    visitor_id: "droid",
    site_id: site,
    session_id: "droid-s",
    os_name: "Android 13",
    created_at: at(300),
  });
  await insertView(db, {
    visitor_id: "droid",
    site_id: site,
    session_id: "droid-s",
    os_name: "Linux",
    created_at: at(200),
  });
  const r = await classifySessions(db, RUN);
  assertEquals(r.os_family_flip, 0);
  assertEquals(r.os_rotation, 0);
  await db.close();
});

Deno.test("classifier — three Android versions on one cookie is rotation", async () => {
  const db = createTestDb();
  const site = "cls-rotate";
  for (const [i, os] of ["Android 11", "Android 13", "Android 14"].entries()) {
    await insertView(db, {
      visitor_id: "rotator",
      site_id: site,
      session_id: `rot-s${i}`,
      os_name: os,
      created_at: at(300 - i * 30),
    });
  }
  const r = await classifySessions(db, RUN);
  assertEquals(r.os_rotation, 1);
  assertEquals(await scores(db, site), [60, 60, 60]);
  await db.close();
});

Deno.test("classifier — two versions in one family is a benign parse split", async () => {
  const db = createTestDb();
  const site = "cls-two";
  await insertView(db, {
    visitor_id: "twover",
    site_id: site,
    session_id: "two-s1",
    os_name: "iOS 18.7",
    created_at: at(300),
  });
  await insertView(db, {
    visitor_id: "twover",
    site_id: site,
    session_id: "two-s2",
    os_name: "iOS 18.7.2",
    created_at: at(200),
  });
  assertEquals((await classifySessions(db, RUN)).os_rotation, 0);
  await db.close();
});

Deno.test("classifier — OS rotation by a proven human is spared", async () => {
  const db = createTestDb();
  const site = "cls-rotate-proven";
  for (const [i, os] of ["Android 11", "Android 13", "Android 14"].entries()) {
    await insertView(db, {
      visitor_id: "provenrot",
      site_id: site,
      session_id: `prot-s${i}`,
      os_name: os,
      validated: i === 0 ? 1 : 0,
      created_at: at(300 - i * 30),
    });
  }
  assertEquals((await classifySessions(db, RUN)).os_rotation, 0);
  assertEquals(await scores(db, site), [0, 0, 0]);
  await db.close();
});

// ── burst_cohort ────────────────────────────────────────────────────────────

async function cohort(
  db: DbAdapter,
  site: string,
  country: string,
  n: number,
  opts: { validated?: number; views?: number } = {},
) {
  for (let i = 0; i < n; i++) {
    for (let v = 0; v < (opts.views ?? 1); v++) {
      await insertView(db, {
        visitor_id: `${site}-${country}-${i}`,
        site_id: site,
        session_id: `${site}-${country}-s${i}`,
        country_code: country,
        screen_width: 1920,
        screen_height: 1080,
        validated: opts.validated ?? 0,
        created_at: at(600 - i - v * 60),
      });
    }
  }
}

Deno.test("classifier — 40 single-view visitors from another continent, same screen, is a flood", async () => {
  const db = createTestDb();
  const site = "cls-burst";
  await db.run(
    "INSERT INTO site_settings (site_id, home_country) VALUES (?, ?)",
    site,
    "IE",
  );
  // Validated, on purpose: this farm runs the real tracker and forges it.
  await cohort(db, site, "US", 40, { validated: 1 });
  const r = await classifySessions(db, RUN);
  assertEquals(r.burst_cohort, 40);
  assertEquals((await scores(db, site)).every((s) => s === 60), true);
  await db.close();
});

Deno.test("classifier — 39 is under the threshold", async () => {
  const db = createTestDb();
  const site = "cls-burst-39";
  await db.run(
    "INSERT INTO site_settings (site_id, home_country) VALUES (?, ?)",
    site,
    "IE",
  );
  await cohort(db, site, "US", 39);
  assertEquals((await classifySessions(db, RUN)).burst_cohort, 0);
  await db.close();
});

Deno.test("classifier — a home-country surge is never a flood", async () => {
  const db = createTestDb();
  const site = "cls-burst-home";
  await db.run(
    "INSERT INTO site_settings (site_id, home_country) VALUES (?, ?)",
    site,
    "FI",
  );
  await cohort(db, site, "FI", 90);
  assertEquals((await classifySessions(db, RUN)).burst_cohort, 0);
  await db.close();
});

Deno.test("classifier — a neighbour-country surge is never a flood", async () => {
  const db = createTestDb();
  const site = "cls-burst-neighbour";
  await db.run(
    "INSERT INTO site_settings (site_id, home_country) VALUES (?, ?)",
    site,
    "FI",
  );
  await cohort(db, site, "SE", 60);
  assertEquals((await classifySessions(db, RUN)).burst_cohort, 0);
  await db.close();
});

Deno.test("classifier — no home country configured: the cohort check does nothing", async () => {
  const db = createTestDb();
  const site = "cls-burst-nohome";
  await cohort(db, site, "US", 60);
  assertEquals((await classifySessions(db, RUN)).burst_cohort, 0);
  await db.close();
});

Deno.test("classifier — visitors who viewed several pages are not part of a flood", async () => {
  const db = createTestDb();
  const site = "cls-burst-multi";
  await db.run(
    "INSERT INTO site_settings (site_id, home_country) VALUES (?, ?)",
    site,
    "IE",
  );
  await cohort(db, site, "US", 45, { views: 2 });
  assertEquals((await classifySessions(db, RUN)).burst_cohort, 0);
  await db.close();
});

// ── General ─────────────────────────────────────────────────────────────────

Deno.test("classifier — views older than 30 minutes are out of scope", async () => {
  const db = createTestDb();
  const site = "cls-old";
  for (let i = 0; i < 6; i++) {
    await insertView(db, {
      visitor_id: "oldfast",
      site_id: site,
      session_id: "old-fast-s",
      path: `/p${i}`,
      created_at: at(40 * 60 - i * 2),
    });
  }
  assertEquals((await classifySessions(db, RUN)).session_velocity, 0);
  await db.close();
});

Deno.test("classifier — a second run finds nothing new", async () => {
  const db = createTestDb();
  const site = "cls-twice";
  for (let i = 0; i < 6; i++) {
    await insertView(db, {
      visitor_id: "twicefast",
      site_id: site,
      session_id: "twice-s",
      path: `/p${i}`,
      created_at: at(600 - i * 2),
    });
  }
  assertEquals((await classifySessions(db, RUN)).session_velocity, 1);
  assertEquals((await classifySessions(db, RUN)).session_velocity, 0);
  await db.close();
});

Deno.test("classifier — a manual exclusion label is not overwritten", async () => {
  const db = createTestDb();
  const site = "cls-manual";
  await db.run(
    "INSERT INTO excluded_visitors (visitor_id, label) VALUES (?, ?)",
    "manualfast",
    "my own office",
  );
  for (let i = 0; i < 6; i++) {
    await insertView(db, {
      visitor_id: "manualfast",
      site_id: site,
      session_id: "manual-s",
      path: `/p${i}`,
      created_at: at(600 - i * 2),
    });
  }
  await classifySessions(db, RUN);
  assertEquals((await excluded(db, "manualfast"))?.label, "my own office");
  await db.close();
});

// ── Beyond the brief ────────────────────────────────────────────────────────

Deno.test("classifier — rows of a flagged session older than the window are left alone", async () => {
  const db = createTestDb();
  const site = "cls-bounded";
  const row = {
    visitor_id: "boundedfast",
    site_id: site,
    session_id: "bounded-s",
  };
  await insertView(db, { ...row, created_at: at(40 * 60) });
  await insertEvent(db, {
    ...row,
    event_type: "web_vital",
    created_at: at(40 * 60),
  });
  for (let i = 0; i < 6; i++) {
    await insertView(db, {
      ...row,
      path: `/p${i}`,
      created_at: at(600 - i * 2),
    });
  }
  assertEquals((await classifySessions(db, RUN)).session_velocity, 1);
  assertEquals(await scores(db, site), [0, 60, 60, 60, 60, 60, 60]);
  const ev = await db.queryOne<{ bot_score: number }>(
    "SELECT bot_score FROM semantic_events WHERE site_id = ?",
    site,
  );
  assertEquals(ev?.bot_score, 0);
  await db.close();
});

Deno.test("classifier — a session of 1,200 views and events is stamped whole", async () => {
  const db = createTestDb();
  const site = "cls-hot";
  const row = { visitor_id: "hotfast", site_id: site, session_id: "hot-s" };
  await db.exec("BEGIN");
  for (let i = 0; i < 1200; i++) {
    const created_at = at(1000 - i / 2);
    await insertView(db, { ...row, path: `/p${i}`, created_at });
    await insertEvent(db, { ...row, event_type: "web_vital", created_at });
  }
  await db.exec("COMMIT");
  const r = await classifySessions(db, RUN);
  assertEquals(r, {
    session_velocity: 1,
    os_rotation: 0,
    os_family_flip: 0,
    burst_cohort: 0,
  });
  for (const table of ["visitor_views", "semantic_events"]) {
    const rows = await db.query<{ bot_score: number; n: number }>(
      `SELECT bot_score, COUNT(*) AS n FROM ${table}
        WHERE site_id = ? GROUP BY bot_score`,
      site,
    );
    assertEquals(rows, [{ bot_score: 60, n: 1200 }], table);
  }
  await db.close();
});

Deno.test("classifier — a visitor-keyed finding stamps the visitor's sessionless events", async () => {
  const db = createTestDb();
  const site = "cls-rotate-events";
  for (const [i, os] of ["Android 11", "Android 13", "Android 14"].entries()) {
    await insertView(db, {
      visitor_id: "rotevents",
      site_id: site,
      session_id: `rote-s${i}`,
      os_name: os,
      created_at: at(300 - i * 30),
    });
  }
  await insertEvent(db, {
    site_id: site,
    session_id: null,
    visitor_id: "rotevents",
    event_type: "web_vital",
    bot_score_detail: "not json",
    created_at: at(250),
  });
  await insertEvent(db, {
    site_id: site,
    session_id: null,
    visitor_id: "someoneelse",
    event_type: "web_vital",
    created_at: at(250),
  });
  // The same visitor id on another site is another identity.
  await insertEvent(db, {
    site_id: `${site}-other`,
    session_id: null,
    visitor_id: "rotevents",
    event_type: "web_vital",
    created_at: at(250),
  });
  assertEquals((await classifySessions(db, RUN)).os_rotation, 1);
  const other = await db.queryOne<{ bot_score: number }>(
    "SELECT bot_score FROM semantic_events WHERE site_id = ?",
    `${site}-other`,
  );
  assertEquals(other?.bot_score, 0);
  const evs = await db.query<{ bot_score: number; bot_score_detail: string }>(
    "SELECT bot_score, bot_score_detail FROM semantic_events WHERE site_id = ? ORDER BY id",
    site,
  );
  assertEquals(evs.map((e) => e.bot_score), [60, 0]);
  assertEquals(JSON.parse(evs[0].bot_score_detail), {
    classifier: "os_rotation",
  });
  assertEquals((await excluded(db, "rotevents"))?.label, "auto:os_rotation");
  await db.close();
});

Deno.test("classifier — a cookie visitor's later views count: one new view plus returning views is not a flood member", async () => {
  const db = createTestDb();
  const site = "cls-burst-returning";
  await db.run(
    "INSERT INTO site_settings (site_id, home_country) VALUES (?, ?)",
    site,
    "IE",
  );
  await cohort(db, site, "US", 45);
  // The second page of a visitor who accepted a cookie is `is_returning = 1`.
  for (let i = 0; i < 45; i++) {
    await insertView(db, {
      visitor_id: `${site}-US-${i}`,
      site_id: site,
      session_id: `${site}-US-s${i}`,
      country_code: "US",
      is_returning: 1,
      created_at: at(300 - i),
    });
  }
  assertEquals((await classifySessions(db, RUN)).burst_cohort, 0);
  assertEquals((await scores(db, site)).every((s) => s === 0), true);
  await db.close();
});

Deno.test("classifier — a view already stamped as a bot's still counts as a view of its visitor", async () => {
  const db = createTestDb();
  const site = "cls-burst-stamped";
  await db.run(
    "INSERT INTO site_settings (site_id, home_country) VALUES (?, ?)",
    site,
    "IE",
  );
  await cohort(db, site, "US", 45);
  for (let i = 0; i < 45; i++) {
    await insertView(db, {
      visitor_id: `${site}-US-${i}`,
      site_id: site,
      session_id: `${site}-US-s${i}`,
      country_code: "US",
      bot_score: 60,
      created_at: at(300 - i),
    });
  }
  assertEquals((await classifySessions(db, RUN)).burst_cohort, 0);
  await db.close();
});

Deno.test("classifier — the home it measures a flood against is the one the scorer's cache holds", async () => {
  // Two rows for one site, differing in case; the cache reads the last in
  // site_id order, which has a language and no country. So this site has no
  // home country, for the scorer and for the classifier alike.
  const db = createTestDb();
  const site = "cls-home-rule";
  await db.run(
    `INSERT INTO site_settings (site_id, home_country, home_language)
     VALUES ('CLS-home-rule', 'IE', NULL), ('cls-home-rule', NULL, 'en')`,
  );
  markSiteHomesStale();
  await refreshSiteHomes(db);
  assertEquals(getSiteHome(site), { country: null, language: "en" });
  await cohort(db, site, "US", 45);
  assertEquals((await classifySessions(db, RUN)).burst_cohort, 0);

  // And a stored code that is no country is no home for either.
  const typo = "cls-home-typo";
  await db.run(
    "INSERT INTO site_settings (site_id, home_country) VALUES (?, 'UK')",
    typo,
  );
  await cohort(db, typo, "US", 45);
  assertEquals((await classifySessions(db, RUN)).burst_cohort, 0);
  await db.close();
});

Deno.test("classifier — a home country with no known continent: the cohort check does nothing", async () => {
  const db = createTestDb();
  const site = "cls-burst-unknown-home";
  await db.run(
    "INSERT INTO site_settings (site_id, home_country) VALUES (?, ?)",
    site,
    "ZZ",
  );
  await cohort(db, site, "US", 60);
  assertEquals((await classifySessions(db, RUN)).burst_cohort, 0);
  await db.close();
});

Deno.test("classifier — an anonymised site's session ids are shared names, never an identity", async () => {
  const db = createTestDb();
  const site = "cls-anon";
  ANONYMIZE_SITES.add(site);
  try {
    // Six different people whose sessions were stored under one name.
    for (let i = 0; i < 6; i++) {
      await insertView(db, {
        visitor_id: `anonperson${i}`,
        site_id: site,
        session_id: "Santiago",
        path: `/p${i}`,
        os_name: i % 2 ? "Android 13" : "Windows 10/11",
        created_at: at(600 - i * 2),
      });
    }
    const r = await classifySessions(db, RUN);
    assertEquals(r.session_velocity, 0);
    assertEquals(r.os_family_flip, 0);
    assertEquals(await scores(db, site), [0, 0, 0, 0, 0, 0]);
    assertEquals(await excluded(db, "anonperson0"), undefined);
  } finally {
    ANONYMIZE_SITES.delete(site);
  }
  await db.close();
});

// ── Settling ────────────────────────────────────────────────────────────────
//
// The validator needs up to a minute, and a person needs time to make the
// gesture it looks for. An identity is judged only once its oldest view in
// the window is SETTLE_MS old: it has then had that long in which it could
// have been validated, however recent its newest view. With a 30-minute
// window read every 15 minutes, every view is still seen at that age.

const MIN = 60_000;

async function fastSession(db: DbAdapter, site: string) {
  // Oldest view 10 s before NOW, the newest exactly at NOW.
  for (let i = 0; i < 6; i++) {
    await insertView(db, {
      visitor_id: `${site}-v`,
      site_id: site,
      session_id: `${site}-s`,
      path: `/p${i}`,
      created_at: at(i * 2),
    });
  }
}

Deno.test("classifier — the settle time is 12 minutes, shorter than window minus interval", () => {
  assertEquals(SETTLE_MS, 12 * MIN);
  // A view is judged at ages 12..30 min: a span longer than the 15-minute
  // interval, so some run always sees it settled.
  assertEquals(30 * MIN - SETTLE_MS > 15 * MIN, true);
});

Deno.test("classifier — a fast session is not judged when 5 minutes old, and is at 13", async () => {
  const db = createTestDb();
  const site = "cls-settle";
  await fastSession(db, site);
  assertEquals((await classifySessions(db, NOW + 5 * MIN)).session_velocity, 0);
  assertEquals(await scores(db, site), [0, 0, 0, 0, 0, 0]);
  assertEquals(await excluded(db, `${site}-v`), undefined);
  // 1 ms before its oldest view (10 s before NOW) is 12 minutes old.
  assertEquals(
    (await classifySessions(db, NOW - 10_000 + SETTLE_MS - 1)).session_velocity,
    0,
  );
  assertEquals(
    (await classifySessions(db, NOW + 13 * MIN)).session_velocity,
    1,
  );
  assertEquals(await scores(db, site), [60, 60, 60, 60, 60, 60]);
  await db.close();
});

Deno.test("classifier — a fast session first seen when 28 minutes old is still judged", async () => {
  const db = createTestDb();
  const site = "cls-settle-late";
  await fastSession(db, site);
  assertEquals(
    (await classifySessions(db, NOW + 28 * MIN)).session_velocity,
    1,
  );
  assertEquals(await scores(db, site), [60, 60, 60, 60, 60, 60]);
  await db.close();
});

/** One page every 2 s on one session, from `fromSecAgo` before NOW to NOW. */
async function pagingSession(db: DbAdapter, site: string, fromSecAgo: number) {
  await db.exec("BEGIN");
  for (let sec = fromSecAgo; sec >= 0; sec -= 2) {
    await insertView(db, {
      visitor_id: `${site}-v`,
      site_id: site,
      session_id: `${site}-s`,
      path: `/p${sec}`,
      created_at: at(sec),
    });
  }
  await db.exec("COMMIT");
}

Deno.test("classifier — a crawler paging without pause is judged while it is still going", async () => {
  const db = createTestDb();
  const site = "cls-continuous";
  await pagingSession(db, site, 20 * 60);
  assertEquals((await classifySessions(db, NOW)).session_velocity, 1);
  // All of it, the view of this very second included.
  assertEquals(await scores(db, site), Array(601).fill(60));
  assertEquals(
    (await excluded(db, `${site}-v`))?.label,
    "auto:session_velocity",
  );
  await db.close();
});

Deno.test("classifier — a session that began paging 5 minutes ago is left for a later run", async () => {
  const db = createTestDb();
  const site = "cls-young";
  await pagingSession(db, site, 5 * 60);
  assertEquals((await classifySessions(db, NOW)).session_velocity, 0);
  assertEquals(await scores(db, site), Array(151).fill(0));
  assertEquals(await excluded(db, `${site}-v`), undefined);
  // The same rows 8 minutes later: its first view is now 13 minutes old.
  assertEquals((await classifySessions(db, NOW + 8 * MIN)).session_velocity, 1);
  assertEquals(await scores(db, site), Array(151).fill(60));
  await db.close();
});

Deno.test("classifier — a visitor is judged by the age of its oldest view, whatever it did since", async () => {
  const db = createTestDb();
  const site = "cls-settle-os";
  const row = { visitor_id: "stillhere", site_id: site };
  // Three Android versions, 5 to 4 minutes before NOW.
  for (const [i, os] of ["Android 11", "Android 13", "Android 14"].entries()) {
    await insertView(db, {
      ...row,
      session_id: `still-s${i}`,
      os_name: os,
      created_at: at(300 - i * 30),
    });
  }
  assertEquals((await classifySessions(db, NOW)).os_rotation, 0);
  assertEquals(await scores(db, site), [0, 0, 0]);
  // One more view just before the next run does not put the verdict off.
  await insertView(db, {
    ...row,
    session_id: "still-s3",
    os_name: "Android 14",
    created_at: new Date(NOW + 8 * MIN - 1000).toISOString(),
  });
  assertEquals((await classifySessions(db, NOW + 8 * MIN)).os_rotation, 1);
  assertEquals(await scores(db, site), [60, 60, 60, 60]);
  await db.close();
});

Deno.test("classifier — a flood is counted from settled visitors only", async () => {
  const db = createTestDb();
  const site = "cls-burst-settle";
  await db.run(
    "INSERT INTO site_settings (site_id, home_country) VALUES (?, ?)",
    site,
    "IE",
  );
  // 45 one-view visitors, 600 down to 556 s before NOW.
  await cohort(db, site, "US", 45);
  // At NOW none has settled; they may all still be reading.
  assertEquals((await classifySessions(db, NOW)).burst_cohort, 0);
  // At NOW + 150 s the 31 oldest (ages 750 down to 720 s) have settled:
  // under 40, although 45 are in the bucket.
  assertEquals((await classifySessions(db, NOW + 150_000)).burst_cohort, 0);
  assertEquals((await scores(db, site)).every((s) => s === 0), true);
  assertEquals((await classifySessions(db, RUN)).burst_cohort, 45);
  await db.close();
});

// ── A flood is counted in sessions ──────────────────────────────────────────

Deno.test("classifier — 45 views from 9 cookie-blocking sessions, a fresh visitor id on each, is not a flood", async () => {
  const db = createTestDb();
  const site = "cls-burst-nocookie";
  await db.run(
    "INSERT INTO site_settings (site_id, home_country) VALUES (?, ?)",
    site,
    "IE",
  );
  for (let s = 0; s < 9; s++) {
    for (let v = 0; v < 5; v++) {
      await insertView(db, {
        visitor_id: `${site}-s${s}-v${v}`,
        site_id: site,
        session_id: `${site}-s${s}`,
        country_code: "US",
        created_at: at(900 - s * 10 - v * 60),
      });
    }
  }
  const r = await classifySessions(db, RUN);
  assertEquals(r, {
    session_velocity: 0,
    os_rotation: 0,
    os_family_flip: 0,
    burst_cohort: 0,
  });
  assertEquals((await scores(db, site)).every((s) => s === 0), true);
  await db.close();
});

Deno.test("classifier — 45 single-view sessions from another continent is a flood", async () => {
  const db = createTestDb();
  const site = "cls-burst-sessions";
  await db.run(
    "INSERT INTO site_settings (site_id, home_country) VALUES (?, ?)",
    site,
    "IE",
  );
  await cohort(db, site, "US", 45);
  assertEquals((await classifySessions(db, RUN)).burst_cohort, 45);
  assertEquals((await scores(db, site)).every((s) => s === 60), true);
  assertEquals(
    (await excluded(db, `${site}-US-0`))?.label,
    "auto:burst_cohort",
  );
  await db.close();
});

Deno.test("classifier — sessionless single views fall back to the visitor id", async () => {
  const db = createTestDb();
  const site = "cls-burst-sessionless";
  await db.run(
    "INSERT INTO site_settings (site_id, home_country) VALUES (?, ?)",
    site,
    "IE",
  );
  for (let i = 0; i < 45; i++) {
    await insertView(db, {
      visitor_id: `${site}-v${i}`,
      site_id: site,
      session_id: null,
      country_code: "US",
      created_at: at(600 - i),
    });
  }
  assertEquals((await classifySessions(db, RUN)).burst_cohort, 45);
  await db.close();
});

// ── Query plans ─────────────────────────────────────────────────────────────
//
// node:sqlite is synchronous: a classifier statement that scans a table, or
// that looks each identity up among rows outside the window, blocks every
// request while it runs. Each statement must enter visitor_views or
// semantic_events through the 30-minute window on (created_at, bot_score), or
// through the primary key.

/** Indexes only migrate() creates: exact DDL from lib/db/database.ts. */
const MIGRATE_ONLY_INDEXES = [
  "CREATE INDEX IF NOT EXISTS idx_se_experiment ON semantic_events(experiment_id, variant_id)",
  "CREATE INDEX IF NOT EXISTS idx_vv_utm_campaign ON visitor_views(utm_campaign)",
  `CREATE INDEX IF NOT EXISTS idx_vv_utm_site_created
     ON visitor_views(utm_campaign, site_id, created_at)
     WHERE utm_campaign IS NOT NULL`,
  `CREATE INDEX IF NOT EXISTS idx_se_utm_campaign
     ON semantic_events(utm_campaign, site_id)
     WHERE utm_campaign IS NOT NULL`,
  `CREATE INDEX IF NOT EXISTS idx_vv_validated
     ON visitor_views(site_id, session_id, visitor_id)
     WHERE validated = 1`,
  VALIDATED_VISITOR_INDEX_SQL,
];

Deno.test("classifier — every statement reaches its rows through the window index or the primary key", async () => {
  const db = createTestDb();
  for (const ddl of MIGRATE_ONLY_INDEXES) await db.exec(ddl);

  const statements: [name: string, sql: string, step: string][] = [
    [
      "window views",
      WINDOW_VIEWS_SQL,
      "SEARCH visitor_views USING INDEX idx_vv_created_bot (created_at>?)",
    ],
    [
      "flagged events",
      FLAGGED_EVENTS_SQL,
      "SEARCH semantic_events USING INDEX idx_se_created_bot (created_at>?)",
    ],
    [
      "stamp views",
      stampSql("visitor_views", "burst_cohort", 500),
      "SEARCH visitor_views USING INTEGER PRIMARY KEY (rowid=?)",
    ],
    [
      "stamp events",
      stampSql("semantic_events", "session_velocity", 500),
      "SEARCH semantic_events USING INTEGER PRIMARY KEY (rowid=?)",
    ],
    // The gate every non-bypassing verdict passes through (proven-human.ts).
    [
      "proven visitors",
      provenHumanSql("visitor_id", 500),
      "SEARCH visitor_views USING INDEX idx_vv_validated_visitor (site_id=? AND visitor_id=?)",
    ],
    [
      "proven sessions",
      provenHumanSql("session_id", 500),
      "SEARCH visitor_views USING INDEX idx_vv_validated (site_id=? AND session_id=?)",
    ],
  ];
  for (const [name, sql, step] of statements) {
    const plan = (await db.query<{ detail: string }>(
      `EXPLAIN QUERY PLAN ${sql}`,
    )).map((r) => r.detail);
    const shown = `${name}:\n${plan.join("\n")}`;
    // Exactly one access to a table, and it is the expected search.
    assertEquals(
      plan.filter((d) => /visitor_views|semantic_events/.test(d)),
      [step],
      shown,
    );
    // The only scans are of the bound id lists (json_each), never a table.
    for (const d of plan.filter((d) => d.startsWith("SCAN"))) {
      assertEquals(d.startsWith("SCAN json_each"), true, shown);
    }
  }
  await db.close();
});

// ── Scheduling ──────────────────────────────────────────────────────────────

Deno.test("classifier — the first run is 2 minutes after start, then every 15 minutes", async () => {
  assertEquals(FIRST_RUN_MS, 2 * 60_000);
  assertEquals(INTERVAL_MS, 15 * 60_000);
  using time = new FakeTime();
  let runs = 0;
  const db = {
    transaction: () => {
      runs++;
      return Promise.resolve();
    },
  } as unknown as DbAdapter;
  const log = console.log;
  console.log = () => {};
  try {
    startSessionClassifier(db);
    startSessionClassifier(db); // a second start is ignored
    await time.tickAsync(FIRST_RUN_MS - 1);
    assertEquals(runs, 0);
    await time.tickAsync(1);
    assertEquals(runs, 1);
    await time.tickAsync(INTERVAL_MS - 1);
    assertEquals(runs, 1);
    await time.tickAsync(1);
    assertEquals(runs, 2);
    await time.tickAsync(INTERVAL_MS);
    assertEquals(runs, 3);
    stopSessionClassifier();
    await time.tickAsync(2 * INTERVAL_MS);
    assertEquals(runs, 3);

    // Stopped before the first run: nothing ever runs.
    startSessionClassifier(db);
    stopSessionClassifier();
    await time.tickAsync(FIRST_RUN_MS + INTERVAL_MS);
    assertEquals(runs, 3);
  } finally {
    stopSessionClassifier();
    console.log = log;
  }
});
