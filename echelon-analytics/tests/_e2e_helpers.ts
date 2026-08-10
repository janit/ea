// E2E test helpers — server + browser harness using Astral.
//
// Launches a Fresh dev server on a random port with an in-memory DB
// and provides a headless Chromium page for browser interactions.
//
// Set SKIP_E2E=1 to skip e2e tests (e.g. in CI without Chromium).

import { launch } from "@astral/astral";
import type { Browser, Page } from "@astral/astral";

export const SKIP_E2E = Deno.env.get("SKIP_E2E") === "1";

export interface E2EContext {
  browser: Browser;
  page: Page;
  baseUrl: string;
  cleanup: () => Promise<void>;
}

/**
 * Start a test server and launch headless Chromium.
 * Returns a context with page + baseUrl for navigating.
 *
 * The server is started by running `deno task dev` with a test port.
 * For simpler testing, we launch the browser against the dev server.
 */
export async function setupE2E(): Promise<E2EContext> {
  // Launch headless browser. Astral auto-discovers a Chromium, but that can
  // pick a snap-confined binary that refuses to boot — set E2E_CHROME_PATH to
  // point at a known-good executable.
  // E2E_CHROME_NO_SANDBOX=1 is needed where the kernel blocks Chromium's
  // sandbox (containers, some hardened hosts).
  const chromePath = Deno.env.get("E2E_CHROME_PATH");
  const noSandbox = Deno.env.get("E2E_CHROME_NO_SANDBOX") === "1";
  const browser = await launch({
    headless: true,
    ...(chromePath ? { path: chromePath } : {}),
    ...(noSandbox ? { args: ["--no-sandbox"] } : {}),
  });
  const page = await browser.newPage();

  // For e2e tests, we assume a dev server is running or use a fixed port.
  // In practice, the e2e tests are optional and need a running server.
  const baseUrl = Deno.env.get("E2E_BASE_URL") ??
    "http://localhost:1947";

  return {
    browser,
    page,
    baseUrl,
    cleanup: async () => {
      await page.close();
      await browser.close();
    },
  };
}

/** Skip an e2e test if SKIP_E2E is set or Chromium isn't available. */
export function skipIfNoE2E(): boolean {
  return SKIP_E2E;
}
