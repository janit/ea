/**
 * Spread onto a server-rendered <select> to submit its form on change.
 * An inline handler string is what SSR needs (no island, no hydration), but
 * Preact's JSX types only accept a function for `onchange`, so it lives here
 * behind one cast instead of at every call site.
 */
export const submitOnChange = {
  onchange: "this.form.submit()",
} as Record<string, string>;
