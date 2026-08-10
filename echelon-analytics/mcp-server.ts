/**
 * Echelon Analytics — MCP Server (API-backed, read-only)
 *
 * Exposes read-only analytics query tools via Model Context Protocol (stdio).
 * Queries the Echelon Analytics REST API — works with any instance.
 *
 * READ-ONLY: This server only calls GET endpoints. It never sends POST, PATCH,
 * or DELETE requests — it cannot create, modify, or delete any data, even if
 * the token has write access.
 *
 * Required env:
 *   ECHELON_URL    — Base URL of the Echelon instance (e.g. https://ea.islets.app)
 *
 * Optional env:
 *   ECHELON_SECRET — Bearer token for read-only API access
 *
 * Usage:
 *   ECHELON_URL=https://ea.islets.app deno task mcp
 *   ECHELON_URL=http://localhost:1947 ECHELON_SECRET=my-token deno task mcp
 */

// The SDK's `./*` export maps types to `./dist/esm/*.d.ts`, so the `.js`
// specifier needed at runtime resolves to a nonexistent `mcp.js.d.ts` for
// types. The extensionless specifier resolves types correctly but not runtime,
// hence the split: `@deno-types` for types, `.js` for the actual import.
// @deno-types="@modelcontextprotocol/sdk/server/mcp"
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
// @deno-types="@modelcontextprotocol/sdk/server/stdio"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

// All logging goes to stderr — stdout is reserved for MCP JSON-RPC
const log = (...args: unknown[]) => console.error("[echelon-mcp]", ...args);

// --- Configuration ----------------------------------------------------------

const baseUrl: string = Deno.env.get("ECHELON_URL") ?? "";
if (!baseUrl) {
  log("ECHELON_URL is required. Example: ECHELON_URL=https://ea.islets.app");
  Deno.exit(1);
}

// Reject embedded credentials: they would be logged verbatim below (MCP
// clients persist subprocess stderr to log files), and Deno merges URL userinfo
// with the bearer into a single malformed Authorization header.
let parsedBase: URL;
try {
  parsedBase = new URL(baseUrl);
} catch {
  log(`ECHELON_URL is not a valid URL: ${baseUrl}`);
  Deno.exit(1);
}
if (parsedBase.username || parsedBase.password) {
  log(
    "ECHELON_URL must not contain credentials. Use ECHELON_SECRET for the bearer token.",
  );
  Deno.exit(1);
}

const secret = Deno.env.get("ECHELON_SECRET");

// Log the origin only — never the full URL, which may carry a query string.
log(`API endpoint: ${parsedBase.origin}`);
if (secret) log("Using bearer token for read-only access");

// --- API client (GET only) --------------------------------------------------

const REQUEST_TIMEOUT_MS = 30_000;
/** Cap on any API text handed to the model. Responses can be unbounded. */
const MAX_RESPONSE_BYTES = 256_000;

function truncate(body: string): string {
  return body.length > MAX_RESPONSE_BYTES
    ? body.slice(0, MAX_RESPONSE_BYTES) +
      `\n… truncated (${body.length} bytes total)`
    : body;
}

async function api(path: string): Promise<unknown> {
  const url = `${baseUrl.replace(/\/$/, "")}${path}`;
  const headers: Record<string, string> = {
    "Accept": "application/json",
  };
  if (secret) {
    headers["Authorization"] = `Bearer ${secret}`;
  }

  const resp = await fetch(url, {
    headers,
    // Do not follow redirects. Deno strips Authorization on a cross-origin
    // hop, so the token does not leak — but a 302 would otherwise let whoever
    // controls it choose the text the agent reads as "your analytics", which
    // is a prompt-injection channel carrying the credibility of the user's own
    // data.
    redirect: "manual",
    // Without a deadline, an instance that opens a response and never writes
    // hangs the tool call, and its promise and socket, indefinitely.
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });

  if (resp.status >= 300 && resp.status < 400) {
    throw new Error(
      `API ${resp.status}: refusing to follow redirect to ${
        resp.headers.get("location") ?? "(no location)"
      }`,
    );
  }

  if (!resp.ok) {
    // Truncate: this string goes straight into the model's context, and a
    // hostile or broken instance can otherwise return megabytes.
    throw new Error(`API ${resp.status}: ${truncate(await resp.text())}`);
  }

  // Reject rather than truncate on the success path — a truncated JSON body
  // would only fail to parse, with a misleading error.
  const text = await resp.text();
  if (text.length > MAX_RESPONSE_BYTES) {
    throw new Error(
      `API ${resp.status}: response too large (${text.length} bytes, limit ${MAX_RESPONSE_BYTES})`,
    );
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`API ${resp.status}: response was not valid JSON`);
  }
}

// --- MCP Server -------------------------------------------------------------

const server = new McpServer({
  name: "echelon-analytics",
  version: "1.0.0",
});

// 1. analytics_overview — site overview stats
server.tool(
  "analytics_overview",
  "Overview stats for a site: visits, unique visitors, top paths, devices, OS breakdown, countries, referrers, screen resolutions, and daily trend.",
  {
    site_id: z.string().describe("Site identifier (e.g. 'my-site')"),
    days: z.number().int().min(1).max(730).default(30).describe(
      "Lookback period in days (default: 30)",
    ),
  },
  async ({ site_id, days }) => {
    const result = await api(
      `/api/stats/overview?site_id=${encodeURIComponent(site_id)}&days=${days}`,
    );
    return {
      content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
    };
  },
);

// 2. analytics_realtime — active visitors in last 5 minutes
server.tool(
  "analytics_realtime",
  "Realtime stats: active visitors and top pages in the last 5 minutes.",
  {
    site_id: z.string().describe("Site identifier"),
  },
  async ({ site_id }) => {
    const result = await api(
      `/api/stats/realtime?site_id=${encodeURIComponent(site_id)}`,
    );
    return {
      content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
    };
  },
);

// 3. analytics_campaigns — campaign list with view/visitor counts
server.tool(
  "analytics_campaigns",
  "UTM campaign stats: views and visitors grouped by campaign.",
  {
    days: z.number().int().min(1).max(90).default(30).describe(
      "Lookback period in days (default: 30, max: 90)",
    ),
    campaign_id: z.string().optional().describe(
      "Filter to a single campaign by ID",
    ),
  },
  async ({ days, campaign_id }) => {
    let path = `/api/stats/campaigns?days=${days}`;
    if (campaign_id) path += `&id=${encodeURIComponent(campaign_id)}`;
    const result = await api(path);
    return {
      content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
    };
  },
);

// 4. analytics_campaign_detail — breakdown by source, medium, content, term
server.tool(
  "analytics_campaign_detail",
  "Detailed campaign breakdown: sources, mediums, content, terms, daily trend, and top landing pages.",
  {
    campaign_id: z.string().describe("Campaign ID"),
    days: z.number().int().min(1).max(90).default(30).describe(
      "Lookback period in days (default: 30, max: 90)",
    ),
  },
  async ({ campaign_id, days }) => {
    const result = await api(
      `/api/stats/campaigns?id=${encodeURIComponent(campaign_id)}&days=${days}`,
    );
    return {
      content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
    };
  },
);

// 5. analytics_experiments — A/B experiment results
server.tool(
  "analytics_experiments",
  "A/B experiment results with conversion rates and statistical significance.",
  {
    experiment_id: z.string().optional().describe(
      "Filter to a single experiment by ID",
    ),
  },
  async ({ experiment_id }) => {
    let path = `/api/stats/experiments`;
    if (experiment_id) {
      path += `?experiment_id=${encodeURIComponent(experiment_id)}`;
    }
    const result = await api(path);
    return {
      content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
    };
  },
);

// 6. analytics_dashboard — live dashboard snapshot
server.tool(
  "analytics_dashboard",
  "Live dashboard: active visitors, hourly/daily trends, recent visitors, and recent events.",
  {
    site_id: z.string().describe("Site identifier"),
  },
  async ({ site_id }) => {
    const result = await api(
      `/api/stats/dashboard?site_id=${encodeURIComponent(site_id)}`,
    );
    return {
      content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
    };
  },
);

// 7. analytics_campaign_events — campaign-to-event correlation
server.tool(
  "analytics_campaign_events",
  "Campaign-to-event correlation: for each campaign (and organic traffic), shows visitors, event-triggering visitors, event counts, event rate, and events per visitor. Use to measure whether campaign visitors adopt features or convert. Rows with utm_campaign=null represent organic (non-campaign) traffic as a baseline.",
  {
    site_id: z.string().describe("Site identifier (e.g. 'my-site')"),
    days: z.number().int().min(1).max(90).default(30).describe(
      "Lookback period in days (default: 30, max: 90)",
    ),
    event_type: z.string().optional().describe(
      "Filter to a specific event type (e.g. 'purchase', 'feature_used', 'signup')",
    ),
  },
  async ({ site_id, days, event_type }) => {
    let path = `/api/stats/campaign-events?site_id=${
      encodeURIComponent(site_id)
    }&days=${days}`;
    if (event_type) path += `&event_type=${encodeURIComponent(event_type)}`;
    const result = await api(path);
    return {
      content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
    };
  },
);

// 8. list_campaigns — campaign metadata
server.tool(
  "list_campaigns",
  "List all registered UTM campaigns with their IDs, names, utm_campaign values, site IDs, and statuses.",
  {},
  async () => {
    const result = await api(`/api/campaigns`);
    return {
      content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
    };
  },
);

// 9. list_experiments — experiment metadata
server.tool(
  "list_experiments",
  "List all A/B experiments with their IDs, names, statuses, metric event types, and variant definitions.",
  {},
  async () => {
    const result = await api(`/api/experiments`);
    return {
      content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
    };
  },
);

// --- Start ------------------------------------------------------------------

const transport = new StdioServerTransport();
await server.connect(transport);
log("MCP server running on stdio");
