import { define } from "../../../utils.ts";
import { isPlainObject, readJsonObject } from "../../../lib/request.ts";

export const handler = define.handlers({
  async GET(ctx) {
    const rows = await ctx.state.db.query(
      `SELECT * FROM experiments ORDER BY created_at DESC LIMIT 200`,
    );
    return Response.json(rows);
  },

  async POST(ctx) {
    const db = ctx.state.db;
    const body = await readJsonObject(ctx.req);
    if (!body) {
      return Response.json(
        { error: "invalid_payload", message: "Invalid JSON" },
        { status: 400 },
      );
    }

    const {
      experiment_id,
      name,
      description,
      metric_event_type,
      allocation_percent,
      variants,
    } = body;
    if (!experiment_id || !name || !metric_event_type) {
      return Response.json(
        { error: "invalid_payload", message: "Missing required fields" },
        { status: 400 },
      );
    }

    // Validate ID format (alphanumeric + ._-), lengths, and variant count
    const ID_RE = /^[a-zA-Z0-9._-]+$/;
    const expId = String(experiment_id).slice(0, 128);
    if (!ID_RE.test(expId)) {
      return Response.json(
        {
          error: "invalid_payload",
          message: "experiment_id must be alphanumeric (plus . _ -)",
        },
        { status: 400 },
      );
    }
    // deno-lint-ignore no-control-regex
    const stripControl = (s: string) => s.replace(/[\x00-\x1f]/g, "");
    const expName = stripControl(String(name).slice(0, 256));
    const expDesc = description
      ? stripControl(String(description).slice(0, 1024))
      : null;
    const expMetric = stripControl(String(metric_event_type).slice(0, 128));
    const expAlloc = Math.round(
      Math.max(1, Math.min(100, Number(allocation_percent) || 100)),
    );
    const variantList = Array.isArray(variants)
      ? (variants as Record<string, unknown>[]).slice(0, 20)
      : [];

    // Validate variant weights up front so a bad weight is a clean 400 and the
    // transaction's catch block is left to deal with real DB errors only.
    const preparedVariants = [];
    for (const v of variantList) {
      // Array.isArray() says nothing about element types — [null] reaches here.
      if (!isPlainObject(v)) {
        return Response.json(
          {
            error: "invalid_payload",
            message: "Each variant must be an object",
          },
          { status: 400 },
        );
      }
      const weight = Number(v.weight);
      if (!Number.isFinite(weight) || weight <= 0) {
        return Response.json(
          {
            error: "invalid_payload",
            message: "Variant weight must be a finite positive number",
          },
          { status: 400 },
        );
      }
      preparedVariants.push({
        variantId: stripControl(String(v.variant_id ?? "").slice(0, 128)),
        name: stripControl(String(v.name ?? "").slice(0, 256)),
        weight,
        isControl: v.is_control ? 1 : 0,
        config: v.config ? JSON.stringify(v.config).slice(0, 4096) : null,
      });
    }

    // A duplicate variant_id violates PRIMARY KEY (experiment_id, variant_id),
    // which the catch below would report as "Experiment already exists" —
    // pointing the operator at a field that is not the problem.
    const variantIds = preparedVariants.map((v) => v.variantId);
    if (new Set(variantIds).size !== variantIds.length) {
      return Response.json(
        {
          error: "invalid_payload",
          message: "Variant IDs must be unique within an experiment",
        },
        { status: 400 },
      );
    }

    try {
      await db.transaction(async (tx) => {
        await tx.run(
          `INSERT INTO experiments (experiment_id, name, description, metric_event_type, allocation_percent)
           VALUES (?, ?, ?, ?, ?)`,
          expId,
          expName,
          expDesc,
          expMetric,
          expAlloc,
        );

        for (const v of preparedVariants) {
          await tx.run(
            `INSERT INTO experiment_variants (experiment_id, variant_id, name, weight, is_control, config)
             VALUES (?, ?, ?, ?, ?, ?)`,
            expId,
            v.variantId,
            v.name,
            v.weight,
            v.isControl,
            v.config,
          );
        }
      });

      return Response.json({ created: expId }, { status: 201 });
    } catch (err) {
      // Only a duplicate ID (constraint violation) is a genuine conflict.
      // Any other failure (locked/full disk, missing table, etc.) is a 500 so
      // operators see a real error instead of a misleading 409.
      if (err instanceof Error && /constraint failed/i.test(err.message)) {
        return Response.json(
          { error: "conflict", message: "Experiment already exists" },
          { status: 409 },
        );
      }
      console.error("[echelon] experiment creation failed:", err);
      return Response.json(
        { error: "internal_error", message: "Experiment creation failed" },
        { status: 500 },
      );
    }
  },
});
