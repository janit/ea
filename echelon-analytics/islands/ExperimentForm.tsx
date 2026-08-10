import { useSignal } from "@preact/signals";

interface Variant {
  variant_id: string;
  name: string;
  weight: number;
  is_control: boolean;
}

export default function ExperimentForm(
  { readOnly }: { readOnly?: boolean },
) {
  const experimentId = useSignal("");
  const name = useSignal("");
  const description = useSignal("");
  const metricEventType = useSignal("");
  const allocationPercent = useSignal(100);
  const variants = useSignal<Variant[]>([
    { variant_id: "control", name: "Control", weight: 50, is_control: true },
    {
      variant_id: "variant-a",
      name: "Variant A",
      weight: 50,
      is_control: false,
    },
  ]);
  const error = useSignal<string | null>(null);
  const success = useSignal<string | null>(null);
  const loading = useSignal(false);

  if (readOnly) return null;

  // a..z then aa, ab, … — String.fromCharCode(97 + n) walked past 'z' into
  // '{', '|', '}' once enough variants were added.
  function letter(n: number): string {
    let out = "";
    n += 1;
    while (n > 0) {
      n -= 1;
      out = String.fromCharCode(97 + (n % 26)) + out;
      n = Math.floor(n / 26);
    }
    return out;
  }

  function addVariant() {
    // Derive from the ids actually in use, not from array length: after
    // removing a middle variant, length-based naming re-minted an id that was
    // still present, which violates PRIMARY KEY (experiment_id, variant_id).
    const used = new Set(variants.value.map((v) => v.variant_id));
    let suffix = 0;
    while (used.has(`variant-${letter(suffix)}`)) suffix++;
    variants.value = [
      ...variants.value,
      {
        variant_id: `variant-${letter(suffix)}`,
        name: `Variant ${letter(suffix).toUpperCase()}`,
        weight: 50,
        is_control: false,
      },
    ];
  }

  function removeVariant(index: number) {
    if (variants.value.length <= 2) return;
    variants.value = variants.value.filter((_, i) => i !== index);
  }

  function updateVariant(
    index: number,
    field: keyof Variant,
    value: string | number | boolean,
  ) {
    variants.value = variants.value.map((v, i) =>
      i === index ? { ...v, [field]: value } : v
    );
  }

  async function submit(e: Event) {
    e.preventDefault();
    error.value = null;
    success.value = null;

    if (!experimentId.value || !name.value || !metricEventType.value) {
      error.value = "Experiment ID, name, and metric event type are required.";
      return;
    }

    loading.value = true;
    try {
      const res = await fetch("/api/experiments", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          experiment_id: experimentId.value,
          name: name.value,
          description: description.value || undefined,
          metric_event_type: metricEventType.value,
          allocation_percent: allocationPercent.value,
          variants: variants.value,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        error.value = data.message || "Failed to create experiment.";
      } else {
        success.value = `Created experiment: ${data.created}`;
        experimentId.value = "";
        name.value = "";
        description.value = "";
      }
    } catch (err) {
      error.value = (err as Error).message;
    }
    loading.value = false;
  }

  const inputCls =
    "border border-[var(--ea-border)] bg-[var(--ea-bg)] text-[var(--ea-primary)] px-2 py-1.5 text-sm w-full focus:border-[var(--ea-primary)] outline-none";

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

      <div class="grid grid-cols-3 gap-2 mb-2">
        <input
          class={inputCls}
          placeholder="experiment_id"
          value={experimentId.value}
          onInput={(
            e,
          ) => (experimentId.value = (e.target as HTMLInputElement).value)}
        />
        <input
          class={inputCls}
          placeholder="name"
          value={name.value}
          onInput={(e) => (name.value = (e.target as HTMLInputElement).value)}
        />
        <input
          class={inputCls}
          placeholder="metric_event_type"
          value={metricEventType.value}
          onInput={(
            e,
          ) => (metricEventType.value = (e.target as HTMLInputElement).value)}
        />
      </div>

      <div class="grid grid-cols-4 gap-2 mb-2">
        <div class="col-span-3">
          <input
            class={inputCls}
            placeholder="description (optional)"
            value={description.value}
            onInput={(
              e,
            ) => (description.value = (e.target as HTMLInputElement).value)}
          />
        </div>
        <div class="flex items-center gap-1">
          <span class="text-xs text-[var(--ea-muted)] whitespace-nowrap">
            alloc %
          </span>
          <input
            type="number"
            class={inputCls}
            min={1}
            max={100}
            value={allocationPercent.value}
            onInput={(e) => (allocationPercent.value = parseInt(
              (e.target as HTMLInputElement).value,
            ))}
          />
        </div>
      </div>

      <h6 class="text-sm text-[var(--ea-primary)] mt-3 mb-1">variants</h6>
      {variants.value.map((v, i) => (
        <div key={i} class="grid grid-cols-12 gap-2 mb-1 items-center">
          <div class="col-span-3">
            <input
              class={inputCls}
              placeholder="variant_id"
              value={v.variant_id}
              onInput={(e) =>
                updateVariant(
                  i,
                  "variant_id",
                  (e.target as HTMLInputElement).value,
                )}
            />
          </div>
          <div class="col-span-3">
            <input
              class={inputCls}
              placeholder="name"
              value={v.name}
              onInput={(e) =>
                updateVariant(
                  i,
                  "name",
                  (e.target as HTMLInputElement).value,
                )}
            />
          </div>
          <div class="col-span-2">
            <input
              type="number"
              class={inputCls}
              placeholder="weight"
              value={v.weight}
              onInput={(e) =>
                updateVariant(
                  i,
                  "weight",
                  parseInt((e.target as HTMLInputElement).value),
                )}
            />
          </div>
          <div class="col-span-2">
            <label class="flex items-center gap-1 text-sm text-[var(--ea-text)]">
              <input
                type="checkbox"
                checked={v.is_control}
                onChange={(e) =>
                  updateVariant(
                    i,
                    "is_control",
                    (e.target as HTMLInputElement).checked,
                  )}
              />
              control
            </label>
          </div>
          <div class="col-span-2">
            {variants.value.length > 2 && (
              <button
                type="button"
                class="text-xs text-[var(--ea-danger)] hover:text-[var(--ea-danger)]"
                onClick={() => removeVariant(i)}
              >
                remove
              </button>
            )}
          </div>
        </div>
      ))}

      <div class="flex gap-2 mt-2">
        <button
          type="button"
          class="px-3 py-1.5 text-xs border border-[var(--ea-border)] text-[var(--ea-text)] hover:text-[var(--ea-primary)] hover:border-[var(--ea-primary)]"
          onClick={addVariant}
        >
          + add variant
        </button>
        <button
          type="submit"
          class="px-3 py-1.5 text-xs border border-[var(--ea-primary)] text-[var(--ea-primary)] hover:bg-[var(--ea-primary)] hover:text-[var(--ea-bg)] disabled:opacity-50"
          disabled={loading.value}
        >
          {loading.value ? "creating..." : "> create experiment"}
        </button>
      </div>
    </form>
  );
}
