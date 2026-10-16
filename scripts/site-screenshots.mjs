// Real product screenshots and Open Graph images for the public website.
//
//   pnpm build && pnpm site:screenshots
//
// Boots the production build on its own port against a fresh database
// (glasstrack_shots), seeds a demo workspace through the real API with the
// test-only sign-in, captures the app in light and dark with Playwright, converts
// the captures to WebP in the browser (no image libraries), and renders one
// 1200x630 OG image per page from an HTML template. Output is committed:
//   apps/server/src/site/public/shots/<name>-<light|dark>-<1280|960|640>.webp
//   apps/server/src/site/public/og/<page>.png
// Then run `pnpm --filter @glasstrack/server build:site` (or `pnpm build`) to serve them.
import { spawn } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { chromium, request } from "@playwright/test";
import pg from "pg";

const ROOT = new URL("..", import.meta.url).pathname;
const PORT = Number(process.env.SHOTS_PORT ?? 3460);
const BASE = `http://localhost:${PORT}`;
const DB = process.env.SHOTS_DATABASE_URL ?? "postgres://localhost:5432/glasstrack_shots";
const OUT = join(ROOT, "apps/server/src/site/public");
const W = 1280;
const H = 800;

async function freshDatabase() {
  const url = new URL(DB);
  const name = url.pathname.slice(1);
  const admin = new URL(DB);
  admin.pathname = "/postgres";
  const c = new pg.Client({ connectionString: admin.toString() });
  await c.connect();
  await c.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
  await c.query(`CREATE DATABASE ${name}`);
  await c.end();
}

function startServer() {
  const files = join(ROOT, "test-results/shots-files");
  rmSync(files, { recursive: true, force: true });
  const proc = spawn(process.execPath, ["apps/server/dist/index.js"], {
    cwd: ROOT,
    stdio: ["ignore", "inherit", "inherit"],
    env: {
      ...process.env,
      NODE_ENV: "test",
      PORT: String(PORT),
      APP_URL: BASE,
      APP_SECRET: "shots-secret-shots-secret-shots-secret-0123",
      DATABASE_URL: DB,
      DB_APP_PASSWORD: "shots-app-password",
      DB_SYSTEM_PASSWORD: "shots-system-password",
      WEB_DIST_DIR: "apps/web/dist",
      STORAGE_LOCAL_DIR: files,
      E2E_TEST_LOGIN: "true",
      BILLING_ENABLED: "false",
      LOG_LEVEL: "warn",
    },
  });
  return proc;
}

async function waitReady() {
  for (let i = 0; i < 120; i++) {
    try {
      const r = await fetch(`${BASE}/ready`);
      if (r.ok) return;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error("server did not become ready");
}

async function apiAs(email, name) {
  const ctx = await request.newContext({ baseURL: BASE, extraHTTPHeaders: { origin: BASE } });
  const r = await ctx.post("/api/v1/auth/test-login", { data: { email, name } });
  if (!r.ok()) throw new Error(`test-login failed: ${r.status()}`);
  const call = async (method, path, body) => {
    const res = await ctx.fetch(`/api/v1${path}`, { method, data: body });
    const json = await res.json().catch(() => null);
    if (res.status() >= 300) throw new Error(`${method} ${path}: ${res.status()} ${JSON.stringify(json)}`);
    return json;
  };
  return { ctx, call };
}

/** A plausible, clearly fictional product team. No real customers or people. */
async function seed() {
  const admin = await apiAs("alex@acme.example", "Alex Morgan");
  const api = admin.call;
  await api("POST", "/workspaces", { name: "Acme", slug: "acme" });
  const w = (p) => `/w/acme${p}`;
  const [team] = await api("GET", w("/teams"));
  await api("PATCH", w(`/teams/${team.id}`), { name: "Engineering", key: "ENG" });
  const design = await api("POST", w("/teams"), { name: "Design", key: "DES" });
  const people = [];
  for (const [addr, name] of [
    ["sam@acme.example", "Sam Rivera"],
    ["priya@acme.example", "Priya Shah"],
    ["leo@acme.example", "Leo Novak"],
    ["mia@acme.example", "Mia Chen"],
  ]) {
    const invite = await api("POST", w("/invites"), { role: "member" });
    const p = await apiAs(addr, name);
    await p.call("POST", `/invites/${invite.url.split("/").pop()}/accept`);
    people.push({ id: (await p.call("GET", "/me")).id, api: p.call });
  }
  const me = (await api("GET", "/me")).id;
  const states = await api("GET", w("/states"));
  const st = (teamId, name) => states.find((s) => s.teamId === teamId && s.name === name).id;
  const labels = {};
  for (const [name, color] of [
    ["bug", "#c0392b"],
    ["feature", "#2f5d50"],
    ["performance", "#b7791f"],
    ["docs", "#4a6fa5"],
    ["mobile", "#7b5ea7"],
  ]) {
    labels[name] = (await api("POST", w("/labels"), { name, color })).id;
  }
  const day = (d) => new Date(Date.now() + d * 86400_000).toISOString().slice(0, 10);
  const cycle = await api("POST", w(`/teams/${team.id}/cycles`), { name: "Search and speed", startsOn: day(-6), endsOn: day(7) });
  await api("POST", w(`/teams/${team.id}/cycles`), { name: "Mobile polish", startsOn: day(8), endsOn: day(21) });

  const items = [
    ["Sign-in link expires too quickly on slow email providers", "Done", 2, ["bug"]],
    ["Shortcut to assign the selected issue to me", "In Progress", 3, ["feature"]],
    ["Board drag feels slow with 300+ cards", "In Review", 2, ["performance"]],
    ["Include attachments in the CSV export", "Done", 3, ["feature"]],
    ["Guide: running behind a reverse proxy with TLS", "Todo", 3, ["docs"]],
    ["Search should match comment text", "Todo", 2, ["feature"]],
    ["Label colours are hard to read in the dark theme", "Backlog", 4, ["bug"]],
    ["Show cycle progress on the cycles page", "In Progress", 3, ["feature"]],
    ["Rate limit invite emails", "Todo", 1, ["bug"]],
    ["Database connection pool sizing notes", "Backlog", 0, ["docs", "performance"]],
    ["Command palette: jump to any team", "In Progress", 3, ["feature"]],
    ["Digest email layout breaks on small screens", "Todo", 2, ["bug", "mobile"]],
    ["Offline banner when the connection drops", "Backlog", 3, ["feature", "mobile"]],
    ["Retry webhooks with backoff", "In Review", 2, ["feature"]],
    ["Crash when pasting a very large image", "Todo", 1, ["bug"]],
    ["Keyboard focus lost after closing a dialog", "Done", 2, ["bug"]],
  ];
  const created = [];
  let n = 0;
  for (const [title, status, priority, ls] of items) {
    const who = n % 5 === 0 ? me : people[n % 4].id;
    created.push(
      await api("POST", w("/issues"), {
        teamId: team.id,
        title,
        statusId: st(team.id, status),
        priority,
        labelIds: ls.map((l) => labels[l]),
        assigneeIds: n % 6 === 5 ? [] : [who],
        cycleId: n < 11 ? cycle.id : null,
        description: `Context for **${title.toLowerCase()}**.\n\n- Steps or scope\n- Expected result`,
        dueDate: n % 4 === 0 ? day(n + 2) : null,
        estimate: (n % 5) + 1,
      }),
    );
    n++;
  }
  const parent = await api("POST", w("/issues"), {
    teamId: team.id,
    title: "Public status page",
    statusId: st(team.id, "Todo"),
    priority: 2,
    description: "Parent issue for the status work.",
  });
  for (const t of ["Health check endpoint", "Uptime history chart", "Incident notes"]) {
    await api("POST", w("/issues"), { teamId: team.id, title: t, parentId: parent.id, statusId: st(team.id, "Backlog") });
  }
  await api("POST", w(`/issues/${created[2].id}/relations`), { relatedIssueId: created[10].id, type: "blocks" });
  await people[0].api("POST", w(`/issues/${created[1].id}/comments`), { body: "Working on this now. Should land tomorrow." });
  await people[1].api("POST", w(`/issues/${created[1].id}/comments`), { body: "Nice. Could A also work for assign?" });
  for (const [title, status] of [
    ["New empty states", "In Progress"],
    ["Icon set review", "Todo"],
    ["Onboarding illustrations", "Backlog"],
  ]) {
    await api("POST", w("/issues"), { teamId: design.id, title, statusId: st(design.id, status), priority: 3 });
  }
  await api("POST", w("/views"), { name: "Urgent and high", shared: true, layout: "list", filters: { priority: [1, 2] } });
  return admin.ctx;
}

async function toWebp(page, png, name) {
  const dataUrl = `data:image/png;base64,${png.toString("base64")}`;
  const out = await page.evaluate(
    async ({ dataUrl, widths }) => {
      const img = new Image();
      img.src = dataUrl;
      await img.decode();
      const res = {};
      for (const w of widths) {
        const h = Math.round((img.height * w) / img.width);
        const c = document.createElement("canvas");
        c.width = w;
        c.height = h;
        const g = c.getContext("2d");
        g.imageSmoothingQuality = "high";
        g.drawImage(img, 0, 0, w, h);
        res[w] = c.toDataURL("image/webp", 0.82);
      }
      return res;
    },
    { dataUrl, widths: [1280, 960, 640] },
  );
  for (const [w, url] of Object.entries(out)) {
    if (!url.startsWith("data:image/webp")) throw new Error("this browser cannot encode WebP");
    writeFileSync(join(OUT, "shots", `${name}-${w}.webp`), Buffer.from(url.split(",")[1], "base64"));
  }
}

const SHOTS = [
  { name: "board", path: "/acme/team/ENG/board" },
  { name: "list", path: "/acme/team/ENG/issues" },
  { name: "palette", path: "/acme/team/ENG/issues", act: async (p) => p.keyboard.press("ControlOrMeta+k") },
  {
    name: "search",
    path: "/acme/team/ENG/issues",
    act: async (p) => {
      await p.keyboard.press("ControlOrMeta+k");
      await p.keyboard.type("email", { delay: 40 });
      await p.getByText("Digest email layout").first().waitFor({ timeout: 10_000 });
    },
  },
  { name: "cycles", path: "/acme/team/ENG/cycles" },
  { name: "github", path: "/acme/settings/github" },
  {
    name: "export",
    path: "/acme/settings/data",
    act: async (p) => {
      const ready = p.getByRole("link", { name: "Download export" });
      if (!(await ready.count())) {
        await p.getByRole("button", { name: "Export workspace" }).click();
        await ready.first().waitFor({ timeout: 30_000 });
      }
    },
  },
];

async function captureApp(browser, storageState) {
  mkdirSync(join(OUT, "shots"), { recursive: true });
  const converter = await (await browser.newContext()).newPage();
  for (const theme of ["light", "dark"]) {
    const ctx = await browser.newContext({ storageState, viewport: { width: W, height: H }, colorScheme: theme, reducedMotion: "reduce" });
    const page = await ctx.newPage();
    for (const s of SHOTS) {
      await page.goto(`${BASE}${s.path}`);
      await page.waitForLoadState("networkidle");
      await page.waitForTimeout(400);
      if (s.act) await s.act(page);
      await page.waitForTimeout(500);
      const png = await page.screenshot({ type: "png" });
      await toWebp(converter, png, `${s.name}-${theme}`);
      console.log(`shot ${s.name}-${theme}`);
      await page.keyboard.press("Escape").catch(() => {});
    }
    await ctx.close();
  }
}

const OG = [
  ["home", "Software should be pay-as-you-go, at cost.", "Open-source issue tracking. Self-host free, or pay only what hosting costs."],
  ["pricing", "Pay what it costs to run.", "A capped share of the servers, your own storage and email, plus 20%. Line by line."],
  ["finances", "Open books", "Every cost of running Glasstrack, what workspaces paid, and the reserve."],
  ["about", "If software costs less to make, it should cost less to use.", "Why Glasstrack exists."],
  ["how-its-run", "How Glasstrack is run", "AI does the routine work. A person is accountable."],
  ["self-host", "Self-host Glasstrack", "MIT licensed. Every feature. Docker Compose in three steps."],
  ["legal", "Glasstrack", "Terms, privacy and data processing."],
  ["contact", "Contact Glasstrack", "Reach the person who runs it."],
  ["status", "Glasstrack status", "Is this server up right now?"],
];

const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;");

function ogHtml(title, sub) {
  return `<!doctype html><html><head><meta charset="utf-8"><style>
@font-face { font-family: "Plex Mono"; src: url("${BASE}/site/fonts/ibm-plex-mono-500.woff2") format("woff2"); font-weight: 500; }
* { box-sizing: border-box; margin: 0; }
body { width: 1200px; height: 630px; background: #f7f6f2; color: #15181b; font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, Arial, sans-serif; position: relative; overflow: hidden; }
.rules { position: absolute; inset: 0; background: repeating-linear-gradient(180deg, transparent 0 69px, #e4e1d7 69px 70px); opacity: .7; }
.margin { position: absolute; top: 0; bottom: 0; left: 120px; width: 1px; background: #d9b8a0; }
.card { position: absolute; left: 160px; right: 80px; top: 110px; }
.brand { display: flex; align-items: center; gap: 14px; font-weight: 700; font-size: 30px; margin-bottom: 44px; }
h1 { font-size: ${title.length > 40 ? 58 : 70}px; line-height: 1.08; letter-spacing: -0.03em; font-weight: 750; max-width: 900px; }
p { margin-top: 26px; font-size: 28px; color: #545a5f; max-width: 860px; line-height: 1.35; }
.url { position: absolute; left: 160px; bottom: 52px; font-family: "Plex Mono", monospace; font-size: 24px; color: #2f5d50; }
.edge { position: absolute; left: 0; right: 0; top: 0; height: 8px; background: #2f5d50; }
</style></head><body><div class="rules"></div><div class="margin"></div><div class="edge"></div>
<div class="card"><div class="brand"><svg width="44" height="44" viewBox="0 0 32 32"><rect width="32" height="32" rx="8" fill="#2f5d50"/><path d="M9 11h14M9 16h10M9 21h6" stroke="#f6f3ec" stroke-width="2.6" stroke-linecap="round"/></svg>Glasstrack</div>
<h1>${esc(title)}</h1><p>${esc(sub)}</p></div><div class="url">glasstrack.dev</div></body></html>`;
}

async function renderOg(browser) {
  mkdirSync(join(OUT, "og"), { recursive: true });
  const page = await (await browser.newContext({ viewport: { width: 1200, height: 630 } })).newPage();
  // Same origin as the font, so it loads without CORS.
  await page.goto(`${BASE}/robots.txt`);
  for (const [key, title, sub] of OG) {
    await page.setContent(ogHtml(title, sub), { waitUntil: "networkidle" });
    await page.evaluate(() => document.fonts.ready);
    writeFileSync(join(OUT, "og", `${key}.png`), await page.screenshot({ type: "png" }));
    console.log(`og ${key}`);
  }
}

await freshDatabase();
const server = startServer();
try {
  await waitReady();
  const browser = await chromium.launch();
  if (!process.argv.includes("--og-only")) {
    const ctx = await seed();
    const storageState = await ctx.storageState();
    await captureApp(browser, storageState);
  }
  await renderOg(browser);
  await browser.close();
} finally {
  server.kill("SIGTERM");
}
console.log("Done. Rebuild the site assets: pnpm --filter @glasstrack/server build:site");
