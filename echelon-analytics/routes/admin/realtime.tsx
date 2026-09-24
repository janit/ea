import { page } from "fresh";
import { define } from "../../utils.ts";
import { AdminNav } from "../../components/AdminNav.tsx";
import { getLiveStats } from "../../lib/admin-stats.ts";
import RealtimePanel from "../../islands/RealtimePanel.tsx";

export const handler = define.handlers({
  async GET(ctx) {
    const liveStats = await getLiveStats(ctx.state.db);
    return page({ liveStats });
  },
});

export default define.page<typeof handler>(function RealtimePage(props) {
  const { data, state } = props;
  const { liveStats } = data;
  return (
    <AdminNav
      title="Realtime Visitors"
      liveStats={liveStats}
      siteId={state.siteId}
      knownSites={state.knownSites}
      days={state.days}
      url={state.url}
      telemetryState={state.telemetryState}
    >
      <RealtimePanel siteId={state.siteId} />
    </AdminNav>
  );
});
