import { define } from "../../../utils.ts";
import { readJsonObject } from "../../../lib/request.ts";

export const handler = define.handlers({
  async POST(ctx) {
    const body = await readJsonObject(ctx.req);
    if (!body) {
      return Response.json(
        { error: "invalid_payload", message: "Invalid JSON" },
        { status: 400 },
      );
    }

    const { visitor_id, label } = body;
    if (typeof visitor_id !== "string" || !visitor_id) {
      return Response.json(
        { error: "invalid_payload", message: "visitor_id required" },
        { status: 400 },
      );
    }

    const vid = visitor_id.slice(0, 128);
    const lbl = typeof label === "string" ? label.slice(0, 256) : null;
    await ctx.state.db.run(
      `INSERT OR IGNORE INTO excluded_visitors (visitor_id, label) VALUES (?, ?)`,
      vid,
      lbl,
    );
    return Response.json({ excluded: vid }, { status: 201 });
  },
});
