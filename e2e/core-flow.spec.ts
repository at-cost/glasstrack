import { readFileSync } from "node:fs";
import { expect, type Page, test } from "@playwright/test";
import { E2E } from "../playwright.config";

function lastMailTo(email: string): { subject: string; text: string } {
  const lines = readFileSync(E2E.mailFile, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  const mail = lines.reverse().find((m) => m.to === email);
  if (!mail) throw new Error(`no email to ${email}`);
  return mail;
}

async function signUp(page: Page, email: string) {
  await page.goto("/login");
  await page.getByLabel(/email/i).fill(email);
  await page.getByRole("button", { name: /sign-in link|continue|send/i }).click();
  await expect(page.getByText(/check your email/i)).toBeVisible();
  const link = /(http\S+\/auth\/verify\?token=[\w-]+)/.exec(lastMailTo(email).text)![1]!;
  await page.goto(link);
}

/** Pointer drag with intermediate moves so dnd-kit's activation constraint triggers. */
async function drag(page: Page, from: ReturnType<Page["locator"]>, to: ReturnType<Page["locator"]>) {
  const a = (await from.boundingBox())!;
  const b = (await to.boundingBox())!;
  await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2);
  await page.mouse.down();
  for (let i = 1; i <= 12; i++) {
    await page.mouse.move(a.x + a.width / 2 + ((b.x + b.width / 2 - a.x - a.width / 2) * i) / 12, a.y + a.height / 2 + ((b.y + 40 - a.y - a.height / 2) * i) / 12);
    await page.waitForTimeout(30);
  }
  await page.mouse.up();
}

test("sign up, create an issue, drag it on the board, comment, export", async ({ page }) => {
  const email = `e2e-${Date.now()}@example.com`;
  await signUp(page, email);

  // Onboarding: create a workspace
  await page.getByLabel("Workspace name").fill("Acme");
  await page.getByLabel("URL").fill("acme");
  await page.getByRole("button", { name: "Create workspace" }).click();

  // Create an issue
  await page.getByTestId("new-issue-button").click();
  await page.getByLabel("Issue title").fill("Ship the first release");
  await page.getByRole("button", { name: "Create issue" }).click();

  // Board: drag from its column to Todo
  await page.getByRole("link", { name: "Board" }).first().click();
  const card = page.getByTestId("issue-card-ACME-1");
  await expect(card).toBeVisible();
  const todo = page.getByTestId("board-column-Todo");
  await drag(page, card, todo);
  await expect(todo.getByTestId("issue-card-ACME-1")).toBeVisible();
  // Persisted on the server
  await page.reload();
  await expect(page.getByTestId("board-column-Todo").getByTestId("issue-card-ACME-1")).toBeVisible();

  // Comment on the issue
  await page.goto("/acme/issue/ACME-1");
  await page.getByLabel("Write a comment").fill("Looks good, shipping today.");
  await page.getByRole("button", { name: "Comment", exact: true }).click();
  await expect(page.getByTestId("comment").filter({ hasText: "Looks good, shipping today." })).toBeVisible();
  await page.reload();
  await expect(page.getByTestId("comment").filter({ hasText: "Looks good, shipping today." })).toBeVisible();

  // Export the workspace
  await page.goto("/acme/settings");
  await page.getByRole("tab", { name: /data/i }).or(page.getByRole("link", { name: /data/i })).first().click();
  await page.getByRole("button", { name: "Export workspace" }).click();
  const download = page.getByRole("link", { name: "Download export" });
  await expect(download).toBeVisible({ timeout: 30_000 });
  const res = await page.request.get((await download.getAttribute("href"))!);
  expect(res.status()).toBe(200);
  expect((await res.body()).subarray(0, 2)).toEqual(Buffer.from([0x1f, 0x8b])); // gzip magic
});
