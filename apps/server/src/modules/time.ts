import { Hono } from "hono";
import { type TimeEntry, timeEntrySchema } from "@glasstrack/shared";
import { type AppEnv, requireRole, requireUser } from "../context";
import { notify, type Tx } from "../db/tenant";
import { badRequest, notFound } from "../lib/errors";
import { uuid7 } from "../lib/ids";
import { findIssue } from "./issues";
import { recordActivity } from "./issueService";
import { visibleTeamIds } from "./teams";

const COLS = ["id", "issueId", "userId", "spentOn", "minutes", "note", "createdAt"] as const;
const toEntry = (r: { id: string; issueId: string; userId: string | null; spentOn: string; minutes: number; note: string | null; createdAt: Date }): TimeEntry => ({
  ...r,
  createdAt: r.createdAt.toISOString(),
});

/** Stops the user's running timer, if any, and logs the time (at least one minute, at most a day). */
async function stopTimer(trx: Tx, workspaceId: string, userId: string): Promise<TimeEntry | null> {
  const t = await trx.deleteFrom("activeTimers").where("userId", "=", userId).where("workspaceId", "=", workspaceId)
    .returning(["issueId", "startedAt"]).executeTakeFirst();
  if (!t) return null;
  const minutes = Math.min(1440, Math.max(1, Math.round((Date.now() - t.startedAt.getTime()) / 60_000)));
  const row = await trx.insertInto("timeEntries").values({
    id: uuid7(), workspaceId, issueId: t.issueId, userId, spentOn: new Date().toISOString().slice(0, 10), minutes, note: "Timer",
  }).returning(COLS).executeTakeFirstOrThrow();
  await recordActivity(trx, workspaceId, t.issueId, userId, "time_logged", { minutes });
  await notify(trx, workspaceId, { t: "issue", id: t.issueId });
  return toEntry(row);
}

export const timeRoutes = new Hono<AppEnv>()
  .get("/issues/:ref/time", async (c) => {
    const issue = await findIssue(c, c.req.param("ref"));
    const rows = await c.get("trx").selectFrom("timeEntries").select(COLS).where("issueId", "=", issue.id)
      .orderBy("spentOn", "desc").orderBy("createdAt", "desc").limit(500).execute();
    return c.json(rows.map(toEntry));
  })
  .post("/issues/:ref/time", async (c) => {
    const user = requireUser(c);
    const body = timeEntrySchema.parse(await c.req.json());
    const trx = c.get("trx");
    const issue = await findIssue(c, c.req.param("ref"));
    const row = await trx.insertInto("timeEntries").values({
      id: uuid7(), workspaceId: c.get("ws").id, issueId: issue.id, userId: user.id, spentOn: body.spentOn, minutes: body.minutes, note: body.note || null,
    }).returning(COLS).executeTakeFirstOrThrow();
    await recordActivity(trx, c.get("ws").id, issue.id, user.id, "time_logged", { minutes: body.minutes });
    await notify(trx, c.get("ws").id, { t: "issue", id: issue.id });
    return c.json(toEntry(row), 201);
  })
  .patch("/time/:id", async (c) => {
    const user = requireUser(c);
    const body = timeEntrySchema.partial().parse(await c.req.json());
    const trx = c.get("trx");
    const cur = await trx.selectFrom("timeEntries").select(["userId", "issueId"]).where("id", "=", c.req.param("id")).executeTakeFirst();
    if (!cur) throw notFound("Time entry not found");
    await findIssue(c, cur.issueId);
    if (cur.userId !== user.id) requireRole(c, "admin");
    const row = await trx.updateTable("timeEntries").set({
      ...(body.minutes ? { minutes: body.minutes } : {}),
      ...(body.spentOn ? { spentOn: body.spentOn } : {}),
      ...(body.note !== undefined ? { note: body.note || null } : {}),
    }).where("id", "=", c.req.param("id")).returning(COLS).executeTakeFirstOrThrow();
    await notify(trx, c.get("ws").id, { t: "issue", id: cur.issueId });
    return c.json(toEntry(row));
  })
  .delete("/time/:id", async (c) => {
    const user = requireUser(c);
    const trx = c.get("trx");
    const cur = await trx.selectFrom("timeEntries").select(["userId", "issueId"]).where("id", "=", c.req.param("id")).executeTakeFirst();
    if (!cur) throw notFound("Time entry not found");
    await findIssue(c, cur.issueId);
    if (cur.userId !== user.id) requireRole(c, "admin");
    await trx.deleteFrom("timeEntries").where("id", "=", c.req.param("id")).execute();
    await notify(trx, c.get("ws").id, { t: "issue", id: cur.issueId });
    return c.json({ ok: true });
  })
  .get("/timer", async (c) => {
    const user = requireUser(c);
    const t = await c.get("trx").selectFrom("activeTimers as a").innerJoin("issues as i", "i.id", "a.issueId").innerJoin("teams as tm", "tm.id", "i.teamId")
      .select(["a.issueId", "a.startedAt", "i.title", "i.number", "tm.key"]).where("a.userId", "=", user.id).executeTakeFirst();
    return c.json(t ? { issueId: t.issueId, identifier: `${t.key}-${t.number}`, title: t.title, startedAt: t.startedAt.toISOString() } : null);
  })
  .post("/issues/:ref/timer/start", async (c) => {
    const user = requireUser(c);
    const trx = c.get("trx");
    const ws = c.get("ws");
    const issue = await findIssue(c, c.req.param("ref"));
    // Starting a timer stops (and logs) any other running one.
    const stopped = await stopTimer(trx, ws.id, user.id);
    await trx.insertInto("activeTimers").values({ workspaceId: ws.id, userId: user.id, issueId: issue.id }).execute();
    await notify(trx, ws.id, { t: "issue", id: issue.id });
    return c.json({ started: true, stopped });
  })
  .post("/timer/stop", async (c) => {
    const user = requireUser(c);
    const entry = await stopTimer(c.get("trx"), c.get("ws").id, user.id);
    if (!entry) throw badRequest("No timer is running");
    return c.json(entry);
  })
  /** Time report: entries in a date range with totals per person and per issue. */
  .get("/time", async (c) => {
    requireUser(c);
    const from = c.req.query("from");
    const to = c.req.query("to");
    const day = /^\d{4}-\d{2}-\d{2}$/;
    if (!from || !to || !day.test(from) || !day.test(to) || from > to) throw badRequest("from and to (YYYY-MM-DD) are required");
    const visible = await visibleTeamIds(c);
    let q = c.get("trx").selectFrom("timeEntries as e").innerJoin("issues as i", "i.id", "e.issueId").innerJoin("teams as t", "t.id", "i.teamId")
      .select(["e.id", "e.issueId", "e.userId", "e.spentOn", "e.minutes", "e.note", "e.createdAt", "i.number", "t.key", "i.title", "i.teamId"])
      .where("e.spentOn", ">=", from).where("e.spentOn", "<=", to);
    const team = c.req.query("team");
    const userId = c.req.query("user");
    if (team) q = q.where("i.teamId", "=", team);
    if (userId) q = q.where("e.userId", "=", userId);
    if (visible) q = q.where("i.teamId", "in", visible.length ? visible : ["00000000-0000-0000-0000-000000000000"]);
    const rows = await q.orderBy("e.spentOn", "desc").limit(5000).execute();
    const byUser = new Map<string, number>();
    const byIssue = new Map<string, { identifier: string; title: string; minutes: number }>();
    for (const r of rows) {
      byUser.set(r.userId ?? "", (byUser.get(r.userId ?? "") ?? 0) + r.minutes);
      const k = byIssue.get(r.issueId) ?? { identifier: `${r.key}-${r.number}`, title: r.title, minutes: 0 };
      k.minutes += r.minutes;
      byIssue.set(r.issueId, k);
    }
    return c.json({
      totalMinutes: rows.reduce((s, r) => s + r.minutes, 0),
      byUser: [...byUser].map(([uid, minutes]) => ({ userId: uid || null, minutes })).sort((a, b) => b.minutes - a.minutes),
      byIssue: [...byIssue].map(([issueId, v]) => ({ issueId, ...v })).sort((a, b) => b.minutes - a.minutes),
      entries: rows.map((r) => ({ ...toEntry(r), identifier: `${r.key}-${r.number}`, title: r.title })),
      truncated: rows.length === 5000,
    });
  });

