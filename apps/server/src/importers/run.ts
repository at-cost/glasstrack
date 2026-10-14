import { Hono } from "hono";
import { z } from "zod";
import { keysAfter } from "@glasstrack/shared";
import { type AppEnv, type Ctx, requireRole, requireUser } from "../context";
import { notify } from "../db/tenant";
import { badRequest } from "../lib/errors";
import { uuid7 } from "../lib/ids";
import { assertTeamAccess } from "../modules/teams";
import { guessCategory, type ParsedImport, parseJiraCsv, parseLinearCsv, parseTrelloJson } from "./parse";

const MAX_ISSUES = 5000;
const MAX_COMMENTS = 50_000;
const CATEGORY_COLORS = { backlog: "#8a8f98", unstarted: "#b4b9c2", started: "#e0a526", completed: "#4a7bd0", canceled: "#a05252" } as const;
const LABEL_COLORS = ["#2f5d50", "#4a7bd0", "#b7791f", "#a05252", "#6b5ca5", "#3fa36b", "#c05f8a", "#5a7d8c"];

export interface ImportSummary {
  issues: number;
  comments: number;
  labelsCreated: string[];
  statusesCreated: string[];
  unmatchedAssignees: string[];
  dryRun: boolean;
}

/** Writes a parsed import into one team, inside the request's workspace transaction. */
export async function runImport(c: Ctx, teamId: string, parsed: ParsedImport, source: string, dryRun: boolean): Promise<ImportSummary> {
  const trx = c.get("trx");
  const ws = c.get("ws");
  const user = requireUser(c);
  await assertTeamAccess(c, teamId);
  if (parsed.issues.length === 0) throw badRequest("No issues found in the file");
  if (parsed.issues.length > MAX_ISSUES) throw badRequest(`Imports are limited to ${MAX_ISSUES} issues at a time`);
  if (parsed.issues.reduce((n, i) => n + i.comments.length, 0) > MAX_COMMENTS) throw badRequest(`Imports are limited to ${MAX_COMMENTS} comments`);

  // Statuses: reuse by name, otherwise create with a guessed category.
  const states = await trx.selectFrom("workflowStates").select(["id", "name", "position"]).where("teamId", "=", teamId).execute();
  const stateByName = new Map(states.map((s) => [s.name.toLowerCase(), s.id]));
  let position = Math.max(0, ...states.map((s) => s.position));
  const statusesCreated: string[] = [];
  for (const name of parsed.statuses) {
    if (stateByName.has(name.toLowerCase())) continue;
    const category = guessCategory(name);
    const id = uuid7();
    if (!dryRun) await trx.insertInto("workflowStates").values({ id, workspaceId: ws.id, teamId, name: name.slice(0, 40), category, color: CATEGORY_COLORS[category], position: ++position }).execute();
    stateByName.set(name.toLowerCase(), id);
    statusesCreated.push(name);
  }

  // Labels: workspace-wide or this team's, by name.
  const labels = await trx.selectFrom("labels").select(["id", "name"]).where((eb) => eb.or([eb("teamId", "is", null), eb("teamId", "=", teamId)])).execute();
  const labelByName = new Map(labels.map((l) => [l.name.toLowerCase(), l.id]));
  const labelsCreated: string[] = [];
  for (const name of new Set(parsed.issues.flatMap((i) => i.labels))) {
    if (labelByName.has(name.toLowerCase())) continue;
    const id = uuid7();
    if (!dryRun) await trx.insertInto("labels").values({ id, workspaceId: ws.id, teamId: null, name: name.slice(0, 40), color: LABEL_COLORS[labelsCreated.length % LABEL_COLORS.length]! }).execute();
    labelByName.set(name.toLowerCase(), id);
    labelsCreated.push(name);
  }

  // People: match by email or display name.
  const members = await trx.selectFrom("workspaceMembers as m").innerJoin("users as u", "u.id", "m.userId").select(["u.id", "u.email", "u.name"])
    .where("m.workspaceId", "=", ws.id).execute();
  const person = new Map<string, string>();
  for (const m of members) {
    person.set(m.email.toLowerCase(), m.id);
    person.set(m.name.toLowerCase(), m.id);
    person.set(m.email.split("@")[0]!.toLowerCase(), m.id);
  }
  const who = (s: string | null) => (s ? (person.get(s.trim().toLowerCase()) ?? null) : null);
  const unmatchedAssignees = [...new Set(parsed.issues.map((i) => i.assignee).filter((a): a is string => Boolean(a) && !who(a)))];
  const commentCount = parsed.issues.reduce((n, i) => n + i.comments.length, 0);
  if (dryRun) return { issues: parsed.issues.length, comments: commentCount, labelsCreated, statusesCreated, unmatchedAssignees, dryRun };

  // Reserve issue numbers and sort keys in one go.
  const counter = await trx.updateTable("teams").set((eb) => ({ issueCounter: eb("issueCounter", "+", parsed.issues.length) }))
    .where("id", "=", teamId).returning("issueCounter").executeTakeFirstOrThrow();
  const firstNumber = counter.issueCounter - parsed.issues.length + 1;
  const last = await trx.selectFrom("issues").select((eb) => eb.fn.max("sortKey").as("k")).where("teamId", "=", teamId).executeTakeFirst();
  const keys = keysAfter((last?.k as string | null) ?? null, parsed.issues.length);
  const categories = new Map((await trx.selectFrom("workflowStates").select(["id", "category"]).where("teamId", "=", teamId).execute()).map((s) => [s.id, s.category]));

  const idByExternal = new Map<string, string>();
  const rows = parsed.issues.map((it, i) => {
    const id = uuid7();
    idByExternal.set(it.externalId, id);
    const statusId = stateByName.get(it.status.toLowerCase())!;
    const category = categories.get(statusId);
    const created = it.createdAt ?? new Date().toISOString();
    return {
      id, workspaceId: ws.id, teamId, number: firstNumber + i, title: it.title.slice(0, 300), descriptionMd: it.description.slice(0, 100_000),
      statusId, priority: it.priority, assigneeId: who(it.assignee), creatorId: user.id, dueDate: it.dueDate, estimate: it.estimate,
      sortKey: keys[i]!, createdAt: created, updatedAt: created,
      completedAt: category === "completed" ? created : null, canceledAt: category === "canceled" ? created : null,
    };
  });
  for (let i = 0; i < rows.length; i += 500) await trx.insertInto("issues").values(rows.slice(i, i + 500)).execute();

  const issueLabels = parsed.issues.flatMap((it) => [...new Set(it.labels.map((l) => labelByName.get(l.toLowerCase())!))].map((labelId) => ({ workspaceId: ws.id, issueId: idByExternal.get(it.externalId)!, labelId })));
  for (let i = 0; i < issueLabels.length; i += 1000) await trx.insertInto("issueLabels").values(issueLabels.slice(i, i + 1000)).execute();

  for (const it of parsed.issues) {
    const parent = it.parentExternalId ? idByExternal.get(it.parentExternalId) : undefined;
    if (parent && parent !== idByExternal.get(it.externalId)) {
      await trx.updateTable("issues").set({ parentId: parent }).where("id", "=", idByExternal.get(it.externalId)!).execute();
    }
  }

  const comments = parsed.issues.flatMap((it) => it.comments.map((cm) => {
    const author = who(cm.author);
    return {
      id: uuid7(), workspaceId: ws.id, issueId: idByExternal.get(it.externalId)!, authorId: author ?? user.id,
      bodyMd: author ? cm.body : `**${cm.author}** (imported):\n\n${cm.body}`, createdAt: cm.createdAt ?? new Date().toISOString(),
    };
  }));
  for (let i = 0; i < comments.length; i += 500) await trx.insertInto("comments").values(comments.slice(i, i + 500)).execute();

  const activity = parsed.issues.map((it) => ({ workspaceId: ws.id, issueId: idByExternal.get(it.externalId)!, actorId: user.id, kind: "imported", data: JSON.stringify({ source, externalId: it.externalId }) }));
  for (let i = 0; i < activity.length; i += 1000) await trx.insertInto("activity").values(activity.slice(i, i + 1000)).execute();
  const subs = rows.map((r) => ({ workspaceId: ws.id, issueId: r.id, userId: user.id }));
  for (let i = 0; i < subs.length; i += 1000) await trx.insertInto("issueSubscribers").values(subs.slice(i, i + 1000)).execute();
  await notify(trx, ws.id, { t: "team", id: teamId });
  return { issues: rows.length, comments: comments.length, labelsCreated, statusesCreated, unmatchedAssignees, dryRun };
}

export const importRoutes = new Hono<AppEnv>().post("/import", async (c) => {
  requireRole(c, "member");
  const body = z.object({
    source: z.enum(["linear", "jira", "trello"]),
    teamId: z.uuid(),
    content: z.string().min(1).max(25 * 1024 * 1024),
    dryRun: z.boolean().default(false),
  }).parse(await c.req.json());
  let parsed: ParsedImport;
  try {
    parsed = body.source === "linear" ? parseLinearCsv(body.content) : body.source === "jira" ? parseJiraCsv(body.content) : parseTrelloJson(body.content);
  } catch (err) {
    throw badRequest(String((err as Error).message));
  }
  return c.json(await runImport(c, body.teamId, parsed, body.source, body.dryRun));
});
