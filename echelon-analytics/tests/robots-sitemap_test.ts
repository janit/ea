// robots.txt and sitemap.xml — the real route handlers, private and public.
// PUBLIC_MODE is read at import time, so public mode runs in a subprocess.

import { assertEquals } from "@std/assert";
import { handler as robots } from "@/routes/robots.txt.ts";
import { handler as sitemap } from "@/routes/sitemap.xml.ts";

type Get = { GET: (ctx: { req: Request }) => Response };
const req = (path: string) =>
  new Request(`https://analytics.example.com${path}`);

async function publicModeBodies(): Promise<
  { robots: string; sitemap: string }
> {
  const code = `
    import { handler as r } from "@/routes/robots.txt.ts";
    import { handler as s } from "@/routes/sitemap.xml.ts";
    const req = (p) => ({ req: new Request("https://analytics.example.com" + p) });
    console.log(JSON.stringify({
      robots: await r.GET(req("/robots.txt")).text(),
      sitemap: await s.GET(req("/sitemap.xml")).text(),
    }));
    Deno.exit(0);`;
  const config = new URL("../deno.json", import.meta.url).pathname;
  const out = await new Deno.Command(Deno.execPath(), {
    args: ["eval", "--config", config, code],
    env: { ECHELON_PUBLIC_MODE: "true" },
    stdout: "piped",
    stderr: "piped",
  }).output();
  if (!out.success) throw new Error(new TextDecoder().decode(out.stderr));
  const lines = new TextDecoder().decode(out.stdout).trim().split("\n");
  return JSON.parse(lines[lines.length - 1]);
}

Deno.test("robots.txt — private instance disallows everything, no sitemap", async () => {
  const body = await (robots as unknown as Get).GET({ req: req("/robots.txt") })
    .text();
  assertEquals(body, "User-agent: *\nDisallow: /\n");
});

Deno.test("sitemap.xml — private instance lists no URLs", async () => {
  const body = await (sitemap as unknown as Get).GET({
    req: req("/sitemap.xml"),
  }).text();
  assertEquals(body.includes("<url>"), false);
  assertEquals(body.includes("<urlset"), true);
});

Deno.test("robots.txt + sitemap.xml — public instance allows crawling and lists pages", async () => {
  const { robots, sitemap } = await publicModeBodies();
  assertEquals(
    robots,
    "User-agent: *\nAllow: /\nSitemap: https://analytics.example.com/sitemap.xml\n",
  );
  assertEquals(
    sitemap.includes("<loc>https://analytics.example.com/admin</loc>"),
    true,
  );
  assertEquals(sitemap.includes("/admin/login"), false);
});
