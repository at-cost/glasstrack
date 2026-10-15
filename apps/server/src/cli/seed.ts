/**
 * Seeds a demo workspace through the real HTTP handlers, so seeded data obeys
 * the same validation and RLS as user data. Usage: pnpm seed [email]
 * Then sign in with that email (magic link is printed in the server log).
 */
import { createApp } from "../app";
import { disabledGateway } from "../billing/gateway";
import { findOrCreateUser } from "../auth/routes";
import { loadConfig } from "../config";
import type { Deps } from "../context";
import { createDatabases, ensureRoles, migrateToLatest } from "../db";
import { createMailer } from "../email";
import { createInlineJobs } from "../jobs";
import { newToken, sha256, uuid7 } from "../lib/ids";
import { UsageMeter } from "../lib/meter";
import { RateLimiter } from "../lib/rateLimit";
import { RealtimeHub } from "../realtime/hub";
import { createStorage } from "../storage";

const email = process.argv[2] ?? "demo@example.com";
const config = loadConfig();
const dbs = createDatabases(config);
await ensureRoles(dbs.owner, config);
await migrateToLatest(dbs.owner);

let deps!: Deps;
deps = {
  config, dbs, mailer: createMailer(config), storage: createStorage(config), hub: new RealtimeHub(dbs.systemPool),
  jobs: createInlineJobs(() => deps),
  payments: disabledGateway(),
  meter: new UsageMeter(false),
  limits: { auth: new RateLimiter(1e6, 60_000), api: new RateLimiter(1e6, 60_000) },
};
const app = createApp(deps);
const origin = new URL(config.APP_URL).origin;

async function sessionFor(addr: string, name: string) {
  const userId = await findOrCreateUser(dbs.system, { email: addr, name });
  const token = newToken();
  await dbs.system.insertInto("sessions").values({ id: uuid7(), userId, tokenHash: sha256(token), expiresAt: new Date(Date.now() + 3600_000) }).execute();
  const cookie = `${config.secureCookies ? "__Host-glasstrack_session" : "glasstrack_session"}=${token}`;
  return async (method: string, path: string, body?: unknown) => {
    const res = await app.request(`/api/v1${path}`, {
      method,
      headers: { cookie, origin, ...(body ? { "content-type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const json = await res.json().catch(() => null);
    if (res.status >= 300) throw new Error(`${method} ${path}: ${res.status} ${JSON.stringify(json)}`);
    return json;
  };
}

const slug = "demo";
const api = await sessionFor(email, "Demo Admin");
const existing = (await api("GET", "/me")).workspaces.find((w: { slug: string }) => w.slug === slug);
if (existing) {
  console.log(`Workspace "${slug}" already exists. Nothing to do.`);
} else {
  await api("POST", "/workspaces", { name: "Demo Co", slug });
  const w = (p: string) => `/w/${slug}${p}`;
  const [team] = await api("GET", w("/teams"));
  await api("PATCH", w(`/teams/${team.id}`), { name: "Engineering", key: "ENG" });
  const design = await api("POST", w("/teams"), { name: "Design", key: "DES" });
  const people: { id: string; api: Awaited<ReturnType<typeof sessionFor>> }[] = [];
  for (const [addr, name] of [["sam@example.com", "Sam Rivera"], ["priya@example.com", "Priya Shah"], ["leo@example.com", "Leo Novak"]] as const) {
    const invite = await api("POST", w("/invites"), { role: "member" });
    const p = await sessionFor(addr, name);
    await p("POST", `/invites/${invite.url.split("/").pop()}/accept`);
    people.push({ id: (await p("GET", "/me")).id, api: p });
  }
  const me = (await api("GET", "/me")).id;
  const states: { id: string; name: string; teamId: string }[] = await api("GET", w("/states"));
  const st = (teamId: string, name: string) => states.find((s) => s.teamId === teamId && s.name === name)!.id;
  const labels: Record<string, string> = {};
  for (const [name, color] of [["bug", "#c0392b"], ["feature", "#2f5d50"], ["performance", "#b7791f"], ["docs", "#4a6fa5"]] as const) {
    labels[name] = (await api("POST", w("/labels"), { name, color })).id;
  }
  const today = new Date();
  const day = (d: number) => new Date(today.getTime() + d * 86400_000).toISOString().slice(0, 10);
  const cycle = await api("POST", w(`/teams/${team.id}/cycles`), { name: "Sprint 1", startsOn: day(-6), endsOn: day(7) });
  await api("POST", w(`/teams/${team.id}/cycles`), { name: "Sprint 2", startsOn: day(8), endsOn: day(21) });

  const items: [string, string, number, string[], string?][] = [
    ["Sign-in link expires too quickly on slow email providers", "Done", 2, ["bug"]],
    ["Keyboard shortcut to assign issues to me", "In Progress", 3, ["feature"]],
    ["Board drag feels laggy with 300+ cards", "In Review", 2, ["performance"]],
    ["Export includes attachments", "Done", 3, ["feature"]],
    ["Self-hosting guide: TLS with Caddy", "Todo", 3, ["docs"]],
    ["Search should match comment text", "Todo", 2, ["feature"]],
    ["Dark theme contrast on labels", "Backlog", 4, ["bug"]],
    ["Show cycle progress on the cycles page", "Backlog", 3, ["feature"]],
    ["Rate limit invite emails", "Todo", 1, ["bug"]],
    ["Postgres connection pool sizing notes", "Backlog", 0, ["docs", "performance"]],
    ["Command palette: jump to any team", "In Progress", 3, ["feature"]],
    ["Digest email layout on mobile", "Cancelled", 4, ["bug"]],
  ];
  let n = 0;
  const created: { id: string }[] = [];
  for (const [title, status, priority, ls] of items) {
    const who = n % 4 === 0 ? me : people[n % 3]!.id;
    created.push(await api("POST", w("/issues"), {
      teamId: team.id, title, statusId: st(team.id, status), priority, labelIds: ls.map((l) => labels[l]),
      assigneeIds: n % 5 === 4 ? [] : n % 6 === 1 ? [who, me] : [who], cycleId: n < 8 ? cycle.id : null,
      description: `Context for **${title.toLowerCase()}**.\n\n- Steps to reproduce or scope\n- Expected result\n\ncc @sam`,
      dueDate: n % 3 === 0 ? day(n) : null, estimate: (n % 5) + 1,
    }));
    n++;
  }
  const parent = await api("POST", w("/issues"), { teamId: team.id, title: "Public finances page", statusId: st(team.id, "Todo"), priority: 2, description: "Parent issue for the transparency work." });
  for (const t of ["Daily cost roll-up job", "Finances CSV download", "History charts"]) {
    await api("POST", w("/issues"), { teamId: team.id, title: t, parentId: parent.id, statusId: st(team.id, "Backlog") });
  }
  await api("POST", w(`/issues/${created[2]!.id}/relations`), { relatedIssueId: created[10]!.id, type: "blocks" });
  await api("POST", w(`/issues/${created[5]!.id}/relations`), { relatedIssueId: created[3]!.id, type: "related" });
  await people[0]!.api("POST", w(`/issues/${created[1]!.id}/comments`), { body: "Working on this now. Should land tomorrow." });
  await people[1]!.api("POST", w(`/issues/${created[1]!.id}/comments`), { body: "Nice. Can we also support **a** for assign? @demo" });
  await api("POST", w(`/issues/${created[2]!.id}/comments`), { body: "Profiled it: most time is spent re-rendering columns. Memoising cards fixes it." });
  for (const [title, status] of [["New empty states", "In Progress"], ["Icon set review", "Todo"], ["Onboarding illustrations", "Backlog"]] as const) {
    await api("POST", w("/issues"), { teamId: design.id, title, statusId: st(design.id, status), priority: 3 });
  }
  await api("POST", w("/views"), { name: "Urgent and high", shared: true, layout: "list", filters: { priority: [1, 2] } });
  console.log(`Seeded workspace "${slug}". Sign in as ${email} at ${config.APP_URL}/login`);
}
await dbs.close();
process.exit(0);
