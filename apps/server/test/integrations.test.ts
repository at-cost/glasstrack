import { createHmac } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { sql } from "kysely";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { guessCategory, parseJiraCsv, parseLinearCsv, parseTrelloJson } from "../src/importers/parse";
import { parseCsv } from "../src/lib/csv";
import { isPrivateAddress } from "../src/lib/ssrf";
import { findIssueKeys } from "../src/modules/github";
import { deliverWebhook, signPayload } from "../src/modules/webhooks";
import { Client, createHarness, type Harness, setupWorkspace } from "./harness";

let h: Harness;
beforeAll(async () => {
  h = await createHarness({ WEBHOOK_ALLOW_PRIVATE: "true" });
});
beforeEach(async () => {
  await h.reset();
});
afterAll(async () => {
  await h?.close();
});

async function bearer(token: string, method: string, path: string, body?: unknown) {
  const r = await h.app.request(path, {
    method,
    headers: { authorization: `Bearer ${token}`, ...(body ? { "content-type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: r.status, body: await r.json().catch(() => null) };
}

describe("API tokens", () => {
  it("act as the user in one workspace only, and can't manage tokens or webhooks", async () => {
    const { c, team } = await setupWorkspace(h, "ann@acme.co", "acme");
    await setupWorkspace(h, "ann2@other.co", "other");
    const other = new Client(h);
    await other.login("ann2@other.co");
    // Ann is a member of both only if invited; make her a member of "other" too.
    const inv = await other.ok("POST", "/api/v1/w/other/invites", { role: "member" });
    await c.ok("POST", `/api/v1/invites/${inv.url.split("/").pop()}/accept`);

    const t = await c.ok("POST", "/api/v1/w/acme/tokens", { name: "CI" });
    expect(t.token).toMatch(/^gt_/);
    expect((await bearer(t.token, "GET", "/api/v1/me")).body.email).toBe("ann@acme.co");
    const created = await bearer(t.token, "POST", "/api/v1/w/acme/issues", { teamId: team.id, title: "from the API" });
    expect(created.status).toBe(201);
    expect((await bearer(t.token, "GET", "/api/v1/w/acme/issues")).body.issues).toHaveLength(1);
    expect((await bearer(t.token, "GET", "/api/v1/w/other/issues")).status).toBe(404);
    for (const [m, p] of [["GET", "/api/v1/w/acme/tokens"], ["POST", "/api/v1/w/acme/webhooks"], ["GET", "/api/v1/w/acme/integrations/github"], ["POST", "/api/v1/workspaces"]] as const) {
      expect((await bearer(t.token, m, p, m === "POST" ? {} : undefined)).status, p).toBe(403);
    }
    const list = await c.ok("GET", "/api/v1/w/acme/tokens");
    expect(list[0]).toMatchObject({ name: "CI", tokenPrefix: t.token.slice(0, 10) });
    expect(JSON.stringify(list)).not.toContain(t.token);
    await c.ok("DELETE", `/api/v1/w/acme/tokens/${t.id}`);
    expect((await bearer(t.token, "GET", "/api/v1/w/acme/issues")).status).toBe(401);
  });

  it("expired, unknown and removed-member tokens are rejected", async () => {
    const { c } = await setupWorkspace(h, "ann@acme.co", "acme");
    const t = await c.ok("POST", "/api/v1/w/acme/tokens", { name: "short", expiresInDays: 1 });
    await sql`UPDATE api_tokens SET expires_at = now() - interval '1 minute'`.execute(h.deps.dbs.owner);
    expect((await bearer(t.token, "GET", "/api/v1/w/acme/issues")).status).toBe(401);
    expect((await bearer("gt_nope", "GET", "/api/v1/me")).status).toBe(401);
    const t2 = await c.ok("POST", "/api/v1/w/acme/tokens", { name: "x" });
    await sql`DELETE FROM workspace_members`.execute(h.deps.dbs.owner);
    expect((await bearer(t2.token, "GET", "/api/v1/w/acme/issues")).status).toBe(401);
  });
});

describe("outgoing webhooks", () => {
  let server: Server;
  let received: { headers: Record<string, string | string[] | undefined>; body: string }[] = [];
  let failNext = 0;
  let url = "";
  beforeAll(async () => {
    server = createServer((req, res) => {
      let body = "";
      req.on("data", (d) => (body += d));
      req.on("end", () => {
        received.push({ headers: req.headers, body });
        if (failNext > 0) {
          failNext--;
          res.writeHead(500).end("nope");
        } else res.writeHead(204).end();
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/hook`;
  });
  afterAll(() => new Promise<void>((r) => server.close(() => r())));
  beforeEach(() => {
    received = [];
    failNext = 0;
  });

  it("delivers signed events after commit, only for subscribed events", async () => {
    const { c, team } = await setupWorkspace(h, "ann@acme.co", "acme");
    const hook = await c.ok("POST", "/api/v1/w/acme/webhooks", { url, events: ["issue.created", "comment.created"] });
    expect(hook.secret).toMatch(/^whsec_/);
    const issue = await c.ok("POST", "/api/v1/w/acme/issues", { teamId: team.id, title: "hooked" });
    await c.ok("PATCH", `/api/v1/w/acme/issues/${issue.id}`, { title: "renamed" }); // not subscribed
    await c.ok("POST", `/api/v1/w/acme/issues/${issue.id}/comments`, { body: "hi" });
    expect(received.map((r) => r.headers["glasstrack-event"])).toEqual(["issue.created", "comment.created"]);
    const first = received[0]!;
    const sig = String(first.headers["glasstrack-signature"]);
    const ts = /t=(\d+)/.exec(sig)![1]!;
    expect(sig).toBe(signPayload(hook.secret, first.body, Number(ts)));
    expect(sig).toContain(createHmac("sha256", hook.secret).update(`${ts}.${first.body}`).digest("hex"));
    const payload = JSON.parse(first.body);
    expect(payload).toMatchObject({ event: "issue.created", workspace: { slug: "acme" }, data: { issue: { identifier: "ACME-1", title: "hooked" } } });
    // A failed request (rolled back) sends nothing.
    received = [];
    expect((await c.post("/api/v1/w/acme/issues", { teamId: team.id, title: "" })).status).toBe(400);
    expect(received).toEqual([]);
  });

  it("retries failures and marks the delivery failed after 5 attempts", async () => {
    const { c, team } = await setupWorkspace(h, "ann@acme.co", "acme");
    await c.ok("POST", "/api/v1/w/acme/webhooks", { url, events: ["issue.created"] });
    failNext = 99;
    await c.ok("POST", "/api/v1/w/acme/issues", { teamId: team.id, title: "x" });
    const d = await h.deps.dbs.system.selectFrom("webhookDeliveries").selectAll().executeTakeFirstOrThrow();
    expect(d).toMatchObject({ status: "pending", attempts: 1, responseStatus: 500 });
    for (let i = 0; i < 3; i++) await expect(deliverWebhook(h.deps, d.id)).rejects.toThrow();
    await deliverWebhook(h.deps, d.id); // fifth attempt: final, no throw
    const after = await h.deps.dbs.system.selectFrom("webhookDeliveries").selectAll().executeTakeFirstOrThrow();
    expect(after).toMatchObject({ status: "failed", attempts: 5 });
    const hooks = await c.ok("GET", "/api/v1/w/acme/webhooks");
    expect(hooks[0].consecutiveFailures).toBe(1);
    const log = await c.ok("GET", `/api/v1/w/acme/webhooks/${hooks[0].id}/deliveries`);
    expect(log[0]).toMatchObject({ status: "failed", attempts: 5 });
  });

  it("refuses private network addresses on hosted servers", async () => {
    const strict = await createHarness();
    try {
      await strict.reset();
      const { c } = await setupWorkspace(strict, "ann@acme.co", "acme");
      for (const u of ["http://127.0.0.1/x", "http://169.254.169.254/latest", "http://10.0.0.5/", "http://[::1]/", "ftp://example.com/"]) {
        expect((await c.post("/api/v1/w/acme/webhooks", { url: u, events: ["issue.created"] })).status, u).toBe(400);
      }
    } finally {
      await strict.close();
    }
    expect(isPrivateAddress("192.168.1.1")).toBe(true);
    expect(isPrivateAddress("::ffff:10.1.2.3")).toBe(true);
    expect(isPrivateAddress("8.8.8.8")).toBe(false);
    expect(isPrivateAddress("2606:4700::1111")).toBe(false);
  });

  it("only admins manage webhooks", async () => {
    const { c } = await setupWorkspace(h, "ann@acme.co", "acme");
    const inv = await c.ok("POST", "/api/v1/w/acme/invites", { role: "member" });
    const m = await new Client(h).login("m@acme.co");
    await m.ok("POST", `/api/v1/invites/${inv.url.split("/").pop()}/accept`);
    expect((await m.get("/api/v1/w/acme/webhooks")).status).toBe(403);
  });
});

describe("importers", () => {
  const linear = [
    'ID,Team,Title,Description,Status,Estimate,Priority,Assignee,Labels,Created,Due Date,Parent issue',
    'LIN-1,Core,"Parent task","Multi\nline, with comma",In Progress,3,High,ann@acme.co,"bug, ui",2025-01-02T10:00:00Z,2025-02-01,',
    'LIN-2,Core,Child task,,Todo,,Urgent,Somebody Else,ui,2025-01-03T10:00:00Z,,LIN-1',
    'LIN-3,Core,Shipped,,Shipped,,No priority,,,2025-01-04T10:00:00Z,,',
  ].join("\n");

  it("parses CSV correctly", () => {
    expect(parseCsv('a,b\n"x, ""y""",2\r\n')).toEqual([["a", "b"], ['x, "y"', "2"]]);
    const p = parseLinearCsv(linear);
    expect(p.issues[0]).toMatchObject({ externalId: "LIN-1", description: "Multi\nline, with comma", priority: 2, labels: ["bug", "ui"], estimate: 3, dueDate: "2025-02-01" });
    expect(p.issues[1]).toMatchObject({ priority: 1, parentExternalId: "LIN-1" });
    expect(p.statuses).toEqual(["In Progress", "Todo", "Shipped"]);
    expect(guessCategory("Shipped")).toBe("completed");
    expect(guessCategory("Won't do")).toBe("canceled");
    expect(() => parseLinearCsv("a,b\n1,2")).toThrow(/Linear/);
  });

  it("imports Linear into a team: statuses, labels, people, parents, original dates", async () => {
    const { c, team } = await setupWorkspace(h, "ann@acme.co", "acme");
    const dry = await c.ok("POST", "/api/v1/w/acme/import", { source: "linear", teamId: team.id, content: linear, dryRun: true });
    expect(dry).toMatchObject({ issues: 3, dryRun: true, statusesCreated: ["Shipped"], labelsCreated: ["bug", "ui"], unmatchedAssignees: ["Somebody Else"] });
    expect((await c.ok("GET", "/api/v1/w/acme/issues")).issues).toEqual([]);
    const r = await c.ok("POST", "/api/v1/w/acme/import", { source: "linear", teamId: team.id, content: linear });
    expect(r.issues).toBe(3);
    const issues = (await c.ok("GET", "/api/v1/w/acme/issues")).issues;
    expect(issues.map((i: { identifier: string }) => i.identifier)).toEqual(["ACME-1", "ACME-2", "ACME-3"]);
    const me = await c.ok("GET", "/api/v1/me");
    const parent = issues.find((i: { title: string }) => i.title === "Parent task");
    expect(parent).toMatchObject({ assigneeIds: [me.id], priority: 2, createdAt: "2025-01-02T10:00:00.000Z" });
    expect(issues.find((i: { title: string }) => i.title === "Child task").parentId).toBe(parent.id);
    const states = await c.ok("GET", "/api/v1/w/acme/states");
    expect(states.find((s: { name: string }) => s.name === "Shipped").category).toBe("completed");
    // Importing again reuses statuses and labels.
    const again = await c.ok("POST", "/api/v1/w/acme/import", { source: "linear", teamId: team.id, content: linear, dryRun: true });
    expect(again).toMatchObject({ statusesCreated: [], labelsCreated: [] });
    expect((await c.ok("GET", `/api/v1/w/acme/issues/${parent.id}/activity`))[0].kind).toBe("imported");
  });

  it("imports Jira with repeated label and comment columns", async () => {
    const jira = [
      "Summary,Issue key,Issue id,Status,Priority,Assignee,Created,Description,Labels,Labels,Comment,Comment,Parent id",
      'Login fails,PROJ-7,10007,Done,Highest,ann@acme.co,2025-03-01 09:00,Broken,backend,urgent,"2025-03-02 10:00;jdoe;Looking into it","2025-03-03 10:00;ann@acme.co;Fixed",',
      "Sub task,PROJ-8,10008,To Do,Low,,2025-03-04 09:00,,,,,,10007",
    ].join("\n");
    const p = parseJiraCsv(jira);
    expect(p.issues[0]).toMatchObject({ labels: ["backend", "urgent"], priority: 1, comments: [{ author: "jdoe", body: "Looking into it" }, { author: "ann@acme.co", body: "Fixed" }] });
    expect(p.issues[1]!.parentExternalId).toBe("PROJ-7");
    const { c, team } = await setupWorkspace(h, "ann@acme.co", "acme");
    await c.ok("POST", "/api/v1/w/acme/import", { source: "jira", teamId: team.id, content: jira });
    const comments = await c.ok("GET", "/api/v1/w/acme/issues/ACME-1/comments");
    const me = await c.ok("GET", "/api/v1/me");
    expect(comments.map((x: { body: string; authorId: string }) => [x.body, x.authorId === me.id])).toEqual([
      ["**jdoe** (imported):\n\nLooking into it", true],
      ["Fixed", true],
    ]);
    expect((await c.ok("GET", "/api/v1/w/acme/issues/ACME-2")).parentId).toBe((await c.ok("GET", "/api/v1/w/acme/issues/ACME-1")).id);
  });

  it("imports a Trello board: lists become statuses, comments come along", async () => {
    const board = {
      lists: [{ id: "l1", name: "Ideas" }, { id: "l2", name: "Doing" }, { id: "l3", name: "Old", closed: true }],
      labels: [{ id: "lb1", name: "design", color: "green" }],
      members: [{ id: "m1", fullName: "Ann" }],
      cards: [
        { id: "c1", name: "Card one", desc: "d", idList: "l2", idLabels: ["lb1"], idMembers: ["m1"], due: "2025-05-01T12:00:00Z" },
        { id: "c2", name: "Archived", idList: "l1", closed: true },
      ],
      actions: [{ type: "commentCard", date: "2025-04-01T00:00:00Z", data: { card: { id: "c1" }, text: "Nice" }, memberCreator: { fullName: "Bob" } }],
    };
    const p = parseTrelloJson(JSON.stringify(board));
    expect(p.issues).toHaveLength(1);
    expect(p.statuses).toEqual(["Ideas", "Doing"]);
    const { c, team } = await setupWorkspace(h, "ann@acme.co", "acme");
    await c.ok("PATCH", "/api/v1/me", { name: "Ann" });
    const r = await c.ok("POST", "/api/v1/w/acme/import", { source: "trello", teamId: team.id, content: JSON.stringify(board) });
    expect(r).toMatchObject({ issues: 1, comments: 1, statusesCreated: ["Ideas", "Doing"], unmatchedAssignees: [] });
    const i = await c.ok("GET", "/api/v1/w/acme/issues/ACME-1");
    expect(i).toMatchObject({ dueDate: "2025-05-01", description: "d" });
    expect((await c.post("/api/v1/w/acme/import", { source: "trello", teamId: team.id, content: "not json" })).status).toBe(400);
  });
});

describe("GitHub integration", () => {
  async function send(workspaceId: string, secret: string, event: string, payload: object) {
    const body = JSON.stringify(payload);
    const sig = `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
    const r = await h.app.request(`/api/v1/github/webhook/${workspaceId}`, {
      method: "POST", headers: { "content-type": "application/json", "x-github-event": event, "x-hub-signature-256": sig }, body,
    });
    return { status: r.status, body: await r.json() };
  }
  const pr = (action: string, extra: object = {}) => ({
    action,
    repository: { full_name: "acme/app" },
    pull_request: { html_url: "https://github.com/acme/app/pull/42", number: 42, title: "Fix login (ACME-1)", body: "Also relates to acme-2", state: "open", merged: false, head: { ref: "feature/ACME-1-login" }, ...extra },
  });

  it("links pull requests to issues by key and moves them to Done on merge", async () => {
    const { c, team } = await setupWorkspace(h, "ann@acme.co", "acme");
    const one = await c.ok("POST", "/api/v1/w/acme/issues", { teamId: team.id, title: "login" });
    await c.ok("POST", "/api/v1/w/acme/issues", { teamId: team.id, title: "other" });
    const g = await c.ok("PUT", "/api/v1/w/acme/integrations/github", {});
    const wsId = g.webhookUrl.split("/").pop();
    expect((await send(wsId, g.secret, "ping", {})).body.pong).toBe(true);
    const opened = await send(wsId, g.secret, "pull_request", pr("opened"));
    expect(opened.body.linked.sort()).toEqual(["ACME-1", "ACME-2"]);
    await send(wsId, g.secret, "pull_request", pr("edited"));
    let d = await c.ok("GET", `/api/v1/w/acme/issues/${one.id}`);
    expect(d.links).toEqual([expect.objectContaining({ provider: "github", state: "open", title: "acme/app#42 Fix login (ACME-1)" })]);
    await send(wsId, g.secret, "pull_request", pr("closed", { state: "closed", merged: true }));
    d = await c.ok("GET", `/api/v1/w/acme/issues/${one.id}`);
    const states = await c.ok("GET", "/api/v1/w/acme/states");
    expect(states.find((s: { id: string }) => s.id === d.statusId).name).toBe("Done");
    expect(d.links[0].state).toBe("merged");
    const kinds = (await c.ok("GET", `/api/v1/w/acme/issues/${one.id}/activity`)).map((a: { kind: string }) => a.kind);
    expect(kinds).toEqual(["created", "pr_linked", "pr_merged", "status"]);
  });

  it("rejects bad signatures and ignores issues of other workspaces", async () => {
    const { c } = await setupWorkspace(h, "ann@acme.co", "acme");
    const other = await setupWorkspace(h, "bob@b.co", "bravo");
    await other.c.ok("POST", "/api/v1/w/bravo/issues", { teamId: other.team.id, title: "bravo issue" });
    const g = await c.ok("PUT", "/api/v1/w/acme/integrations/github", {});
    const wsId = g.webhookUrl.split("/").pop();
    expect((await send(wsId, "wrong", "pull_request", pr("opened"))).status).toBe(401);
    const r = await send(wsId, g.secret, "pull_request", pr("opened", { title: "Touches BRAVO-1", body: "", head: { ref: "x" } }));
    expect(r.body.linked).toEqual([]);
    await c.ok("DELETE", "/api/v1/w/acme/integrations/github");
    expect((await send(wsId, g.secret, "ping", {})).status).toBe(401);
  });

  it("finds keys in text", () => {
    expect(findIssueKeys("Fix ENG-12 and eng-13", "branch/ENG-12-x", "noKEY-1x, A-1")).toEqual([
      { key: "ENG", number: 12 }, { key: "ENG", number: 13 }, { key: "NOKEY", number: 1 },
    ]);
  });
});
