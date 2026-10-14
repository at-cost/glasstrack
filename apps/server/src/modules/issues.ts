import { Hono } from "hono";
import { sql } from "kysely";
import { z } from "zod";
import {
  type Activity,
  createIssueSchema,
  type Issue,
  type IssueDetail,
  type IssueFilter,
  issueFilterSchema,
  type IssueRelation,
  keyBetween,
  moveIssueSchema,
  parseIssueKey,
  relationSchema,
  updateIssueSchema,
} from "@tracker/shared";
import { type AppEnv, type Ctx, requireRole, requireUser } from "../context";
import { notify, type Tx } from "../db/tenant";
import { badRequest, conflict, notFound } from "../lib/errors";
import { isUuid, uuid7 } from "../lib/ids";
import { attachmentsFor } from "./attachments";
import { createNotifications, resolveMentions, subscribe, subscribersOf } from "./notifyService";
import { assertTeamAccess, visibleTeamIds } from "./teams";

const NONE = "00000000-0000-0000-0000-000000000000";

const ISSUE_COLUMNS = [
  "i.id",
  "i.teamId",
  "i.number",
  "i.title",
  "i.descriptionMd",
  "i.statusId",
  "i.priority",
  "i.assigneeId",
  "i.creatorId",
  "i.parentId",
  "i.cycleId",
  "i.dueDate",
  "i.estimate",
  "i.sortKey",
  "i.createdAt",
  "i.updatedAt",
  "i.completedAt",
  "i.archivedAt",
  "t.key as teamKey",
] as const;

function baseQuery(trx: Tx) {
  return trx
    .selectFrom("issues as i")
    .innerJoin("teams as t", "t.id", "i.teamId")
    .select(ISSUE_COLUMNS)
    .select((eb) =>
      eb
        .selectFrom("issueLabels as il")
        .select(sql<string[]>`coalesce(array_agg(il.label_id ORDER BY il.label_id), '{}')`.as("labelIds"))
        .whereRef("il.issueId", "=", "i.id")
        .as("labelIds"),
    );
}

type IssueRowOut = Awaited<ReturnType<ReturnType<typeof baseQuery>["executeTakeFirstOrThrow"]>>;

export function toIssue(r: IssueRowOut): Issue {
  return {
    id: r.id,
    teamId: r.teamId,
    number: r.number,
    identifier: `${r.teamKey}-${r.number}`,
    title: r.title,
    description: r.descriptionMd,
    statusId: r.statusId,
    priority: r.priority as Issue["priority"],
    assigneeId: r.assigneeId,
    creatorId: r.creatorId ?? "",
    parentId: r.parentId,
    cycleId: r.cycleId,
    dueDate: r.dueDate,
    estimate: r.estimate === null ? null : Number(r.estimate),
    sortKey: r.sortKey,
    labelIds: r.labelIds ?? [],
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
    completedAt: r.completedAt?.toISOString() ?? null,
    archivedAt: r.archivedAt?.toISOString() ?? null,
  };
}

/** Resolves "ENG-12", an old key alias, or a uuid, honouring guest team access. */
export async function findIssue(c: Ctx, ref: string): Promise<Issue> {
  const trx = c.get("trx");
  let q = baseQuery(trx);
  if (isUuid(ref)) {
    q = q.where("i.id", "=", ref);
  } else {
    const k = parseIssueKey(ref);
    if (!k) throw notFound("Issue not found");
    q = q.where("i.number", "=", k.number).where((eb) =>
      eb.or([
        eb("t.key", "=", k.key),
        eb("i.teamId", "in", eb.selectFrom("teamKeyAliases").select("teamId").where("key", "=", k.key)),
      ]),
    );
  }
  const row = await q.executeTakeFirst();
  if (!row) throw notFound("Issue not found");
  const visible = await visibleTeamIds(c);
  if (visible && !visible.includes(row.teamId)) throw notFound("Issue not found");
  return toIssue(row);
}

export function applyFilters(q: ReturnType<typeof baseQuery>, f: IssueFilter, userId: string, visible: string[] | null) {
  if (visible) q = q.where("i.teamId", "in", visible.length ? visible : [NONE]);
  if (f.team) q = q.where("i.teamId", "=", f.team);
  if (!f.includeArchived) q = q.where("i.archivedAt", "is", null).where("t.archivedAt", "is", null);
  if (f.status?.length) q = q.where("i.statusId", "in", f.status);
  if (f.priority?.length) q = q.where("i.priority", "in", f.priority);
  if (f.parent) q = q.where("i.parentId", "=", f.parent);
  if (f.assignee?.length) {
    const ids = f.assignee.filter((a) => a !== "none").map((a) => (a === "me" ? userId : a));
    const wantNone = f.assignee.includes("none");
    q = q.where((eb) => {
      const ors = [];
      if (ids.length) ors.push(eb("i.assigneeId", "in", ids));
      if (wantNone) ors.push(eb("i.assigneeId", "is", null));
      return eb.or(ors);
    });
  }
  if (f.label?.length) {
    q = q.where((eb) =>
      eb.exists(eb.selectFrom("issueLabels as fl").select("fl.issueId").whereRef("fl.issueId", "=", "i.id").where("fl.labelId", "in", f.label!)),
    );
  }
  if (f.cycle === "none") q = q.where("i.cycleId", "is", null);
  else if (f.cycle === "active") {
    q = q.where("i.cycleId", "in", (eb) =>
      eb.selectFrom("cycles").select("id").where("completedAt", "is", null)
        .where("startsOn", "<=", sql<string>`current_date`).where("endsOn", ">=", sql<string>`current_date`),
    );
  } else if (f.cycle) q = q.where("i.cycleId", "=", f.cycle);
  if (f.q?.trim()) {
    const text = f.q.trim();
    const key = parseIssueKey(text);
    q = q.where((eb) => {
      const ors = [
        sql<boolean>`i.search @@ websearch_to_tsquery('simple', ${text})`,
        eb("i.title", "ilike", `%${text.replace(/[\\%_]/g, (m) => `\\${m}`)}%`),
        eb.exists(
          eb.selectFrom("comments as sc").select("sc.id").whereRef("sc.issueId", "=", "i.id").where("sc.deletedAt", "is", null)
            .where(sql<boolean>`sc.search @@ websearch_to_tsquery('simple', ${text})`),
        ),
      ];
      if (key) ors.push(eb.and([eb("t.key", "=", key.key), eb("i.number", "=", key.number)]));
      return eb.or(ors);
    });
  }
  return q;
}

/** Parses repeated or comma separated query params into a filter. */
export function filterFromQuery(c: Ctx): IssueFilter {
  const list = (k: string) => {
    const v = c.req.queries(k)?.flatMap((s) => s.split(",")).filter(Boolean);
    return v?.length ? v : undefined;
  };
  return issueFilterSchema.parse({
    team: c.req.query("team") || undefined,
    status: list("status"),
    assignee: list("assignee"),
    label: list("label"),
    priority: list("priority")?.map(Number),
    cycle: c.req.query("cycle") || undefined,
    q: c.req.query("q") || undefined,
    parent: c.req.query("parent") || undefined,
    includeArchived: c.req.query("includeArchived") === "true" || undefined,
  });
}

async function recordActivity(trx: Tx, workspaceId: string, issueId: string, actorId: string, kind: string, data: Record<string, unknown> = {}) {
  await trx.insertInto("activity").values({ workspaceId, issueId, actorId, kind, data: JSON.stringify(data) }).execute();
}

async function assertMember(trx: Tx, userId: string) {
  const m = await trx.selectFrom("workspaceMembers").select("userId").where("userId", "=", userId)
    .where("workspaceId", "=", sql<string>`app.ws()`).executeTakeFirst();
  if (!m) throw badRequest("Assignee must be a workspace member");
}

async function assertState(trx: Tx, statusId: string, teamId: string) {
  const s = await trx.selectFrom("workflowStates").select(["teamId", "category"]).where("id", "=", statusId).executeTakeFirst();
  if (!s || s.teamId !== teamId) throw badRequest("Status does not belong to this team");
  return s.category;
}

async function assertLabels(trx: Tx, labelIds: string[], teamId: string) {
  if (labelIds.length === 0) return;
  const rows = await trx.selectFrom("labels").select(["id", "teamId"]).where("id", "in", labelIds).execute();
  if (rows.length !== new Set(labelIds).size || rows.some((l) => l.teamId && l.teamId !== teamId)) {
    throw badRequest("Unknown label or label from another team");
  }
}

async function assertCycle(trx: Tx, cycleId: string, teamId: string) {
  const cy = await trx.selectFrom("cycles").select("teamId").where("id", "=", cycleId).executeTakeFirst();
  if (!cy || cy.teamId !== teamId) throw badRequest("Cycle does not belong to this team");
}

/** Rejects a parent that doesn't exist or would create a loop. */
async function assertParent(trx: Tx, issueId: string | null, parentId: string) {
  const r = await sql<{ id: string }>`
    WITH RECURSIVE chain AS (
      SELECT id, parent_id, 1 AS depth FROM issues WHERE id = ${parentId}
      UNION ALL
      SELECT i.id, i.parent_id, c.depth + 1 FROM issues i JOIN chain c ON i.id = c.parent_id WHERE c.depth < 50
    ) SELECT id FROM chain`.execute(trx);
  if (r.rows.length === 0) throw badRequest("Parent issue not found");
  if (issueId && r.rows.some((x) => x.id === issueId)) throw badRequest("An issue can't be its own ancestor");
}

function categoryTimestamps(category: string, prev: { startedAt?: Date | null }) {
  const now = new Date();
  return {
    startedAt: category === "started" ? (prev.startedAt ?? now) : category === "backlog" || category === "unstarted" ? null : (prev.startedAt ?? null),
    completedAt: category === "completed" ? now : null,
    canceledAt: category === "canceled" ? now : null,
  };
}

async function lastSortKey(trx: Tx, teamId: string): Promise<string | null> {
  const r = await trx.selectFrom("issues").select((eb) => eb.fn.max("sortKey").as("k")).where("teamId", "=", teamId).executeTakeFirst();
  return (r?.k as string | null) ?? null;
}

export async function detail(c: Ctx, issue: Issue): Promise<IssueDetail> {
  const trx = c.get("trx");
  const user = requireUser(c);
  const children = await trx.selectFrom("issues as i").innerJoin("teams as t", "t.id", "i.teamId")
    .select(["i.id", "i.number", "t.key", "i.title", "i.statusId", "i.assigneeId"])
    .where("i.parentId", "=", issue.id).where("i.archivedAt", "is", null).orderBy("i.sortKey").execute();
  const outgoing = await trx.selectFrom("issueRelations as r").innerJoin("issues as o", "o.id", "r.relatedIssueId")
    .innerJoin("teams as t", "t.id", "o.teamId")
    .select(["r.id", "r.type", "o.id as oid", "o.number", "t.key", "o.title", "o.statusId"])
    .where("r.issueId", "=", issue.id).execute();
  const incoming = await trx.selectFrom("issueRelations as r").innerJoin("issues as o", "o.id", "r.issueId")
    .innerJoin("teams as t", "t.id", "o.teamId")
    .select(["r.id", "r.type", "o.id as oid", "o.number", "t.key", "o.title", "o.statusId"])
    .where("r.relatedIssueId", "=", issue.id).execute();
  const rel = (dir: "outgoing" | "incoming") => (r: (typeof outgoing)[number]): IssueRelation => ({
    id: r.id,
    type: r.type,
    direction: dir,
    issue: { id: r.oid, identifier: `${r.key}-${r.number}`, title: r.title, statusId: r.statusId },
  });
  const sub = await trx.selectFrom("issueSubscribers").select("userId").where("issueId", "=", issue.id)
    .where("userId", "=", user.id).executeTakeFirst();
  return {
    ...issue,
    children: children.map((ch) => ({ id: ch.id, identifier: `${ch.key}-${ch.number}`, title: ch.title, statusId: ch.statusId, assigneeId: ch.assigneeId })),
    relations: [...outgoing.map(rel("outgoing")), ...incoming.map(rel("incoming"))],
    attachments: await attachmentsFor(c, issue.id),
    subscribed: Boolean(sub),
  };
}

export const issueRoutes = new Hono<AppEnv>()
  .get("/issues", async (c) => {
    const user = requireUser(c);
    const f = filterFromQuery(c);
    const limit = Math.min(Number(c.req.query("limit") ?? 500) || 500, 2000);
    const offset = Math.max(Number(c.req.query("offset") ?? 0) || 0, 0);
    const order = c.req.query("order") ?? "manual";
    let q = applyFilters(baseQuery(c.get("trx")), f, user.id, await visibleTeamIds(c));
    if (order === "priority") q = q.orderBy(sql`CASE WHEN i.priority = 0 THEN 9 ELSE i.priority END`).orderBy("i.sortKey");
    else if (order === "updated") q = q.orderBy("i.updatedAt", "desc");
    else if (order === "created") q = q.orderBy("i.createdAt", "desc");
    else q = q.orderBy("i.sortKey").orderBy("i.id");
    const rows = await q.limit(limit + 1).offset(offset).execute();
    return c.json({ issues: rows.slice(0, limit).map(toIssue), hasMore: rows.length > limit });
  })

  .post("/issues", async (c) => {
    const user = requireUser(c);
    const body = createIssueSchema.parse(await c.req.json());
    const trx = c.get("trx");
    const ws = c.get("ws");
    await assertTeamAccess(c, body.teamId);
    let statusId = body.statusId;
    if (statusId) await assertState(trx, statusId, body.teamId);
    else {
      const s = await trx.selectFrom("workflowStates").select("id").where("teamId", "=", body.teamId)
        .orderBy(sql`CASE category WHEN 'backlog' THEN 0 WHEN 'unstarted' THEN 1 ELSE 2 END`).orderBy("position").executeTakeFirst();
      if (!s) throw badRequest("Team has no statuses");
      statusId = s.id;
    }
    const category = await assertState(trx, statusId, body.teamId);
    if (body.assigneeId) await assertMember(trx, body.assigneeId);
    await assertLabels(trx, body.labelIds, body.teamId);
    if (body.cycleId) await assertCycle(trx, body.cycleId, body.teamId);
    if (body.parentId) await assertParent(trx, null, body.parentId);
    const counter = await trx.updateTable("teams").set((eb) => ({ issueCounter: eb("issueCounter", "+", 1) }))
      .where("id", "=", body.teamId).returning("issueCounter").executeTakeFirstOrThrow();
    const id = uuid7();
    await trx.insertInto("issues").values({
      id,
      workspaceId: ws.id,
      teamId: body.teamId,
      number: counter.issueCounter,
      title: body.title,
      descriptionMd: body.description,
      statusId,
      priority: body.priority,
      assigneeId: body.assigneeId ?? null,
      creatorId: user.id,
      parentId: body.parentId ?? null,
      cycleId: body.cycleId ?? null,
      dueDate: body.dueDate ?? null,
      estimate: body.estimate ?? null,
      sortKey: keyBetween(await lastSortKey(trx, body.teamId), null),
      ...categoryTimestamps(category, {}),
    }).execute();
    if (body.labelIds.length) {
      await trx.insertInto("issueLabels").values(body.labelIds.map((labelId) => ({ workspaceId: ws.id, issueId: id, labelId }))).execute();
    }
    await recordActivity(trx, ws.id, id, user.id, "created");
    const mentioned = await resolveMentions(trx, body.description);
    await subscribe(trx, ws.id, id, [user.id, body.assigneeId, ...mentioned]);
    if (body.assigneeId) {
      await createNotifications(trx, { workspaceId: ws.id, issueId: id, actorId: user.id, kind: "assigned", userIds: [body.assigneeId] });
    }
    await createNotifications(trx, { workspaceId: ws.id, issueId: id, actorId: user.id, kind: "mentioned", userIds: mentioned });
    await notify(trx, ws.id, { t: "issue", id });
    return c.json(await findIssue(c, id), 201);
  })

  .get("/issues/:ref", async (c) => c.json(await detail(c, await findIssue(c, c.req.param("ref")))))

  .patch("/issues/:ref", async (c) => {
    const user = requireUser(c);
    const body = updateIssueSchema.parse(await c.req.json());
    const trx = c.get("trx");
    const ws = c.get("ws");
    const cur = await findIssue(c, c.req.param("ref"));
    const raw = await trx.selectFrom("issues").select(["startedAt"]).where("id", "=", cur.id).executeTakeFirstOrThrow();
    const set: Record<string, unknown> = {};
    const acts: [string, Record<string, unknown>][] = [];
    const diff = <K extends keyof Issue>(k: K, v: Issue[K] | undefined, col: string, kind: string) => {
      if (v === undefined || v === cur[k]) return;
      set[col] = v;
      acts.push([kind, { from: cur[k], to: v }]);
    };
    diff("title", body.title, "title", "title");
    if (body.description !== undefined && body.description !== cur.description) {
      set.descriptionMd = body.description;
      acts.push(["description", {}]);
    }
    if (body.statusId !== undefined && body.statusId !== cur.statusId) {
      const category = await assertState(trx, body.statusId, cur.teamId);
      Object.assign(set, categoryTimestamps(category, raw));
    }
    diff("statusId", body.statusId, "statusId", "status");
    diff("priority", body.priority as Issue["priority"] | undefined, "priority", "priority");
    if (body.assigneeId) await assertMember(trx, body.assigneeId);
    diff("assigneeId", body.assigneeId, "assigneeId", "assignee");
    diff("dueDate", body.dueDate, "dueDate", "due_date");
    diff("estimate", body.estimate, "estimate", "estimate");
    if (body.cycleId) await assertCycle(trx, body.cycleId, cur.teamId);
    diff("cycleId", body.cycleId, "cycleId", "cycle");
    if (body.parentId) await assertParent(trx, cur.id, body.parentId);
    diff("parentId", body.parentId, "parentId", "parent");

    if (Object.keys(set).length) {
      await trx.updateTable("issues").set({ ...set, updatedAt: new Date() }).where("id", "=", cur.id).execute();
    }
    if (body.labelIds) {
      await assertLabels(trx, body.labelIds, cur.teamId);
      const before = new Set(cur.labelIds);
      const after = new Set(body.labelIds);
      const added = [...after].filter((l) => !before.has(l));
      const removed = [...before].filter((l) => !after.has(l));
      if (removed.length) await trx.deleteFrom("issueLabels").where("issueId", "=", cur.id).where("labelId", "in", removed).execute();
      if (added.length) await trx.insertInto("issueLabels").values(added.map((labelId) => ({ workspaceId: ws.id, issueId: cur.id, labelId }))).execute();
      if (added.length || removed.length) {
        acts.push(["labels", { added, removed }]);
        if (!Object.keys(set).length) await trx.updateTable("issues").set({ updatedAt: new Date() }).where("id", "=", cur.id).execute();
      }
    }
    for (const [kind, data] of acts) await recordActivity(trx, ws.id, cur.id, user.id, kind, data);

    if (body.assigneeId && body.assigneeId !== cur.assigneeId) {
      await subscribe(trx, ws.id, cur.id, [body.assigneeId]);
      await createNotifications(trx, { workspaceId: ws.id, issueId: cur.id, actorId: user.id, kind: "assigned", userIds: [body.assigneeId] });
    }
    if (body.statusId && body.statusId !== cur.statusId) {
      await createNotifications(trx, {
        workspaceId: ws.id, issueId: cur.id, actorId: user.id, kind: "status_changed",
        userIds: await subscribersOf(trx, cur.id), data: { from: cur.statusId, to: body.statusId },
      });
    }
    if (body.description !== undefined && body.description !== cur.description) {
      const before = new Set(await resolveMentions(trx, cur.description));
      const fresh = (await resolveMentions(trx, body.description)).filter((u) => !before.has(u));
      await subscribe(trx, ws.id, cur.id, fresh);
      await createNotifications(trx, { workspaceId: ws.id, issueId: cur.id, actorId: user.id, kind: "mentioned", userIds: fresh });
    }
    if (acts.length) await notify(trx, ws.id, { t: "issue", id: cur.id });
    return c.json(await findIssue(c, cur.id));
  })

  .post("/issues/:ref/move", async (c) => {
    const user = requireUser(c);
    const body = moveIssueSchema.parse(await c.req.json());
    const trx = c.get("trx");
    const ws = c.get("ws");
    const cur = await findIssue(c, c.req.param("ref"));
    const statusId = body.statusId ?? cur.statusId;
    const set: Record<string, unknown> = {};
    if (statusId !== cur.statusId) {
      const category = await assertState(trx, statusId, cur.teamId);
      const raw = await trx.selectFrom("issues").select(["startedAt"]).where("id", "=", cur.id).executeTakeFirstOrThrow();
      Object.assign(set, { statusId }, categoryTimestamps(category, raw));
    }
    const keyOf = async (id: string | null | undefined) => {
      if (!id) return null;
      const r = await trx.selectFrom("issues").select(["sortKey", "teamId"]).where("id", "=", id).executeTakeFirst();
      if (!r || r.teamId !== cur.teamId) throw badRequest("Neighbour issue not found in this team");
      return r.sortKey;
    };
    let a = await keyOf(body.afterId);
    let b = await keyOf(body.beforeId);
    if (a === null && b === null && body.afterId === null) {
      // Move to the top of the column.
      const first = await trx.selectFrom("issues").select((eb) => eb.fn.min("sortKey").as("k"))
        .where("teamId", "=", cur.teamId).where("statusId", "=", statusId).where("id", "!=", cur.id).executeTakeFirst();
      b = (first?.k as string | null) ?? null;
    }
    if (a !== null && (b === null || a >= b)) {
      // Find the real next key after `a` in the team so the result is strictly between.
      const next = await trx.selectFrom("issues").select((eb) => eb.fn.min("sortKey").as("k"))
        .where("teamId", "=", cur.teamId).where("sortKey", ">", a).where("id", "!=", cur.id).executeTakeFirst();
      b = (next?.k as string | null) ?? null;
    }
    if (a !== null && b !== null && a >= b) a = null;
    set.sortKey = keyBetween(a, b);
    await trx.updateTable("issues").set({ ...set, updatedAt: new Date() }).where("id", "=", cur.id).execute();
    if (set.statusId) {
      await recordActivity(trx, ws.id, cur.id, user.id, "status", { from: cur.statusId, to: statusId });
      await createNotifications(trx, {
        workspaceId: ws.id, issueId: cur.id, actorId: user.id, kind: "status_changed",
        userIds: await subscribersOf(trx, cur.id), data: { from: cur.statusId, to: statusId },
      });
    }
    await notify(trx, ws.id, { t: "issue", id: cur.id });
    return c.json(await findIssue(c, cur.id));
  })

  .post("/issues/:ref/archive", async (c) => {
    const user = requireUser(c);
    const { archived } = z.object({ archived: z.boolean() }).parse(await c.req.json());
    const trx = c.get("trx");
    const cur = await findIssue(c, c.req.param("ref"));
    await trx.updateTable("issues").set({ archivedAt: archived ? new Date() : null, updatedAt: new Date() }).where("id", "=", cur.id).execute();
    await recordActivity(trx, c.get("ws").id, cur.id, user.id, archived ? "archived" : "unarchived");
    await notify(trx, c.get("ws").id, { t: "issue", id: cur.id });
    return c.json(await findIssue(c, cur.id));
  })

  .delete("/issues/:ref", async (c) => {
    const user = requireUser(c);
    const cur = await findIssue(c, c.req.param("ref"));
    if (cur.creatorId !== user.id) requireRole(c, "admin");
    const trx = c.get("trx");
    const files = await trx.selectFrom("attachments").select("storageKey").where("issueId", "=", cur.id).execute();
    await trx.deleteFrom("issues").where("id", "=", cur.id).execute();
    const storage = c.get("deps").storage;
    for (const f of files) await storage.delete(f.storageKey).catch(() => undefined);
    await notify(trx, c.get("ws").id, { t: "issue", id: cur.id });
    return c.json({ ok: true });
  })

  .post("/issues/:ref/relations", async (c) => {
    const user = requireUser(c);
    const body = relationSchema.parse(await c.req.json());
    const trx = c.get("trx");
    const ws = c.get("ws");
    const cur = await findIssue(c, c.req.param("ref"));
    const other = await findIssue(c, body.relatedIssueId);
    if (other.id === cur.id) throw badRequest("An issue can't relate to itself");
    const existing = await trx.selectFrom("issueRelations").select("id")
      .where((eb) => eb.or([
        eb.and([eb("issueId", "=", cur.id), eb("relatedIssueId", "=", other.id)]),
        eb.and([eb("issueId", "=", other.id), eb("relatedIssueId", "=", cur.id)]),
      ])).where("type", "=", body.type).executeTakeFirst();
    if (existing) throw conflict("These issues are already linked");
    const id = uuid7();
    await trx.insertInto("issueRelations").values({ id, workspaceId: ws.id, issueId: cur.id, relatedIssueId: other.id, type: body.type }).execute();
    await recordActivity(trx, ws.id, cur.id, user.id, "relation_added", { type: body.type, issue: other.identifier });
    await recordActivity(trx, ws.id, other.id, user.id, "relation_added", { type: body.type, issue: cur.identifier, incoming: true });
    await notify(trx, ws.id, { t: "issue", id: cur.id });
    await notify(trx, ws.id, { t: "issue", id: other.id });
    return c.json({ id }, 201);
  })
  .delete("/issues/:ref/relations/:id", async (c) => {
    const user = requireUser(c);
    const trx = c.get("trx");
    const cur = await findIssue(c, c.req.param("ref"));
    const r = await trx.deleteFrom("issueRelations").where("id", "=", c.req.param("id"))
      .where((eb) => eb.or([eb("issueId", "=", cur.id), eb("relatedIssueId", "=", cur.id)]))
      .returning(["issueId", "relatedIssueId", "type"]).executeTakeFirst();
    if (!r) throw notFound("Link not found");
    const otherId = r.issueId === cur.id ? r.relatedIssueId : r.issueId;
    const other = await findIssue(c, otherId).catch(() => null);
    await recordActivity(trx, c.get("ws").id, cur.id, user.id, "relation_removed", { type: r.type, issue: other?.identifier ?? null });
    if (other) await recordActivity(trx, c.get("ws").id, other.id, user.id, "relation_removed", { type: r.type, issue: cur.identifier, incoming: true });
    await notify(trx, c.get("ws").id, { t: "issue", id: r.issueId });
    await notify(trx, c.get("ws").id, { t: "issue", id: r.relatedIssueId });
    return c.json({ ok: true });
  })

  .put("/issues/:ref/subscription", async (c) => {
    const user = requireUser(c);
    const { subscribed } = z.object({ subscribed: z.boolean() }).parse(await c.req.json());
    const trx = c.get("trx");
    const cur = await findIssue(c, c.req.param("ref"));
    if (subscribed) await subscribe(trx, c.get("ws").id, cur.id, [user.id]);
    else await trx.deleteFrom("issueSubscribers").where("issueId", "=", cur.id).where("userId", "=", user.id).execute();
    return c.json({ subscribed });
  })

  .get("/issues/:ref/activity", async (c) => {
    const cur = await findIssue(c, c.req.param("ref"));
    const rows = await c.get("trx").selectFrom("activity").select(["id", "issueId", "actorId", "kind", "data", "createdAt"])
      .where("issueId", "=", cur.id).orderBy("id").limit(1000).execute();
    return c.json(rows.map((r): Activity => ({ ...r, createdAt: r.createdAt.toISOString() })));
  })

  .get("/search", async (c) => {
    const user = requireUser(c);
    const q = (c.req.query("q") ?? "").trim();
    if (!q) return c.json({ issues: [] });
    const rows = await applyFilters(baseQuery(c.get("trx")), { q, includeArchived: false }, user.id, await visibleTeamIds(c))
      .orderBy(sql`ts_rank(i.search, websearch_to_tsquery('simple', ${q}))`, "desc")
      .orderBy("i.updatedAt", "desc")
      .limit(20)
      .execute();
    return c.json({ issues: rows.map(toIssue).map(({ id, identifier, title, statusId, teamId }) => ({ id, identifier, title, statusId, teamId })) });
  });

