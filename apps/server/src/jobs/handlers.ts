import { createWriteStream } from "node:fs";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createGzip } from "node:zlib";
import { sql } from "kysely";
import type { Deps } from "../context";
import { asWorkspace } from "../db/tenant";
import { layout } from "../email";
import { toCsv } from "../lib/csv";
import { logger } from "../lib/logger";
import { TarWriter } from "../lib/tar";
import { workspacePrefix } from "../storage";
import type { JobName, JobPayloads } from "./types";

const EXPORT_TTL_DAYS = 7;

/** Builds workspace.json + CSVs + attachments into a .tar.gz, with RLS enforced. */
export async function exportWorkspace(deps: Deps, { exportId, workspaceId }: JobPayloads["export.workspace"]) {
  const { app, system } = deps.dbs;
  const found = await asWorkspace(app, workspaceId, (trx) =>
    trx.updateTable("exports").set({ status: "running" }).where("id", "=", exportId).returning("id").executeTakeFirst(),
  );
  if (!found) {
    logger.warn({ exportId }, "export row not found");
    return;
  }
  const dir = await mkdtemp(path.join(tmpdir(), "glasstrack-export-"));
  const file = path.join(dir, "export.tar.gz");
  try {
    const data = await asWorkspace(app, workspaceId, async (trx) => {
      const workspace = await system.selectFrom("workspaces").select(["id", "slug", "name", "createdAt"]).where("id", "=", workspaceId).executeTakeFirstOrThrow();
      return {
        format: "glasstrack-export",
        version: 1,
        exportedAt: new Date().toISOString(),
        workspace,
        members: await (trx.selectFrom("workspaceMembers as m").innerJoin("users as u", "u.id", "m.userId")
          .select(["u.id", "u.name", "u.email", "m.role", "m.joinedAt"]).execute()),
        teams: await (trx.selectFrom("teams").select(["id", "key", "name", "createdAt", "archivedAt"]).execute()),
        teamKeyAliases: await (trx.selectFrom("teamKeyAliases").select(["key", "teamId"]).execute()),
        teamMembers: await (trx.selectFrom("teamMembers").select(["teamId", "userId"]).execute()),
        states: await (trx.selectFrom("workflowStates").select(["id", "teamId", "name", "category", "color", "position"]).execute()),
        labels: await (trx.selectFrom("labels").select(["id", "teamId", "name", "color"]).execute()),
        cycles: await (trx.selectFrom("cycles").select(["id", "teamId", "number", "name", "startsOn", "endsOn", "completedAt"]).execute()),
        issues: await (trx.selectFrom("issues as i").innerJoin("teams as t", "t.id", "i.teamId")
          .select(["i.id", "i.teamId", sql<string>`t.key || '-' || i.number`.as("identifier"), "i.title", "i.descriptionMd",
            "i.statusId", "i.priority", "i.creatorId", "i.parentId", "i.cycleId", "i.dueDate", "i.estimate",
            "i.sortKey", "i.createdAt", "i.updatedAt", "i.startedAt", "i.completedAt", "i.canceledAt", "i.archivedAt"])
          .select((eb) => eb.selectFrom("issueLabels as il").select(sql<string[]>`coalesce(array_agg(il.label_id), '{}')`.as("l"))
            .whereRef("il.issueId", "=", "i.id").as("labelIds"))
          .select((eb) => eb.selectFrom("issueAssignees as ia").select(sql<string[]>`coalesce(array_agg(ia.user_id), '{}')`.as("a"))
            .whereRef("ia.issueId", "=", "i.id").as("assigneeIds"))
          .select((eb) => eb.selectFrom("issueFieldValues as fv").select(sql<Record<string, unknown>>`coalesce(jsonb_object_agg(fv.field_id, fv.value), '{}'::jsonb)`.as("f"))
            .whereRef("fv.issueId", "=", "i.id").as("fields"))
          .orderBy("i.createdAt").execute()),
        relations: await (trx.selectFrom("issueRelations").select(["id", "issueId", "relatedIssueId", "type", "createdAt"]).execute()),
        comments: await (trx.selectFrom("comments").select(["id", "issueId", "authorId", "bodyMd", "createdAt", "editedAt"])
          .where("deletedAt", "is", null).orderBy("createdAt").execute()),
        activity: await (trx.selectFrom("activity").select(["id", "issueId", "actorId", "kind", "data", "createdAt"]).orderBy("id").execute()),
        savedViews: await (trx.selectFrom("savedViews").select(["id", "name", "teamId", "ownerId", "shared", "layout", "filters"]).execute()),
        customFields: await trx.selectFrom("customFields").select(["id", "teamId", "name", "type", "options", "position", "archivedAt"]).execute(),
        timeEntries: await trx.selectFrom("timeEntries").select(["id", "issueId", "userId", "spentOn", "minutes", "note", "createdAt"]).execute(),
        templates: await trx.selectFrom("issueTemplates").select(["id", "teamId", "name", "title", "descriptionMd", "statusId", "priority", "labelIds", "assigneeIds", "estimate", "fieldValues"]).execute(),
        recurring: await trx.selectFrom("recurringIssues").select(["id", "templateId", "frequency", "interval", "weekdays", "monthDay", "hour", "timezone", "startsOn", "nextRunAt", "active"]).execute(),
        auditLog: await trx.selectFrom("auditLog").select(["id", "actorLabel", "action", "targetType", "targetId", "data", "createdAt"]).orderBy("id").execute(),
        attachments: await (trx.selectFrom("attachments").select(["id", "issueId", "filename", "contentType", "sizeBytes", "storageKey", "createdAt"])
          .where("deletedAt", "is", null).where("uploadedAt", "is not", null).execute()),
      };
    });

    const gzip = createGzip({ level: 6 });
    const done = new Promise<void>((resolve, reject) => {
      const out = createWriteStream(file);
      out.on("finish", resolve).on("error", reject);
      gzip.on("error", reject);
      gzip.pipe(out);
    });
    const tar = new TarWriter(gzip);
    const root = `${data.workspace.slug}-export`;
    await tar.addBuffer(
      `${root}/workspace.json`,
      JSON.stringify({ ...data, attachments: data.attachments.map(({ storageKey: _s, ...a }) => ({ ...a, path: `attachments/${a.id}-${a.filename}` })) }, null, 2),
    );
    const userName = new Map(data.members.map((m) => [m.id, m.name]));
    const stateName = new Map(data.states.map((s) => [s.id, s.name]));
    const labelName = new Map(data.labels.map((l) => [l.id, l.name]));
    const issueKey = new Map(data.issues.map((i) => [i.id, i.identifier]));
    await tar.addBuffer(
      `${root}/issues.csv`,
      toCsv(
        data.issues.map((i) => ({
          ...i,
          status: stateName.get(i.statusId),
          assignees: (i.assigneeIds ?? []).map((a) => userName.get(a)),
          creator: i.creatorId ? userName.get(i.creatorId) : "",
          parent: i.parentId ? issueKey.get(i.parentId) : "",
          labels: (i.labelIds ?? []).map((l) => labelName.get(l)),
        })),
        ["identifier", "title", "status", "priority", "assignees", "creator", "labels", "parent", "dueDate", "estimate", "createdAt", "updatedAt", "completedAt", "archivedAt", "descriptionMd"],
      ),
    );
    await tar.addBuffer(
      `${root}/time.csv`,
      toCsv(
        data.timeEntries.map((t) => ({ ...t, issue: issueKey.get(t.issueId), person: t.userId ? userName.get(t.userId) : "" })),
        ["issue", "person", "spentOn", "minutes", "note", "createdAt"],
      ),
    );
    await tar.addBuffer(
      `${root}/comments.csv`,
      toCsv(
        data.comments.map((cm) => ({ ...cm, issue: issueKey.get(cm.issueId), author: cm.authorId ? userName.get(cm.authorId) : "" })),
        ["issue", "author", "createdAt", "editedAt", "bodyMd"],
      ),
    );
    for (const a of data.attachments) {
      const size = await deps.storage.size(a.storageKey);
      if (size === null) continue;
      await tar.addStream(`${root}/attachments/${a.id}-${a.filename}`, size, await deps.storage.get(a.storageKey));
    }
    await tar.finish();
    await done;
    const size = (await stat(file)).size;
    const key = `${workspacePrefix(workspaceId)}exports/${exportId}.tar.gz`;
    await deps.storage.put(key, { path: file, size }, "application/gzip");
    await asWorkspace(app, workspaceId, (trx) =>
      trx.updateTable("exports").set({
        status: "done", storageKey: key, sizeBytes: size, expiresAt: new Date(Date.now() + EXPORT_TTL_DAYS * 86400_000),
      }).where("id", "=", exportId).execute(),
    );
  } catch (err) {
    logger.error({ err, exportId }, "export failed");
    await asWorkspace(app, workspaceId, (trx) =>
      trx.updateTable("exports").set({ status: "failed", error: String(err).slice(0, 500) }).where("id", "=", exportId).execute(),
    );
    throw err;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** GDPR erasure: files first, then every tenant row via ON DELETE CASCADE. */
export async function deleteWorkspace(deps: Deps, { workspaceId }: JobPayloads["workspace.delete"]) {
  const ws = await deps.dbs.system.selectFrom("workspaces").select("status").where("id", "=", workspaceId).executeTakeFirst();
  if (!ws || ws.status !== "deleting") return;
  await deps.storage.deletePrefix(workspacePrefix(workspaceId));
  await deps.dbs.system.deleteFrom("workspaces").where("id", "=", workspaceId).execute();
  logger.info({ workspaceId }, "workspace deleted");
}

const DIGEST_EVERY: Record<string, number> = { hourly: 3600_000, daily: 86400_000 };

/** Emails unread notifications that are at least 10 minutes old, per user and workspace. */
export async function sendDigests(deps: Deps) {
  const sys = deps.dbs.system;
  const groups = await sys
    .selectFrom("notifications as n")
    .innerJoin("users as u", "u.id", "n.userId")
    .innerJoin("workspaces as w", "w.id", "n.workspaceId")
    .leftJoin("notificationSettings as s", (j) => j.onRef("s.userId", "=", "n.userId").onRef("s.workspaceId", "=", "n.workspaceId"))
    .select(["n.workspaceId", "n.userId", "u.email", "w.name as wsName", "w.slug", "s.digest", "s.lastDigestAt"])
    .select((eb) => eb.fn.countAll<string>().as("n"))
    .where("n.emailedAt", "is", null)
    .where("n.readAt", "is", null)
    .where("n.createdAt", "<", new Date(Date.now() - 10 * 60_000))
    .where("w.status", "!=", "deleting")
    .groupBy(["n.workspaceId", "n.userId", "u.email", "w.name", "w.slug", "s.digest", "s.lastDigestAt"])
    .execute();
  const base = deps.config.APP_URL.replace(/\/$/, "");
  for (const g of groups) {
    const freq = g.digest ?? "daily";
    if (freq === "off") continue;
    if (g.lastDigestAt && Date.now() - g.lastDigestAt.getTime() < DIGEST_EVERY[freq]! - 60_000) continue;
    const items = await sys
      .selectFrom("notifications as n")
      .innerJoin("issues as i", "i.id", "n.issueId")
      .innerJoin("teams as t", "t.id", "i.teamId")
      .leftJoin("users as a", "a.id", "n.actorId")
      .select(["n.id", "n.kind", "i.number", "t.key", "i.title", "a.name as actor"])
      .where("n.workspaceId", "=", g.workspaceId)
      .where("n.userId", "=", g.userId)
      .where("n.emailedAt", "is", null)
      .where("n.readAt", "is", null)
      .orderBy("n.createdAt")
      .limit(50)
      .execute();
    if (items.length === 0) continue;
    const verb: Record<string, string> = { assigned: "assigned you", mentioned: "mentioned you on", commented: "commented on", status_changed: "changed the status of" };
    const lines = items.map((it) => `${it.actor ?? "Someone"} ${verb[it.kind] ?? "updated"} ${it.key}-${it.number}: ${it.title}`);
    const { text, html } = layout(`${items.length} update${items.length === 1 ? "" : "s"} in ${g.wsName}`, lines, {
      label: "Open inbox",
      url: `${base}/${g.slug}/inbox`,
    });
    await deps.mailer.send({ to: g.email, subject: `${items.length} new update${items.length === 1 ? "" : "s"} in ${g.wsName}`, text, html, workspaceId: g.workspaceId });
    await sys.updateTable("notifications").set({ emailedAt: new Date() }).where("id", "in", items.map((i) => i.id)).execute();
    await sys.insertInto("notificationSettings")
      .values({ workspaceId: g.workspaceId, userId: g.userId, events: "{}", lastDigestAt: new Date() })
      .onConflict((oc) => oc.columns(["workspaceId", "userId"]).doUpdateSet({ lastDigestAt: new Date() }))
      .execute();
  }
}

export async function cleanup(deps: Deps) {
  const sys = deps.dbs.system;
  const dayAgo = new Date(Date.now() - 86400_000);
  await sys.deleteFrom("sessions").where("expiresAt", "<", new Date()).execute();
  await sys.deleteFrom("magicLinks").where("createdAt", "<", dayAgo).execute();
  const stale = await sys.selectFrom("attachments").select(["id", "storageKey"])
    .where((eb) => eb.or([eb.and([eb("uploadedAt", "is", null), eb("createdAt", "<", dayAgo)]), eb("deletedAt", "is not", null)]))
    .limit(1000).execute();
  for (const a of stale) await deps.storage.delete(a.storageKey).catch(() => undefined);
  if (stale.length) await sys.deleteFrom("attachments").where("id", "in", stale.map((a) => a.id)).execute();
  const expired = await sys.selectFrom("exports").select(["id", "storageKey"]).where("expiresAt", "<", new Date()).limit(1000).execute();
  for (const e of expired) if (e.storageKey) await deps.storage.delete(e.storageKey).catch(() => undefined);
  if (expired.length) await sys.deleteFrom("exports").where("id", "in", expired.map((e) => e.id)).execute();
  await sys.deleteFrom("webhookDeliveries").where("createdAt", "<", new Date(Date.now() - 14 * 86_400_000)).execute();
  // Keep run_key rows (they stop scheduled rules firing twice); prune the rest after 30 days.
  await sys.deleteFrom("automationRuns").where("createdAt", "<", new Date(Date.now() - 30 * 86_400_000)).where("runKey", "is", null).execute();
}

export type Handlers = { [N in JobName]: (deps: Deps, data: JobPayloads[N]) => Promise<void> };

export const handlers: Handlers = {
  "export.workspace": exportWorkspace,
  "workspace.delete": deleteWorkspace,
  "notifications.digest": (deps) => sendDigests(deps),
  "maintenance.cleanup": (deps) => cleanup(deps),
  "billing.daily": async (deps) => {
    const { runDailyBilling } = await import("../billing/service");
    await runDailyBilling(deps);
  },
  "billing.autotopup": async (deps, { workspaceId }) => {
    const { runAutoTopup } = await import("../billing/service");
    await runAutoTopup(deps, workspaceId);
  },
  "billing.fees": async (deps) => {
    const { backfillFees } = await import("../billing/service");
    await backfillFees(deps);
  },
  "finances.daily": async (deps) => {
    await deps.meter.flush(deps.dbs.system);
    const { runDailyFinances } = await import("../finances/service");
    await runDailyFinances(deps);
  },
  "webhook.deliver": async (deps, { deliveryId }) => {
    const { deliverWebhook } = await import("../modules/webhooks");
    await deliverWebhook(deps, deliveryId);
  },
  "recurring.tick": async (deps) => {
    const { runRecurring } = await import("../modules/templates");
    await runRecurring(deps);
  },
  "automation.event": async (deps, data) => {
    const { runAutomations } = await import("../modules/automations");
    await runAutomations(deps, data);
  },
  "automation.scheduled": async (deps) => {
    const { runScheduledAutomations } = await import("../modules/automations");
    await runScheduledAutomations(deps);
  },
  "backup.run": async (deps) => {
    const { runBackup } = await import("./backup");
    await runBackup(deps);
  },
};
