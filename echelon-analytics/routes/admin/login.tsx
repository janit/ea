import { page } from "fresh";
import { define } from "../../utils.ts";
import {
  AUTH_PASSWORD_HASH,
  AUTH_USERNAME,
  constantTimeEquals,
  VERSION,
} from "../../lib/config.ts";
import { DEFAULT_THEME } from "../../lib/themes.ts";
import { verifyPassword } from "../../lib/auth.ts";
import { createSession } from "../../lib/session.ts";
import { getClientIp } from "../../lib/ip.ts";

// --- Login rate limiting ---
const RATE_LIMIT_WINDOW_MS = 15 * 60 * 1000; // 15 minutes
const RATE_LIMIT_MAX_ATTEMPTS = 5;
const MAX_LOGIN_MAP_SIZE = 50_000;

interface RateLimitEntry {
  attempts: number;
  firstAttempt: number;
}

const loginAttempts = new Map<string, RateLimitEntry>();

/** Prune expired entries from the login attempts map. */
function pruneLoginAttempts(): void {
  const now = Date.now();
  for (const [ip, entry] of loginAttempts) {
    if (now - entry.firstAttempt > RATE_LIMIT_WINDOW_MS) {
      loginAttempts.delete(ip);
    }
  }
}

// GC stale rate limit entries every 5 minutes
setInterval(pruneLoginAttempts, 5 * 60 * 1000);

function isRateLimited(ip: string): boolean {
  const entry = loginAttempts.get(ip);
  if (!entry) return false;
  if (Date.now() - entry.firstAttempt > RATE_LIMIT_WINDOW_MS) {
    loginAttempts.delete(ip);
    return false;
  }
  return entry.attempts >= RATE_LIMIT_MAX_ATTEMPTS;
}

function recordFailedAttempt(ip: string): void {
  // Prevent unbounded map growth from distributed attacks
  if (loginAttempts.size >= MAX_LOGIN_MAP_SIZE) {
    pruneLoginAttempts();
    if (loginAttempts.size >= MAX_LOGIN_MAP_SIZE) {
      const oldest = loginAttempts.keys().next().value;
      if (oldest !== undefined) loginAttempts.delete(oldest);
    }
  }
  const now = Date.now();
  const entry = loginAttempts.get(ip);
  if (!entry || now - entry.firstAttempt > RATE_LIMIT_WINDOW_MS) {
    loginAttempts.set(ip, { attempts: 1, firstAttempt: now });
  } else {
    entry.attempts++;
  }
}

export const handler = define.handlers({
  GET(_ctx) {
    _ctx.state.pageData = {
      error: false,
      rateLimited: false,
      version: VERSION,
    };
    return page();
  },

  async POST(ctx) {
    const ip = getClientIp(ctx.req);

    // Check rate limit before processing
    if (isRateLimited(ip)) {
      ctx.state.pageData = {
        error: false,
        rateLimited: true,
        version: VERSION,
      };
      return page();
    }

    const form = await ctx.req.formData();
    const username = (form.get("username") as string) ?? "";
    const password = (form.get("password") as string) ?? "";

    const usernameOk = constantTimeEquals(username, AUTH_USERNAME);
    const passwordOk = await verifyPassword(password, AUTH_PASSWORD_HASH);
    if (usernameOk && passwordOk) {
      const { token } = createSession(username);
      const headers = new Headers({ location: "/admin" });
      // Path=/ is required: session cookie must cover both /admin and /api paths
      // (islands fetch API endpoints under /api using the session cookie)
      headers.append(
        "set-cookie",
        `echelon_session=${token}; Path=/; HttpOnly; SameSite=Strict; Secure; Max-Age=86400`,
      );
      return new Response(null, { status: 303, headers });
    }

    // Record failed attempt for rate limiting
    recordFailedAttempt(ip);

    ctx.state.pageData = { error: true, rateLimited: false, version: VERSION };
    return page();
  },
});

export default define.page<typeof handler>(function LoginPage({ state }) {
  const data = state.pageData as {
    error: boolean;
    rateLimited: boolean;
    version: string;
  };
  return (
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>Login — Echelon Analytics</title>
        <meta name="robots" content="noindex, nofollow" />
        <link rel="icon" href="/favicon.ico" />
        <link rel="stylesheet" href="/styles.css" />
        {/* SECURITY: Only interpolates DEFAULT_THEME (compile-time constant). No user data. */}
        <script
          dangerouslySetInnerHTML={{
            __html:
              `document.documentElement.dataset.theme=(document.cookie.match(/(?:^|;\\s*)echelon_theme=(\\w+)/)||[])[1]||"${DEFAULT_THEME}"`,
          }}
        />
      </head>
      <body class="flex items-center justify-center min-h-screen">
        <div
          class="w-full max-w-sm p-6 border border-[var(--ea-border)] border-t-[3px] border-t-[var(--ea-accent)]"
          style="background:var(--ea-surface)"
        >
          <div class="flex justify-center mb-4">
            <img
              src="/img/mmm.webp"
              alt="Mette-Maya-Marit: Echelon Analytics Seal of Approval (project mascot)"
              width="200"
              height="200"
              class="opacity-80"
            />
          </div>
          <h1 class="text-lg font-semibold text-[var(--ea-primary)] mb-4 text-center">
            <a
              href="https://ea.js.org/"
              target="_blank"
              rel="noopener"
              class="hover:underline"
            >
              Echelon Analytics
            </a>
          </h1>
          {data.rateLimited && (
            <p
              class="text-sm text-[var(--ea-danger)] mb-3 border border-[var(--ea-danger-border)] px-3 py-1.5"
              style="background:var(--ea-danger-bg)"
            >
              RATE LIMITED — Too many failed attempts. Try again later.
            </p>
          )}
          {data.error && (
            <p
              class="text-sm text-[var(--ea-danger)] mb-3 border border-[var(--ea-danger-border)] px-3 py-1.5"
              style="background:var(--ea-danger-bg)"
            >
              ACCESS DENIED — Invalid credentials.
            </p>
          )}
          <form method="POST">
            <label class="block text-sm text-[var(--ea-text)] mb-1">
              username
            </label>
            <input
              type="text"
              name="username"
              required
              class="w-full border border-[var(--ea-border)] px-3 py-2 text-sm mb-3 bg-[var(--ea-bg)] text-[var(--ea-primary)] focus:outline-none focus:border-[var(--ea-primary)]"
            />
            <label class="block text-sm text-[var(--ea-text)] mb-1">
              password
            </label>
            <input
              type="password"
              name="password"
              required
              class="w-full border border-[var(--ea-border)] px-3 py-2 text-sm mb-4 bg-[var(--ea-bg)] text-[var(--ea-primary)] focus:outline-none focus:border-[var(--ea-primary)]"
            />
            <button
              type="submit"
              class="w-full border border-[var(--ea-primary)] text-[var(--ea-primary)] px-4 py-2 text-sm hover:bg-[var(--ea-primary)] hover:text-[var(--ea-bg)]"
            >
              &gt; authenticate
            </button>
          </form>
          <div class="mt-4 text-xs text-[var(--ea-muted)] text-center">
            <div class="text-sm">🛢️ "Data er den nye oljen!" -🦭</div>
            <hr class="my-2 border-[var(--ea-border)]" />
            <div>
              <a
                href="https://ea.js.org/"
                target="_blank"
                rel="noopener"
                class="hover:text-[var(--ea-primary)]"
              >
                Echelon Analytics 🩺
              </a>{" "}
              {data.version}
            </div>
          </div>
        </div>
      </body>
    </html>
  );
});
