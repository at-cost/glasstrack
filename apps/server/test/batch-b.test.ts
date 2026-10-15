import { sql } from "kysely";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { runScheduledAutomations } from "../src/modules/automations";
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

const owner = () => h.deps.dbs.owner;

async function team2() {
  const a = await setupWorkspace(h, "ann@acme.co", "acme");
  const inv = await a.c.ok("POST", "/api/v1/w/acme/invites", { role: "member" });
  const ben = await new Client(h).login("ben@acme.co", "Ben");
  await ben.ok("POST", `/api/v1/invites/${inv.url.split("/").pop()}/accept`);
  const st = (name: string) => a.states.find((s) => s.name === name)!.id;
  return { ...a, ben, benId: (await ben.ok("GET", "/api/v1/me")).id as string, st };
}

describe("timeline data", () => {
  it("stores start dates, keeps start before due, and lists dependencies", async () => {
    const { c, team } = await team2();
    expect((await c.post("/api/v1/w/acme/issues", { teamId: team.id, title: "x", startDate: "2026-11-10", dueDate: "2026-11-01" })).status).toBe(400);
    const a = await c.ok("POST", "/api/v1/w/acme/issues", { teamId: team.id, title: "design", startDate: "2026-11-01", dueDate: "2026-11-05" });
    const b = await c.ok("POST", "/api/v1/w/acme/issues", { teamId: team.id, title: "build", startDate: "2026-11-06", dueDate: "2026-11-20" });
    expect(a).toMatchObject({ startDate: "2026-11-01", dueDate: "2026-11-05" });
    expect((await c.patch(`/api/v1/w/acme/issues/${a.id}`, { startDate: "2026-11-09" })).status).toBe(400);
    await c.ok("PATCH", `/api/v1/w/acme/issues/${a.id}`, { startDate: "2026-11-02" });
    await c.ok("POST", `/api/v1/w/acme/issues/${a.id}/relations`, { relatedIssueId: b.id, type: "blocks" });
    await c.ok("POST", `/api/v1/w/acme/issues/${a.id}/relations`, { relatedIssueId: b.id, type: "related" });
    const rels = await c.ok("GET", `/api/v1/w/acme/relations?team=${team.id}`);
    expect(rels).toEqual([expect.objectContaining({ issueId: a.id, relatedIssueId: b.id, type: "blocks" })]);
    const acts = await c.ok("GET", `/api/v1/w/acme/issues/${a.id}/activity`);
    expect(acts.map((x: { kind: string }) => x.kind)).toContain("start_date");
  });
});

describe("automations", () => {
  it("runs a status rule after the change commits and logs it", async () => {
    const { c, team, st } = await team2();
    const shipped = await c.ok("POST", "/api/v1/w/acme/labels", { name: "shipped", color: "#2f5d50" });
    const rule = await c.ok("POST", "/api/v1/w/acme/automations", {
      name: "Tag done work", teamId: team.id, trigger: "status_changed", triggerConfig: { toCategories: ["completed"] },
      actions: [{ type: "add_labels", labelIds: [shipped.id] }, { type: "comment", body: "Shipped, thanks!" }],
    });
    const i = await c.ok("POST", "/api/v1/w/acme/issues", { teamId: team.id, title: "work" });
    await c.ok("PATCH", `/api/v1/w/acme/issues/${i.id}`, { statusId: st("In Progress") });
    expect((await c.ok("GET", `/api/v1/w/acme/issues/${i.id}`)).labelIds).toEqual([]);
    await c.ok("POST", `/api/v1/w/acme/issues/${i.id}/move`, { statusId: st("Done"), afterId: null, beforeId: null });
    const d = await c.ok("GET", `/api/v1/w/acme/issues/${i.id}`);
    expect(d.labelIds).toEqual([shipped.id]);
    const comments = await c.ok("GET", `/api/v1/w/acme/issues/${i.id}/comments`);
    expect(comments.map((x: { body: string }) => x.body)).toEqual(["Shipped, thanks!"]);
    const acts = await c.ok("GET", `/api/v1/w/acme/issues/${i.id}/activity`);
    expect(acts.find((x: { kind: string; data: { via?: string } }) => x.kind === "labels" && x.data.via === "automation")).toMatchObject({ actorId: null, data: { rule: "Tag done work" } });
    const rules = await c.ok("GET", "/api/v1/w/acme/automations");
    expect(rules[0]).toMatchObject({ id: rule.id, runCount: 1, lastError: null });
    const runs = await c.ok("GET", `/api/v1/w/acme/automations/${rule.id}/runs`);
    expect(runs[0]).toMatchObject({ status: "ok", identifier: d.identifier });
  });

  it("checks conditions, and changes made by automations never trigger other rules", async () => {
    const { c, team, benId } = await team2();
    const l1 = await c.ok("POST", "/api/v1/w/acme/labels", { name: "triage", color: "#111111" });
    const l2 = await c.ok("POST", "/api/v1/w/acme/labels", { name: "chain", color: "#222222" });
    await c.ok("POST", `/api/v1/w/acme/teams/${team.id}/cycles`, { startsOn: "2020-01-01", endsOn: "2099-01-01" });
    await c.ok("POST", "/api/v1/w/acme/automations", {
      name: "Urgent to Ben", teamId: team.id, trigger: "issue_created", conditions: { priorities: [1] },
      actions: [{ type: "add_assignees", userIds: [benId] }, { type: "add_to_active_cycle" }, { type: "add_labels", labelIds: [l1.id] }],
    });
    // Would fire if automation changes triggered rules.
    await c.ok("POST", "/api/v1/w/acme/automations", {
      name: "Chain", teamId: team.id, trigger: "label_added", triggerConfig: { labelIds: [l1.id] }, actions: [{ type: "add_labels", labelIds: [l2.id] }],
    });
    const urgent = await c.ok("POST", "/api/v1/w/acme/issues", { teamId: team.id, title: "fire", priority: 1 });
    const calm = await c.ok("POST", "/api/v1/w/acme/issues", { teamId: team.id, title: "calm", priority: 4 });
    const u = await c.ok("GET", `/api/v1/w/acme/issues/${urgent.id}`);
    expect(u.assigneeIds).toEqual([benId]);
    expect(u.cycleId).not.toBeNull();
    expect(u.labelIds).toEqual([l1.id]);
    expect((await c.ok("GET", `/api/v1/w/acme/issues/${calm.id}`)).assigneeIds).toEqual([]);
    // A person adding the label does trigger the chain rule.
    await c.ok("PATCH", `/api/v1/w/acme/issues/${calm.id}`, { labelIds: [l1.id] });
    expect((await c.ok("GET", `/api/v1/w/acme/issues/${calm.id}`)).labelIds.sort()).toEqual([l1.id, l2.id].sort());
  });

  it("a failing rule is logged and doesn't stop others", async () => {
    const { c, team, st } = await team2();
    await c.ok("POST", "/api/v1/w/acme/automations", { name: "Broken", teamId: team.id, trigger: "comment_added", actions: [{ type: "set_status", statusId: st("Todo") }] });
    await c.ok("POST", "/api/v1/w/acme/automations", { name: "Bump", teamId: team.id, trigger: "comment_added", actions: [{ type: "set_priority", priority: 2 }] });
    // Break the first rule behind its back: point it at a status that no longer exists.
    await sql`UPDATE automation_rules SET actions = '[{"type":"set_status","statusId":"00000000-0000-4000-8000-000000000000"}]' WHERE name = 'Broken'`.execute(owner());
    const i = await c.ok("POST", "/api/v1/w/acme/issues", { teamId: team.id, title: "x" });
    await c.ok("POST", `/api/v1/w/acme/issues/${i.id}/comments`, { body: "hi" });
    expect((await c.ok("GET", `/api/v1/w/acme/issues/${i.id}`)).priority).toBe(2);
    const rules = await c.ok("GET", "/api/v1/w/acme/automations");
    expect(rules.find((r: { name: string }) => r.name === "Broken").lastError).toContain("Status does not belong");
  });

  it("validates rules and is admin-only", async () => {
    const { c, ben, st, team } = await team2();
    expect((await c.post("/api/v1/w/acme/automations", { name: "x", trigger: "issue_created", actions: [{ type: "set_status", statusId: st("Done") }] })).status).toBe(400);
    expect((await c.post("/api/v1/w/acme/automations", { name: "x", teamId: team.id, trigger: "issue_created", actions: [] })).status).toBe(400);
    expect((await ben.post("/api/v1/w/acme/automations", { name: "x", trigger: "issue_created", actions: [{ type: "archive" }] })).status).toBe(403);
    const r = await c.ok("POST", "/api/v1/w/acme/automations", { name: "x", trigger: "issue_created", actions: [{ type: "set_priority", priority: 3 }] });
    const paused = await c.ok("PATCH", `/api/v1/w/acme/automations/${r.id}`, { enabled: false });
    expect(paused).toMatchObject({ enabled: false, actions: [{ type: "set_priority", priority: 3 }] });
    const i = await c.ok("POST", "/api/v1/w/acme/issues", { teamId: team.id, title: "y" });
    expect((await c.ok("GET", `/api/v1/w/acme/issues/${i.id}`)).priority).toBe(0);
  });

  it("scheduled rules fire once per issue per occasion", async () => {
    const { c, team } = await team2();
    await c.ok("POST", "/api/v1/w/acme/automations", { name: "Overdue", teamId: team.id, trigger: "due_date_passed", actions: [{ type: "set_priority", priority: 1 }, { type: "comment", body: "This is overdue." }] });
    await c.ok("POST", "/api/v1/w/acme/automations", { name: "Stale", trigger: "no_activity", triggerConfig: { days: 10 }, actions: [{ type: "comment", body: "Still needed?" }] });
    const late = await c.ok("POST", "/api/v1/w/acme/issues", { teamId: team.id, title: "late", dueDate: "2020-01-01" });
    const old = await c.ok("POST", "/api/v1/w/acme/issues", { teamId: team.id, title: "old" });
    await sql`UPDATE issues SET updated_at = now() - interval '30 days' WHERE id = ${old.id}`.execute(owner());
    await runScheduledAutomations(h.deps);
    await runScheduledAutomations(h.deps);
    expect((await c.ok("GET", `/api/v1/w/acme/issues/${late.id}`)).priority).toBe(1);
    expect((await c.ok("GET", `/api/v1/w/acme/issues/${late.id}/comments`)).length).toBe(1);
    expect((await c.ok("GET", `/api/v1/w/acme/issues/${old.id}/comments`)).map((x: { body: string }) => x.body)).toEqual(["Still needed?"]);
  });
});

describe("reports", () => {
  it("computes cycle and lead time percentiles, throughput and open trend", async () => {
    const { c, team } = await team2();
    const mk = async (title: string, createdDaysAgo: number, startedDaysAgo: number | null, doneDaysAgo: number | null) => {
      const i = await c.ok("POST", "/api/v1/w/acme/issues", { teamId: team.id, title });
      await sql`UPDATE issues SET created_at = now() - make_interval(days => ${createdDaysAgo}),
        started_at = CASE WHEN ${startedDaysAgo}::int IS NULL THEN NULL ELSE now() - make_interval(days => ${startedDaysAgo}::int) END,
        completed_at = CASE WHEN ${doneDaysAgo}::int IS NULL THEN NULL ELSE now() - make_interval(days => ${doneDaysAgo}::int) END
        WHERE id = ${i.id}`.execute(owner());
      return i;
    };
    await mk("a", 10, 4, 3); // cycle 1d, lead 7d
    await mk("b", 10, 6, 3); // cycle 3d, lead 7d
    await mk("c", 5, 5, 0); //  cycle 5d, lead 5d
    await mk("open", 2, null, null);
    const day = (d: number) => new Date(Date.now() - d * 86_400_000).toISOString().slice(0, 10);
    const r = await c.ok("GET", `/api/v1/w/acme/reports/overview?from=${day(20)}&to=${day(0)}&team=${team.id}`);
    expect(r.completed).toBe(3);
    expect(Math.round(r.cycleTimeHours.p50)).toBe(72);
    expect(Math.round(r.leadTimeHours.p50)).toBe(168);
    expect(r.cycleTimeHistogram.find((b: { bucket: string }) => b.bucket === "1 to 3 days").count).toBe(1);
    expect(r.weekly.reduce((s: number, w: { completed: number }) => s + w.completed, 0)).toBe(3);
    expect(r.weekly.at(-1).open).toBe(1);
    expect(r.byAssignee).toEqual([{ userId: null, completed: 3 }]);
    expect((await c.get("/api/v1/w/acme/reports/overview?from=x&to=y")).status).toBe(400);
  });

  it("burns down a cycle by points when estimates are used", async () => {
    const { c, team } = await team2();
    const start = new Date(Date.now() - 4 * 86_400_000).toISOString().slice(0, 10);
    const end = new Date(Date.now() + 5 * 86_400_000).toISOString().slice(0, 10);
    const cy = await c.ok("POST", `/api/v1/w/acme/teams/${team.id}/cycles`, { startsOn: start, endsOn: end });
    const a = await c.ok("POST", "/api/v1/w/acme/issues", { teamId: team.id, title: "a", cycleId: cy.id, estimate: 3 });
    await c.ok("POST", "/api/v1/w/acme/issues", { teamId: team.id, title: "b", cycleId: cy.id, estimate: 5 });
    await sql`UPDATE issues SET created_at = ${start}::date WHERE cycle_id = ${cy.id}`.execute(owner());
    await sql`UPDATE issues SET completed_at = now() - interval '1 day' WHERE id = ${a.id}`.execute(owner());
    const r = await c.ok("GET", `/api/v1/w/acme/reports/cycles/${cy.id}`);
    expect(r.unit).toBe("points");
    expect(r.days[0]).toMatchObject({ scope: 8, remaining: 8, ideal: 8 });
    expect(r.days.at(-1)).toMatchObject({ scope: 8, remaining: 5, completed: 3 });
    expect(r.totalDays).toBe(10);
  });
});
