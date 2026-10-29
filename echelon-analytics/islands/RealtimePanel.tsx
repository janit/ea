import { useComputed, useSignal } from "@preact/signals";
import { useEffect } from "preact/hooks";

interface RealtimeData {
  site_id: string;
  active_visitors: number;
  pageviews: number;
  active_paths: { path: string; views: number }[];
}

interface Props {
  siteId: string;
}

export default function RealtimePanel({ siteId }: Props) {
  const data = useSignal<RealtimeData | null>(null);
  const error = useSignal<string | null>(null);
  const lastUpdate = useSignal<string>("");
  const isStale = useComputed(() => !data.value);

  useEffect(() => {
    let active = true;

    async function fetchData() {
      try {
        const res = await fetch(
          `/api/stats/realtime?site_id=${encodeURIComponent(siteId)}`,
        );
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const json = await res.json();
        if (active) {
          data.value = json;
          error.value = null;
          lastUpdate.value = new Date().toLocaleTimeString();
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
        ERROR: {error.value}
      </div>
    );
  }

  if (isStale.value) {
    return (
      <p class="text-[var(--ea-muted)] text-sm">
        Loading realtime data...
      </p>
    );
  }

  const d = data.value!;

  return (
    <div>
      <div class="flex gap-2 mb-3 items-center">
        <span class="bg-[var(--ea-surface-alt)] border border-[var(--ea-border)] text-[var(--ea-text)] text-xs px-2 py-1">
          site: {siteId}
        </span>
        <span class="text-xs text-[var(--ea-muted)]">
          updated: {lastUpdate.value}
        </span>
      </div>

      <div class="grid grid-cols-2 gap-3 mb-4">
        <div class="kpi-card">
          <div class="kpi-value">{d.active_visitors}</div>
          <div class="kpi-label">Active Visitors (5 min)</div>
        </div>
        <div class="kpi-card">
          <div class="kpi-value">{d.pageviews}</div>
          <div class="kpi-label">Recent Pageviews</div>
        </div>
      </div>

      {
        <div class="bg-[var(--ea-surface)] border border-[var(--ea-border)] overflow-x-auto">
          <div class="px-4 py-3 border-b border-[var(--ea-border)]">
            <h2 class="text-sm text-[var(--ea-primary)]">Active Pages</h2>
          </div>
          <table class="w-full text-sm">
            <thead>
              <tr class="border-b border-[var(--ea-border)]">
                <th class="text-left px-4 py-2 text-xs text-[var(--ea-muted)]">
                  Path
                </th>
                <th class="text-right px-4 py-2 text-xs text-[var(--ea-muted)]">
                  Views
                </th>
              </tr>
            </thead>
            <tbody>
              {d.active_paths.length === 0 && (
                <tr>
                  <td
                    colSpan={2}
                    class="px-4 py-3 text-xs text-[var(--ea-muted)]"
                  >
                    No pages viewed in the last 5 minutes.
                  </td>
                </tr>
              )}
              {d.active_paths.map((p) => (
                <tr
                  key={p.path}
                  class="border-b border-[var(--ea-surface-alt)]"
                >
                  <td class="px-4 py-1.5 text-[var(--ea-text)]">{p.path}</td>
                  <td class="px-4 py-1.5 text-right tabular-nums text-[var(--ea-primary)]">
                    {p.views}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      }
    </div>
  );
}
