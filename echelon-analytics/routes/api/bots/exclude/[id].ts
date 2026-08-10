import { define } from "../../../../utils.ts";
import { decodeParam } from "../../../../lib/request.ts";

export const handler = define.handlers({
  async DELETE(ctx) {
    const raw = decodeParam(ctx.params.id);
    if (raw === null) {
      return Response.json(
        { error: "invalid_id", message: "Malformed visitor ID" },
        { status: 400 },
      );
    }
    const visitorId = raw.slice(0, 128);
    await ctx.state.db.run(
      `DELETE FROM excluded_visitors WHERE visitor_id = ?`,
      visitorId,
    );
    return Response.json({ included: visitorId });
  },
});
