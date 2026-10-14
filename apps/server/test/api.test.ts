import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { sql } from "kysely";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { verifyFileToken } from "../src/storage";
import { Client, createHarness, type Harness, setupWorkspace } from "./harness";

let h: Harness;

beforeAll(async () => {
  h = await createHarness();
});
beforeEach(async () => {
  await h.reset();
});
afterAll(async () => {
  await h?.close();
});

describe("auth", () => {
  it("magic link signs in once and creates a verified user", async () => {
    const c = new Client(h);
    expect((await c.get("/api/v1/me")).status).toBe(401);
    expect((await c.post("/api/v1/auth/magic-link", { email: "New.User@Example.com", redirectTo: "/acme" })).status).toBe(200);
    const mail = h.mailer.last("new.user@example.com");
    expect(mail?.subject).toBe("Your sign-in link");
    const token = /token=([\w-]+)/.exec(mail!.text)![1]!;
    const v = await c.post("/api/v1/auth/magic-link/verify", { token });
    expect(v.status).toBe(200);
    expect(v.body.redirectTo).toBe("/acme");
    const me = await c.ok("GET", "/api/v1/me");
    expect(me.email).toBe("new.user@example.com");
    // Reuse fails
    expect((await new Client(h).post("/api/v1/auth/magic-link/verify", { token })).status).toBe(400);
  });

  it("rejects open redirects", async () => {
    const c = new Client(h);
    await c.post("/api/v1/auth/magic-link", { email: "a@b.co", redirectTo: "//evil.example" });
    const token = /token=([\w-]+)/.exec(h.mailer.last("a@b.co")!.text)![1]!;
    expect((await c.post("/api/v1/auth/magic-link/verify", { token })).body.redirectTo).toBe("/");
  });

  it("expired links are rejected", async () => {
    const c = new Client(h);
    await c.post("/api/v1/auth/magic-link", { email: "late@b.co" });
    await sql`UPDATE magic_links SET expires_at = now() - interval '1 minute'`.execute(h.deps.dbs.owner);
    const token = /token=([\w-]+)/.exec(h.mailer.last("late@b.co")!.text)![1]!;
    expect((await c.post("/api/v1/auth/magic-link/verify", { token })).status).toBe(400);
  });

  it("logout ends the session", async () => {
    const c = await new Client(h).login("x@y.co");
    const cookie = c.cookie;
    await c.post("/api/v1/auth/logout");
    const again = new Client(h);
    again.cookie = cookie;
    expect((await again.get("/api/v1/me")).status).toBe(401);
  });

  it("blocks cross-site form posts (CSRF)", async () => {
    const c = await new Client(h).login("csrf@y.co");
    const r = await h.app.request("/api/v1/workspaces", {
      method: "POST",
      headers: { "content-type": "text/plain", origin: "https://evil.example", cookie: c.cookie },
      body: JSON.stringify({ name: "Evil", slug: "evil" }),
    });
    expect(r.status).toBe(403);
  });

  it("rate limits magic links per email", async () => {
    const strict = await createHarness();
    try {
      strict.deps.limits.auth = new (strict.deps.limits.auth.constructor as typeof import("../src/lib/rateLimit").RateLimiter)(3, 60_000);
      const c = new Client(strict);
      const codes = [];
      for (let i = 0; i < 5; i++) codes.push((await c.post("/api/v1/auth/magic-link", { email: "spam@y.co" })).status);
      expect(codes).toEqual([200, 200, 200, 429, 429]);
    } finally {
      await strict.close();
    }
  });

  it("test-login is refused unless explicitly enabled", async () => {
    const off = await createHarness({ E2E_TEST_LOGIN: "false" });
    try {
      expect((await new Client(off).post("/api/v1/auth/test-login", { email: "a@b.co" })).status).toBe(404);
    } finally {
      await off.close();
    }
  });
});

describe("workspaces, invites and roles", () => {
  it("creates a workspace with a default team and statuses", async () => {
    const { team, states } = await setupWorkspace(h, "owner@acme.co", "acme");
    expect(team.key).toBe("ACME");
    expect(states.map((s) => s.name)).toEqual(["Backlog", "Todo", "In Progress", "In Review", "Done", "Cancelled"]);
  });

  it("rejects duplicate slugs", async () => {
    await setupWorkspace(h, "owner@acme.co", "acme");
    const c = await new Client(h).login("other@x.co");
    expect((await c.post("/api/v1/workspaces", { name: "Acme 2", slug: "acme" })).status).toBe(409);
  });

  it("email invites are bound to the address; link invites are reusable", async () => {
    const { c } = await setupWorkspace(h, "owner@acme.co", "acme");
    const inv = await c.ok("POST", "/api/v1/w/acme/invites", { email: "dev@acme.co", role: "member" });
    expect(h.mailer.last("dev@acme.co")?.subject).toContain("invited you");
    const token = inv.url.split("/").pop();
    const wrong = await new Client(h).login("intruder@x.co");
    expect((await wrong.post(`/api/v1/invites/${token}/accept`)).status).toBe(403);
    const dev = await new Client(h).login("dev@acme.co");
    expect((await dev.ok("POST", `/api/v1/invites/${token}/accept`)).slug).toBe("acme");
    expect((await dev.post(`/api/v1/invites/${token}/accept`)).status).toBe(404);

    const link = await c.ok("POST", "/api/v1/w/acme/invites", { role: "guest" });
    const ltoken = link.url.split("/").pop();
    for (const email of ["g1@x.co", "g2@x.co"]) {
      const g = await new Client(h).login(email);
      await g.ok("POST", `/api/v1/invites/${ltoken}/accept`);
    }
    const members = await c.ok("GET", "/api/v1/w/acme/members");
    expect(members.map((m: { role: string }) => m.role).sort()).toEqual(["admin", "guest", "guest", "member"]);
    await c.ok("DELETE", `/api/v1/w/acme/invites/${link.id}`);
    const late = await new Client(h).login("g3@x.co");
    expect((await late.post(`/api/v1/invites/${ltoken}/accept`)).status).toBe(404);
  });

  it("guests only see teams they were added to", async () => {
    const { c, team } = await setupWorkspace(h, "owner@acme.co", "acme");
    const other = await c.ok("POST", "/api/v1/w/acme/teams", { name: "Design", key: "DES" });
    const hidden = await c.ok("POST", "/api/v1/w/acme/issues", { teamId: other.id, title: "secret design" });
    await c.ok("POST", "/api/v1/w/acme/issues", { teamId: team.id, title: "visible" });
    const link = await c.ok("POST", "/api/v1/w/acme/invites", { role: "guest" });
    const g = await new Client(h).login("guest@x.co");
    await g.ok("POST", `/api/v1/invites/${link.url.split("/").pop()}/accept`);
    const gid = (await g.ok("GET", "/api/v1/me")).id;
    expect(await g.ok("GET", "/api/v1/w/acme/teams")).toEqual([]);
    await c.ok("PUT", `/api/v1/w/acme/teams/${team.id}/members/${gid}`, {});
    const teams = await g.ok("GET", "/api/v1/w/acme/teams");
    expect(teams.map((t: { key: string }) => t.key)).toEqual(["ACME"]);
    const list = await g.ok("GET", "/api/v1/w/acme/issues");
    expect(list.issues.map((i: { title: string }) => i.title)).toEqual(["visible"]);
    expect((await g.get(`/api/v1/w/acme/issues/${hidden.identifier}`)).status).toBe(404);
    expect((await g.post("/api/v1/w/acme/issues", { teamId: other.id, title: "x" })).status).toBe(404);
    expect((await g.post("/api/v1/w/acme/teams", { name: "G", key: "GG" })).status).toBe(403);
  });

  it("keeps at least one admin", async () => {
    const { c } = await setupWorkspace(h, "owner@acme.co", "acme");
    const me = await c.ok("GET", "/api/v1/me");
    expect((await c.patch(`/api/v1/w/acme/members/${me.id}`, { role: "member" })).status).toBe(400);
    expect((await c.del(`/api/v1/w/acme/members/${me.id}`)).status).toBe(400);
  });

  it("members cannot do admin things", async () => {
    const { c } = await setupWorkspace(h, "owner@acme.co", "acme");
    const inv = await c.ok("POST", "/api/v1/w/acme/invites", { role: "member" });
    const m = await new Client(h).login("m@acme.co");
    await m.ok("POST", `/api/v1/invites/${inv.url.split("/").pop()}/accept`);
    expect((await m.patch("/api/v1/w/acme", { name: "x" })).status).toBe(403);
    expect((await m.post("/api/v1/w/acme/invites", { role: "admin" })).status).toBe(403);
    expect((await m.post("/api/v1/w/acme/exports")).status).toBe(403);
    expect((await m.del("/api/v1/w/acme", { confirm: "acme" })).status).toBe(403);
  });
});

describe("issues", () => {
  it("numbers issues per team and resolves human ids, including after a key rename", async () => {
    const { c, team } = await setupWorkspace(h, "o@acme.co", "acme");
    const a = await c.ok("POST", "/api/v1/w/acme/issues", { teamId: team.id, title: "first" });
    const b = await c.ok("POST", "/api/v1/w/acme/issues", { teamId: team.id, title: "second" });
    expect([a.identifier, b.identifier]).toEqual(["ACME-1", "ACME-2"]);
    expect((await c.ok("GET", "/api/v1/w/acme/issues/acme-2")).title).toBe("second");
    await c.ok("PATCH", `/api/v1/w/acme/teams/${team.id}`, { key: "CORE" });
    expect((await c.ok("GET", "/api/v1/w/acme/issues/CORE-2")).title).toBe("second");
    expect((await c.ok("GET", "/api/v1/w/acme/issues/ACME-2")).identifier).toBe("CORE-2");
  });

  it("updates fields, tracks activity and status timestamps", async () => {
    const { c, team, states } = await setupWorkspace(h, "o@acme.co", "acme");
    const me = await c.ok("GET", "/api/v1/me");
    const label = await c.ok("POST", "/api/v1/w/acme/labels", { name: "bug", color: "#aa0000" });
    const i = await c.ok("POST", "/api/v1/w/acme/issues", { teamId: team.id, title: "t" });
    expect(i.statusId).toBe(states.find((s) => s.name === "Backlog")!.id);
    const done = states.find((s) => s.category === "completed")!;
    const up = await c.ok("PATCH", `/api/v1/w/acme/issues/${i.id}`, {
      title: "renamed", statusId: done.id, priority: 1, assigneeId: me.id, labelIds: [label.id], dueDate: "2026-12-01", estimate: 3,
    });
    expect(up).toMatchObject({ title: "renamed", statusId: done.id, priority: 1, assigneeId: me.id, labelIds: [label.id], dueDate: "2026-12-01", estimate: 3 });
    expect(up.completedAt).not.toBeNull();
    const acts = await c.ok("GET", `/api/v1/w/acme/issues/${i.id}/activity`);
    expect(acts.map((a: { kind: string }) => a.kind)).toEqual(["created", "title", "status", "priority", "assignee", "due_date", "estimate", "labels"]);
    const back = await c.ok("PATCH", `/api/v1/w/acme/issues/${i.id}`, { statusId: states[1]!.id });
    expect(back.completedAt).toBeNull();
  });

  it("validates statuses, labels and cycles from other teams", async () => {
    const { c, team } = await setupWorkspace(h, "o@acme.co", "acme");
    const other = await c.ok("POST", "/api/v1/w/acme/teams", { name: "Ops", key: "OPS" });
    const states = await c.ok("GET", "/api/v1/w/acme/states");
    const opsState = states.find((s: { teamId: string }) => s.teamId === other.id);
    const opsLabel = await c.ok("POST", "/api/v1/w/acme/labels", { name: "ops-only", color: "#000000", teamId: other.id });
    const opsCycle = await c.ok("POST", `/api/v1/w/acme/teams/${other.id}/cycles`, { startsOn: "2026-01-01", endsOn: "2026-01-02" });
    for (const bad of [{ statusId: opsState.id }, { labelIds: [opsLabel.id] }, { cycleId: opsCycle.id }]) {
      expect((await c.post("/api/v1/w/acme/issues", { teamId: team.id, title: "x", ...bad })).status).toBe(400);
    }
  });

  it("supports sub-issues and prevents parent loops", async () => {
    const { c, team } = await setupWorkspace(h, "o@acme.co", "acme");
    const p = await c.ok("POST", "/api/v1/w/acme/issues", { teamId: team.id, title: "parent" });
    const ch = await c.ok("POST", "/api/v1/w/acme/issues", { teamId: team.id, title: "child", parentId: p.id });
    const gc = await c.ok("POST", "/api/v1/w/acme/issues", { teamId: team.id, title: "grandchild", parentId: ch.id });
    const d = await c.ok("GET", `/api/v1/w/acme/issues/${p.id}`);
    expect(d.children.map((x: { title: string }) => x.title)).toEqual(["child"]);
    expect((await c.patch(`/api/v1/w/acme/issues/${p.id}`, { parentId: gc.id })).status).toBe(400);
    expect((await c.patch(`/api/v1/w/acme/issues/${p.id}`, { parentId: p.id })).status).toBe(400);
  });

  it("links issues both ways", async () => {
    const { c, team } = await setupWorkspace(h, "o@acme.co", "acme");
    const a = await c.ok("POST", "/api/v1/w/acme/issues", { teamId: team.id, title: "a" });
    const b = await c.ok("POST", "/api/v1/w/acme/issues", { teamId: team.id, title: "b" });
    const rel = await c.ok("POST", `/api/v1/w/acme/issues/${a.id}/relations`, { relatedIssueId: b.id, type: "blocks" });
    expect((await c.post(`/api/v1/w/acme/issues/${b.id}/relations`, { relatedIssueId: a.id, type: "blocks" })).status).toBe(409);
    const da = await c.ok("GET", `/api/v1/w/acme/issues/${a.id}`);
    const db = await c.ok("GET", `/api/v1/w/acme/issues/${b.id}`);
    expect(da.relations[0]).toMatchObject({ type: "blocks", direction: "outgoing", issue: { identifier: b.identifier } });
    expect(db.relations[0]).toMatchObject({ type: "blocks", direction: "incoming", issue: { identifier: a.identifier } });
    await c.ok("DELETE", `/api/v1/w/acme/issues/${b.id}/relations/${rel.id}`);
    expect((await c.ok("GET", `/api/v1/w/acme/issues/${a.id}`)).relations).toEqual([]);
  });

  it("moves issues on the board with stable ordering", async () => {
    const { c, team, states } = await setupWorkspace(h, "o@acme.co", "acme");
    const todo = states.find((s) => s.name === "Todo")!;
    const ids: string[] = [];
    for (const t of ["one", "two", "three"]) ids.push((await c.ok("POST", "/api/v1/w/acme/issues", { teamId: team.id, title: t, statusId: todo.id })).id);
    const order = async () =>
      (await c.ok("GET", `/api/v1/w/acme/issues?team=${team.id}&status=${todo.id}`)).issues.map((i: { title: string }) => i.title);
    expect(await order()).toEqual(["one", "two", "three"]);
    await c.ok("POST", `/api/v1/w/acme/issues/${ids[2]}/move`, { afterId: null, beforeId: ids[0] });
    expect(await order()).toEqual(["three", "one", "two"]);
    await c.ok("POST", `/api/v1/w/acme/issues/${ids[2]}/move`, { afterId: ids[0], beforeId: ids[1] });
    expect(await order()).toEqual(["one", "three", "two"]);
    for (let n = 0; n < 30; n++) {
      await c.ok("POST", `/api/v1/w/acme/issues/${ids[n % 2 ? 0 : 1]}/move`, { afterId: ids[2], beforeId: null });
    }
    const inProgress = states.find((s) => s.name === "In Progress")!;
    const moved = await c.ok("POST", `/api/v1/w/acme/issues/${ids[0]}/move`, { statusId: inProgress.id, afterId: null, beforeId: null });
    expect(moved.statusId).toBe(inProgress.id);
    const acts = await c.ok("GET", `/api/v1/w/acme/issues/${ids[0]}/activity`);
    expect(acts.at(-1)).toMatchObject({ kind: "status", data: { from: todo.id, to: inProgress.id } });
  });

  it("filters and full-text search", async () => {
    const { c, team, states } = await setupWorkspace(h, "o@acme.co", "acme");
    const me = await c.ok("GET", "/api/v1/me");
    const bug = await c.ok("POST", "/api/v1/w/acme/labels", { name: "bug", color: "#aa0000" });
    const cycle = await c.ok("POST", `/api/v1/w/acme/teams/${team.id}/cycles`, { startsOn: "2020-01-01", endsOn: "2099-01-01" });
    await c.ok("POST", "/api/v1/w/acme/issues", { teamId: team.id, title: "Login page crashes", labelIds: [bug.id], priority: 1, assigneeId: me.id, cycleId: cycle.id });
    await c.ok("POST", "/api/v1/w/acme/issues", { teamId: team.id, title: "Dark mode", description: "users want a darker theme" });
    const third = await c.ok("POST", "/api/v1/w/acme/issues", { teamId: team.id, title: "Export button", statusId: states[2]!.id });
    await c.ok("POST", `/api/v1/w/acme/issues/${third.id}/comments`, { body: "the zebra pattern breaks here" });
    const titles = async (q: string) =>
      (await c.ok("GET", `/api/v1/w/acme/issues?${q}`)).issues.map((i: { title: string }) => i.title).sort();
    expect(await titles(`label=${bug.id}`)).toEqual(["Login page crashes"]);
    expect(await titles("priority=1")).toEqual(["Login page crashes"]);
    expect(await titles("assignee=me")).toEqual(["Login page crashes"]);
    expect(await titles("assignee=none")).toEqual(["Dark mode", "Export button"]);
    expect(await titles("cycle=active")).toEqual(["Login page crashes"]);
    expect(await titles("cycle=none")).toEqual(["Dark mode", "Export button"]);
    expect(await titles(`status=${states[2]!.id}`)).toEqual(["Export button"]);
    expect(await titles("q=darker")).toEqual(["Dark mode"]);
    expect(await titles("q=zebra")).toEqual(["Export button"]);
    expect(await titles("q=ACME-1")).toEqual(["Login page crashes"]);
    const s = await c.ok("GET", "/api/v1/w/acme/search?q=crashes");
    expect(s.issues.map((i: { identifier: string }) => i.identifier)).toEqual(["ACME-1"]);
  });

  it("archives and deletes", async () => {
    const { c, team } = await setupWorkspace(h, "o@acme.co", "acme");
    const i = await c.ok("POST", "/api/v1/w/acme/issues", { teamId: team.id, title: "old" });
    await c.ok("POST", `/api/v1/w/acme/issues/${i.id}/archive`, { archived: true });
    expect((await c.ok("GET", "/api/v1/w/acme/issues")).issues).toEqual([]);
    expect((await c.ok("GET", "/api/v1/w/acme/issues?includeArchived=true")).issues).toHaveLength(1);
    await c.ok("DELETE", `/api/v1/w/acme/issues/${i.id}`);
    expect((await c.get(`/api/v1/w/acme/issues/${i.id}`)).status).toBe(404);
  });

  it("saved views: private unless shared", async () => {
    const { c } = await setupWorkspace(h, "o@acme.co", "acme");
    const inv = await c.ok("POST", "/api/v1/w/acme/invites", { role: "member" });
    const m = await new Client(h).login("m@acme.co");
    await m.ok("POST", `/api/v1/invites/${inv.url.split("/").pop()}/accept`);
    await c.ok("POST", "/api/v1/w/acme/views", { name: "mine", filters: { priority: [1] } });
    const shared = await c.ok("POST", "/api/v1/w/acme/views", { name: "team", shared: true, layout: "board", filters: { assignee: ["me"] } });
    expect((await m.ok("GET", "/api/v1/w/acme/views")).map((v: { name: string }) => v.name)).toEqual(["team"]);
    expect((await m.patch(`/api/v1/w/acme/views/${shared.id}`, { name: "hijack" })).status).toBe(403);
  });
});

describe("comments and notifications", () => {
  async function team2() {
    const owner = await setupWorkspace(h, "ann@acme.co", "acme");
    const inv = await owner.c.ok("POST", "/api/v1/w/acme/invites", { role: "member" });
    const ben = await new Client(h).login("ben@acme.co", "Ben");
    await ben.ok("POST", `/api/v1/invites/${inv.url.split("/").pop()}/accept`);
    const benId = (await ben.ok("GET", "/api/v1/me")).id;
    return { ...owner, ben, benId };
  }

  it("mentions, assignment, comments and status changes notify the right people once", async () => {
    const { c, team, ben, benId, states } = await team2();
    const i = await c.ok("POST", "/api/v1/w/acme/issues", { teamId: team.id, title: "needs eyes", description: "cc @ben" });
    let inbox = await ben.ok("GET", "/api/v1/w/acme/notifications");
    expect(inbox.map((n: { kind: string }) => n.kind)).toEqual(["mentioned"]);
    expect(inbox[0].issueIdentifier).toBe("ACME-1");

    await c.ok("PATCH", `/api/v1/w/acme/issues/${i.id}`, { assigneeId: benId });
    await c.ok("POST", `/api/v1/w/acme/issues/${i.id}/comments`, { body: "any update @ben?" });
    await c.ok("POST", `/api/v1/w/acme/issues/${i.id}/comments`, { body: "plain comment" });
    await c.ok("PATCH", `/api/v1/w/acme/issues/${i.id}`, { statusId: states[2]!.id });
    inbox = await ben.ok("GET", "/api/v1/w/acme/notifications");
    expect(inbox.map((n: { kind: string }) => n.kind).reverse()).toEqual(["mentioned", "assigned", "mentioned", "commented", "status_changed"]);

    // Ben's own actions don't notify Ben; Ann is subscribed as creator.
    await ben.ok("POST", `/api/v1/w/acme/issues/${i.id}/comments`, { body: "on it" });
    const annInbox = await c.ok("GET", "/api/v1/w/acme/notifications");
    expect(annInbox.map((n: { kind: string }) => n.kind)).toEqual(["commented"]);
    expect((await ben.ok("GET", "/api/v1/w/acme/notifications/unread-count")).count).toBe(5);
    await ben.ok("POST", "/api/v1/w/acme/notifications/read", { all: true });
    expect((await ben.ok("GET", "/api/v1/w/acme/notifications/unread-count")).count).toBe(0);
  });

  it("respects per-user event settings and unsubscribe", async () => {
    const { c, team, ben } = await team2();
    await ben.ok("PUT", "/api/v1/w/acme/notification-settings", { digest: "off", events: { mentioned: false } });
    const i = await c.ok("POST", "/api/v1/w/acme/issues", { teamId: team.id, title: "x", description: "@ben" });
    expect(await ben.ok("GET", "/api/v1/w/acme/notifications")).toEqual([]);
    await ben.ok("PUT", `/api/v1/w/acme/issues/${i.id}/subscription`, { subscribed: false });
    await c.ok("POST", `/api/v1/w/acme/issues/${i.id}/comments`, { body: "hello" });
    expect(await ben.ok("GET", "/api/v1/w/acme/notifications")).toEqual([]);
    expect((await ben.ok("GET", "/api/v1/w/acme/notification-settings")).events).toMatchObject({ mentioned: false, assigned: true });
  });

  it("comment edit and delete permissions", async () => {
    const { c, team, ben } = await team2();
    const i = await c.ok("POST", "/api/v1/w/acme/issues", { teamId: team.id, title: "x" });
    const cm = await ben.ok("POST", `/api/v1/w/acme/issues/${i.id}/comments`, { body: "ben's" });
    expect((await c.patch(`/api/v1/w/acme/comments/${cm.id}`, { body: "edited by ann" })).status).toBe(403);
    expect((await ben.ok("PATCH", `/api/v1/w/acme/comments/${cm.id}`, { body: "fixed" })).editedAt).not.toBeNull();
    await c.ok("DELETE", `/api/v1/w/acme/comments/${cm.id}`); // admin can delete
    expect(await c.ok("GET", `/api/v1/w/acme/issues/${i.id}/comments`)).toEqual([]);
  });

  it("emails a digest of unread notifications and marks them emailed", async () => {
    const { c, team } = await team2();
    await c.ok("POST", "/api/v1/w/acme/issues", { teamId: team.id, title: "digest me", description: "@ben" });
    await sql`UPDATE notifications SET created_at = now() - interval '1 hour'`.execute(h.deps.dbs.owner);
    await h.deps.jobs.send("notifications.digest", {});
    const mail = h.mailer.last("ben@acme.co");
    expect(mail?.subject).toBe("1 new update in ACME");
    expect(mail?.text).toContain("ACME-1: digest me");
    h.mailer.outbox.length = 0;
    await h.deps.jobs.send("notifications.digest", {});
    expect(h.mailer.outbox).toEqual([]);
  });
});

describe("attachments, export and deletion", () => {
  async function upload(c: Client, issueId: string, name: string, content: string) {
    const r = await c.ok("POST", `/api/v1/w/acme/issues/${issueId}/attachments`, { filename: name, contentType: "text/plain", size: content.length });
    const url = new URL(r.upload.url);
    const put = await h.app.request(url.pathname, { method: "PUT", headers: { ...r.upload.headers, origin: "http://localhost:3999" }, body: content });
    expect(put.status).toBe(204);
    await c.ok("POST", `/api/v1/w/acme/attachments/${r.id}/complete`);
    return r.id as string;
  }

  it("uploads through signed URLs, refuses oversize bodies and serves downloads", async () => {
    const { c, team } = await setupWorkspace(h, "o@acme.co", "acme");
    const i = await c.ok("POST", "/api/v1/w/acme/issues", { teamId: team.id, title: "files" });
    await upload(c, i.id, "notes.txt", "hello");
    const d = await c.ok("GET", `/api/v1/w/acme/issues/${i.id}`);
    expect(d.attachments).toHaveLength(1);
    const dl = await h.app.request(new URL(d.attachments[0].url).pathname);
    expect(await dl.text()).toBe("hello");
    expect(dl.headers.get("content-security-policy")).toContain("sandbox");

    const r = await c.ok("POST", `/api/v1/w/acme/issues/${i.id}/attachments`, { filename: "x.txt", contentType: "text/plain", size: 2 });
    const big = await h.app.request(new URL(r.upload.url).pathname, { method: "PUT", headers: { origin: "http://localhost:3999" }, body: "too big" });
    expect(big.status).toBe(413);
    // Tokens can't be reused for another operation.
    const token = new URL(r.upload.url).pathname.split("/").pop()!;
    expect(verifyFileToken(h.deps.config.APP_SECRET, token)?.op).toBe("put");
    expect((await h.app.request(`/api/v1/files/${token}`)).status).toBe(404);
  });

  it("exports the whole workspace as JSON + CSV + attachments", async () => {
    const { c, team } = await setupWorkspace(h, "o@acme.co", "acme");
    const i = await c.ok("POST", "/api/v1/w/acme/issues", { teamId: team.id, title: "=cmd|' /C calc'!A0", description: "body" });
    await c.ok("POST", `/api/v1/w/acme/issues/${i.id}/comments`, { body: "a comment, with \"quotes\"" });
    await upload(c, i.id, "spec.txt", "attached content");
    const job = await c.ok("POST", "/api/v1/w/acme/exports");
    const list = await c.ok("GET", "/api/v1/w/acme/exports");
    expect(list[0]).toMatchObject({ id: job.id, status: "done" });
    const res = await h.app.request(new URL(list[0].downloadUrl).pathname);
    const dir = mkdtempSync(path.join(tmpdir(), "export-test-"));
    const file = path.join(dir, "e.tar.gz");
    writeFileSync(file, Buffer.from(await res.arrayBuffer()));
    execFileSync("tar", ["-xzf", file, "-C", dir]);
    const root = path.join(dir, "acme-export");
    const json = JSON.parse(readFileSync(path.join(root, "workspace.json"), "utf8"));
    expect(json.workspace.slug).toBe("acme");
    expect(json.issues).toHaveLength(1);
    expect(json.comments[0].bodyMd).toContain("quotes");
    const csv = readFileSync(path.join(root, "issues.csv"), "utf8");
    expect(csv).toContain(`'=cmd|' /C calc'!A0`); // formula injection neutralised
    expect(readFileSync(path.join(root, "attachments", `${json.attachments[0].id}-spec.txt`), "utf8")).toBe("attached content");
    expect(JSON.stringify(json)).not.toContain("storageKey");
  });

  it("export still works when a workspace is read-only, edits do not", async () => {
    const { c, team } = await setupWorkspace(h, "o@acme.co", "acme");
    await sql`UPDATE workspaces SET status = 'read_only'`.execute(h.deps.dbs.owner);
    expect((await c.post("/api/v1/w/acme/issues", { teamId: team.id, title: "x" })).status).toBe(402);
    expect((await c.post("/api/v1/w/acme/exports")).status).toBe(202);
    expect((await c.get("/api/v1/w/acme/issues")).status).toBe(200);
  });

  it("deleting a workspace removes every row and file but keeps users", async () => {
    const { c, team } = await setupWorkspace(h, "o@acme.co", "acme");
    const keep = await setupWorkspace(h, "k@keep.co", "keep");
    await keep.c.ok("POST", "/api/v1/w/keep/issues", { teamId: keep.team.id, title: "survivor" });
    const i = await c.ok("POST", "/api/v1/w/acme/issues", { teamId: team.id, title: "doomed" });
    await upload(c, i.id, "a.txt", "bye");
    const wsId = (await c.ok("GET", "/api/v1/w/acme")).id;
    expect((await c.del("/api/v1/w/acme", { confirm: "wrong" })).status).toBe(400);
    await c.ok("DELETE", "/api/v1/w/acme", { confirm: "acme" });
    expect((await c.get("/api/v1/w/acme")).status).toBe(404);
    const counts = await sql<{ t: string; n: string }>`
      SELECT 'issues' t, count(*) n FROM issues WHERE workspace_id = ${wsId}
      UNION ALL SELECT 'activity', count(*) FROM activity WHERE workspace_id = ${wsId}
      UNION ALL SELECT 'attachments', count(*) FROM attachments WHERE workspace_id = ${wsId}
      UNION ALL SELECT 'members', count(*) FROM workspace_members WHERE workspace_id = ${wsId}
      UNION ALL SELECT 'workspace', count(*) FROM workspaces WHERE id = ${wsId}`.execute(h.deps.dbs.owner);
    expect(counts.rows.every((r) => Number(r.n) === 0)).toBe(true);
    expect(await h.deps.storage.size(`w/${wsId}/`)).toBeNull();
    expect((await c.ok("GET", "/api/v1/me")).email).toBe("o@acme.co");
    expect((await keep.c.ok("GET", "/api/v1/w/keep/issues")).issues).toHaveLength(1);
  });
});

describe("operations", () => {
  it("health and readiness", async () => {
    expect((await h.app.request("/health")).status).toBe(200);
    const r = await h.app.request("/ready");
    expect(r.status).toBe(200);
  });

  it("unknown API routes are JSON 404s", async () => {
    const r = await h.app.request("/api/v1/nope");
    expect(r.status).toBe(404);
    expect(await r.json()).toEqual({ error: { code: "not_found", message: "Not found" } });
  });

  it("invalid input gets a readable 400", async () => {
    const { c } = await setupWorkspace(h, "o@acme.co", "acme");
    const r = await c.post("/api/v1/w/acme/issues", { title: "" });
    expect(r.status).toBe(400);
    expect(r.body.error.code).toBe("invalid");
  });
});
