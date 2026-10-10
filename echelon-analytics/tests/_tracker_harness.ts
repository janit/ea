// Runs the real /ea.js output inside a minimal fake browser. No DOM library:
// only the globals the tracker touches.

import { handleTracker } from "@/lib/tracker.ts";
import { generateChallenge } from "@/lib/challenge.ts";
import { createTestDb } from "./_helpers.ts";

export interface Harness {
  win: Record<string, unknown>;
  storage: Map<string, string>;
  beacons: string[];
  fetched: string[];
  setNow(ms: number): void;
  /** Dispatch an event to its listeners; `trusted` (default true) is its isTrusted. */
  fire(type: string, trusted?: boolean): void;
  tick(): void;
  /** Fire (and drop) every pending setTimeout whose delay is <= maxMs. */
  runTimers(maxMs: number): void;
  sentEvents(): Promise<{ type: string; data?: Record<string, unknown> }[]>;
  navigate(path: string): void;
}

export async function loadTracker(opts: {
  site: string;
  challengeResponse?: () => Promise<string>;
  wasm?: boolean;
  wasmRejects?: boolean;
  /** WebAssembly.instantiate never settles: the first solve stays in flight. */
  wasmHangs?: boolean;
}): Promise<Harness> {
  const db = createTestDb();
  const resp = await handleTracker(
    new Request(`https://ea.example.com/ea.js?s=${opts.site}`, {
      headers: { host: "ea.example.com" },
    }),
    db,
  );
  const src = await resp.text();
  await db.close();

  let now = Date.now();
  const storage = new Map<string, string>();
  const beacons: string[] = [];
  const sent: Promise<string>[] = [];
  const fetched: string[] = [];
  const listeners = new Map<string, ((e: unknown) => void)[]>();
  const intervals: (() => void)[] = [];
  let timers: { id: number; fn: () => void; ms: number }[] = [];
  let timerSeq = 0;
  const add = (type: string, fn: (e: unknown) => void) => {
    listeners.set(type, [...(listeners.get(type) ?? []), fn]);
  };
  const remove = (type: string, fn: (e: unknown) => void) => {
    listeners.set(type, (listeners.get(type) ?? []).filter((f) => f !== fn));
  };

  const RealDate = Date;
  class FakeDate extends RealDate {
    static override now() {
      return now;
    }
  }

  const doc = {
    currentScript: {
      getAttribute: (n: string) => (n === "data-site" ? opts.site : null),
      hasAttribute: () => false,
    },
    visibilityState: "visible",
    hidden: false,
    referrer: "",
    body: {},
    documentElement: { scrollHeight: 1000, clientHeight: 800 },
    addEventListener: add,
    removeEventListener: remove,
    querySelector: () => null,
    createElement: () => ({}),
  };
  const win: Record<string, unknown> = {
    document: doc,
    location: { pathname: "/page", search: "", origin: "https://site.example" },
    screen: { width: 1440, height: 900 },
    navigator: {
      sendBeacon: (_url: string, body: Blob) => {
        sent.push(body.text());
        return true;
      },
    },
    history: { pushState() {}, replaceState() {} },
    sessionStorage: {
      getItem: (k: string) => storage.get(k) ?? null,
      setItem: (k: string, v: string) => void storage.set(k, v),
    },
    localStorage: { getItem: () => null, setItem() {} },
    matchMedia: () => ({ matches: false }),
    addEventListener: add,
    removeEventListener: remove,
    // Timeouts never fire on their own: a test fires them with runTimers().
    setTimeout: (fn: () => void, ms?: number) => {
      timers.push({ id: ++timerSeq, fn, ms: ms ?? 0 });
      return timerSeq;
    },
    clearTimeout: (id: number) => {
      timers = timers.filter((t) => t.id !== id);
    },
    setInterval: (fn: () => void) => {
      intervals.push(fn);
      return intervals.length;
    },
    requestAnimationFrame() {},
    Image: class {
      set src(v: string) {
        beacons.push(v);
      }
    },
    Blob,
    URL,
    URLSearchParams,
    TextEncoder,
    Uint8Array,
    Promise,
    Math,
    JSON,
    Object,
    Array,
    String,
    console,
    atob,
    btoa,
    encodeURIComponent,
    parseInt,
    crypto: { randomUUID: () => "99999999-9999-4999-8999-999999999999" },
    Date: FakeDate,
    WebAssembly: opts.wasm === false
      ? undefined
      : opts.wasmRejects
      ? { instantiate: () => Promise.reject(new Error("CSP blocked wasm")) }
      : opts.wasmHangs
      ? { instantiate: () => new Promise(() => {}) }
      : WebAssembly,
    PerformanceObserver: undefined,
    customElements: { define() {} },
    HTMLElement: class {},
    fetch: (url: string) => {
      fetched.push(url);
      const body = opts.challengeResponse ?? generateChallenge;
      return body().then((text) => ({ text: () => Promise.resolve(text) }));
    },
  };
  win.window = win;
  win.self = win;

  // Run the tracker with `win` as its global scope.
  new Function("w", `with (w) { ${src} }`)(win);

  return {
    win,
    storage,
    beacons,
    fetched,
    setNow(ms) {
      now = ms;
    },
    fire(type, trusted = true) {
      for (const fn of listeners.get(type) ?? []) fn({ isTrusted: trusted });
    },
    tick() {
      for (const fn of intervals) fn();
    },
    runTimers(maxMs) {
      const due = timers.filter((t) => t.ms <= maxMs);
      timers = timers.filter((t) => t.ms > maxMs);
      for (const t of due) t.fn();
    },
    async sentEvents() {
      const out: { type: string; data?: Record<string, unknown> }[] = [];
      for (const text of await Promise.all(sent)) {
        out.push(...JSON.parse(text).events);
      }
      return out;
    },
    navigate(path) {
      (win.location as { pathname: string }).pathname = path;
      (win.history as { pushState: (...a: unknown[]) => void }).pushState(
        {},
        "",
        path,
      );
    },
  };
}
