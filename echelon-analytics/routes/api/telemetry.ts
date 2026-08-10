import { define } from "../../utils.ts";
import { readJsonObject } from "../../lib/request.ts";
import { TELEMETRY_OVERRIDE } from "../../lib/config.ts";
import { getTelemetryState, setTelemetryChoice } from "../../lib/telemetry.ts";

export const handler = define.handlers({
  async GET(ctx) {
    const state = await getTelemetryState(ctx.state.db);
    return Response.json({
      telemetry: state,
      envOverride: TELEMETRY_OVERRIDE,
    });
  },

  async POST(ctx) {
    if (TELEMETRY_OVERRIDE !== null) {
      return Response.json(
        {
          error: "locked",
          message: "Telemetry is locked by ECHELON_TELEMETRY env variable",
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
    if (typeof body.optin !== "boolean") {
      return Response.json(
        { error: "invalid_body", message: "Missing boolean 'optin' field" },
        { status: 400 },
      );
    }

    await setTelemetryChoice(ctx.state.db, body.optin);
    const state = await getTelemetryState(ctx.state.db);
    return Response.json({ telemetry: state });
  },
});
