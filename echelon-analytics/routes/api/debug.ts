import { define } from "../../utils.ts";
import { readJsonObject } from "../../lib/request.ts";
import { DEBUG } from "../../lib/config.ts";
import { isDebugEnabled, setRuntimeDebug } from "../../lib/debug.ts";

export const handler = define.handlers({
  GET(_ctx) {
    return Response.json({
      debug: isDebugEnabled(),
      envOverride: DEBUG,
    });
  },

  async POST(ctx) {
    if (DEBUG) {
      return Response.json(
        {
          error: "locked",
          message: "Debug is locked by ECHELON_DEBUG env variable",
        },
        { status: 409 },
      );
    }

    const body = await readJsonObject(ctx.req);
    if (!body) {
      return Response.json(
        { error: "invalid_body", message: "Invalid JSON body" },
        { status: 400 },
      );
    }
    if (typeof body.enabled !== "boolean") {
      return Response.json(
        { error: "invalid_body", message: "Missing boolean 'enabled' field" },
        { status: 400 },
      );
    }

    setRuntimeDebug(body.enabled ? true : null);
    return Response.json({ debug: isDebugEnabled() });
  },
});
