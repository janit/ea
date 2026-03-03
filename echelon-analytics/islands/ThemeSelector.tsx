import { useSignal } from "@preact/signals";
import type { Theme } from "../lib/themes.ts";

export default function ThemeSelector({ themes }: { themes: Theme[] }) {
  const current = useSignal("");

  // Read initial value on mount
  if (typeof document !== "undefined" && !current.value) {
    const m = document.cookie.match(/(?:^|;\s*)echelon_theme=(\w+)/);
    current.value = m ? m[1] : themes[0]?.id ?? "default";
  }

  function onChange(e: Event) {
    const value = (e.target as HTMLSelectElement).value;
    current.value = value;
    document.cookie = `echelon_theme=${value}; Path=/; Max-Age=${
      60 * 60 * 24 * 365
    }; SameSite=Lax; Secure`;
    document.documentElement.dataset.theme = value;
  }

  return (
    <select
      class="border border-[var(--ea-nav-muted)] bg-[var(--ea-nav-bg)] text-[var(--ea-nav-text)] px-2 py-1 text-xs focus:border-[var(--ea-nav-text)] outline-none"
      onChange={onChange}
      value={current.value}
    >
      {themes.map((t) => (
        <option key={t.id} value={t.id}>
          {t.name}
        </option>
      ))}
    </select>
  );
}
