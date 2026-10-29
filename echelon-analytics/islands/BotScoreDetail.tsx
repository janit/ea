import { useSignal } from "@preact/signals";
import { scoreBadge } from "../components/ScoreBadge.tsx";
import { formatFactor } from "../lib/score-factor.ts";

interface Props {
  viewId?: number;
  eventId?: number;
  score: number;
}

const FACTOR_LABELS: Record<string, string> = {
  cf: "Cloudflare",
  timing: "Timing",
  geo: "Geography",
  geo_site: "Site Geo",
  burst: "Burst",
  headers: "Headers",
  screen: "Screen",
  referrer: "Referrer",
  pow: "PoW Token",
  pow_result: "PoW Result",
  pow_ok: "PoW waived (proven)",
  pow_ok_by: "PoW waived by (s = session, v = visitor)",
  no_events: "No interaction",
  unproven: "No PoW and no interaction",
  no_engagement: "No engagement (strict mode)",
  correlated: "Fingerprint cluster",
  crawler_feed: "Crawler feed",
  ai_crawler_feed: "AI crawler feed",
  datacenter_ip: "Datacenter IP",
  bot_ip: "Known bot IP",
  win_tablet_mismatch: "Windows UA, tablet screen",
  linux_desktop: "Linux desktop",
  cross_site: "Many sites, one IP",
  country_mismatch: "Country unlike site home",
  cross_continent: "Other continent",
  global_common_foreign: "Windows tablet, foreign",
  linux_foreign: "Linux desktop, foreign",
  stale_android_foreign: "Old Android, foreign",
  classifier: "Session classifier",
};

export default function BotScoreDetail({ viewId, eventId, score }: Props) {
  const open = useSignal(false);
  const detail = useSignal<Record<string, unknown> | null | undefined>(
    undefined,
  );
  const loading = useSignal(false);
  const error = useSignal<string | null>(null);

  async function toggle() {
    if (open.value) {
      open.value = false;
      return;
    }

    if (detail.value !== undefined) {
      open.value = true;
      return;
    }

    loading.value = true;
    error.value = null;
    try {
      const param = viewId ? `view_id=${viewId}` : `event_id=${eventId}`;
      const res = await fetch(`/api/bots/score-detail?${param}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      detail.value = json.detail;
      open.value = true;
    } catch {
      error.value = "Failed to load";
    }
    loading.value = false;
  }

  return (
    <span>
      <span class="inline-flex items-center gap-1">
        {scoreBadge(score)}
        <button
          type="button"
          class="text-xs text-[var(--ea-muted)] hover:text-[var(--ea-primary)] cursor-pointer"
          onClick={toggle}
          disabled={loading.value}
          aria-expanded={open.value}
          aria-label={open.value
            ? "Hide score breakdown"
            : "Show score breakdown"}
        >
          {loading.value ? "..." : open.value ? "[-]" : "[+]"}
        </button>
      </span>
      {error.value && (
        <span class="text-xs text-[var(--ea-danger)] ml-1">{error.value}</span>
      )}
      {open.value && (
        <div class="mt-1 text-xs">
          {detail.value === null
            ? (
              <span class="text-[var(--ea-muted)]">
                No breakdown available
              </span>
            )
            : (
              <table class="text-xs">
                <tbody>
                  {Object.entries(detail.value!).map(([key, val]) => (
                    <tr key={key}>
                      <td class="pr-2 text-[var(--ea-muted)]">
                        {FACTOR_LABELS[key] ?? key}
                      </td>
                      <td class="tabular-nums text-[var(--ea-primary)]">
                        {formatFactor(val)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
        </div>
      )}
    </span>
  );
}
