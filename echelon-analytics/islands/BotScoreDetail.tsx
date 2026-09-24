import { useSignal } from "@preact/signals";
import { scoreBadge } from "../components/ScoreBadge.tsx";

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
};

export default function BotScoreDetail({ viewId, eventId, score }: Props) {
  const open = useSignal(false);
  const detail = useSignal<
    Record<string, number | string> | null | undefined
  >(undefined);
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
                        {typeof val === "string" ? val : `+${val}`}
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
