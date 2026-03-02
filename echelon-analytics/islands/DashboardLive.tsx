import { useSignal } from "@preact/signals";
import { useEffect } from "preact/hooks";

interface TimeCount {
  minute?: string;
  hour?: string;
  count: number;
}

interface DashboardData {
  now: {
    activeVisitors: number;
    estimatedBots: number;
    pageviews: number;
  };
  hourly: { visitors: TimeCount[]; events: TimeCount[] };
  daily: { visitors: TimeCount[]; events: TimeCount[] };
  recentVisitors: Record<string, unknown>[];
  recentEvents: Record<string, unknown>[];
}

interface Props {
  siteId: string;
}

function timeAgo(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 60000) return `${Math.floor(ms / 1000)}s ago`;
  if (ms < 3600000) return `${Math.floor(ms / 60000)}m ago`;
  return `${Math.floor(ms / 3600000)}h ago`;
}

function MiniChart(
  { data, color, label, width = 400, height = 120 }: {
    data: TimeCount[];
    color: string;
    label: string;
    width?: number;
    height?: number;
  },
) {
  if (data.length === 0) {
    return (
      <div
        class="flex items-center justify-center text-[var(--ea-muted)] text-xs"
        style={{ width, height }}
      >
        No data
      </div>
    );
  }

  const maxVal = Math.max(...data.map((d) => d.count), 1);
  const pad = 30;
  const chartW = width - pad * 2;
  const chartH = height - 30;

  const points = data.map((d, i) => {
    const x = pad + (i / Math.max(data.length - 1, 1)) * chartW;
    const y = 10 + chartH - (d.count / maxVal) * chartH;
    return `${x},${y}`;
  }).join(" ");

  // Fill area
  const firstX = pad;
  const lastX = pad + ((data.length - 1) / Math.max(data.length - 1, 1)) *
      chartW;
  const fillPoints = `${firstX},${10 + chartH} ${points} ${lastX},${
    10 + chartH
  }`;

  // Labels
  const labelStep = Math.max(1, Math.floor(data.length / 5));
  const labels = data.filter((_, i) =>
    i % labelStep === 0 || i === data.length - 1
  );

  const total = data.reduce((s, d) => s + d.count, 0);

  return (
    <div>
      <div class="flex justify-between items-center mb-1">
        <span class="text-xs text-[var(--ea-muted)]">{label}</span>
        <span class="text-xs tabular-nums" style={{ color }}>
          {total} total
        </span>
      </div>
      <svg
        width={width}
        height={height}
        class="w-full"
        role="img"
        aria-label={`${label}: ${total} total`}
      >
        {/* Grid lines */}
        {[0, 0.25, 0.5, 0.75, 1].map((frac) => {
          const y = 10 + chartH - frac * chartH;
          return (
            <g key={frac}>
              <line
                x1={pad}
                y1={y}
                x2={width - pad}
                y2={y}
                stroke="var(--ea-border)"
                stroke-width="0.5"
              />
              <text
                x={pad - 4}
                y={y + 3}
                text-anchor="end"
                fill="var(--ea-muted)"
                font-size="9"
              >
                {Math.round(maxVal * frac)}
              </text>
            </g>
          );
        })}
        {/* Fill */}
        <polygon points={fillPoints} fill={color} opacity="0.1" />
        {/* Line */}
        <polyline
          points={points}
          fill="none"
          stroke={color}
          stroke-width="1.5"
        />
        {/* X labels */}
        {labels.map((d, i) => {
          const idx = data.indexOf(d);
          const x = pad + (idx / Math.max(data.length - 1, 1)) * chartW;
          return (
            <text
              key={i}
              x={x}
              y={height - 2}
              text-anchor="middle"
              fill="var(--ea-muted)"
              font-size="9"
            >
              {d.minute ?? d.hour ?? ""}
            </text>
          );
        })}
      </svg>
    </div>
  );
}

export default function DashboardLive({ siteId }: Props) {
  const data = useSignal<DashboardData | null>(null);
  const error = useSignal<string | null>(null);

  useEffect(() => {
    let active = true;

    async function fetchData() {
      try {
        const res = await fetch(
          `/api/stats/dashboard?site_id=${encodeURIComponent(siteId)}`,
        );
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const json = await res.json();
        if (active) {
          data.value = json;
          error.value = null;
        }
      } catch (e) {
        if (active) error.value = (e as Error).message;
      }
    }

    fetchData();
    const interval = setInterval(fetchData, 10_000);
    return () => {
      active = false;
      clearInterval(interval);
    };
  }, [siteId]);

  if (error.value) {
    return (
      <div
        class="border border-[var(--ea-danger-border)] text-[var(--ea-danger)] px-4 py-2 text-sm"
        style="background:var(--ea-danger-bg)"
      >
        {error.value}
      </div>
    );
  }

  if (!data.value) {
    return <p class="text-[var(--ea-muted)] text-sm">Loading live data...</p>;
  }

  const d = data.value;

  return (
    <div>
      {/* Now + Charts row */}
      <div class="grid grid-cols-5 gap-3 mb-4">
        {/* Now */}
        <div class="bg-[var(--ea-surface)] border border-[var(--ea-border)] p-4 flex flex-col items-center justify-center">
          <div class="text-3xl font-bold tabular-nums text-[var(--ea-primary)]">
            {d.now.activeVisitors}
          </div>
          <div class="text-xs text-[var(--ea-muted)] mt-1">Now (5 min)</div>
          <div class="flex gap-3 mt-2 text-xs">
            <span class="text-[var(--ea-primary)] tabular-nums">
              {d.now.pageviews} views
            </span>
            <span class="text-[var(--ea-danger)] tabular-nums">
              {d.now.estimatedBots} bots
            </span>
          </div>
        </div>

        {/* Last 60 minutes */}
        <div class="col-span-2 bg-[var(--ea-surface)] border border-[var(--ea-border)] p-3">
          <MiniChart
            data={d.hourly.visitors}
            color="var(--ea-primary)"
            label="Visitors — Last 60 min"
          />
          <div class="mt-2">
            <MiniChart
              data={d.hourly.events}
              color="#ff6600"
              label="Events — Last 60 min"
              height={80}
            />
          </div>
        </div>

        {/* Last 24 hours */}
        <div class="col-span-2 bg-[var(--ea-surface)] border border-[var(--ea-border)] p-3">
          <MiniChart
            data={d.daily.visitors}
            color="var(--ea-primary)"
            label="Visitors — Last 24 hours"
          />
          <div class="mt-2">
            <MiniChart
              data={d.daily.events}
              color="#ff6600"
              label="Events — Last 24 hours"
              height={80}
            />
          </div>
        </div>
      </div>

      {/* Recent visitors + events */}
      <div class="grid grid-cols-3 gap-3 mb-4">
        {/* Recent visitors */}
        <div class="col-span-2 bg-[var(--ea-surface)] border border-[var(--ea-border)] overflow-hidden">
          <div class="px-4 py-2 border-b border-[var(--ea-border)]">
            <h3 class="text-xs text-[var(--ea-primary)]">Recent Visitors</h3>
          </div>
          <table class="w-full text-xs">
            <thead>
              <tr class="border-b border-[var(--ea-border)]">
                <th class="text-left px-3 py-1.5 text-[var(--ea-muted)]">
                  Visitor
                </th>
                <th class="text-right px-3 py-1.5 text-[var(--ea-muted)]">
                  Views
                </th>
                <th class="text-left px-3 py-1.5 text-[var(--ea-muted)]">
                  Device
                </th>
                <th class="text-left px-3 py-1.5 text-[var(--ea-muted)]">
                  Country
                </th>
                <th class="text-left px-3 py-1.5 text-[var(--ea-muted)]">
                  When
                </th>
              </tr>
            </thead>
            <tbody>
              {d.recentVisitors.map(
                (v: Record<string, unknown>, i: number) => (
                  <tr key={i} class="border-b border-[var(--ea-surface-alt)]">
                    <td class="px-3 py-1">
                      <a
                        href={`/admin/visitors/${
                          encodeURIComponent(v.visitor_id as string)
                        }`}
                        class="visitor-id text-[var(--ea-primary)]"
                      >
                        {(v.visitor_id as string).slice(0, 10)}
                      </a>
                    </td>
                    <td class="px-3 py-1 text-right tabular-nums text-[var(--ea-primary)]">
                      {v.view_count as number}
                    </td>
                    <td class="px-3 py-1 text-[var(--ea-text)]">
                      {(v.device_type as string) || "-"}
                    </td>
                    <td class="px-3 py-1 text-[var(--ea-text)]">
                      {(v.country_code as string) || "-"}
                    </td>
                    <td class="px-3 py-1 text-[var(--ea-muted)] whitespace-nowrap">
                      {timeAgo(v.created_at as string)}
                    </td>
                  </tr>
                ),
              )}
              {d.recentVisitors.length === 0 && (
                <tr>
                  <td
                    colspan={5}
                    class="px-3 py-3 text-center text-[var(--ea-muted)]"
                  >
                    No recent visitors
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>

        {/* Recent events */}
        <div class="bg-[var(--ea-surface)] border border-[var(--ea-border)] overflow-hidden">
          <div class="px-4 py-2 border-b border-[var(--ea-border)]">
            <h3 class="text-xs text-[var(--ea-primary)]">Recent Events</h3>
          </div>
          <table class="w-full text-xs">
            <thead>
              <tr class="border-b border-[var(--ea-border)]">
                <th class="text-left px-3 py-1.5 text-[var(--ea-muted)]">
                  Event
                </th>
                <th class="text-left px-3 py-1.5 text-[var(--ea-muted)]">
                  Visitor
                </th>
                <th class="text-left px-3 py-1.5 text-[var(--ea-muted)]">
                  When
                </th>
              </tr>
            </thead>
            <tbody>
              {d.recentEvents.map(
                (e: Record<string, unknown>, i: number) => (
                  <tr key={i} class="border-b border-[var(--ea-surface-alt)]">
                    <td class="px-3 py-1">
                      <span class="bot-score-badge bot-score-low">
                        {e.event_type as string}
                      </span>
                    </td>
                    <td class="px-3 py-1">
                      {e.visitor_id
                        ? (
                          <a
                            href={`/admin/visitors/${
                              encodeURIComponent(e.visitor_id as string)
                            }`}
                            class="visitor-id text-[var(--ea-primary)]"
                          >
                            {(e.visitor_id as string).slice(0, 10)}
                          </a>
                        )
                        : <span class="text-[var(--ea-muted)]">-</span>}
                    </td>
                    <td class="px-3 py-1 text-[var(--ea-muted)] whitespace-nowrap">
                      {timeAgo(e.created_at as string)}
                    </td>
                  </tr>
                ),
              )}
              {d.recentEvents.length === 0 && (
                <tr>
                  <td
                    colspan={3}
                    class="px-3 py-3 text-center text-[var(--ea-muted)]"
                  >
                    No recent events
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
