import { createWriteStream } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { createGzip } from "node:zlib";
import { sql } from "kysely";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { importWorkspaceArchive } from "../src/importers/workspaceArchive";
import { extractTarGz, TarWriter } from "../src/lib/tar";
import { workspacePrefix } from "../src/storage";
import { Client, createHarness, type Harness, setupWorkspace } from "./harness";

let h: Harness;
let dir: string;
beforeAll(async () => {
  h = await createHarness();
  dir = await mkdtemp(path.join(tmpdir(), "gt-import-test-"));
});
beforeEach(async () => {
  await h.reset();
});
afterAll(async () => {
  await h?.close();
  await rm(dir, { recursive: true, force: true });
});

const LONG_NAME = "Skärmavbild 2026-10-18 kl. 14.32.11 of the broken login page showing the error message.png";
let n = 0;
const tmp = (name: string) => path.join(dir, `${++n}-${name}`);

/** A workspace using most features, exported through the real export job. */
async function exportRich(opts: { benLeaves?: boolean; extraTimeEntries?: number } = {}) {
  const { c, team, states } = await setupWorkspace(h, "ann@acme.co", "acme");
  const inv = await c.ok("POST", "/api/v1/w/acme/invites", { role: "member" });
  const ben = await new Client(h).login("ben@acme.co", "Ben Ames");
  await ben.ok("POST", `/api/v1/invites/${inv.url.split("/").pop()}/accept`);
  const benId = (await ben.ok("GET", "/api/v1/me")).id as string;
  const wsId = (await c.ok("GET", "/api/v1/w/acme")).id as string;
  const st = (name: string) => states.find((s: { name: string }) => s.name === name)!.id as string;

  const secret = await c.ok("POST", "/api/v1/w/acme/teams", { name: "Security", key: "SEC", private: true });
  const label = await c.ok("POST", "/api/v1/w/acme/labels", { name: "bug", color: "#d73a4a", teamId: team.id });
  const field = await c.ok("POST", "/api/v1/w/acme/fields", { name: "Owner", type: "user" });
  const cycle = await c.ok("POST", `/api/v1/w/acme/teams/${team.id}/cycles`, { startsOn: "2026-10-01", endsOn: "2026-10-14" });
  const one = await c.ok("POST", "/api/v1/w/acme/issues", {
    teamId: team.id, title: "Login fails", description: "Steps: **click**", labelIds: [label.id], assigneeIds: [benId], cycleId: cycle.id,
    startDate: "2026-10-02", dueDate: "2026-10-09", estimate: 3, fields: { [field.id]: benId },
  });
  const two = await c.ok("POST", "/api/v1/w/acme/issues", { teamId: team.id, title: "Child task", parentId: one.id });
  await c.ok("POST", "/api/v1/w/acme/issues", { teamId: secret.id, title: "Rotate keys" });
  const gone = await c.ok("POST", "/api/v1/w/acme/issues", { teamId: team.id, title: "Deleted later" });
  await sql`DELETE FROM issues WHERE id = ${gone.id}`.execute(h.deps.dbs.owner);
  await c.ok("PATCH", `/api/v1/w/acme/issues/${one.id}`, { statusId: st("In Progress") });
  await c.ok("POST", `/api/v1/w/acme/issues/${one.id}/relations`, { relatedIssueId: two.id, type: "blocks" });
  await ben.ok("POST", `/api/v1/w/acme/issues/${one.id}/comments`, { body: "I can reproduce this." });
  await ben.ok("POST", `/api/v1/w/acme/issues/${one.id}/time`, { minutes: 45, spentOn: "2026-10-03", note: "debugging" });
  const tpl = await c.ok("POST", "/api/v1/w/acme/templates", { teamId: team.id, name: "Bug", title: "Bug: ", labelIds: [label.id] });
  await c.ok("POST", "/api/v1/w/acme/recurring", { templateId: tpl.id, frequency: "weekly", weekdays: [1], hour: 9, timezone: "Europe/London", startsOn: "2026-10-05" });
  await c.ok("POST", "/api/v1/w/acme/automations", { name: "Tag done", teamId: team.id, trigger: "status_changed", actions: [{ type: "add_labels", labelIds: [label.id] }] });
  await c.ok("POST", "/api/v1/w/acme/views", { name: "Ben's bugs", shared: true, filters: { label: [label.id], assignee: [benId], field: [`${field.id}:${benId}`] } });
  await sql`INSERT INTO issue_links (id, workspace_id, issue_id, provider, url, title, state)
    VALUES (gen_random_uuid(), ${wsId}, ${one.id}, 'github', 'https://github.com/acme/app/pull/7', 'acme/app#7 Fix login', 'merged')`.execute(h.deps.dbs.owner);
  // An attachment with a long, non-ASCII name, stored the way uploads are.
  const attId = "01900000-0000-7000-8000-00000000a77a";
  const key = `${workspacePrefix(wsId)}attachments/${attId}/file`;
  await h.deps.storage.put(key, Buffer.from("PNG-BYTES-123"), "image/png");
  await sql`INSERT INTO attachments (id, workspace_id, issue_id, storage_key, filename, content_type, size_bytes, uploaded_at)
    VALUES (${attId}, ${wsId}, ${one.id}, ${key}, ${LONG_NAME}, 'image/png', 13, now())`.execute(h.deps.dbs.owner);
  if (opts.extraTimeEntries) {
    await sql`INSERT INTO time_entries (id, workspace_id, issue_id, user_id, spent_on, minutes)
      SELECT gen_random_uuid(), ${wsId}, ${one.id}, ${benId}, '2026-10-04', 1 FROM generate_series(1, ${opts.extraTimeEntries})`.execute(h.deps.dbs.owner);
  }
  if (opts.benLeaves) await c.ok("DELETE", `/api/v1/w/acme/members/${benId}`);

  await c.ok("POST", "/api/v1/w/acme/exports");
  const ex = await h.deps.dbs.system.selectFrom("exports").select(["status", "storageKey", "error"]).where("workspaceId", "=", wsId).executeTakeFirstOrThrow();
  expect(ex.status, ex.error ?? "").toBe("done");
  const file = tmp("export.tar.gz");
  await pipeline(await h.deps.storage.get(ex.storageKey!), createWriteStream(file));
  return { c, ben, benId, file, one, two, team, label, field, wsId, st };
}

/** Rewrites workspace.json inside an export (to simulate an older version). */
async function rewriteArchive(file: string, edit: (json: Record<string, unknown>) => void) {
  const work = await mkdtemp(path.join(dir, "rw-"));
  const entries = await extractTarGz(file, work);
  const out = tmp("rewritten.tar.gz");
  const gz = createGzip();
  const done = pipeline(gz, createWriteStream(out));
  const tar = new TarWriter(gz);
  for (const e of entries) {
    if (e.name.endsWith("workspace.json")) {
      const json = JSON.parse(await readFile(e.path, "utf8"));
      edit(json);
      await tar.addBuffer(e.name, JSON.stringify(json));
    } else await tar.addFile(e.name, e.path, e.size);
  }
  await tar.finish();
  await done;
  return out;
}

const read = async (key: string) => {
  const chunks: Buffer[] = [];
  for await (const ch of await h.deps.storage.get(key)) chunks.push(ch as Buffer);
  return Buffer.concat(chunks).toString();
};

describe("importing a workspace export", () => {
  it("round-trips identifiers, comments, history, attachments and settings into a new workspace", async () => {
    const src = await exportRich();
    const before = await src.c.ok("GET", "/api/v1/w/acme/issues/ACME-1");
    const report = await importWorkspaceArchive(h.deps, src.file, { slug: "acme-copy" });
    expect(report.counts).toMatchObject({ issues: 3, comments: 1, attachments: 1, teams: 2, members: 2, automations: 1, pullRequestLinks: 1, savedViews: 1 });
    expect(report.matchedAccounts).toEqual([{ email: "ann@acme.co", role: "admin" }, { email: "ben@acme.co", role: "member" }]);
    expect(report.newAccounts).toEqual([]);
    expect(report.warnings.join(" ")).toContain("Recurring issues were imported paused");

    const c = src.c;
    const after = await c.ok("GET", "/api/v1/w/acme-copy/issues/ACME-1");
    expect(after.id).not.toBe(before.id);
    for (const k of ["identifier", "title", "description", "priority", "startDate", "dueDate", "estimate", "createdAt"]) expect(after[k], k).toEqual(before[k]);
    expect(after.children.map((x: { identifier: string }) => x.identifier)).toEqual(["ACME-2"]);
    expect(after.relations[0]).toMatchObject({ type: "blocks", issue: { identifier: "ACME-2" } });
    expect(after.timeSpentMinutes).toBe(45);
    expect(after.links).toEqual([expect.objectContaining({ provider: "github", url: "https://github.com/acme/app/pull/7", state: "merged" })]);
    expect(after.attachments).toEqual([expect.objectContaining({ size: 13 })]);
    expect(after.attachments[0].filename).toContain("2026-10-18");
    const copyKey = await h.deps.dbs.system.selectFrom("attachments").select("storageKey").where("id", "=", after.attachments[0].id).executeTakeFirstOrThrow();
    expect(await read(copyKey.storageKey)).toBe("PNG-BYTES-123");

    const history = await c.ok("GET", `/api/v1/w/acme-copy/issues/${after.id}/activity`);
    const historyBefore = await c.ok("GET", `/api/v1/w/acme/issues/${before.id}/activity`);
    expect(history.map((x: { kind: string }) => x.kind)).toEqual(historyBefore.map((x: { kind: string }) => x.kind));
    const teams = await c.ok("GET", "/api/v1/w/acme-copy/teams");
    expect(teams.find((t: { key: string }) => t.key === "SEC").private).toBe(true);
    expect((await c.ok("GET", "/api/v1/w/acme-copy/automations"))[0]).toMatchObject({ name: "Tag done", enabled: false });
    const next = await c.ok("POST", "/api/v1/w/acme-copy/issues", { teamId: teams.find((t: { key: string }) => t.key === "ACME").id, title: "New" });
    expect(next.identifier).toBe("ACME-4"); // ACME-3 was deleted; its number isn't reused
    expect((await c.ok("GET", "/api/v1/w/acme/issues/ACME-1")).id).toBe(before.id); // the original is untouched
  });

  it("on a fresh server every reference follows the new ids: assignees, authors, history, fields, templates, automations, views", async () => {
    const src = await exportRich();
    // A different server: nobody has an account yet, so everyone gets a new id.
    await sql`UPDATE users SET email = 'old-' || email`.execute(h.deps.dbs.owner);
    const r = await importWorkspaceArchive(h.deps, src.file, { slug: "moved", name: "Moved Co" });
    expect(r.newAccounts.sort()).toEqual(["ann@acme.co", "ben@acme.co"]);
    const ann = await new Client(h).login("ann@acme.co");
    const newBen = (await new Client(h).login("ben@acme.co").then((b) => b.ok("GET", "/api/v1/me"))).id as string;
    expect(newBen).not.toBe(src.benId);
    const ws = await ann.ok("GET", "/api/v1/w/moved");
    expect(ws).toMatchObject({ name: "Moved Co", role: "admin" });

    const issue = await ann.ok("GET", "/api/v1/w/moved/issues/ACME-1");
    expect(issue.assigneeIds).toEqual([newBen]);
    expect(Object.values(issue.fields)).toEqual([newBen]);
    const comments = await ann.ok("GET", `/api/v1/w/moved/issues/${issue.id}/comments`);
    expect(comments[0]).toMatchObject({ authorId: newBen, body: "I can reproduce this." });
    const states = await ann.ok("GET", "/api/v1/w/moved/states");
    const inProgress = states.find((s: { name: string; teamId: string }) => s.name === "In Progress" && s.teamId === issue.teamId).id;
    const history = await ann.ok("GET", `/api/v1/w/moved/issues/${issue.id}/activity`);
    expect(history.find((x: { kind: string }) => x.kind === "status").data.to).toBe(inProgress);
    const labels = await ann.ok("GET", "/api/v1/w/moved/labels");
    const newLabel = labels.find((l: { name: string }) => l.name === "bug").id;
    expect(newLabel).not.toBe(src.label.id);
    expect(issue.labelIds).toEqual([newLabel]);
    const tpls = await ann.ok("GET", "/api/v1/w/moved/templates");
    expect(tpls[0].labelIds).toEqual([newLabel]);
    expect((await ann.ok("GET", "/api/v1/w/moved/automations"))[0].actions).toEqual([{ type: "add_labels", labelIds: [newLabel] }]);
    const fields = await ann.ok("GET", "/api/v1/w/moved/fields");
    const views = await ann.ok("GET", "/api/v1/w/moved/views");
    expect(views[0].filters).toEqual({ label: [newLabel], assignee: [newBen], field: [`${fields[0].id}:${newBen}`] });
    // No old id is left anywhere in the imported rows.
    const dump = await sql<{ j: string }>`SELECT (SELECT json_agg(t) FROM issues t WHERE workspace_id = ${ws.id})::text
      || (SELECT json_agg(t) FROM activity t WHERE workspace_id = ${ws.id})::text || (SELECT json_agg(t) FROM saved_views t WHERE workspace_id = ${ws.id})::text
      || (SELECT json_agg(t) FROM issue_field_values t WHERE workspace_id = ${ws.id})::text AS j`.execute(h.deps.dbs.owner);
    for (const old of [src.benId, src.label.id, src.field.id, src.one.id, src.team.id]) expect(dump.rows[0]!.j).not.toContain(old);
  });

  it("keeps the names of people who left, without giving them access", async () => {
    const src = await exportRich({ benLeaves: true });
    await importWorkspaceArchive(h.deps, src.file, { slug: "acme-copy" });
    const issue = await src.c.ok("GET", "/api/v1/w/acme-copy/issues/ACME-1");
    const comments = await src.c.ok("GET", `/api/v1/w/acme-copy/issues/${issue.id}/comments`);
    expect(comments[0].authorId).toBe(src.benId); // matched to Ben's account by email
    const members = await src.c.ok("GET", "/api/v1/w/acme-copy/members");
    expect(members.map((m: { email: string }) => m.email)).toEqual(["ann@acme.co"]);
    expect((await src.ben.get("/api/v1/w/acme-copy")).status).toBe(404);
  });

  it("dry run writes nothing but reports what would happen; --members-as caps roles; the owner becomes admin", async () => {
    const src = await exportRich();
    const dry = await importWorkspaceArchive(h.deps, src.file, { slug: "moved", ownerEmail: "ops@new.example", membersAs: "viewer", dryRun: true });
    expect(dry).toMatchObject({ dryRun: true, workspace: { id: null }, newAccounts: ["ops@new.example"], counts: { issues: 3, comments: 1 } });
    expect(dry.matchedAccounts).toEqual([{ email: "ann@acme.co", role: "viewer" }, { email: "ben@acme.co", role: "viewer" }]);
    expect(await h.deps.dbs.system.selectFrom("workspaces").select("id").where("slug", "=", "moved").executeTakeFirst()).toBeUndefined();
    expect(await h.deps.dbs.system.selectFrom("users").select("id").where("email", "=", "ops@new.example").executeTakeFirst()).toBeUndefined();

    await importWorkspaceArchive(h.deps, src.file, { slug: "moved", ownerEmail: "ops@new.example", membersAs: "viewer" });
    const ops = await new Client(h).login("ops@new.example");
    expect((await ops.ok("GET", "/api/v1/w/moved")).role).toBe("admin");
    expect((await src.c.ok("GET", "/api/v1/w/moved")).role).toBe("viewer");
  });

  it("imports exports from before the newer fields existed", async () => {
    const src = await exportRich();
    const old = await rewriteArchive(src.file, (j) => {
      delete j.people;
      delete j.automationRules;
      delete j.issueLinks;
      for (const t of j.teams as Record<string, unknown>[]) {
        delete t.issueCounter;
        delete t.private;
      }
      for (const i of j.issues as Record<string, unknown>[]) delete i.startDate;
    });
    const r = await importWorkspaceArchive(h.deps, old, { slug: "acme-old" });
    expect(r.counts).toMatchObject({ issues: 3, comments: 1, attachments: 1, automations: 0, pullRequestLinks: 0 });
    expect(r.warnings.join(" ")).toContain("older version");
    expect((await src.c.ok("GET", "/api/v1/w/acme-old/issues/ACME-1")).title).toBe("Login fails");
  });

  it("handles thousands of rows (over Postgres's parameter limit per statement)", async () => {
    const src = await exportRich({ extraTimeEntries: 9000 });
    const r = await importWorkspaceArchive(h.deps, src.file, { slug: "big" });
    expect(r.counts.timeEntries).toBe(9001);
    expect((await src.c.ok("GET", "/api/v1/w/big/issues/ACME-1")).timeSpentMinutes).toBe(45 + 9000);
  }, 120_000);

  it("never touches an existing workspace and rejects files that aren't exports or are damaged", async () => {
    const src = await exportRich();
    await expect(importWorkspaceArchive(h.deps, src.file, { slug: "acme" })).rejects.toThrow(/already exists/);
    await expect(importWorkspaceArchive(h.deps, src.file, { slug: "Bad Slug!" })).rejects.toThrow(/Invalid workspace URL/);
    await expect(importWorkspaceArchive(h.deps, src.file, { slug: "x-ok", ownerEmail: "foo" })).rejects.toThrow(/isn't an email/);
    const notExport = await rewriteArchive(src.file, (j) => {
      j.format = "something-else";
    });
    await expect(importWorkspaceArchive(h.deps, notExport, { slug: "bogus" })).rejects.toThrow(/isn't a Glasstrack export/);
    // Damaged archives: cut short, or a corrupted header.
    const { gunzipSync, gzipSync } = await import("node:zlib");
    const raw = gunzipSync(await readFile(src.file));
    const truncated = tmp("truncated.tar.gz");
    await writeFile(truncated, gzipSync(raw.subarray(0, Math.floor(raw.length / 2))));
    await expect(importWorkspaceArchive(h.deps, truncated, { slug: "trunc" })).rejects.toThrow(/truncated/);
    const corrupt = Buffer.from(raw);
    corrupt[0] = corrupt[0]! ^ 0xff;
    const badHeader = tmp("bad-header.tar.gz");
    await writeFile(badHeader, gzipSync(corrupt));
    await expect(importWorkspaceArchive(h.deps, badHeader, { slug: "corrupt" })).rejects.toThrow(/checksum/);
    const badSize = Buffer.from(raw);
    badSize.write("-7777777770\0", 124, "ascii");
    let sum = 0;
    for (let i = 0; i < 512; i++) sum += i >= 148 && i < 156 ? 32 : badSize[i]!;
    badSize.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148, "ascii");
    const badSizeFile = tmp("bad-size.tar.gz");
    await writeFile(badSizeFile, gzipSync(badSize));
    await expect(importWorkspaceArchive(h.deps, badSizeFile, { slug: "badsize" })).rejects.toThrow(/malformed entry size/);
    expect(await h.deps.dbs.system.selectFrom("workspaces").select("slug").where("slug", "in", ["bogus", "trunc", "corrupt", "badsize", "x-ok"]).execute()).toEqual([]);
  });

  it("every table with workspace data is exported or deliberately left out (so new tables can't be forgotten)", async () => {
    const exported = new Set(["workspace_members", "teams", "team_key_aliases", "team_members", "workflow_states", "labels", "cycles", "issues", "issue_labels",
      "issue_assignees", "issue_field_values", "issue_relations", "comments", "activity", "saved_views", "custom_fields", "time_entries", "issue_templates",
      "recurring_issues", "automation_rules", "issue_links", "audit_log", "attachments"]);
    // Not moved, on purpose: billing and money (stays with the old host), secrets and tokens (create new ones), per-server state.
    const leftOut = new Set(["api_tokens", "webhooks", "webhook_deliveries", "github_integrations", "git_integrations", "sso_configs", "intake_channels",
      "intake_submissions", "invites", "exports", "notifications", "notification_settings", "issue_subscribers", "active_timers", "automation_runs",
      "billing_accounts", "credit_ledger", "payments", "starter_credit_claims", "usage_daily", "workspace_cost_daily"]);
    const r = await sql<{ t: string }>`SELECT DISTINCT table_name AS t FROM information_schema.columns
      WHERE column_name = 'workspace_id' AND table_schema = 'public'`.execute(h.deps.dbs.owner);
    const unknown = r.rows.map((x) => x.t).filter((t) => !exported.has(t) && !leftOut.has(t));
    expect(unknown, "add new tables to the export and import, or to leftOut with a reason").toEqual([]);
  });
});
