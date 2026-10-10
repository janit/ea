// Echelon Analytics — Fresh 2 Entry Point
//
// IMPORTANT: This app uses in-memory state (session store, rate limiter,
// buffered writers, caches). When using `deno serve`, run with a single
// worker (default). Multiple workers (--parallel) will create isolated
// copies of all in-memory state, causing incorrect behavior.

import { App, staticFiles } from "fresh";
import type { State } from "./utils.ts";
import { closeDb, initDb } from "./lib/db/database.ts";
import { flushRemainingViews, startViewWriter } from "./lib/beacon.ts";
import {
  flushRemainingEvents,
  startEventWriter,
} from "./lib/events-endpoint.ts";
import { scheduleDailyMaintenance } from "./lib/maintenance.ts";
import { startBotCorrelator, stopBotCorrelator } from "./lib/bot-correlator.ts";
import { startViewValidator, stopViewValidator } from "./lib/view-validator.ts";
import {
  startSessionClassifier,
  stopSessionClassifier,
} from "./lib/session-classifier.ts";
import { startThreatFeeds, stopThreatFeeds } from "./lib/threat-feeds.ts";
import { recordRequest } from "./lib/request-stats.ts";
import { pruneSessions } from "./lib/session.ts";
import { refreshUtmCampaigns } from "./lib/utm.ts";
import { AUTH_USERNAME, SECRET, SHUTDOWN_TIMEOUT_MS } from "./lib/config.ts";

// Warn if no authentication is configured
if (!SECRET && !AUTH_USERNAME) {
  console.warn(
    "[echelon] WARNING: No authentication configured. Set ECHELON_SECRET or ECHELON_USERNAME + ECHELON_PASSWORD_HASH.",
  );
}

// Initialize database
const db = await initDb();

// Start buffered writers
startViewWriter(db);
startEventWriter(db);

// Warm UTM campaign cache
await refreshUtmCampaigns(db);

// Schedule daily maintenance (rollup + purge + VACUUM at 03:00 UTC)
scheduleDailyMaintenance(db);

// Start background bot correlator (async fingerprint clustering)
startBotCorrelator(db);

// Start the view validator (marks views whose session demonstrably interacted)
startViewValidator(db);

// Start the session classifier (cross-request bot patterns, every 15 min)
startSessionClassifier(db);

// Start threat intelligence feeds (async refresh every 6h)
startThreatFeeds();

// Prune expired sessions every 30 minutes
setInterval(pruneSessions, 30 * 60 * 1000);

// Graceful shutdown
let _shuttingDown = false;
function gracefulShutdown(signal: string) {
  if (_shuttingDown) return;
  _shuttingDown = true;
  console.log(`[echelon] ${signal} received — flushing writers...`);
  stopBotCorrelator();
  stopViewValidator();
  stopSessionClassifier();
  stopThreatFeeds();

  // Hard timeout: force exit to avoid hanging
  const forceTimer = setTimeout(() => {
    console.error(
      `[echelon] Shutdown timed out after ${SHUTDOWN_TIMEOUT_MS}ms — forcing exit`,
    );
    Deno.exit(1);
  }, SHUTDOWN_TIMEOUT_MS);

  Promise.all([
    flushRemainingViews(db),
    flushRemainingEvents(db),
  ]).then(async () => {
    await closeDb();
    clearTimeout(forceTimer);
    Deno.exit(0);
  }).catch((e) => {
    console.error("[echelon] Error during shutdown:", e);
    clearTimeout(forceTimer);
    Deno.exit(1);
  });
}

Deno.addSignalListener("SIGTERM", () => gracefulShutdown("SIGTERM"));
Deno.addSignalListener("SIGINT", () => gracefulShutdown("SIGINT"));

export const app = new App<State>();

app.use(staticFiles());

// Security headers + request timing middleware
app.use(async (ctx) => {
  const start = performance.now();
  const resp = await ctx.next();
  const durationMs = performance.now() - start;
  const url = new URL(ctx.req.url);
  recordRequest(url.pathname, durationMs, resp.status);
  resp.headers.set("X-Frame-Options", "DENY");
  resp.headers.set("X-Content-Type-Options", "nosniff");
  resp.headers.set("Referrer-Policy", "strict-origin-when-cross-origin");
  return resp;
});

// Inject DB into state for all routes
app.use((ctx) => {
  ctx.state.db = db;
  ctx.state.isAuthenticated = false;
  return ctx.next();
});

app.fsRoutes();
