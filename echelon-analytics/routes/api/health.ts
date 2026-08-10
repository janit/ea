import { define } from "../../utils.ts";
import { getViewWriterHealth } from "../../lib/beacon.ts";
import { getEventWriterHealth } from "../../lib/events-endpoint.ts";

export const handler = define.handlers({
  GET() {
    // This endpoint is unauthenticated, so report a status rather than raw
    // counters — enough for a monitor to alert on, without publishing traffic
    // volume. BufferedWriter already escalates to CRITICAL in the logs; this
    // makes the same degradation visible to a health check.
    const views = getViewWriterHealth();
    const events = getEventWriterHealth();
    const degraded = views.failedCycles > 0 || events.failedCycles > 0 ||
      views.dropped > 0 || events.dropped > 0;

    return Response.json({
      status: degraded ? "degraded" : "ok",
      service: "Echelon Analytics",
      writers: {
        views: {
          flushing: views.failedCycles === 0,
          dropping: views.dropped > 0,
        },
        events: {
          flushing: events.failedCycles === 0,
          dropping: events.dropped > 0,
        },
      },
    }, { status: degraded ? 503 : 200 });
  },
});
