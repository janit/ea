import { useSignal } from "@preact/signals";

export default function ConsentCssEditor(
  { siteId, initialCss, readOnly }: {
    siteId: string;
    initialCss: string;
    readOnly?: boolean;
  },
) {
  const css = useSignal(initialCss);
  const saving = useSignal(false);
  const msg = useSignal<string | null>(null);
  const err = useSignal<string | null>(null);

  async function save() {
    saving.value = true;
    msg.value = null;
    err.value = null;
    try {
      const res = await fetch(
        `/api/sites/${encodeURIComponent(siteId)}`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ consent_css: css.value || null }),
        },
      );
      if (!res.ok) {
        const data = await res.json();
        err.value = data.message || "Save failed";
      } else {
        msg.value = "Saved";
        setTimeout(() => (msg.value = null), 2000);
      }
    } catch (e) {
      err.value = (e as Error).message;
    }
    saving.value = false;
  }

  const inputCls =
    "border border-[var(--ea-border)] bg-[var(--ea-bg)] text-[var(--ea-primary)] px-3 py-2 text-sm w-full focus:border-[var(--ea-primary)] font-mono";

  return (
    <div>
      <label
        for="consent-css"
        class="block text-xs text-[var(--ea-muted)] mb-1"
      >
        Custom CSS (injected into shadow DOM)
      </label>
      <textarea
        id="consent-css"
        class={inputCls}
        rows={6}
        placeholder={`.bar { background: #2d2d2d; }
.ok { background: #22c55e; }
.no { border-color: #666; color: #ccc; }`}
        value={css.value}
        disabled={readOnly}
        onInput={(e) => (css.value = (e.target as HTMLTextAreaElement).value)}
      />
      {!readOnly && (
        <div class="flex items-center gap-3 mt-2">
          <button
            type="button"
            class="px-3 py-1.5 text-xs border border-[var(--ea-primary)] text-[var(--ea-primary)] hover:bg-[var(--ea-primary)] hover:text-[var(--ea-bg)] disabled:opacity-50"
            disabled={saving.value}
            onClick={save}
          >
            {saving.value ? "saving..." : "> save"}
          </button>
          {msg.value && (
            <span class="text-xs text-[var(--ea-primary)]">{msg.value}</span>
          )}
          {err.value && (
            <span class="text-xs text-[var(--ea-danger)]">{err.value}</span>
          )}
        </div>
      )}
      <div class="mt-3 text-xs text-[var(--ea-muted)]">
        Available selectors: <code class="text-[var(--ea-text)]">.bar</code>
        {" "}
        (container), <code class="text-[var(--ea-text)]">.msg</code> (text),
        {" "}
        <code class="text-[var(--ea-text)]">.btns</code> (button wrapper),{" "}
        <code class="text-[var(--ea-text)]">.ok</code> (accept),{" "}
        <code class="text-[var(--ea-text)]">.no</code> (decline)
      </div>
    </div>
  );
}
