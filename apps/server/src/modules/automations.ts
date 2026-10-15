import { Hono } from "hono";
import { sql } from "kysely";
import {
  type AutomationAction,
  type AutomationEvent,
  type AutomationRule,
  automationRuleSchema,
  type Conditions,
  conditionsMatch,
  type IssueSnapshot,
  type StateCategory,
  type TriggerConfig,
  triggerMatches,
  updateAutomationRuleSchema,
} from "@glasstrack/shared";
import { type AppEnv, type Deps, requireRole, requireUser } from "../context";
import { asWorkspace, notify, type Tx } from "../db/tenant";
import { badRequest, notFound } from "../lib/errors";
import { uuid7 } from "../lib/ids";
import { logger } from "../lib/logger";
import { audit } from "./audit";
import { validateFieldValues, writeFieldValues } from "./fields";
import { assertLabels, assertMembers, assertState, categoryTimestamps, recordActivity, setAssignees } from "./issueService";
import { createNotifications } from "./notifyService";
import { assertTeamAccess } from "./teams";
import { enqueueWebhookEvent } from "./webhooks";

type RuleRow = {
  id: string; name: string; teamId: string | null; enabled: boolean; trigger: string; triggerConfig: Record<string, unknown>;
  conditions: Record<string, unknown>; actions: Record<string, unknown>[]; runCount: number; lastRunAt: Date | null; lastError: string | null;
  createdBy?: string | null;
};
const COLS = ["id", "name", "teamId", "enabled", "trigger", "triggerConfig", "conditions", "actions", "runCount", "lastRunAt", "lastError"] as const;
const toRule = (r: RuleRow): AutomationRule => ({
  id: r.id, name: r.name, teamId: r.teamId, enabled: r.enabled, trigger: r.trigger as AutomationRule["trigger"],
  triggerConfig: r.triggerConfig as TriggerConfig, conditions: r.conditions as Conditions, actions: r.actions as AutomationAction[],
  runCount: r.runCount, lastRunAt: r.lastRunAt?.toISOString() ?? null, lastError: r.lastError,
});

/** Checks references in a rule so mistakes surface when saving, not when it fires. */
async function validateRule(trx: Tx, teamId: string | null, conditions: Conditions, actions: AutomationAction[]) {
  for (const a of actions) {
    switch (a.type) {
      case "set_status":
        if (!teamId) throw badRequest("Pick a team to use \"Set status\" (statuses belong to a team)");
        await assertState(trx, a.statusId, teamId);
        break;
      case "add_labels":
      case "remove_labels":
        if (teamId) await assertLabels(trx, a.labelIds, teamId);
        else {
          const n = await trx.selectFrom("labels").select("id").where("id", "in", a.labelIds).where("teamId", "is", null).execute();
          if (n.length !== new Set(a.labelIds).size) throw badRequest("Workspace-wide rules can only use workspace-wide labels");
        }
        break;
      case "set_assignees":
      case "add_assignees":
        await assertMembers(trx, a.userIds);
        break;
      case "set_field": {
        const f = await trx.selectFrom("customFields").select("teamId").where("id", "=", a.fieldId).where("archivedAt", "is", null).executeTakeFirst();
        if (!f || (f.teamId && f.teamId !== teamId)) throw badRequest("Unknown custom field for this rule");
        if (teamId) await validateFieldValues(trx, teamId, { [a.fieldId]: a.value });
        break;
      }
    }
  }
  if (conditions.assignee && Array.isArray(conditions.assignee)) await assertMembers(trx, conditions.assignee);
}

async function snapshot(trx: Tx, issueId: string): Promise<(IssueSnapshot & { id: string; archivedAt: Date | null; startedAt: Date | null; title: string; number: number; key: string }) | null> {
  const r = await trx.selectFrom("issues as i").innerJoin("workflowStates as s", "s.id", "i.statusId").innerJoin("teams as t", "t.id", "i.teamId")
    .select(["i.id", "i.teamId", "i.statusId", "s.category", "i.priority", "i.archivedAt", "i.startedAt", "i.title", "i.number", "t.key"])
    .select((eb) => eb.selectFrom("issueLabels as l").select(sql<string[]>`coalesce(array_agg(l.label_id), '{}')`.as("x")).whereRef("l.issueId", "=", "i.id").as("labelIds"))
    .select((eb) => eb.selectFrom("issueAssignees as a").select(sql<string[]>`coalesce(array_agg(a.user_id), '{}')`.as("x")).whereRef("a.issueId", "=", "i.id").as("assigneeIds"))
    .select((eb) => eb.selectFrom("issueFieldValues as f").select(sql<Record<string, unknown>>`coalesce(jsonb_object_agg(f.field_id, f.value), '{}'::jsonb)`.as("x")).whereRef("f.issueId", "=", "i.id").as("fields"))
    .where("i.id", "=", issueId).executeTakeFirst();
  if (!r) return null;
  return { ...r, category: r.category as StateCategory, labelIds: r.labelIds ?? [], assigneeIds: r.assigneeIds ?? [], fields: r.fields ?? {} };
}

/** Applies one rule's actions. Returns a short description of what changed. */
async function applyActions(trx: Tx, workspaceId: string, issueId: string, rule: RuleRow): Promise<string[]> {
  const done: string[] = [];
  const actor = rule.createdBy ?? null;
  for (const a of rule.actions as AutomationAction[]) {
    const cur = await snapshot(trx, issueId);
    if (!cur || cur.archivedAt) break;
    switch (a.type) {
      case "set_status": {
        if (cur.statusId === a.statusId) break;
        const category = await assertState(trx, a.statusId, cur.teamId);
        await trx.updateTable("issues").set({ statusId: a.statusId, updatedAt: new Date(), ...categoryTimestamps(category, cur) }).where("id", "=", issueId).execute();
        await recordActivity(trx, workspaceId, issueId, null, "status", { from: cur.statusId, to: a.statusId, via: "automation", rule: rule.name });
        done.push("status");
        break;
      }
      case "set_priority":
        if (cur.priority === a.priority) break;
        await trx.updateTable("issues").set({ priority: a.priority, updatedAt: new Date() }).where("id", "=", issueId).execute();
        await recordActivity(trx, workspaceId, issueId, null, "priority", { from: cur.priority, to: a.priority, via: "automation", rule: rule.name });
        done.push("priority");
        break;
      case "add_labels": {
        await assertLabels(trx, a.labelIds, cur.teamId);
        const added = a.labelIds.filter((l) => !cur.labelIds.includes(l));
        if (!added.length) break;
        await trx.insertInto("issueLabels").values(added.map((labelId) => ({ workspaceId, issueId, labelId }))).execute();
        await recordActivity(trx, workspaceId, issueId, null, "labels", { added, removed: [], via: "automation", rule: rule.name });
        done.push("labels");
        break;
      }
      case "remove_labels": {
        const removed = a.labelIds.filter((l) => cur.labelIds.includes(l));
        if (!removed.length) break;
        await trx.deleteFrom("issueLabels").where("issueId", "=", issueId).where("labelId", "in", removed).execute();
        await recordActivity(trx, workspaceId, issueId, null, "labels", { added: [], removed, via: "automation", rule: rule.name });
        done.push("labels");
        break;
      }
      case "set_assignees":
      case "add_assignees": {
        const next = a.type === "set_assignees" ? a.userIds : [...new Set([...cur.assigneeIds, ...a.userIds])];
        await assertMembers(trx, next);
        const { added, removed } = await setAssignees(trx, workspaceId, issueId, next);
        if (!added.length && !removed.length) break;
        await recordActivity(trx, workspaceId, issueId, null, "assignees", { added, removed, via: "automation", rule: rule.name });
        if (actor) await createNotifications(trx, { workspaceId, issueId, actorId: actor, kind: "assigned", userIds: added });
        done.push("assignees");
        break;
      }
      case "set_field": {
        const values = await validateFieldValues(trx, cur.teamId, { [a.fieldId]: a.value });
        const changed = await writeFieldValues(trx, workspaceId, issueId, values, cur.fields);
        if (!changed.length) break;
        await recordActivity(trx, workspaceId, issueId, null, "field", { fieldId: a.fieldId, from: cur.fields[a.fieldId] ?? null, to: values.get(a.fieldId) ?? null, via: "automation", rule: rule.name });
        done.push("field");
        break;
      }
      case "comment":
        await trx.insertInto("comments").values({ id: uuid7(), workspaceId, issueId, authorId: null, bodyMd: a.body }).execute();
        await recordActivity(trx, workspaceId, issueId, null, "automation_comment", { rule: rule.name });
        done.push("comment");
        break;
      case "set_due_in_days": {
        const due = new Date(Date.now() + a.days * 86_400_000).toISOString().slice(0, 10);
        await trx.updateTable("issues").set({ dueDate: due, startDate: sql<string>`CASE WHEN start_date > ${due}::date THEN NULL ELSE start_date END`, updatedAt: new Date() })
          .where("id", "=", issueId).execute();
        await recordActivity(trx, workspaceId, issueId, null, "due_date", { to: due, via: "automation", rule: rule.name });
        done.push("due date");
        break;
      }
      case "add_to_active_cycle": {
        const cy = await trx.selectFrom("cycles").select("id").where("teamId", "=", cur.teamId).where("completedAt", "is", null)
          .where("startsOn", "<=", sql<string>`current_date`).where("endsOn", ">=", sql<string>`current_date`).orderBy("startsOn").executeTakeFirst();
        if (!cy) break;
        await trx.updateTable("issues").set({ cycleId: cy.id, updatedAt: new Date() }).where("id", "=", issueId).where("cycleId", "is distinct from", cy.id).execute();
        await recordActivity(trx, workspaceId, issueId, null, "cycle", { to: cy.id, via: "automation", rule: rule.name });
        done.push("cycle");
        break;
      }
      case "archive":
        await trx.updateTable("issues").set({ archivedAt: new Date(), updatedAt: new Date() }).where("id", "=", issueId).execute();
        await recordActivity(trx, workspaceId, issueId, null, "archived", { via: "automation", rule: rule.name });
        done.push("archived");
        break;
    }
  }
  return done;
}

/**
 * Runs the workspace's rules for events on one issue. Called from a job after
 * the triggering change commits. Changes made here never trigger rules (no loops).
 */
export async function runAutomations(
  deps: Deps,
  p: { workspaceId: string; issueId: string; events: AutomationEvent[]; runKey?: (ruleId: string) => string | null; ruleIds?: string[] },
): Promise<number> {
  const ws = await deps.dbs.system.selectFrom("workspaces").select(["slug", "status"]).where("id", "=", p.workspaceId).executeTakeFirst();
  if (!ws || ws.status === "deleting" || ws.status === "read_only") return 0;
  const types = [...new Set(p.events.map((e) => e.type))];
  let applied = 0;
  const changed = await asWorkspace(deps.dbs.app, p.workspaceId, async (trx) => {
    const issue = await snapshot(trx, p.issueId);
    if (!issue || issue.archivedAt) return false;
    let q = trx.selectFrom("automationRules").select(COLS).select("createdBy").where("enabled", "=", true).where("trigger", "in", types)
      .where((eb) => eb.or([eb("teamId", "is", null), eb("teamId", "=", issue.teamId)])).orderBy("createdAt");
    if (p.ruleIds) q = q.where("id", "in", p.ruleIds.length ? p.ruleIds : ["00000000-0000-0000-0000-000000000000"]);
    const rules = await q.execute();
    let any = false;
    for (const rule of rules) {
      const fresh = await snapshot(trx, p.issueId);
      if (!fresh || fresh.archivedAt) break;
      const fired = p.events.some((e) => triggerMatches(rule.trigger as AutomationRule["trigger"], rule.triggerConfig as TriggerConfig, e));
      if (!fired || !conditionsMatch(rule.conditions as Conditions, fresh)) continue;
      const runKey = p.runKey?.(rule.id) ?? null;
      // Each rule in its own savepoint: one broken rule doesn't undo another's work.
      await sql`SAVEPOINT rule_run`.execute(trx);
      try {
        if (runKey) {
          const claimed = await trx.insertInto("automationRuns").values({ workspaceId: p.workspaceId, ruleId: rule.id, issueId: p.issueId, status: "ok", runKey, detail: "{}" })
            .onConflict((oc) => oc.columns(["ruleId", "issueId", "runKey"]).where("runKey", "is not", null).doNothing()).returning("id").executeTakeFirst();
          if (!claimed) {
            await sql`RELEASE SAVEPOINT rule_run`.execute(trx);
            continue;
          }
        }
        const done = await applyActions(trx, p.workspaceId, p.issueId, rule);
        if (!runKey) {
          await trx.insertInto("automationRuns").values({ workspaceId: p.workspaceId, ruleId: rule.id, issueId: p.issueId, status: "ok", detail: JSON.stringify({ changed: done }) }).execute();
        }
        await trx.updateTable("automationRules").set((eb) => ({ runCount: eb("runCount", "+", 1), lastRunAt: new Date(), lastError: null })).where("id", "=", rule.id).execute();
        await sql`RELEASE SAVEPOINT rule_run`.execute(trx);
        if (done.length) {
          any = true;
          applied++;
        }
      } catch (err) {
        await sql`ROLLBACK TO SAVEPOINT rule_run`.execute(trx);
        const message = String((err as Error).message ?? err).slice(0, 300);
        await trx.insertInto("automationRuns").values({ workspaceId: p.workspaceId, ruleId: rule.id, issueId: p.issueId, status: "error", detail: JSON.stringify({ error: message }) }).execute();
        await trx.updateTable("automationRules").set({ lastError: message, lastRunAt: new Date() }).where("id", "=", rule.id).execute();
        logger.warn({ ruleId: rule.id, err: message }, "automation rule failed");
      }
    }
    if (any) {
      await trx.updateTable("issues").set({ updatedAt: new Date() }).where("id", "=", p.issueId).execute();
      await notify(trx, p.workspaceId, { t: "issue", id: p.issueId });
    }
    return any;
  });
  if (changed) {
    await enqueueWebhookEvent(deps, { id: p.workspaceId, slug: ws.slug }, "issue.updated", { issue: { id: p.issueId }, source: "automation" });
  }
  return applied;
}

/** Hourly: "due date passed" and "no activity" rules, once per issue per occasion. */
export async function runScheduledAutomations(deps: Deps, now = new Date()): Promise<number> {
  const rules = await deps.dbs.system.selectFrom("automationRules as r").innerJoin("workspaces as w", "w.id", "r.workspaceId")
    .select(["r.id", "r.workspaceId", "r.teamId", "r.trigger", "r.triggerConfig"])
    .where("r.enabled", "=", true).where("r.trigger", "in", ["due_date_passed", "no_activity"]).where("w.status", "in", ["active", "grace"]).execute();
  let total = 0;
  const today = now.toISOString().slice(0, 10);
  for (const r of rules) {
    try {
      let q = deps.dbs.system.selectFrom("issues as i").innerJoin("workflowStates as s", "s.id", "i.statusId")
        .select(["i.id", "i.dueDate", "i.updatedAt"]).where("i.workspaceId", "=", r.workspaceId).where("i.archivedAt", "is", null)
        .where("s.category", "not in", ["completed", "canceled"]).limit(200);
      if (r.teamId) q = q.where("i.teamId", "=", r.teamId);
      if (r.trigger === "due_date_passed") q = q.where("i.dueDate", "<", today);
      else q = q.where("i.updatedAt", "<", new Date(now.getTime() - ((r.triggerConfig as TriggerConfig).days ?? 14) * 86_400_000));
      const issues = await q.execute();
      for (const i of issues) {
        const key = r.trigger === "due_date_passed" ? `due:${i.dueDate}` : `stale:${i.updatedAt.toISOString().slice(0, 10)}`;
        total += await runAutomations(deps, {
          workspaceId: r.workspaceId, issueId: i.id, events: [{ type: r.trigger as "due_date_passed" | "no_activity" }],
          runKey: () => key, ruleIds: [r.id],
        });
      }
    } catch (err) {
      logger.error({ err, ruleId: r.id }, "scheduled automation failed");
    }
  }
  return total;
}

export const automationRoutes = new Hono<AppEnv>()
  .get("/automations", async (c) => {
    const rows = await c.get("trx").selectFrom("automationRules").select(COLS).orderBy("createdAt").execute();
    return c.json(rows.map(toRule));
  })
  .post("/automations", async (c) => {
    requireRole(c, "admin");
    const user = requireUser(c);
    const body = automationRuleSchema.parse(await c.req.json());
    if (body.teamId) await assertTeamAccess(c, body.teamId);
    if (body.trigger === "no_activity" && !body.triggerConfig.days) body.triggerConfig.days = 14;
    const trx = c.get("trx");
    await validateRule(trx, body.teamId ?? null, body.conditions, body.actions);
    const id = uuid7();
    const row = await trx.insertInto("automationRules").values({
      id, workspaceId: c.get("ws").id, teamId: body.teamId ?? null, name: body.name, enabled: body.enabled, trigger: body.trigger,
      triggerConfig: JSON.stringify(body.triggerConfig), conditions: JSON.stringify(body.conditions), actions: JSON.stringify(body.actions), createdBy: user.id,
    }).returning(COLS).executeTakeFirstOrThrow();
    await audit(c, "automation.created", "automation", id, { name: body.name, trigger: body.trigger });
    return c.json(toRule(row), 201);
  })
  .patch("/automations/:id", async (c) => {
    requireRole(c, "admin");
    const body = updateAutomationRuleSchema.parse(await c.req.json());
    const trx = c.get("trx");
    const cur = await trx.selectFrom("automationRules").select(COLS).where("id", "=", c.req.param("id")).executeTakeFirst();
    if (!cur) throw notFound("Automation not found");
    const teamId = body.teamId === undefined ? cur.teamId : (body.teamId ?? null);
    if (teamId) await assertTeamAccess(c, teamId);
    await validateRule(trx, teamId, (body.conditions ?? cur.conditions) as Conditions, (body.actions ?? cur.actions) as AutomationAction[]);
    const row = await trx.updateTable("automationRules").set({
      ...(body.name !== undefined ? { name: body.name } : {}),
      ...(body.teamId !== undefined ? { teamId } : {}),
      ...(body.enabled !== undefined ? { enabled: body.enabled } : {}),
      ...(body.trigger !== undefined ? { trigger: body.trigger } : {}),
      ...(body.triggerConfig !== undefined ? { triggerConfig: JSON.stringify(body.triggerConfig) } : {}),
      ...(body.conditions !== undefined ? { conditions: JSON.stringify(body.conditions) } : {}),
      ...(body.actions !== undefined ? { actions: JSON.stringify(body.actions) } : {}),
      updatedAt: new Date(),
    }).where("id", "=", c.req.param("id")).returning(COLS).executeTakeFirstOrThrow();
    await audit(c, "automation.updated", "automation", row.id, { name: row.name, enabled: row.enabled });
    return c.json(toRule(row));
  })
  .delete("/automations/:id", async (c) => {
    requireRole(c, "admin");
    const r = await c.get("trx").deleteFrom("automationRules").where("id", "=", c.req.param("id")).returning("name").executeTakeFirst();
    if (!r) throw notFound("Automation not found");
    await audit(c, "automation.deleted", "automation", c.req.param("id"), { name: r.name });
    return c.json({ ok: true });
  })
  .get("/automations/:id/runs", async (c) => {
    requireRole(c, "admin");
    const rows = await c.get("trx").selectFrom("automationRuns as r").leftJoin("issues as i", "i.id", "r.issueId").leftJoin("teams as t", "t.id", "i.teamId")
      .select(["r.id", "r.status", "r.detail", "r.createdAt", "r.issueId", "i.number", "t.key"])
      .where("r.ruleId", "=", c.req.param("id")).orderBy("r.id", "desc").limit(50).execute();
    return c.json(rows.map((r) => ({
      id: r.id, status: r.status, detail: r.detail, createdAt: r.createdAt.toISOString(), issueId: r.issueId,
      identifier: r.key && r.number ? `${r.key}-${r.number}` : null,
    })));
  });
