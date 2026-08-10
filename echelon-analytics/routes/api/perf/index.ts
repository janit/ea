import { define } from "../../../utils.ts";
import { isPlainObject, readJsonArray } from "../../../lib/request.ts";
import {
  insertMetrics,
  type PerfQuery,
  queryMetrics,
} from "../../../lib/perf.ts";
import type { PerfMetric } from "../../../types.ts";

export const handler = define.handlers({
  async GET(ctx) {
    const url = new URL(ctx.req.url);
    const query: PerfQuery = {
      category: url.searchParams.get("category") ?? undefined,
      metric: url.searchParams.get("metric") ?? undefined,
      limit: Math.min(
        1000,
        Math.max(1, parseInt(url.searchParams.get("limit") ?? "100") || 100),
      ),
      since: url.searchParams.get("since") ?? undefined,
    };

    const rows = await queryMetrics(ctx.state.db, query);
    return Response.json(rows);
  },

  async POST(ctx) {
    const contentLength = parseInt(
      ctx.req.headers.get("content-length") ?? "0",
    );
    if (contentLength > 65_536) {
      return Response.json(
        { error: "payload_too_large", message: "Max 64 KB" },
        { status: 413 },
      );
    }

    const body = await readJsonArray(ctx.req);
    if (!body || body.length > 100) {
      return Response.json(
        {
          error: "invalid_payload",
          message: "Expected array of metrics (max 100)",
        },
        { status: 400 },
      );
    }

    const sanitized: PerfMetric[] = [];
    for (const m of body) {
      if (!isPlainObject(m)) {
        return Response.json(
          {
            error: "invalid_payload",
            message: "Each metric must be an object",
          },
          { status: 400 },
        );
      }
      if (
        typeof m.category !== "string" || !m.category ||
        typeof m.metric !== "string" || !m.metric ||
        typeof m.value !== "number" || !isFinite(m.value) ||
        typeof m.unit !== "string" || !m.unit
      ) {
        return Response.json(
          {
            error: "invalid_payload",
            message:
              "Each metric requires category (string), metric (string), value (number), unit (string)",
          },
          { status: 400 },
        );
      }

      // Enforce the size cap on the serialized form, and reject rather than
      // truncate — a truncated JSON string is not recoverable by any consumer.
      let metadata: Record<string, unknown> | null = null;
      if (m.metadata != null) {
        if (!isPlainObject(m.metadata)) {
          return Response.json(
            {
              error: "invalid_payload",
              message: "metadata must be an object",
            },
            { status: 400 },
          );
        }
        if (JSON.stringify(m.metadata).length > 2048) {
          return Response.json(
            {
              error: "invalid_payload",
              message: "metadata must serialize to at most 2048 bytes",
            },
            { status: 400 },
          );
        }
        metadata = m.metadata;
      }

      sanitized.push({
        category: String(m.category).slice(0, 128),
        metric: String(m.metric).slice(0, 128),
        value: m.value,
        unit: String(m.unit).slice(0, 32),
        commit_hash: typeof m.commit_hash === "string"
          ? m.commit_hash.slice(0, 64)
          : undefined,
        branch: typeof m.branch === "string"
          ? m.branch.slice(0, 128)
          : undefined,
        // Pass the object through — insertMetrics() serializes. Stringifying
        // here too stored a JSON-encoded string instead of an object, and the
        // 2048 truncation could cut mid-escape into unparseable JSON.
        metadata: metadata ?? undefined,
      });
    }

    try {
      const count = await insertMetrics(ctx.state.db, sanitized);
      return Response.json({ inserted: count });
    } catch (err) {
      console.error("[echelon] Perf ingest error:", err);
      return Response.json(
        { error: "internal", message: "Ingest failed" },
        { status: 500 },
      );
    }
  },
});
