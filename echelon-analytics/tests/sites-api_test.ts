// PATCH /api/sites/:id — the handler itself, against a real schema.

import { assertEquals } from "@std/assert";
import { handler } from "@/routes/api/sites/[id].ts";
import type { DbAdapter } from "@/lib/db/adapter.ts";
import {
  getConsentCss,
  markConsentCssStale,
  refreshConsentCss,
} from "@/lib/consent-css.ts";
import {
  getSiteHome,
  markSiteHomesStale,
  refreshSiteHomes,
} from "@/lib/site-home.ts";
import { createTestDb, probeApiAuth } from "./_helpers.ts";

type Ctx = Parameters<NonNullable<typeof handler.PATCH>>[0];

function call(
  method: "GET" | "PATCH",
  db: DbAdapter,
  id: string,
  body?: unknown,
): Promise<Response> {
  const ctx = {
    params: { id: encodeURIComponent(id) },
    state: { db },
    req: new Request(`http://localhost/api/sites/${encodeURIComponent(id)}`, {
      method,
      headers: { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
  } as unknown as Ctx;
  return Promise.resolve(handler[method]!(ctx)) as Promise<Response>;
}

const rows = (db: DbAdapter) =>
  db.query<
    {
      site_id: string;
      consent_css: string | null;
      home_country: string | null;
      home_language: string | null;
    }
  >(
    `SELECT site_id, consent_css, home_country, home_language
       FROM site_settings ORDER BY site_id`,
  );

Deno.test("PATCH /api/sites/:id — an unassigned home country is refused with 400", async () => {
  const db = createTestDb();
  for (const code of ["UK", "XX", "EN"]) {
    const res = await call("PATCH", db, "typo.example", { home_country: code });
    assertEquals(res.status, 400, code);
    const body = await res.json();
    assertEquals(body.error, "invalid_home_country");
    assertEquals(typeof body.message, "string");
  }
  assertEquals(await rows(db), []);
  await db.close();
});

Deno.test("PATCH /api/sites/:id — assigned home countries are stored upper-cased", async () => {
  const db = createTestDb();
  for (const [sent, stored] of [["GB", "GB"], ["fi", "FI"], ["RU", "RU"]]) {
    const res = await call("PATCH", db, "ok.example", { home_country: sent });
    assertEquals(res.status, 200, sent);
    assertEquals((await rows(db))[0].home_country, stored);
  }
  await db.close();
});

Deno.test("PATCH /api/sites/:id — a partial update leaves the other fields as they were", async () => {
  const db = createTestDb();
  const site = "partial.example";
  assertEquals(
    (await call("PATCH", db, site, {
      consent_css: ".bar{color:red}",
      home_country: "FI",
      home_language: "fi",
    })).status,
    200,
  );
  const before = (await rows(db))[0];
  assertEquals(before.home_country, "FI");
  assertEquals(before.home_language, "fi");
  assertEquals(typeof before.consent_css, "string");

  assertEquals(
    (await call("PATCH", db, site, { home_language: "sv-FI" })).status,
    200,
  );
  assertEquals(await rows(db), [{ ...before, home_language: "sv" }]);

  // An empty body changes nothing.
  assertEquals((await call("PATCH", db, site, {})).status, 200);
  assertEquals(await rows(db), [{ ...before, home_language: "sv" }]);

  const got = await (await call("GET", db, site)).json();
  assertEquals(got, {
    site_id: site,
    consent_css: before.consent_css,
    home_country: "FI",
    home_language: "sv",
  });
  await db.close();
});

Deno.test("PATCH /api/sites/:id — null or an empty string clears one field only", async () => {
  const db = createTestDb();
  const site = "clear.example";
  await call("PATCH", db, site, {
    consent_css: ".bar{color:red}",
    home_country: "SE",
    home_language: "sv",
  });
  const css = (await rows(db))[0].consent_css;
  assertEquals(
    (await call("PATCH", db, site, { home_country: null })).status,
    200,
  );
  assertEquals(await rows(db), [{
    site_id: site,
    consent_css: css,
    home_country: null,
    home_language: "sv",
  }]);
  assertEquals(
    (await call("PATCH", db, site, { home_language: "" })).status,
    200,
  );
  assertEquals((await rows(db))[0].home_language, null);
  assertEquals(
    (await call("PATCH", db, site, { consent_css: null })).status,
    200,
  );
  assertEquals(await rows(db), [{
    site_id: site,
    consent_css: null,
    home_country: null,
    home_language: null,
  }]);
  await db.close();
});

Deno.test("PATCH /api/sites/:id — invalid values are refused with 400 and change nothing", async () => {
  const db = createTestDb();
  const site = "strict.example";
  await call("PATCH", db, site, { home_country: "FI", home_language: "fi" });
  const before = await rows(db);
  const bad: [unknown, string][] = [
    [{ home_country: "FIN" }, "invalid_home_country"],
    [{ home_country: 42 }, "invalid_home_country"],
    [{ home_country: "UK", home_language: "en" }, "invalid_home_country"],
    [{ home_language: "english" }, "invalid_home_language"],
    [{ home_language: 7, home_country: "SE" }, "invalid_home_language"],
    [[], "invalid_payload"],
    ["FI", "invalid_payload"],
  ];
  for (const [body, error] of bad) {
    const res = await call("PATCH", db, site, body);
    assertEquals(res.status, 400, JSON.stringify(body));
    assertEquals((await res.json()).error, error, JSON.stringify(body));
    assertEquals(await rows(db), before, JSON.stringify(body));
  }
  const res = await call("PATCH", db, "bad site id!", { home_country: "FI" });
  assertEquals(res.status, 400);
  assertEquals((await res.json()).error, "invalid_site_id");
  assertEquals(await rows(db), before);
  await db.close();
});

Deno.test("PATCH /api/sites/:id — read-only public mode still refuses it", async () => {
  const [anonymous, withToken] = await probeApiAuth(
    { ECHELON_PUBLIC_MODE: "true", ECHELON_SECRET: "s3cret" },
    [
      { method: "PATCH", path: "/api/sites/example.com" },
      {
        method: "PATCH",
        path: "/api/sites/example.com",
        headers: { authorization: "Bearer s3cret" },
      },
    ],
  );
  assertEquals(anonymous.status, 403);
  assertEquals(withToken.status, 403);
});

Deno.test("site settings — the site id matches without regard to case, and a PATCH never makes a second row", async () => {
  const db = createTestDb();
  await call("PATCH", db, "mysite", {
    home_country: "FI",
    consent_css: ".a{}",
  });
  const css = (await rows(db))[0].consent_css;

  assertEquals(
    (await call("PATCH", db, "MySite", { home_language: "fi" })).status,
    200,
  );
  assertEquals(await rows(db), [{
    site_id: "mysite",
    consent_css: css,
    home_country: "FI",
    home_language: "fi",
  }]);

  const got = await (await call("GET", db, "MYSITE")).json();
  assertEquals(got.home_country, "FI");
  assertEquals(got.home_language, "fi");
  assertEquals(got.consent_css, css);

  // The scorer's cache sees the same row under any spelling; the PATCH
  // itself marked the cache stale.
  await refreshSiteHomes(db);
  assertEquals(getSiteHome("MySite"), { country: "FI", language: "fi" });
  await db.close();
});

Deno.test("site settings — with two rows differing in case, the API and the cache read the same one", async () => {
  // Rows an earlier build could create. Neither is merged or removed; all
  // readers settle on the same one (the last in site_id order).
  const db = createTestDb();
  await db.run(
    `INSERT INTO site_settings (site_id, home_country, home_language)
     VALUES ('Dupe.example', 'SE', 'sv'), ('dupe.example', 'FI', 'fi')`,
  );
  markSiteHomesStale();
  await refreshSiteHomes(db);
  assertEquals(getSiteHome("DUPE.example"), { country: "FI", language: "fi" });
  const got = await (await call("GET", db, "DUPE.example")).json();
  assertEquals([got.home_country, got.home_language], ["FI", "fi"]);
  await call("PATCH", db, "DUPE.example", { home_country: "NO" });
  assertEquals(
    (await rows(db)).map((r) => [r.site_id, r.home_country]),
    [["Dupe.example", "SE"], ["dupe.example", "NO"]],
  );
  await db.close();
});

Deno.test("site settings — consent CSS saved under another spelling of the site id is served", async () => {
  const db = createTestDb();
  await call("PATCH", db, "mysite", { home_country: "FI" });
  await call("PATCH", db, "MySite", { consent_css: ".bar{color:red}" });
  assertEquals((await rows(db)).map((r) => r.site_id), ["mysite"]);
  // The PATCH marked the cache stale.
  await refreshConsentCss(db);
  for (const spelling of ["MySite", "mysite", "MYSITE"]) {
    assertEquals(getConsentCss(spelling), ".bar{color:red}", spelling);
  }
  assertEquals(getConsentCss("other-site"), "");
  await db.close();
});

Deno.test("site settings — two legacy rows: the page, the scorer and the banner all use one row, and a clear really clears", async () => {
  // Rows an earlier build could create for one site: one holds the home,
  // the other only the CSS. Every reader takes the last in site_id order.
  const db = createTestDb();
  await db.run(
    `INSERT INTO site_settings (site_id, consent_css, home_country, home_language)
     VALUES ('MySite', NULL, 'FI', 'fi'), ('mysite', '.a{color:red}', NULL, NULL)`,
  );
  const readers = async () => {
    markSiteHomesStale();
    markConsentCssStale();
    await refreshSiteHomes(db);
    await refreshConsentCss(db);
    const api = await (await call("GET", db, "MySite")).json();
    return {
      api: [api.home_country, api.home_language, api.consent_css],
      scorer: [
        getSiteHome("MySite").country,
        getSiteHome("MySite").language,
        getConsentCss("MySite"),
      ],
    };
  };
  const none = [null, null, ".a{color:red}"];
  assertEquals(await readers(), { api: none, scorer: none });

  // Setting a home through the API is what the scorer then uses...
  assertEquals(
    (await call("PATCH", db, "MySite", { home_country: "SE" })).status,
    200,
  );
  const se = ["SE", null, ".a{color:red}"];
  assertEquals(await readers(), { api: se, scorer: se });

  // ...and clearing it clears it for the scorer too.
  assertEquals(
    (await call("PATCH", db, "MYSITE", { home_country: null })).status,
    200,
  );
  assertEquals(await readers(), { api: none, scorer: none });
  assertEquals((await rows(db)).length, 2);
  await db.close();
});

// ── The saved home reaches the scorer ───────────────────────────────────────

Deno.test("beacon — a saved home country reaches the stored score detail", async () => {
  // The visitor's country comes from a geo header the server only reads when
  // told to trust it, and that is fixed at start: so this runs the real
  // beacon handler in a process started with the setting.
  const sid = "5a5a5a5a-5a5a-4a5a-8a5a-5a5a5a5a5a5a";
  const code = `
    import { DatabaseSync } from "node:sqlite";
    import { SqliteAdapter } from "@/lib/db/sqlite-adapter.ts";
    import { SCHEMA_SQL } from "@/lib/db/schema.ts";
    import { flushRemainingViews, handleBeacon } from "@/lib/beacon.ts";
    import { handler } from "@/routes/api/sites/[id].ts";
    import { solvePow } from "@/tests/_helpers.ts";
    const raw = new DatabaseSync(":memory:");
    raw.exec(SCHEMA_SQL);
    const db = new SqliteAdapter(raw);
    const sid = ${JSON.stringify(sid)};
    // Solved here: a token is only valid in the process that issued it.
    const tokens = {
      "home-fi.example": await solvePow("home-fi.example", sid),
      "no-home.example": await solvePow("no-home.example", sid),
    };
    const saved = await handler.PATCH({
      params: { id: "home-fi.example" },
      state: { db },
      req: new Request("http://localhost/api/sites/home-fi.example", {
        method: "PATCH",
        body: JSON.stringify({ home_country: "fi", home_language: "fi" }),
      }),
    });
    const out = { saved: saved.status };
    for (const [site, tok] of Object.entries(tokens)) {
      const res = await handleBeacon(
        new Request(
          "https://a.example.com/b.gif?p=" + btoa("/page") +
            "&_v=2000&sw=1440&sh=900&s=" + site + "&sid=" + sid + "&tok=" + tok,
          {
            headers: {
              "user-agent":
                "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/120.0.0.0",
              "accept-language": "pt-BR",
              "sec-ch-ua": '"Chrome"',
              "sec-fetch-site": "cross-site",
              "x-country-code": "BR",
            },
          },
        ),
        db,
      );
      await res.body?.cancel();
    }
    await flushRemainingViews(db);
    for (const row of await db.query("SELECT site_id, country_code, bot_score_detail FROM visitor_views")) {
      out[row.site_id] = { country: row.country_code, detail: JSON.parse(row.bot_score_detail ?? "{}") };
    }
    console.log(JSON.stringify(out));
    Deno.exit(0);`;
  const config = new URL("../deno.json", import.meta.url).pathname;
  const run = await new Deno.Command(Deno.execPath(), {
    args: ["eval", "--no-check", "--config", config, code],
    env: {
      ECHELON_TRUST_GEO_HEADERS: "true",
      ECHELON_BOT_SCORE_WEIGHTS: "",
      ECHELON_ANONYMIZE_SITES: "",
    },
    stdout: "piped",
    stderr: "piped",
  }).output();
  const stderr = new TextDecoder().decode(run.stderr);
  assertEquals(run.success, true, stderr);
  const lines = new TextDecoder().decode(run.stdout).trim().split("\n");
  const out = JSON.parse(lines[lines.length - 1]);
  assertEquals(out.saved, 200);
  assertEquals(out["home-fi.example"].country, "BR");
  assertEquals(out["home-fi.example"].detail.country_mismatch, 15);
  assertEquals(out["home-fi.example"].detail.cross_continent, 8);
  assertEquals(out["no-home.example"].country, "BR");
  assertEquals(out["no-home.example"].detail.country_mismatch, undefined);
  assertEquals(out["no-home.example"].detail.cross_continent, undefined);
});
