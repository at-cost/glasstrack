import { Hono } from "hono";
import {
  type IssueTemplate,
  issueTemplateSchema,
  isValidTimeZone,
  nextRun,
  type RecurringIssue,
  recurringIssueSchema,
  updateIssueTemplateSchema,
  updateRecurringIssueSchema,
} from "@glasstrack/shared";
import { type AppEnv, type Deps, requireRole, requireUser } from "../context";
import { asWorkspace, type Tx } from "../db/tenant";
import { badRequest, notFound } from "../lib/errors";
import { uuid7 } from "../lib/ids";
import { logger } from "../lib/logger";
import { audit } from "./audit";
import { validateFieldValues } from "./fields";
import { assertLabels, assertMembers, assertState, createIssueCore } from "./issueService";
import { assertTeamAccess } from "./teams";
import { enqueueWebhookEvent } from "./webhooks";

type TemplateRow = {
  id: string; teamId: string; name: string; title: string; descriptionMd: string; statusId: string | null; priority: number;
  labelIds: string[]; assigneeIds: string[]; estimate: string | null; fieldValues: Record<string, unknown>;
};
const TCOLS = ["id", "teamId", "name", "title", "descriptionMd", "statusId", "priority", "labelIds", "assigneeIds", "estimate", "fieldValues"] as const;
const toTemplate = (r: TemplateRow): IssueTemplate => ({
  id: r.id, teamId: r.teamId, name: r.name, title: r.title, description: r.descriptionMd, statusId: r.statusId, priority: r.priority,
  labelIds: r.labelIds ?? [], assigneeIds: r.assigneeIds ?? [], estimate: r.estimate === null ? null : Number(r.estimate), fields: r.fieldValues ?? {},
});

type RecurringRow = {
  id: string; templateId: string; frequency: RecurringIssue["frequency"]; interval: number; weekdays: number[]; monthDay: number | null;
  hour: number; timezone: string; startsOn: string; nextRunAt: Date; lastRunAt: Date | null; lastIssueId: string | null; active: boolean;
};
const RCOLS = ["id", "templateId", "frequency", "interval", "weekdays", "monthDay", "hour", "timezone", "startsOn", "nextRunAt", "lastRunAt", "lastIssueId", "active"] as const;
const toRecurring = (r: RecurringRow): RecurringIssue => ({
  ...r, weekdays: r.weekdays ?? [], nextRunAt: r.nextRunAt.toISOString(), lastRunAt: r.lastRunAt?.toISOString() ?? null,
});

async function checkTemplate(trx: Tx, teamId: string, t: { statusId?: string | null; labelIds?: string[]; assigneeIds?: string[]; fields?: Record<string, unknown> }) {
  if (t.statusId) await assertState(trx, t.statusId, teamId);
  if (t.labelIds) await assertLabels(trx, t.labelIds, teamId);
  if (t.assigneeIds) await assertMembers(trx, t.assigneeIds);
  if (t.fields) {
    const values = await validateFieldValues(trx, teamId, t.fields);
    return Object.fromEntries([...values].filter(([, v]) => v !== null));
  }
  return undefined;
}

function scheduleOf(r: { frequency: RecurringIssue["frequency"]; interval: number; weekdays: number[]; monthDay?: number | null; hour: number; timezone: string; startsOn: string }) {
  if (!isValidTimeZone(r.timezone)) throw badRequest("Unknown time zone");
  const next = nextRun({ ...r, monthDay: r.monthDay ?? null }, new Date());
  if (!next) throw badRequest("That schedule never runs");
  return next;
}

export const templateRoutes = new Hono<AppEnv>()
  .get("/templates", async (c) => {
    const rows = await c.get("trx").selectFrom("issueTemplates").select(TCOLS).orderBy("name").execute();
    return c.json(rows.map(toTemplate));
  })
  .post("/templates", async (c) => {
    requireRole(c, "member");
    const user = requireUser(c);
    const body = issueTemplateSchema.parse(await c.req.json());
    await assertTeamAccess(c, body.teamId);
    const trx = c.get("trx");
    const fields = await checkTemplate(trx, body.teamId, body);
    const row = await trx.insertInto("issueTemplates").values({
      id: uuid7(), workspaceId: c.get("ws").id, teamId: body.teamId, name: body.name, title: body.title, descriptionMd: body.description,
      statusId: body.statusId ?? null, priority: body.priority, labelIds: body.labelIds, assigneeIds: body.assigneeIds,
      estimate: body.estimate ?? null, fieldValues: JSON.stringify(fields ?? {}), createdBy: user.id,
    }).returning(TCOLS).executeTakeFirstOrThrow();
    return c.json(toTemplate(row), 201);
  })
  .patch("/templates/:id", async (c) => {
    requireRole(c, "member");
    const body = updateIssueTemplateSchema.parse(await c.req.json());
    const trx = c.get("trx");
    const cur = await trx.selectFrom("issueTemplates").select("teamId").where("id", "=", c.req.param("id")).executeTakeFirst();
    if (!cur) throw notFound("Template not found");
    await assertTeamAccess(c, cur.teamId);
    const fields = await checkTemplate(trx, cur.teamId, body);
    const { description, fields: _f, statusId, estimate, ...rest } = body;
    const row = await trx.updateTable("issueTemplates").set({
      ...rest,
      ...(description !== undefined ? { descriptionMd: description } : {}),
      ...(statusId !== undefined ? { statusId: statusId ?? null } : {}),
      ...(estimate !== undefined ? { estimate: estimate ?? null } : {}),
      ...(fields ? { fieldValues: JSON.stringify(fields) } : {}),
      updatedAt: new Date(),
    }).where("id", "=", c.req.param("id")).returning(TCOLS).executeTakeFirstOrThrow();
    return c.json(toTemplate(row));
  })
  .delete("/templates/:id", async (c) => {
    requireRole(c, "member");
    const trx = c.get("trx");
    const cur = await trx.selectFrom("issueTemplates").select("teamId").where("id", "=", c.req.param("id")).executeTakeFirst();
    if (!cur) throw notFound("Template not found");
    await assertTeamAccess(c, cur.teamId);
    await trx.deleteFrom("issueTemplates").where("id", "=", c.req.param("id")).execute();
    return c.json({ ok: true });
  })

  .get("/recurring", async (c) => {
    const rows = await c.get("trx").selectFrom("recurringIssues").select(RCOLS).orderBy("nextRunAt").execute();
    return c.json(rows.map(toRecurring));
  })
  .post("/recurring", async (c) => {
    requireRole(c, "member");
    const user = requireUser(c);
    const body = recurringIssueSchema.parse(await c.req.json());
    const trx = c.get("trx");
    const t = await trx.selectFrom("issueTemplates").select("teamId").where("id", "=", body.templateId).executeTakeFirst();
    if (!t) throw notFound("Template not found");
    await assertTeamAccess(c, t.teamId);
    const next = scheduleOf(body);
    const row = await trx.insertInto("recurringIssues").values({
      id: uuid7(), workspaceId: c.get("ws").id, templateId: body.templateId, frequency: body.frequency, interval: body.interval,
      weekdays: body.weekdays, monthDay: body.monthDay ?? null, hour: body.hour, timezone: body.timezone, startsOn: body.startsOn,
      nextRunAt: next, active: body.active, createdBy: user.id,
    }).returning(RCOLS).executeTakeFirstOrThrow();
    await audit(c, "recurring.created", "recurring", row.id, { frequency: body.frequency });
    return c.json(toRecurring(row), 201);
  })
  .patch("/recurring/:id", async (c) => {
    requireRole(c, "member");
    const body = updateRecurringIssueSchema.parse(await c.req.json());
    const trx = c.get("trx");
    const cur = await trx.selectFrom("recurringIssues").select(RCOLS).where("id", "=", c.req.param("id")).executeTakeFirst();
    if (!cur) throw notFound("Recurring issue not found");
    const merged = { ...cur, ...body, monthDay: body.monthDay === undefined ? cur.monthDay : (body.monthDay ?? null) };
    const next = scheduleOf(merged);
    const row = await trx.updateTable("recurringIssues").set({
      frequency: merged.frequency, interval: merged.interval, weekdays: merged.weekdays, monthDay: merged.monthDay, hour: merged.hour,
      timezone: merged.timezone, startsOn: merged.startsOn, active: merged.active, nextRunAt: next,
    }).where("id", "=", c.req.param("id")).returning(RCOLS).executeTakeFirstOrThrow();
    return c.json(toRecurring(row));
  })
  .delete("/recurring/:id", async (c) => {
    requireRole(c, "member");
    await c.get("trx").deleteFrom("recurringIssues").where("id", "=", c.req.param("id")).execute();
    await audit(c, "recurring.deleted", "recurring", c.req.param("id"));
    return c.json({ ok: true });
  });

/**
 * Job: creates issues for due schedules. A run that was missed (downtime)
 * creates one issue, not a backlog of them, then moves to the next future run.
 */
export async function runRecurring(deps: Deps, now = new Date()): Promise<number> {
  const due = await deps.dbs.system.selectFrom("recurringIssues as r").innerJoin("workspaces as w", "w.id", "r.workspaceId")
    .select(["r.id", "r.workspaceId", "w.slug", "w.status"]).where("r.active", "=", true).where("r.nextRunAt", "<=", now)
    .where("w.status", "in", ["active", "grace"]).orderBy("r.nextRunAt").limit(200).execute();
  let created = 0;
  for (const d of due) {
    try {
      const issueId = await asWorkspace(deps.dbs.app, d.workspaceId, async (trx) => {
        // Lock the rule so two workers can't both run it.
        const r = await trx.selectFrom("recurringIssues").select(RCOLS).select("createdBy").where("id", "=", d.id)
          .where("nextRunAt", "<=", now).where("active", "=", true).forUpdate().skipLocked().executeTakeFirst();
        if (!r) return null;
        const t = await trx.selectFrom("issueTemplates").select(TCOLS).select("createdBy").where("id", "=", r.templateId).executeTakeFirst();
        const actor = r.createdBy ?? t?.createdBy ?? null;
        const next = nextRun({ ...r, weekdays: r.weekdays ?? [] }, now);
        if (!t || !actor) {
          await trx.updateTable("recurringIssues").set({ active: false }).where("id", "=", r.id).execute();
          return null;
        }
        const id = await createIssueCore(trx, {
          workspaceId: d.workspaceId, actorId: actor, visible: null,
          input: {
            teamId: t.teamId, title: t.title, description: t.descriptionMd, statusId: t.statusId, priority: t.priority,
            assigneeIds: t.assigneeIds ?? [], labelIds: t.labelIds ?? [], estimate: t.estimate === null ? null : Number(t.estimate), fields: t.fieldValues ?? {},
          },
          activity: { recurringId: r.id, templateId: t.id },
        });
        await trx.updateTable("recurringIssues").set({ lastRunAt: now, lastIssueId: id, nextRunAt: next ?? now, active: next !== null })
          .where("id", "=", r.id).execute();
        return id;
      });
      if (issueId) {
        created++;
        const issue = await deps.dbs.system.selectFrom("issues as i").innerJoin("teams as t", "t.id", "i.teamId")
          .select(["i.id", "i.title", "i.number", "t.key"]).where("i.id", "=", issueId).executeTakeFirstOrThrow();
        await deps.jobs.send("automation.event", { workspaceId: d.workspaceId, issueId, actorId: "", events: [{ type: "issue_created" }] }).catch(() => undefined);
        await enqueueWebhookEvent(deps, { id: d.workspaceId, slug: d.slug }, "issue.created", {
          issue: { id: issue.id, identifier: `${issue.key}-${issue.number}`, title: issue.title }, source: "recurring",
        });
      }
    } catch (err) {
      logger.error({ err, recurringId: d.id }, "recurring issue failed");
    }
  }
  return created;
}

