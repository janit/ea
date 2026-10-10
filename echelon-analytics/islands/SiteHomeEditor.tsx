import { useSignal } from "@preact/signals";

interface Props {
  siteId: string;
  initialCountry: string;
  initialLanguage: string;
  readOnly: boolean;
}

export default function SiteHomeEditor(
  { siteId, initialCountry, initialLanguage, readOnly }: Props,
) {
  const country = useSignal(initialCountry);
  const language = useSignal(initialLanguage);
  const status = useSignal<"idle" | "saving" | "saved" | "error">("idle");
  const message = useSignal("");

  async function save() {
    status.value = "saving";
    message.value = "";
    try {
      const resp = await fetch(`/api/sites/${encodeURIComponent(siteId)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          home_country: country.value.trim(),
          home_language: language.value.trim(),
        }),
      });
      if (resp.ok) {
        status.value = "saved";
        return;
      }
      const body = await resp.json().catch(() => null);
      message.value = body?.message ?? `Save failed (${resp.status})`;
      status.value = "error";
    } catch {
      message.value = "Could not reach the server";
      status.value = "error";
    }
  }

  const inputClass =
    "bg-[var(--ea-bg)] border border-[var(--ea-border)] text-[var(--ea-text)] text-sm px-2 py-1 w-24 uppercase";

  return (
    <div class="flex flex-wrap items-end gap-4">
      <label class="text-xs text-[var(--ea-muted)]">
        <span class="block mb-1">Home country (ISO code, e.g. FI)</span>
        <input
          type="text"
          maxLength={2}
          class={inputClass}
          value={country.value}
          disabled={readOnly}
          onInput={(e) => {
            country.value = (e.target as HTMLInputElement).value;
            status.value = "idle";
          }}
        />
      </label>
      <label class="text-xs text-[var(--ea-muted)]">
        <span class="block mb-1">Site language (e.g. fi, en)</span>
        <input
          type="text"
          maxLength={6}
          class={inputClass.replace(" uppercase", " lowercase")}
          value={language.value}
          disabled={readOnly}
          onInput={(e) => {
            language.value = (e.target as HTMLInputElement).value;
            status.value = "idle";
          }}
        />
      </label>
      {!readOnly && (
        <button
          type="button"
          class="text-sm px-3 py-1 border border-[var(--ea-primary)] text-[var(--ea-primary)]"
          disabled={status.value === "saving"}
          onClick={save}
        >
          {status.value === "saving" ? "Saving…" : "Save"}
        </button>
      )}
      <span class="text-xs" role="status">
        {status.value === "saved" && "Saved. Takes effect within a minute."}
        {status.value === "error" && message.value}
      </span>
    </div>
  );
}
