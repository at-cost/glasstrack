import { createWorkspaceSchema, estimateEmails, monthlyCost } from "@glasstrack/shared";
import { sql } from "kysely";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { examplePricing } from "../src/finances/public";
import { isBot, PageViewCounter, pageViews, referrerHost } from "../src/site/analytics";
import { centsSplit } from "../src/site/fmt";
import { PUBLIC_PAGES } from "../src/site";
import { THEME_BOOT_HASH } from "../src/site/layout";
import { Client, createHarness, type Harness } from "./harness";

let h: Harness;
const BROWSER = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0 Safari/537.36";

beforeAll(async () => {
  h = await createHarness();
});
beforeEach(async () => {
  await h.reset();
  await sql`TRUNCATE page_views`.execute(h.deps.dbs.owner);
});
afterAll(async () => {
  await h?.close();
});

describe("public site", () => {
  it("renders every public page server-side with its own title, description, canonical and OG image", async () => {
    const titles = new Set<string>();
    for (const path of PUBLIC_PAGES) {
      const res = await h.app.request(path, { headers: { "user-agent": BROWSER } });
      expect(res.status, path).toBe(200);
      const html = await res.text();
      expect(html.startsWith("<!doctype html>")).toBe(true);
      const title = /<title>([^<]+)<\/title>/.exec(html)?.[1];
      expect(title, path).toBeTruthy();
      titles.add(title!);
      expect(html).toMatch(/<meta name="description" content="[^"]{30,}"/);
      expect(html).toContain(`<link rel="canonical" href="http://localhost:3999${path}"/>`);
      expect(html).toMatch(/<meta property="og:image" content="http:\/\/localhost:3999\/og\/[a-z-]+\.png"\/>/);
      expect(html).toContain('name="twitter:card"');
      expect(html).not.toContain(String.fromCharCode(0x2014)); // house style: no em dashes
      expect(res.headers.get("cache-control")).toBe(path === "/status" ? "no-store" : "public, max-age=300");
    }
    expect(titles.size).toBe(PUBLIC_PAGES.length);
  });

  it("home shows the computed estimate, example labels and the right buttons", async () => {
    const html = await (await h.app.request("/")).text();
    expect(html).toContain("Software should be pay-as-you-go, at cost.");
    const p = examplePricing();
    const typical = monthlyCost({ settings: p.settings, sharedFixedMonthMicro: p.sharedFixedMonthMicro, activeWorkspaces: p.activeWorkspaces, storageGb: 5, emailsPerMonth: estimateEmails(20) });
    expect(html).toContain(`most teams pay about <span class="num" data-typical="true">$${Math.round(typical.totalMicro / 1e6)}</span>`);
    expect(html).toContain("Example");
    expect(html).toContain("Real figures appear here once costs are recorded.");
    expect(html).toContain("Sign in");
    expect(html).toContain("Start free ($10 credit)");
    expect(html).not.toContain("Open app");

    const c = await new Client(h).login("site@example.com");
    const res = await h.app.request("/", { headers: { cookie: c.cookie } });
    const signedIn = await res.text();
    expect(signedIn).toContain('href="/app"');
    expect(signedIn).toContain("Open app");
    expect(signedIn).not.toContain(">Sign in<");
    expect(res.headers.get("cache-control")).toContain("private");
  });

  it("pricing renders a correct default result without JavaScript", async () => {
    const html = await (await h.app.request("/pricing")).text();
    expect(html).toContain('data-out="total">$6.38</p>');
    expect(html).toContain("47 days");
    expect(html).toContain("linear.app/pricing");
    expect(html).toContain("paid by AWS credits");
    expect(html).toContain("Show the maths");
  });

  it("serves the finances CSV, sitemap, robots and OG images", async () => {
    const csv = await h.app.request("/finances.csv");
    expect(csv.headers.get("content-type")).toContain("text/csv");
    expect((await csv.text()).split("\n")[0]).toContain("month,revenue_usd");
    const sitemap = await (await h.app.request("/sitemap.xml")).text();
    for (const p of PUBLIC_PAGES) expect(sitemap).toContain(`<loc>http://localhost:3999${p}</loc>`);
    expect(await (await h.app.request("/robots.txt")).text()).toContain("Sitemap: http://localhost:3999/sitemap.xml");
    const og = await h.app.request("/og/home.png");
    expect(og.status).toBe(200);
    expect(og.headers.get("content-type")).toBe("image/png");
    expect((await h.app.request("/og/nope.png")).status).toBe(404);
  });

  it("allows only its own inline theme script by hash", async () => {
    const res = await h.app.request("/about");
    expect(res.headers.get("content-security-policy")).toContain(THEME_BOOT_HASH);
    const api = await h.app.request("/api/v1/auth/providers");
    expect(api.headers.get("content-security-policy")).not.toContain("sha256-");
  });

  it("compares with Jira (free up to 10 users) and shows live figures on /about", async () => {
    const { competitorMonthly, COMPETITORS } = await import("../src/site/competitors");
    const jira = COMPETITORS.find((c) => c.vendor === "Jira")!;
    expect(competitorMonthly(jira, 10)).toBe(0);
    expect(competitorMonthly(jira, 20)).toBeCloseTo(169.6, 6);
    const pricing = await (await h.app.request("/pricing")).text();
    expect(pricing).toContain("Jira Standard");
    expect(pricing).toMatch(/data-competitor="Jira">\s*\$170/);
    const about = await (await h.app.request("/about")).text();
    // Example pricing ($60 of servers, 1 workspace): 20 people about $6.40, 200 people about $8.50.
    expect(about).toContain("about $6.40 a month and a 200-person team about $8.50, where Linear would charge $200 and $2,000");
  });

  it("status reports the database and process", async () => {
    const html = await (await h.app.request("/status")).text();
    expect(html).toContain("Everything is working");
    expect(html).toContain("Reachable");
  });

  it("reserves every public path as a workspace slug", () => {
    for (const p of PUBLIC_PAGES) {
      const slug = p.slice(1);
      if (slug.length < 3) continue;
      expect(createWorkspaceSchema.safeParse({ name: "X", slug }).success, slug).toBe(false);
    }
  });
});

describe("sign-in lands in the app", () => {
  it("magic links without a destination, or to /, go to /app", async () => {
    for (const redirectTo of [undefined, "/"]) {
      const c = new Client(h);
      await c.post("/api/v1/auth/magic-link", { email: "land@example.com", redirectTo });
      const token = /token=([\w-]+)/.exec(h.mailer.last("land@example.com")!.text)![1]!;
      expect((await c.post("/api/v1/auth/magic-link/verify", { token })).body.redirectTo).toBe("/app");
    }
  });

  it("OAuth remembers /app as the destination", async () => {
    const h2 = await createHarness({ GITHUB_CLIENT_ID: "id", GITHUB_CLIENT_SECRET: "secret" });
    try {
      const res = await h2.app.request("/api/v1/auth/oauth/github");
      expect(res.status).toBe(302);
      const cookies = res.headers.getSetCookie().join("\n");
      expect(cookies).toContain(`oauth_redirect=${encodeURIComponent("/app")}`);
      const res2 = await h2.app.request("/api/v1/auth/oauth/github?redirectTo=/");
      expect(res2.headers.getSetCookie().join("\n")).toContain(`oauth_redirect=${encodeURIComponent("/app")}`);
    } finally {
      await h2.close();
    }
  });
});

describe("page view counter", () => {
  it("drops bots and keeps only the referring host", () => {
    expect(isBot(undefined)).toBe(true);
    expect(isBot("Googlebot/2.1")).toBe(true);
    expect(isBot(BROWSER)).toBe(false);
    expect(referrerHost("https://news.ycombinator.com/item?id=1&x=y", "glasstrack.dev")).toBe("news.ycombinator.com");
    expect(referrerHost("https://www.glasstrack.dev/pricing", "glasstrack.dev")).toBe("");
    expect(referrerHost("android-app://com.slack", "glasstrack.dev")).toBe("");
    expect(referrerHost("not a url", "glasstrack.dev")).toBe("");
  });

  it("counts public page views in memory and flushes them to page_views", async () => {
    await pageViews.flush(h.deps.dbs.system);
    await sql`TRUNCATE page_views`.execute(h.deps.dbs.owner);
    await h.app.request("/pricing", { headers: { "user-agent": BROWSER, referer: "https://example.org/a/b?c=d" } });
    await h.app.request("/pricing", { headers: { "user-agent": BROWSER, referer: "https://example.org/other" } });
    await h.app.request("/pricing", { headers: { "user-agent": "Googlebot/2.1" } });
    await h.app.request("/api/v1/auth/providers", { headers: { "user-agent": BROWSER } });
    await pageViews.flush(h.deps.dbs.system);
    const rows = await sql<{ path: string; ref: string; views: number }>`SELECT path, referrer_host AS ref, views FROM page_views`.execute(h.deps.dbs.owner);
    expect(rows.rows).toEqual([{ path: "/pricing", ref: "example.org", views: 2 }]);

    const c = new PageViewCounter();
    c.count("/", "", "2026-10-16");
    c.count("/", "", "2026-10-16");
    await c.stop(h.deps.dbs.system);
    const home = await sql<{ views: number }>`SELECT views FROM page_views WHERE path = '/'`.execute(h.deps.dbs.owner);
    expect(home.rows[0]?.views).toBe(2);
  });
});

describe("cents split", () => {
  it("rounded lines always add up to the rounded total", () => {
    const s = examplePricing().settings;
    for (const [team, gb, emails] of [[1, 0, 100], [20, 5, 2000], [37, 13, 3700], [500, 200, 50000], [3, 199, 7]] as const) {
      const b = monthlyCost({ settings: s, sharedFixedMonthMicro: 60e6, activeWorkspaces: 1, storageGb: gb, emailsPerMonth: emails });
      const parts = centsSplit([b.serverShareMicro, b.storageMicro, b.emailMicro, b.feesAndReserveMicro], b.totalMicro);
      expect(parts.reduce((a, x) => a + x, 0), `${team}`).toBe(Math.round(b.totalMicro / 10_000) * 10_000);
    }
  });
});
