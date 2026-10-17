import { readFileSync } from "node:fs";
import { expect, type Page, test } from "@playwright/test";
import { E2E } from "../playwright.config";

/** Public pages, a phrase each must contain in the raw server HTML, and its OG image. */
const PAGES: [string, string, string][] = [
  ["/", "Software should be pay-as-you-go, at cost.", "home"],
  ["/pricing", "What would my team pay?", "pricing"],
  ["/finances", "Covered by the founder", "finances"],
  ["/about", "Glasstrack is my attempt at that.", "about"],
  ["/how-its-run", "Merge small changes once every test passes", "how-its-run"],
  ["/self-host", "docker compose up -d", "self-host"],
  ["/terms", "minus the payment processing fees", "legal"],
  ["/privacy", "does not store IP addresses", "legal"],
  ["/dpa", "Article 28 of the UK GDPR", "legal"],
  ["/contact", "transparent-ai-businesses@proton.me", "contact"],
  ["/status", "Database", "status"],
];

const usd = (s: string | null) => Number((s ?? "").replace(/[^0-9.]/g, ""));

function lastMailTo(email: string): { text: string } {
  const lines = readFileSync(E2E.mailFile, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  const mail = lines.reverse().find((m) => m.to === email);
  if (!mail) throw new Error(`no email to ${email}`);
  return mail;
}

async function emailSignIn(page: Page, email: string) {
  await page.getByLabel(/email/i).fill(email);
  await page.getByRole("button", { name: /sign-in link|sign-up link/i }).click();
  await expect(page.getByText(/check your email/i)).toBeVisible();
  const link = /(http\S+\/auth\/verify\?token=[\w-]+)/.exec(lastMailTo(email).text)![1]!;
  await page.goto(link);
}

test("every public page is rendered on the server with its metadata", async ({ request }) => {
  for (const [path, phrase, og] of PAGES) {
    const res = await request.get(path);
    expect(res.status(), path).toBe(200);
    const html = await res.text();
    expect(html, path).toContain(phrase);
    expect(html).toMatch(/<title>[^<]{5,}<\/title>/);
    expect(html).toMatch(/<meta name="description" content="[^"]{30,}"\/>/);
    expect(html).toContain(`<link rel="canonical" href="${E2E.url}${path}"/>`);
    expect(html).toContain(`<meta property="og:image" content="${E2E.url}/og/${og}.png"/>`);
    expect((await request.get(`/og/${og}.png`)).status()).toBe(200);
  }
});

test("pricing calculator matches the pricing module", async ({ page }) => {
  await page.goto("/pricing");
  const total = page.locator('[data-out="total"]');
  const lines = ["server", "storageCost", "email", "fees"].map((k) => page.locator(`[data-out="${k}"]`));
  const sumsToTotal = async () => {
    const parts = await Promise.all(lines.map(async (l) => usd(await l.textContent())));
    const t = usd(await total.textContent());
    expect(Math.round(parts.reduce((a, b) => a + b, 0) * 100)).toBe(Math.round(t * 100));
    expect(usd(await page.locator('[data-out="total2"]').textContent())).toBe(t);
    return t;
  };

  // Example inputs: $60 shared costs, 1 active workspace. 20 people, 5 GB, 2,000 emails.
  await expect(total).toHaveText("$6.38");
  await expect(page.locator("#c-emails")).toHaveValue("2000");
  await expect(page.locator('[data-out="lasts"]')).toHaveText("47 days");
  await sumsToTotal();

  await page.locator("#c-storage").fill("200");
  await expect(total).toHaveText("$11.76");
  await sumsToTotal();

  for (const [team, gb] of [["1", "0"], ["37", "13"], ["500", "200"], ["120", "77"]]) {
    await page.locator("#c-team").fill(team!);
    await page.locator("#c-storage").fill(gb!);
    await expect(page.locator("#c-emails")).toHaveValue(String(Number(team) * 100));
    await sumsToTotal();
  }

  // Editing emails detaches them from the team slider until reset.
  await page.locator("#c-team").fill("20");
  await page.locator("#c-storage").fill("5");
  await page.locator("#c-emails").fill("10000");
  await page.locator("#c-team").fill("40");
  await expect(page.locator("#c-emails")).toHaveValue("10000");
  await page.getByRole("button", { name: "Match team size" }).click();
  await expect(page.locator("#c-emails")).toHaveValue("4000");
  await sumsToTotal();

  // Comparison follows the team size.
  await expect(page.locator('#compare [data-competitor="Linear"]')).toHaveText("$400");

  // What if: 100 teams share $60 of fixed costs.
  await expect(page.locator('[data-out="share"]')).toHaveText("$0.60");
  await page.locator("#w-teams").fill("10");
  await expect(page.locator('[data-out="share"]')).toHaveText("$5.00");
});

test("home: signed out shows Sign in and Start free, signed in shows Open app", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("link", { name: "Sign in" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Start free ($10 credit)" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Open app" })).toHaveCount(0);
  // Mini calculator
  await page.locator("#mc-team").fill("50");
  await expect(page.locator('[data-mini-calc] [data-competitor="Linear"]')).toHaveText("$500/mo");

  await page.getByRole("link", { name: "Start free ($10 credit)" }).click();
  await expect(page).toHaveURL(/\/login\?signup=1/);
  await expect(page.getByRole("heading", { name: "Create your account" })).toBeVisible();

  const res = await page.request.post("/api/v1/auth/test-login", { data: { email: `home-${Date.now()}@example.com`, name: "Home" } });
  expect(res.ok()).toBe(true);
  await page.goto("/");
  await expect(page.getByRole("link", { name: "Open app" }).first()).toBeVisible();
  await expect(page.getByRole("link", { name: "Sign in" })).toHaveCount(0);
  await page.getByRole("link", { name: "Open app" }).first().click();
  // A new user has no workspace yet, so /app sends them to create one.
  await expect(page).toHaveURL(/\/new$/);
  await expect(page.getByLabel("Workspace name")).toBeVisible();
});

test("/app sends signed-out visitors to sign in", async ({ page }) => {
  await page.goto("/app");
  await expect(page).toHaveURL(/\/login/);
  await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();
});

test("magic link sign-in lands in the app, and invites land in the workspace", async ({ page, browser }) => {
  const owner = `owner-${Date.now()}@example.com`;
  await page.goto("/login");
  await emailSignIn(page, owner);
  await expect(page).toHaveURL(/\/new$/);
  await page.getByLabel("Workspace name").fill("Site Test");
  await page.getByLabel("URL").fill(`site-${Date.now() % 100000}`);
  await page.getByRole("button", { name: "Create workspace" }).click();
  await expect(page).toHaveURL(/\/my-issues$/);
  const slug = new URL(page.url()).pathname.split("/")[1]!;

  const invite = await page.request.post(`/api/v1/w/${slug}/invites`, { data: { role: "member" }, headers: { origin: E2E.url } });
  expect(invite.ok()).toBe(true);
  const inviteUrl = (await invite.json()).url as string;

  const ctx = await browser.newContext();
  const guest = await ctx.newPage();
  await guest.goto(new URL(inviteUrl).pathname);
  await expect(guest).toHaveURL(/\/login\?redirect=/);
  await emailSignIn(guest, `guest-${Date.now()}@example.com`);
  await expect(guest.getByRole("button", { name: "Accept invite" })).toBeVisible();
  await guest.getByRole("button", { name: "Accept invite" }).click();
  await expect(guest).toHaveURL(new RegExp(`/${slug}/my-issues$`));
  await ctx.close();

  // Signed in, the public home shows Open app, which opens the last workspace.
  await page.goto("/");
  await page.getByRole("link", { name: "Open app" }).first().click();
  await expect(page).toHaveURL(new RegExp(`/${slug}/my-issues$`));
});
