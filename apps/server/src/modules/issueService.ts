import { sql } from "kysely";
import { keyBetween } from "@glasstrack/shared";
import { notify, type Tx } from "../db/tenant";
import { badRequest, notFound } from "../lib/errors";
import { uuid7 } from "../lib/ids";
import { validateFieldValues, writeFieldValues } from "./fields";
import { createNotifications, resolveMentions, subscribe } from "./notifyService";

export interface IssueInput {
  teamId: string;
  title: string;
  description: string;
  statusId?: string | null;
  priority: number;
  assigneeIds: string[];
  labelIds: string[];
  dueDate?: string | null;
  estimate?: number | null;
  parentId?: string | null;
  cycleId?: string | null;
  fields: Record<string, unknown>;
}

const NONE = "00000000-0000-0000-0000-000000000000";

export async function recordActivity(trx: Tx, workspaceId: string, issueId: string, actorId: string | null, kind: string, data: Record<string, unknown> = {}) {
  await trx.insertInto("activity").values({ workspaceId, issueId, actorId, kind, data: JSON.stringify(data) }).execute();
}

export async function assertMembers(trx: Tx, userIds: string[]) {
  const ids = [...new Set(userIds)];
  if (ids.length === 0) return;
  const rows = await trx.selectFrom("workspaceMembers").select("userId").where("userId", "in", ids)
    .where("workspaceId", "=", sql<string>`app.ws()`).execute();
  if (rows.length !== ids.length) throw badRequest("Assignees must be workspace members");
}

export async function assertState(trx: Tx, statusId: string, teamId: string) {
  const s = await trx.selectFrom("workflowStates").select(["teamId", "category"]).where("id", "=", statusId).executeTakeFirst();
  if (!s || s.teamId !== teamId) throw badRequest("Status does not belong to this team");
  return s.category;
}

export async function assertLabels(trx: Tx, labelIds: string[], teamId: string) {
  if (labelIds.length === 0) return;
  const rows = await trx.selectFrom("labels").select(["id", "teamId"]).where("id", "in", labelIds).execute();
  if (rows.length !== new Set(labelIds).size || rows.some((l) => l.teamId && l.teamId !== teamId)) {
    throw badRequest("Unknown label or label from another team");
  }
}

export async function assertCycle(trx: Tx, cycleId: string, teamId: string) {
  const cy = await trx.selectFrom("cycles").select("teamId").where("id", "=", cycleId).executeTakeFirst();
  if (!cy || cy.teamId !== teamId) throw badRequest("Cycle does not belong to this team");
}

/** Rejects a parent that doesn't exist or would create a loop. */
export async function assertParent(trx: Tx, issueId: string | null, parentId: string) {
  const r = await sql<{ id: string }>`
    WITH RECURSIVE chain AS (
      SELECT id, parent_id, 1 AS depth FROM issues WHERE id = ${parentId}
      UNION ALL
      SELECT i.id, i.parent_id, c.depth + 1 FROM issues i JOIN chain c ON i.id = c.parent_id WHERE c.depth < 50
    ) SELECT id FROM chain`.execute(trx);
  if (r.rows.length === 0) throw badRequest("Parent issue not found");
  if (issueId && r.rows.some((x) => x.id === issueId)) throw badRequest("An issue can't be its own ancestor");
}

export function categoryTimestamps(category: string, prev: { startedAt?: Date | null }) {
  const now = new Date();
  return {
    startedAt: category === "started" ? (prev.startedAt ?? now) : category === "backlog" || category === "unstarted" ? null : (prev.startedAt ?? null),
    completedAt: category === "completed" ? now : null,
    canceledAt: category === "canceled" ? now : null,
  };
}

export async function lastSortKey(trx: Tx, teamId: string): Promise<string | null> {
  const r = await trx.selectFrom("issues").select((eb) => eb.fn.max("sortKey").as("k")).where("teamId", "=", teamId).executeTakeFirst();
  return (r?.k as string | null) ?? null;
}

/** Replaces the assignee set; returns who was added and removed. */
export async function setAssignees(trx: Tx, workspaceId: string, issueId: string, next: string[]) {
  const cur = (await trx.selectFrom("issueAssignees").select("userId").where("issueId", "=", issueId).execute()).map((r) => r.userId);
  const want = [...new Set(next)];
  const added = want.filter((u) => !cur.includes(u));
  const removed = cur.filter((u) => !want.includes(u));
  if (removed.length) await trx.deleteFrom("issueAssignees").where("issueId", "=", issueId).where("userId", "in", removed).execute();
  if (added.length) await trx.insertInto("issueAssignees").values(added.map((userId) => ({ workspaceId, issueId, userId }))).execute();
  return { added, removed };
}

/**
 * Creates an issue with every check the API applies. Shared by POST /issues,
 * templates and recurring issues. `visible` is the guest team allow-list
 * (null = all teams). Returns the new id; the caller loads and returns it.
 */
export async function createIssueCore(
  trx: Tx,
  p: { workspaceId: string; actorId: string; visible: string[] | null; input: IssueInput; activity?: Record<string, unknown> },
): Promise<string> {
  const { input } = p;
  const team = await trx.selectFrom("teams").select(["id", "archivedAt"]).where("id", "=", input.teamId).executeTakeFirst();
  if (!team || (p.visible && !p.visible.includes(input.teamId))) throw notFound("Team not found");
  let statusId = input.statusId ?? null;
  if (!statusId) {
    const s = await trx.selectFrom("workflowStates").select("id").where("teamId", "=", input.teamId)
      .orderBy(sql`CASE category WHEN 'backlog' THEN 0 WHEN 'unstarted' THEN 1 ELSE 2 END`).orderBy("position").executeTakeFirst();
    if (!s) throw badRequest("Team has no statuses");
    statusId = s.id;
  }
  const category = await assertState(trx, statusId, input.teamId);
  await assertMembers(trx, input.assigneeIds);
  await assertLabels(trx, input.labelIds, input.teamId);
  if (input.cycleId) await assertCycle(trx, input.cycleId, input.teamId);
  if (input.parentId) await assertParent(trx, null, input.parentId);
  const fieldValues = await validateFieldValues(trx, input.teamId, input.fields);
  const counter = await trx.updateTable("teams").set((eb) => ({ issueCounter: eb("issueCounter", "+", 1) }))
    .where("id", "=", input.teamId).returning("issueCounter").executeTakeFirstOrThrow();
  const id = uuid7();
  await trx.insertInto("issues").values({
    id,
    workspaceId: p.workspaceId,
    teamId: input.teamId,
    number: counter.issueCounter,
    title: input.title,
    descriptionMd: input.description,
    statusId,
    priority: input.priority,
    creatorId: p.actorId,
    parentId: input.parentId ?? null,
    cycleId: input.cycleId ?? null,
    dueDate: input.dueDate ?? null,
    estimate: input.estimate ?? null,
    sortKey: keyBetween(await lastSortKey(trx, input.teamId), null),
    ...categoryTimestamps(category, {}),
  }).execute();
  if (input.labelIds.length) {
    await trx.insertInto("issueLabels").values([...new Set(input.labelIds)].map((labelId) => ({ workspaceId: p.workspaceId, issueId: id, labelId }))).execute();
  }
  await setAssignees(trx, p.workspaceId, id, input.assigneeIds);
  await writeFieldValues(trx, p.workspaceId, id, fieldValues);
  await recordActivity(trx, p.workspaceId, id, p.actorId, "created", p.activity ?? {});
  const mentioned = await resolveMentions(trx, input.description);
  await subscribe(trx, p.workspaceId, id, [p.actorId, ...input.assigneeIds, ...mentioned]);
  await createNotifications(trx, { workspaceId: p.workspaceId, issueId: id, actorId: p.actorId, kind: "assigned", userIds: input.assigneeIds });
  await createNotifications(trx, { workspaceId: p.workspaceId, issueId: id, actorId: p.actorId, kind: "mentioned", userIds: mentioned });
  await notify(trx, p.workspaceId, { t: "issue", id });
  return id;
}

export { NONE };
