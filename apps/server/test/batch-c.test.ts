import { createHmac } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { intakeLimits, notifyResolvedRequests } from "../src/modules/intake";
import { Client, createHarness, type Harness, setupWorkspace } from "./harness";

const SECRET = "inbound-test-secret-123";
let h: Harness;
beforeAll(async () => {
  h = await createHarness({ INBOUND_EMAIL_DOMAIN: "in.example.com", INBOUND_EMAIL_SECRET: SECRET });
});
beforeEach(async () => {
  await h.reset();
  intakeLimits.reset();
});
afterAll(async () => {
  await h?.close();
});

/** Workspace "acme": ann (admin), plus a member, a viewer and a guest. */
async function setup() {
  const a = await setupWorkspace(h, "ann@acme.co", "acme");
  const join = async (email: string, role: string) => {
    const inv = await a.c.ok("POST", "/api/v1/w/acme/invites", { role });
    const cl = await new Client(h).login(email, email.split("@")[0]);
    await cl.ok("POST", `/api/v1/invites/${inv.url.split("/").pop()}/accept`);
    return { c: cl, id: (await cl.ok("GET", "/api/v1/me")).id as string };
  };
  const ben = await join("ben@acme.co", "member");
  const vic = await join("vic@acme.co", "viewer");
  const st = (name: string) => a.states.find((s) => s.name === name)!.id;
  return { ...a, ben, vic, st };
}

describe("private teams", () => {
  it("hides a private team and its issues from non-members, including links and notifications", async () => {
    const { c, team, ben, vic } = await setup();
    const secret = await c.ok("POST", "/api/v1/w/acme/teams", { name: "Security", key: "SEC", private: true });
    await c.ok("POST", "/api/v1/w/acme/labels", { name: "pentest", color: "#aa0000", teamId: secret.id });
    expect((await ben.c.ok("GET", "/api/v1/w/acme/labels")).map((l: { name: string }) => l.name)).not.toContain("pentest");
    expect(secret.private).toBe(true);
    const hidden = await c.ok("POST", "/api/v1/w/acme/issues", { teamId: secret.id, title: "Rotate keys", description: "@ben please look" });
    const open = await c.ok("POST", "/api/v1/w/acme/issues", { teamId: team.id, title: "Public work" });
    await c.ok("POST", `/api/v1/w/acme/issues/${open.id}/relations`, { relatedIssueId: hidden.id, type: "blocks" });

    for (const who of [ben.c, vic.c]) {
      const teams = await who.ok("GET", "/api/v1/w/acme/teams");
      expect(teams.map((t: { key: string }) => t.key)).not.toContain("SEC");
      expect((await who.get(`/api/v1/w/acme/issues/${hidden.id}`)).status).toBe(404);
      expect((await who.get("/api/v1/w/acme/issues/SEC-1")).status).toBe(404);
      const list = await who.ok("GET", "/api/v1/w/acme/issues");
      expect(list.issues ?? list).not.toContainEqual(expect.objectContaining({ id: hidden.id }));
      expect((await who.ok("GET", `/api/v1/w/acme/issues/${open.id}`)).relations).toEqual([]);
    }
    // The mention didn't reach ben, so the title never leaked into his inbox.
    expect(await ben.c.ok("GET", "/api/v1/w/acme/notifications")).toEqual([]);

    // Joining the team makes it visible.
    await c.ok("PUT", `/api/v1/w/acme/teams/${secret.id}/members/${ben.id}`);
    expect((await ben.c.ok("GET", "/api/v1/w/acme/teams")).map((t: { key: string }) => t.key)).toContain("SEC");
    expect((await ben.c.ok("GET", `/api/v1/w/acme/issues/${hidden.id}`)).title).toBe("Rotate keys");
    expect((await ben.c.ok("GET", `/api/v1/w/acme/issues/${open.id}`)).relations).toHaveLength(1);

    // Making it public again shows it to everyone.
    await c.ok("PATCH", `/api/v1/w/acme/teams/${secret.id}`, { private: false });
    expect((await vic.c.ok("GET", "/api/v1/w/acme/teams")).map((t: { key: string }) => t.key)).toContain("SEC");
    const log = await c.ok("GET", "/api/v1/w/acme/audit");
    expect((log.entries ?? log).map((e: { action: string }) => e.action)).toContain("team.made_public");
  });

  it("renaming a private team keeps it private", async () => {
    const { c } = await setup();
    const t = await c.ok("POST", "/api/v1/w/acme/teams", { name: "HR", key: "HR", private: true });
    const r = await c.ok("PATCH", `/api/v1/w/acme/teams/${t.id}`, { name: "People" });
    expect(r.private).toBe(true);
  });
});

describe("viewers", () => {
  it("can read but not change anything", async () => {
    const { c, team, vic } = await setup();
    const i = await c.ok("POST", "/api/v1/w/acme/issues", { teamId: team.id, title: "Read me" });
    expect((await vic.c.ok("GET", `/api/v1/w/acme/issues/${i.id}`)).title).toBe("Read me");
    const blocked = await vic.c.post("/api/v1/w/acme/issues", { teamId: team.id, title: "nope" });
    expect(blocked.status).toBe(403);
    expect(blocked.body.code ?? blocked.body.error?.code).toBe("read_only_viewer");
    expect((await vic.c.patch(`/api/v1/w/acme/issues/${i.id}`, { title: "x" })).status).toBe(403);
    expect((await vic.c.post(`/api/v1/w/acme/issues/${i.id}/comments`, { body: "hi" })).status).toBe(403);
    expect((await vic.c.post("/api/v1/w/acme/labels", { name: "x", color: "#000000" })).status).toBe(403);
    // Their own things still work.
    await vic.c.ok("PUT", `/api/v1/w/acme/issues/${i.id}/subscription`, { subscribed: true });
    await vic.c.ok("POST", "/api/v1/w/acme/notifications/read", {});
    const members = await c.ok("GET", "/api/v1/w/acme/members");
    expect(members.find((m: { userId: string }) => m.userId === vic.id).role).toBe("viewer");
  });

  it("are not counted as members for costs", async () => {
    const { vic } = await setup();
    const { sql } = await import("kysely");
    const r = await sql<{ n: string }>`SELECT count(*) AS n FROM workspace_members m WHERE m.role <> 'viewer'`.execute(h.deps.dbs.owner);
    expect(Number(r.rows[0]!.n)).toBe(2);
    expect(vic.id).toBeTruthy();
  });
});

describe("GitLab and Gitea", () => {
  it("links GitLab merge requests and moves issues to Done on merge", async () => {
    const { c, team } = await setup();
    const i = await c.ok("POST", "/api/v1/w/acme/issues", { teamId: team.id, title: "Login bug" });
    const gl = await c.ok("PUT", "/api/v1/w/acme/integrations/gitlab", { moveOnMerge: true });
    expect(gl.webhookUrl).toMatch(/\/api\/v1\/git\/gitlab\/webhook\//);
    const send = (token: string, state: string) => h.app.request(new URL(gl.webhookUrl).pathname, {
      method: "POST", headers: { "content-type": "application/json", "x-gitlab-event": "Merge Request Hook", "x-gitlab-token": token },
      body: JSON.stringify({ object_kind: "merge_request", project: { path_with_namespace: "acme/app" }, object_attributes: { iid: 7, title: "Fix ACME-1", description: null, url: "https://gitlab.com/acme/app/-/merge_requests/7", state, source_branch: "fix" } }),
    });
    expect((await send("wrong", "opened")).status).toBe(401);
    expect((await send(gl.secret, "opened")).status).toBe(200);
    let d = await c.ok("GET", `/api/v1/w/acme/issues/${i.id}`);
    expect(d.links).toEqual([expect.objectContaining({ provider: "gitlab", state: "open", title: "acme/app!7 Fix ACME-1" })]);
    await send(gl.secret, "merged");
    d = await c.ok("GET", `/api/v1/w/acme/issues/${i.id}`);
    expect(d.links[0].state).toBe("merged");
    const states = await c.ok("GET", "/api/v1/w/acme/states");
    expect(states.find((s: { id: string }) => s.id === d.statusId).category).toBe("completed");
  });

  it("verifies Gitea/Forgejo signatures", async () => {
    const { c, team } = await setup();
    await c.ok("POST", "/api/v1/w/acme/issues", { teamId: team.id, title: "x" });
    const gt = await c.ok("PUT", "/api/v1/w/acme/integrations/gitea", { moveOnMerge: false });
    const body = JSON.stringify({ action: "opened", repository: { full_name: "acme/app" }, pull_request: { html_url: "https://codeberg.org/acme/app/pulls/3", number: 3, title: "ACME-1: x", body: "", state: "open", merged: false } });
    const sig = createHmac("sha256", gt.secret).update(body).digest("hex");
    const post = (headers: Record<string, string>) => h.app.request(new URL(gt.webhookUrl).pathname, { method: "POST", headers: { "content-type": "application/json", ...headers }, body });
    expect((await post({ "x-gitea-event": "pull_request", "x-gitea-signature": "00" })).status).toBe(401);
    const ok = await post({ "x-forgejo-event": "pull_request", "x-forgejo-signature": sig });
    expect(await ok.json()).toMatchObject({ ok: true, linked: ["ACME-1"] });
    const github = await c.ok("GET", "/api/v1/w/acme/integrations/github");
    expect(github.enabled).toBe(false);
    await c.ok("DELETE", "/api/v1/w/acme/integrations/gitea");
    expect((await post({ "x-forgejo-event": "pull_request", "x-forgejo-signature": sig })).status).toBe(401);
  });
});

describe("public request forms", () => {
  it("turns submissions into issues and emails the requester once it's done", async () => {
    const { c, team, st, ben } = await setup();
    const label = await c.ok("POST", "/api/v1/w/acme/labels", { name: "request", color: "#123456" });
    expect((await ben.c.post("/api/v1/w/acme/intake", { teamId: team.id, kind: "form", name: "x" })).status).toBe(403);
    const form = await c.ok("POST", "/api/v1/w/acme/intake", {
      teamId: team.id, kind: "form", name: "Feature requests", intro: "Tell us what you need.", labelIds: [label.id], statusId: st("Todo"), requireEmail: true,
    });
    const path = `/api/v1/forms/${form.address.split("/").pop()}`;
    const anon = new Client(h);
    expect(await anon.ok("GET", path)).toEqual({ name: "Feature requests", intro: "Tell us what you need.", workspaceName: "ACME", requireEmail: true });
    expect((await anon.post(path, { title: "Dark mode" })).status).toBe(400);
    await anon.ok("POST", path, { title: "Dark mode please", description: "My eyes @ann", email: "Pat@Example.com", name: "Pat" });
    // Honeypot: looks fine, creates nothing.
    await anon.ok("POST", path, { title: "Buy pills", email: "x@y.z", website: "spam.example" });
    const list = await c.ok("GET", "/api/v1/w/acme/issues");
    const issues = list.issues ?? list;
    expect(issues).toHaveLength(1);
    const d = await c.ok("GET", `/api/v1/w/acme/issues/${issues[0].id}`);
    expect(d).toMatchObject({ title: "Dark mode please", statusId: st("Todo"), labelIds: [label.id], creatorId: "", requester: { via: "form", email: "pat@example.com", name: "Pat", channelName: "Feature requests" } });
    // A mention in a public submission notifies nobody.
    expect(await c.ok("GET", "/api/v1/w/acme/notifications")).toEqual([]);

    expect(await notifyResolvedRequests(h.deps)).toBe(0);
    await c.ok("PATCH", `/api/v1/w/acme/issues/${d.id}`, { statusId: st("Done") });
    expect(await notifyResolvedRequests(h.deps)).toBe(1);
    expect(await notifyResolvedRequests(h.deps)).toBe(0);
    expect(h.mailer.last("pat@example.com")?.subject).toBe("Done: Dark mode please");
  });

  it("rate limits, and closed forms are gone", async () => {
    const { c, team } = await setup();
    const form = await c.ok("POST", "/api/v1/w/acme/intake", { teamId: team.id, kind: "form", name: "Bugs" });
    const path = `/api/v1/forms/${form.address.split("/").pop()}`;
    const anon = new Client(h);
    for (let i = 0; i < 5; i++) await anon.ok("POST", path, { title: `Bug number ${i}` });
    expect((await anon.post(path, { title: "One too many" })).status).toBe(429);
    await c.ok("PATCH", `/api/v1/w/acme/intake/${form.id}`, { enabled: false });
    expect((await anon.get(path)).status).toBe(404);
    const rotated = await c.ok("PATCH", `/api/v1/w/acme/intake/${form.id}`, { enabled: true, rotateToken: true });
    expect(rotated.address).not.toBe(form.address);
    expect((await anon.get(path)).status).toBe(404);
  });
});

describe("email to issue", () => {
  const mime = (p: { from: string; to: string; subject: string; body: string; messageId?: string; inReplyTo?: string; extra?: string; attachment?: boolean }) => {
    const b = "BOUNDARY42";
    const head = [
      `From: ${p.from}`, `To: ${p.to}`, `Subject: ${p.subject}`, `Message-ID: ${p.messageId ?? `<${Math.random()}@mail.example>`}`,
      ...(p.inReplyTo ? [`In-Reply-To: ${p.inReplyTo}`] : []), ...(p.extra ? [p.extra] : []), "MIME-Version: 1.0",
    ];
    if (!p.attachment) return [...head, "Content-Type: text/plain; charset=utf-8", "", p.body, ""].join("\r\n");
    return [...head, `Content-Type: multipart/mixed; boundary="${b}"`, "", `--${b}`, "Content-Type: text/plain; charset=utf-8", "", p.body,
      `--${b}`, "Content-Type: text/plain; name=\"log.txt\"", "Content-Disposition: attachment; filename=\"log.txt\"", "Content-Transfer-Encoding: base64", "",
      Buffer.from("error at line 3").toString("base64"), `--${b}--`, ""].join("\r\n");
  };
  const deliver = (raw: string, to: string, secret = SECRET) => h.app.request(`/api/v1/inbound/email?to=${encodeURIComponent(to)}`, {
    method: "POST", headers: { "content-type": "message/rfc822", "x-glasstrack-inbound-secret": secret }, body: raw,
  });

  it("creates issues with attachments, and replies become comments", async () => {
    const { c, team } = await setup();
    const inbox = await c.ok("POST", "/api/v1/w/acme/intake", { teamId: team.id, kind: "email", name: "Support" });
    expect(inbox.address).toMatch(/^in-[a-z0-9]+@in\.example\.com$/);
    const raw = mime({ from: "Sam <sam@customer.com>", to: inbox.address, subject: "App crashes on save", body: "It crashes.", messageId: "<first@customer.com>", attachment: true });
    expect((await deliver(raw, inbox.address, "wrong")).status).toBe(401);
    expect((await deliver(raw, "in-nope12345@in.example.com")).status).toBe(404);
    const r = await deliver(raw, inbox.address);
    expect(r.status).toBe(201);
    const { issue } = (await r.json()) as { issue: string };
    const d = await c.ok("GET", `/api/v1/w/acme/issues/${issue}`);
    expect(d).toMatchObject({ title: "App crashes on save", description: "It crashes.", requester: { via: "email", email: "sam@customer.com", name: "Sam" } });
    expect(d.attachments).toEqual([expect.objectContaining({ filename: "log.txt", size: 15 })]);

    const reply = mime({ from: "sam@customer.com", to: inbox.address, subject: "Re: App crashes on save", body: "Still broken.\n\nOn Tue, Ann wrote:\n> old text", inReplyTo: "<first@customer.com>" });
    expect(await (await deliver(reply, inbox.address)).json()).toMatchObject({ ok: true, commented: d.id });
    const comments = await c.ok("GET", `/api/v1/w/acme/issues/${d.id}/comments`);
    expect(comments).toHaveLength(1);
    expect(comments[0].body).toBe("Still broken.\n\n_Email from sam@customer.com_");
    expect((await c.ok("GET", "/api/v1/w/acme/issues")).issues ?? []).toBeDefined();
  });

  it("ignores automatic mail and, when set, non-members", async () => {
    const { c, team } = await setup();
    const inbox = await c.ok("POST", "/api/v1/w/acme/intake", { teamId: team.id, kind: "email", name: "Team", membersOnly: true });
    const auto = await deliver(mime({ from: "ben@acme.co", to: inbox.address, subject: "Out of office", body: "Away", extra: "Auto-Submitted: auto-replied" }), inbox.address);
    expect(await auto.json()).toMatchObject({ ignored: "automatic" });
    const stranger = await deliver(mime({ from: "x@evil.example", to: inbox.address, subject: "hi", body: "hi" }), inbox.address);
    expect(await stranger.json()).toMatchObject({ ignored: "not_a_member" });
    const member = await deliver(mime({ from: "BEN@acme.co", to: inbox.address, subject: "Printer is out of toner", body: "" }), inbox.address);
    expect(member.status).toBe(201);
  });
});
