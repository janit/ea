import { useSignal } from "@preact/signals";

export default function TelemetryBanner(
  { readOnly }: { readOnly?: boolean },
) {
  const dismissed = useSignal(false);
  const saving = useSignal(false);
  const error = useSignal<string | null>(null);

  if (readOnly) return null;

  async function choose(optin: boolean) {
    saving.value = true;
    error.value = null;
    try {
      const res = await fetch("/api/telemetry", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ optin }),
      });
      if (res.ok) {
        if (optin) {
          location.reload();
        } else {
          dismissed.value = true;
        }
      } else {
        const data = await res.json().catch(() => null);
        error.value = data?.error || data?.message ||
          `Request failed (${res.status})`;
      }
    } catch (e) {
      error.value = (e as Error).message || "Network error";
    }
    saving.value = false;
  }

  if (dismissed.value) return null;

  return (
    <div
      class="border-l-4 border-l-[var(--ea-primary)] border-b border-b-[var(--ea-border)] px-4 py-4 mx-4 my-4"
      style="background:var(--ea-surface)"
    >
      <div class="max-w-7xl mx-auto flex flex-col gap-3">
        <div class="text-base font-semibold text-[var(--ea-primary)]">
          Help improve Echelon Analytics?
        </div>
        <div class="text-sm text-[var(--ea-text)]">
          Send anonymous admin panel usage data (pages visited, no visitor data,
          no PII). You can change this anytime in{" "}
          <a
            href="/admin/settings"
            class="underline text-[var(--ea-primary)]"
          >
            Settings
          </a>{" "}
          or with the <code class="text-xs">ECHELON_TELEMETRY</code>{" "}
          env variable.{" "}
          <a
            href="https://ea.js.org/telemetry.html"
            target="_blank"
            rel="noopener"
            class="underline text-[var(--ea-muted)]"
          >
            What telemetry sends
          </a>
        </div>
        {error.value && (
          <div class="text-xs text-[var(--ea-danger)]">
            {error.value}
          </div>
        )}
        <div class="flex gap-3">
          <button
            type="button"
            onClick={() => choose(true)}
            disabled={saving.value}
            class="px-4 py-1.5 text-sm font-medium bg-[var(--ea-primary)] text-[var(--ea-bg)] hover:opacity-90 transition-opacity disabled:opacity-50"
          >
            {saving.value ? "Saving…" : "Yes, opt in"}
          </button>
          <button
            type="button"
            onClick={() => choose(false)}
            disabled={saving.value}
            class="px-4 py-1.5 text-sm border border-[var(--ea-border)] text-[var(--ea-muted)] hover:text-[var(--ea-text)] transition-colors disabled:opacity-50"
          >
            No thanks
          </button>
        </div>
      </div>
    </div>
  );
}
