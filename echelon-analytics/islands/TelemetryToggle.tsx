import { useSignal } from "@preact/signals";

interface Props {
  initialState: "on" | "off" | "undecided";
  envOverride: "on" | "off" | null;
  readOnly?: boolean;
}

export default function TelemetryToggle(
  { initialState, envOverride, readOnly }: Props,
) {
  const state = useSignal(initialState);
  const saving = useSignal(false);
  const msg = useSignal<string | null>(null);

  const locked = readOnly || envOverride !== null;
  const isOn = state.value === "on";

  async function toggle() {
    if (locked) return;
    saving.value = true;
    msg.value = null;
    try {
      const res = await fetch("/api/telemetry", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ optin: !isOn }),
      });
      if (res.ok) {
        const data = await res.json();
        state.value = data.telemetry;
        msg.value = data.telemetry === "on"
          ? "Telemetry enabled"
          : "Telemetry disabled";
        setTimeout(() => (msg.value = null), 2000);
      } else {
        const data = await res.json();
        msg.value = data.error || "Failed";
      }
    } catch (e) {
      msg.value = (e as Error).message;
    }
    saving.value = false;
  }

  return (
    <div class="flex items-center gap-3">
      <button
        type="button"
        role="switch"
        aria-checked={isOn}
        aria-label="Telemetry"
        onClick={toggle}
        disabled={locked || saving.value}
        class={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${
          locked ? "opacity-50 cursor-not-allowed" : "cursor-pointer"
        } ${isOn ? "bg-[var(--ea-primary)]" : "bg-[var(--ea-border)]"}`}
      >
        <span
          class={`inline-block h-4 w-4 rounded-full bg-[var(--ea-bg)] transition-transform ${
            isOn ? "translate-x-6" : "translate-x-1"
          }`}
        />
      </button>
      <span class="text-sm text-[var(--ea-text)]">
        {isOn ? "On" : "Off"}
      </span>
      {locked && (
        <span class="text-xs text-[var(--ea-muted)]">
          (locked by <code>ECHELON_TELEMETRY={envOverride}</code>)
        </span>
      )}
      {msg.value && (
        <span class="text-xs text-[var(--ea-primary)]">{msg.value}</span>
      )}
    </div>
  );
}
