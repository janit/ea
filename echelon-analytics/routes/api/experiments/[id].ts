import { define } from "../../../utils.ts";
import { decodeParam } from "../../../lib/request.ts";
import { readJsonObject } from "../../../lib/request.ts";

const VALID_STATUSES = new Set([
  "draft",
  "active",
  "paused",
  "completed",
  "archived",
]);

const VALID_TRANSITIONS: Record<string, string[]> = {
  draft: ["active"],
  active: ["paused", "completed"],
  paused: ["active"],
  completed: ["archived"],
};

export const handler = define.handlers({
  async PATCH(ctx) {
    const db = ctx.state.db;
    const rawId = decodeParam(ctx.params.id);
    if (rawId === null) {
      return Response.json(
        { error: "invalid_id", message: "Malformed experiment ID" },
        { status: 400 },
      );
    }
    const expId = rawId.slice(0, 128);

    const body = await readJsonObject(ctx.req);
    if (!body) {
      return Response.json(
        { error: "invalid_payload", message: "Invalid JSON" },
        { status: 400 },
      );
    }

    const { status } = body;
    if (!status || !VALID_STATUSES.has(status as string)) {
      return Response.json(
        {
          error: "invalid_payload",
          message: "Invalid status. Must be one of: " +
            [...VALID_STATUSES].join(", "),
        },
        { status: 400 },
      );
    }

    // Verify experiment exists
    const existing = await db.queryOne<
      { experiment_id: string; status: string }
    >(
      `SELECT experiment_id, status FROM experiments WHERE experiment_id = ?`,
      expId,
    );
    if (!existing) {
      return Response.json(
        { error: "not_found", message: "Experiment not found" },
        { status: 404 },
      );
    }

    const allowed = VALID_TRANSITIONS[existing.status] ?? [];
    if (!allowed.includes(status as string)) {
      return Response.json(
        {
          error: "invalid_transition",
          message: `Cannot transition from '${existing.status}' to '${status}'`,
        },
        { status: 400 },
      );
    }

    // Atomic status transition: AND status = ? prevents TOCTOU races where
    // concurrent requests both read the same status and both write.
    const now = new Date().toISOString();
    let result;
    if (status === "active") {
      result = await db.run(
        `UPDATE experiments SET status = ?, started_at = COALESCE(started_at, ?) WHERE experiment_id = ? AND status = ?`,
        status as string,
        now,
        expId,
        existing.status,
      );
    } else if (status === "completed" || status === "archived") {
      result = await db.run(
        `UPDATE experiments SET status = ?, ended_at = COALESCE(ended_at, ?) WHERE experiment_id = ? AND status = ?`,
        status as string,
        now,
        expId,
        existing.status,
      );
    } else {
      result = await db.run(
        `UPDATE experiments SET status = ? WHERE experiment_id = ? AND status = ?`,
        status as string,
        expId,
        existing.status,
      );
    }

    if (result.changes === 0) {
      return Response.json(
        {
          error: "conflict",
          message: "Experiment status was modified concurrently, retry",
        },
        { status: 409 },
      );
    }

    return Response.json({ updated: expId });
  },
});
