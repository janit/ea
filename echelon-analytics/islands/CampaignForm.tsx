import { useSignal } from "@preact/signals";

export default function CampaignForm({ readOnly }: { readOnly?: boolean }) {
  const id = useSignal("");
  const name = useSignal("");
  const utmCampaign = useSignal("");
  const siteId = useSignal("default");
  const error = useSignal<string | null>(null);
  const success = useSignal<string | null>(null);
  const loading = useSignal(false);

  if (readOnly) return null;

  async function submit(e: Event) {
    e.preventDefault();
    error.value = null;
    success.value = null;

    if (!id.value || !name.value || !utmCampaign.value) {
      error.value = "ID, name, and utm_campaign are required.";
      return;
    }

    loading.value = true;
    try {
      const res = await fetch("/api/campaigns", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id: id.value,
          name: name.value,
          utm_campaign: utmCampaign.value,
          site_id: siteId.value || "default",
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        error.value = data.message || "Failed to create campaign.";
      } else {
        id.value = "";
        name.value = "";
        utmCampaign.value = "";
        siteId.value = "default";
        success.value = data.created;
        location.href = `/admin/campaigns/${encodeURIComponent(data.created)}`;
      }
    } catch (err) {
      error.value = (err as Error).message;
    }
    loading.value = false;
  }

  const inputCls =
    "border border-[var(--ea-border)] bg-[var(--ea-bg)] text-[var(--ea-primary)] px-2 py-1.5 text-sm w-full focus:border-[var(--ea-primary)]";

  return (
    <form onSubmit={submit}>
      {error.value && (
        <div
          class="border border-[var(--ea-danger-border)] text-[var(--ea-danger)] px-3 py-1.5 text-sm mb-2"
          style="background:var(--ea-danger-bg)"
        >
          {error.value}
        </div>
      )}
      {success.value && (
        <div
          class="border border-[var(--ea-border)] text-[var(--ea-primary)] px-3 py-1.5 text-sm mb-2"
          style="background:var(--ea-surface-alt)"
        >
          {success.value}
        </div>
      )}

      <div class="grid grid-cols-1 md:grid-cols-4 gap-2 mb-2">
        <label class="block">
          <span class="block text-xs text-[var(--ea-muted)] mb-0.5">
            ID (slug)
          </span>
          <input
            class={inputCls}
            placeholder="id (slug)"
            value={id.value}
            onInput={(e) => (id.value = (e.target as HTMLInputElement).value)}
          />
        </label>
        <label class="block">
          <span class="block text-xs text-[var(--ea-muted)] mb-0.5">Name</span>
          <input
            class={inputCls}
            placeholder="name"
            value={name.value}
            onInput={(e) => (name.value = (e.target as HTMLInputElement).value)}
          />
        </label>
        <label class="block">
          <span class="block text-xs text-[var(--ea-muted)] mb-0.5">
            utm_campaign value
          </span>
          <input
            class={inputCls}
            placeholder="utm_campaign value"
            value={utmCampaign.value}
            onInput={(
              e,
            ) => (utmCampaign.value = (e.target as HTMLInputElement).value)}
          />
        </label>
        <label class="block">
          <span class="block text-xs text-[var(--ea-muted)] mb-0.5">
            Site ID
          </span>
          <input
            class={inputCls}
            placeholder="site_id (default)"
            value={siteId.value}
            onInput={(
              e,
            ) => (siteId.value = (e.target as HTMLInputElement).value)}
          />
        </label>
      </div>

      <button
        type="submit"
        class="px-3 py-1.5 text-xs border border-[var(--ea-primary)] text-[var(--ea-primary)] hover:bg-[var(--ea-primary)] hover:text-[var(--ea-bg)] disabled:opacity-50"
        disabled={loading.value}
      >
        {loading.value ? "creating..." : "> create campaign"}
      </button>
    </form>
  );
}
