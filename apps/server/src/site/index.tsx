/** @jsxImportSource hono/jsx */
import { Hono } from "hono";
import { sql } from "kysely";
import pkg from "../../package.json";
import { sessionMiddleware } from "../auth/session";
import type { AppEnv, Ctx } from "../context";
import { financesCsv, getPublicFinances, getPublicPricing } from "../finances/public";
import { isBot, pageViews, referrerHost } from "./analytics";
import { assets } from "./assets";
import { renderPage, type SiteCtx } from "./layout";
import { AboutPage, HowPage } from "./pages/content";
import { FinancesPage } from "./pages/finances";
import { HomePage } from "./pages/home";
import { ContactPage, DpaPage, PrivacyPage, TermsPage } from "./pages/legal";
import { PricingPage } from "./pages/pricing";
import { SelfHostPage } from "./pages/selfHost";
import { StatusPage } from "./pages/status";

/** Every server-rendered public page. Also listed in RESERVED_SLUGS so no workspace can take one. */
export const PUBLIC_PAGES = ["/", "/pricing", "/finances", "/about", "/how-its-run", "/self-host", "/terms", "/privacy", "/dpa", "/contact", "/status"] as const;

/** Paths the site owns (pages, feeds and its static files). app.ts gives these the site's CSP. */
export function isSitePath(path: string): boolean {
  return (
    (PUBLIC_PAGES as readonly string[]).includes(path) ||
    path === "/finances.csv" ||
    path === "/sitemap.xml" ||
    path === "/robots.txt" ||
    path.startsWith("/og/") ||
    path.startsWith("/site/")
  );
}

const startedAt = Date.now();
const baseUrl = (c: Ctx) => c.get("deps").config.APP_URL.replace(/\/$/, "");

/** Session lookup, cache headers and the page view count for one public page. */
async function page(c: Ctx, render: (site: SiteCtx) => unknown | Promise<unknown>) {
  let signedIn = false;
  await sessionMiddleware(c, async () => {
    signedIn = Boolean(c.get("user"));
  });
  const html = await renderPage(await render({ baseUrl: baseUrl(c), signedIn }));
  c.header("Cache-Control", signedIn ? "private, no-cache" : "public, max-age=300");
  c.header("Vary", "Cookie");
  if (c.req.method === "GET" && !isBot(c.req.header("user-agent"))) {
    pageViews.count(c.req.path, referrerHost(c.req.header("referer"), new URL(baseUrl(c)).hostname));
  }
  return c.html(html);
}

export const siteRoutes = new Hono<AppEnv>()
  .get("/", (c) =>
    page(c, async (site) => {
      const deps = c.get("deps");
      const [pricing, finances] = await Promise.all([getPublicPricing(deps), getPublicFinances(deps)]);
      return <HomePage pricing={pricing} finances={finances} site={site} />;
    }),
  )
  .get("/pricing", (c) =>
    page(c, async (site) => {
      const deps = c.get("deps");
      const [pricing, finances] = await Promise.all([getPublicPricing(deps), getPublicFinances(deps)]);
      return <PricingPage pricing={pricing} finances={finances} site={site} />;
    }),
  )
  .get("/finances", (c) => page(c, async (site) => <FinancesPage finances={await getPublicFinances(c.get("deps"))} site={site} />))
  .get("/finances.csv", async (c) => {
    const f = await getPublicFinances(c.get("deps"));
    c.header("Content-Type", "text/csv; charset=utf-8");
    c.header("Content-Disposition", 'attachment; filename="glasstrack-finances.csv"');
    c.header("Cache-Control", "public, max-age=300");
    return c.body(financesCsv(f));
  })
  .get("/about", (c) => page(c, async (site) => <AboutPage pricing={await getPublicPricing(c.get("deps"))} site={site} />))
  .get("/how-its-run", (c) => page(c, (site) => <HowPage site={site} />))
  .get("/self-host", (c) => page(c, (site) => <SelfHostPage site={site} />))
  .get("/terms", (c) => page(c, (site) => <TermsPage site={site} />))
  .get("/privacy", (c) => page(c, (site) => <PrivacyPage site={site} />))
  .get("/dpa", (c) => page(c, (site) => <DpaPage site={site} />))
  .get("/contact", (c) => page(c, (site) => <ContactPage site={site} />))
  .get("/status", async (c) => {
    const deps = c.get("deps");
    let databaseOk = false;
    try {
      await sql`SELECT 1`.execute(deps.dbs.system);
      databaseOk = true;
    } catch {
      databaseOk = false;
    }
    const status = {
      databaseOk,
      version: pkg.version,
      commit: deps.config.GIT_COMMIT,
      uptimeSeconds: Math.floor((Date.now() - startedAt) / 1000),
      checkedAt: new Date().toISOString(),
      statusPageUrl: deps.config.STATUS_PAGE_URL,
    };
    const res = await page(c, (site) => <StatusPage status={status} site={site} />);
    res.headers.set("Cache-Control", "no-store");
    if (!databaseOk) return new Response(res.body, { status: 503, headers: res.headers });
    return res;
  })
  .get("/sitemap.xml", (c) => {
    const base = baseUrl(c);
    const urls = PUBLIC_PAGES.map((p) => `  <url><loc>${base}${p}</loc></url>`).join("\n");
    c.header("Content-Type", "application/xml; charset=utf-8");
    c.header("Cache-Control", "public, max-age=3600");
    return c.body(`<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}\n</urlset>\n`);
  })
  .get("/robots.txt", (c) => {
    c.header("Cache-Control", "public, max-age=3600");
    return c.text(`User-agent: *\nAllow: /\nDisallow: /api/\nDisallow: /app\nDisallow: /login\n\nSitemap: ${baseUrl(c)}/sitemap.xml\n`);
  })
  .get("/og/:file", (c) => {
    const a = assets().get(`og/${c.req.param("file")}`);
    if (!a || !c.req.param("file").endsWith(".png")) return c.notFound();
    c.header("Content-Type", a.type);
    c.header("Cache-Control", "public, max-age=86400");
    return c.body(a.body);
  })
  .get("/site/*", (c) => {
    const path = c.req.path.slice("/site/".length);
    const a = assets().get(path);
    if (!a) return c.notFound();
    c.header("Content-Type", a.type);
    c.header("Cache-Control", c.req.query("v") === a.hash ? "public, max-age=31536000, immutable" : "public, max-age=3600");
    c.header("X-Content-Type-Options", "nosniff");
    return c.body(a.body);
  });
