import { Hono } from "hono";
import { sql } from "kysely";
import { z } from "zod";
import {
  type Cycle,
  createTeamSchema,
  cycleSchema,
  type Label,
  labelSchema,
  stateSchema,
  type Team,
  updateCycleSchema,
  updateLabelSchema,
  updateStateSchema,
  updateTeamSchema,
  type WorkflowState,
} from "@tracker/shared";
import { type AppEnv, type Ctx, requireRole, requireUser } from "../context";
import { notify, type Tx } from "../db/tenant";
import { badRequest, conflict, forbidden, notFound } from "../lib/errors";
import { uuid7 } from "../lib/ids";
import { insertTeam } from "./workspaces";

/** null = every team (members, admins); otherwise the guest's team ids. */
export async function visibleTeamIds(c: Ctx): Promise<string[] | null> {
  if (c.get("ws").role !== "guest") return null;
  const user = requireUser(c);
  const rows = await c.get("trx").selectFrom("teamMembers").select("teamId").where("userId", "=", user.id).execute();
  return rows.map((r) => r.teamId);
}

export async function assertTeamAccess(c: Ctx, teamId: string): Promise<void> {
  const team = await c.get("trx").selectFrom("teams").select("id").where("id", "=", teamId).executeTakeFirst();
  if (!team) throw notFound("Team not found");
  const visible = await visibleTeamIds(c);
  if (visible && !visible.includes(teamId)) throw notFound("Team not found");
}

const uniqueViolation = (e: unknown) => (e as { code?: string }).code === "23505";

export const toCycle = (r: {
  id: string;
  teamId: string;
  number: number;
  name: string | null;
  startsOn: string;
  endsOn: string;
  completedAt: Date | null;
}): Cycle => ({ ...r, completedAt: r.completedAt?.toISOString() ?? null });

async function changed(trx: Tx, wsId: string, t: "team" | "state" | "label" | "cycle", id: string) {
  await notify(trx, wsId, { t, id });
}

export const teamRoutes = new Hono<AppEnv>()
  .get("/teams", async (c) => {
    const visible = await visibleTeamIds(c);
    let q = c.get("trx").selectFrom("teams").select(["id", "key", "name"]).where("archivedAt", "is", null).orderBy("name");
    if (visible) q = q.where("id", "in", visible.length ? visible : ["00000000-0000-0000-0000-000000000000"]);
    return c.json((await q.execute()) satisfies Team[]);
  })
  .post("/teams", async (c) => {
    requireRole(c, "admin");
    const body = createTeamSchema.parse(await c.req.json());
    const ws = c.get("ws");
    try {
      const id = await insertTeam(c.get("trx"), ws.id, body.name, body.key);
      await changed(c.get("trx"), ws.id, "team", id);
      return c.json({ id, key: body.key, name: body.name } satisfies Team, 201);
    } catch (e) {
      if (uniqueViolation(e)) throw conflict(`Team key ${body.key} is already used`);
      throw e;
    }
  })
  .patch("/teams/:teamId", async (c) => {
    requireRole(c, "admin");
    const body = updateTeamSchema.parse(await c.req.json());
    const trx = c.get("trx");
    const ws = c.get("ws");
    const teamId = c.req.param("teamId");
    const team = await trx.selectFrom("teams").selectAll().where("id", "=", teamId).executeTakeFirst();
    if (!team) throw notFound("Team not found");
    if (body.key && body.key !== team.key) {
      const taken = await trx.selectFrom("teamKeyAliases").select("teamId").where("key", "=", body.key).executeTakeFirst();
      if (taken && taken.teamId !== teamId) throw conflict(`Team key ${body.key} was used before by another team`);
      // Old identifiers like OLD-12 keep resolving after a rename.
      await trx.insertInto("teamKeyAliases").values({ workspaceId: ws.id, key: team.key, teamId })
        .onConflict((oc) => oc.columns(["workspaceId", "key"]).doNothing()).execute();
      await trx.deleteFrom("teamKeyAliases").where("key", "=", body.key).execute();
    }
    try {
      const row = await trx.updateTable("teams").set(body).where("id", "=", teamId)
        .returning(["id", "key", "name"]).executeTakeFirstOrThrow();
      await changed(trx, ws.id, "team", teamId);
      return c.json(row satisfies Team);
    } catch (e) {
      if (uniqueViolation(e)) throw conflict(`Team key ${body.key} is already used`);
      throw e;
    }
  })
  .delete("/teams/:teamId", async (c) => {
    requireRole(c, "admin");
    const trx = c.get("trx");
    const n = await trx.selectFrom("teams").select((eb) => eb.fn.countAll<string>().as("n")).where("archivedAt", "is", null).executeTakeFirstOrThrow();
    if (Number(n.n) <= 1) throw badRequest("A workspace needs at least one team");
    await trx.updateTable("teams").set({ archivedAt: new Date() }).where("id", "=", c.req.param("teamId")).execute();
    await changed(trx, c.get("ws").id, "team", c.req.param("teamId"));
    return c.json({ ok: true });
  })

  // Team membership (controls guest access).
  .get("/teams/:teamId/members", async (c) => {
    await assertTeamAccess(c, c.req.param("teamId"));
    const rows = await c.get("trx").selectFrom("teamMembers").select("userId").where("teamId", "=", c.req.param("teamId")).execute();
    return c.json(rows.map((r) => r.userId));
  })
  .put("/teams/:teamId/members/:userId", async (c) => {
    requireRole(c, "admin");
    const trx = c.get("trx");
    await assertTeamAccess(c, c.req.param("teamId"));
    const member = await trx.selectFrom("workspaceMembers").select("userId").where("userId", "=", c.req.param("userId"))
      .where("workspaceId", "=", c.get("ws").id).executeTakeFirst();
    if (!member) throw notFound("Member not found");
    await trx.insertInto("teamMembers")
      .values({ workspaceId: c.get("ws").id, teamId: c.req.param("teamId"), userId: c.req.param("userId") })
      .onConflict((oc) => oc.columns(["teamId", "userId"]).doNothing()).execute();
    return c.json({ ok: true });
  })
  .delete("/teams/:teamId/members/:userId", async (c) => {
    requireRole(c, "admin");
    await c.get("trx").deleteFrom("teamMembers").where("teamId", "=", c.req.param("teamId"))
      .where("userId", "=", c.req.param("userId")).execute();
    return c.json({ ok: true });
  })

  // Workflow states
  .get("/states", async (c) => {
    const visible = await visibleTeamIds(c);
    let q = c.get("trx").selectFrom("workflowStates").select(["id", "teamId", "name", "category", "color", "position"])
      .where("teamId", "in", (eb) => eb.selectFrom("teams").select("id").where("archivedAt", "is", null))
      .orderBy("teamId").orderBy("position");
    if (visible) q = q.where("teamId", "in", visible.length ? visible : ["00000000-0000-0000-0000-000000000000"]);
    return c.json((await q.execute()) satisfies WorkflowState[]);
  })
  .post("/teams/:teamId/states", async (c) => {
    requireRole(c, "admin");
    const teamId = c.req.param("teamId");
    await assertTeamAccess(c, teamId);
    const body = stateSchema.parse(await c.req.json());
    const trx = c.get("trx");
    const max = await trx.selectFrom("workflowStates").select((eb) => eb.fn.max("position").as("p")).where("teamId", "=", teamId).executeTakeFirst();
    const row = { id: uuid7(), workspaceId: c.get("ws").id, teamId, name: body.name, category: body.category, color: body.color,
      position: body.position ?? Number(max?.p ?? 0) + 1 };
    try {
      await trx.insertInto("workflowStates").values(row).execute();
    } catch (e) {
      if (uniqueViolation(e)) throw conflict(`A status called ${body.name} already exists`);
      throw e;
    }
    await changed(trx, c.get("ws").id, "state", row.id);
    const { workspaceId: _w, ...out } = row;
    return c.json(out satisfies WorkflowState, 201);
  })
  .patch("/states/:id", async (c) => {
    requireRole(c, "admin");
    const body = updateStateSchema.parse(await c.req.json());
    const trx = c.get("trx");
    const row = await trx.updateTable("workflowStates").set(body).where("id", "=", c.req.param("id"))
      .returning(["id", "teamId", "name", "category", "color", "position"]).executeTakeFirst();
    if (!row) throw notFound("Status not found");
    await changed(trx, c.get("ws").id, "state", row.id);
    return c.json(row satisfies WorkflowState);
  })
  .delete("/states/:id", async (c) => {
    requireRole(c, "admin");
    const trx = c.get("trx");
    const { moveTo } = z.object({ moveTo: z.uuid() }).parse(await c.req.json());
    const state = await trx.selectFrom("workflowStates").select(["id", "teamId"]).where("id", "=", c.req.param("id")).executeTakeFirst();
    const target = await trx.selectFrom("workflowStates").select(["id", "teamId"]).where("id", "=", moveTo).executeTakeFirst();
    if (!state || !target || state.teamId !== target.teamId || state.id === target.id) throw badRequest("Pick another status of the same team to move issues to");
    await trx.updateTable("issues").set({ statusId: target.id, updatedAt: new Date() }).where("statusId", "=", state.id).execute();
    await trx.deleteFrom("workflowStates").where("id", "=", state.id).execute();
    await changed(trx, c.get("ws").id, "state", state.id);
    return c.json({ ok: true });
  })

  // Labels
  .get("/labels", async (c) => {
    const rows = await c.get("trx").selectFrom("labels").select(["id", "teamId", "name", "color"]).orderBy("name").execute();
    return c.json(rows satisfies Label[]);
  })
  .post("/labels", async (c) => {
    requireRole(c, "member");
    const body = labelSchema.parse(await c.req.json());
    if (body.teamId) await assertTeamAccess(c, body.teamId);
    const row = { id: uuid7(), workspaceId: c.get("ws").id, teamId: body.teamId ?? null, name: body.name, color: body.color };
    try {
      await c.get("trx").insertInto("labels").values(row).execute();
    } catch (e) {
      if (uniqueViolation(e)) throw conflict(`Label ${body.name} already exists`);
      throw e;
    }
    await changed(c.get("trx"), row.workspaceId, "label", row.id);
    const { workspaceId: _w, ...out } = row;
    return c.json(out satisfies Label, 201);
  })
  .patch("/labels/:id", async (c) => {
    requireRole(c, "member");
    const body = updateLabelSchema.parse(await c.req.json());
    const row = await c.get("trx").updateTable("labels").set(body).where("id", "=", c.req.param("id"))
      .returning(["id", "teamId", "name", "color"]).executeTakeFirst();
    if (!row) throw notFound("Label not found");
    await changed(c.get("trx"), c.get("ws").id, "label", row.id);
    return c.json(row satisfies Label);
  })
  .delete("/labels/:id", async (c) => {
    requireRole(c, "member");
    await c.get("trx").deleteFrom("labels").where("id", "=", c.req.param("id")).execute();
    await changed(c.get("trx"), c.get("ws").id, "label", c.req.param("id"));
    return c.json({ ok: true });
  })

  // Cycles
  .get("/cycles", async (c) => {
    const visible = await visibleTeamIds(c);
    let q = c.get("trx").selectFrom("cycles").select(["id", "teamId", "number", "name", "startsOn", "endsOn", "completedAt"])
      .where("teamId", "in", (eb) => eb.selectFrom("teams").select("id").where("archivedAt", "is", null))
      .orderBy("teamId").orderBy("number", "desc");
    if (visible) q = q.where("teamId", "in", visible.length ? visible : ["00000000-0000-0000-0000-000000000000"]);
    return c.json((await q.execute()).map(toCycle));
  })
  .post("/teams/:teamId/cycles", async (c) => {
    requireRole(c, "member");
    const teamId = c.req.param("teamId");
    await assertTeamAccess(c, teamId);
    const body = cycleSchema.parse(await c.req.json());
    const trx = c.get("trx");
    // Serialise numbering per team.
    await sql`SELECT 1 FROM teams WHERE id = ${teamId} FOR UPDATE`.execute(trx);
    const max = await trx.selectFrom("cycles").select((eb) => eb.fn.max("number").as("n")).where("teamId", "=", teamId).executeTakeFirst();
    const row = { id: uuid7(), workspaceId: c.get("ws").id, teamId, number: Number(max?.n ?? 0) + 1, name: body.name || null,
      startsOn: body.startsOn, endsOn: body.endsOn };
    await trx.insertInto("cycles").values(row).execute();
    await changed(trx, row.workspaceId, "cycle", row.id);
    const { workspaceId: _w, ...out } = row;
    return c.json({ ...out, completedAt: null } satisfies Cycle, 201);
  })
  .patch("/cycles/:id", async (c) => {
    requireRole(c, "member");
    const body = updateCycleSchema.parse(await c.req.json());
    const trx = c.get("trx");
    const cur = await trx.selectFrom("cycles").select(["teamId", "startsOn", "endsOn"]).where("id", "=", c.req.param("id")).executeTakeFirst();
    if (!cur) throw notFound("Cycle not found");
    await assertTeamAccess(c, cur.teamId);
    const startsOn = body.startsOn ?? cur.startsOn;
    const endsOn = body.endsOn ?? cur.endsOn;
    if (startsOn > endsOn) throw badRequest("The end date must be on or after the start date");
    const { completed, ...rest } = body;
    const row = await trx.updateTable("cycles")
      .set({ ...rest, ...(completed === undefined ? {} : { completedAt: completed ? new Date() : null }) })
      .where("id", "=", c.req.param("id"))
      .returning(["id", "teamId", "number", "name", "startsOn", "endsOn", "completedAt"])
      .executeTakeFirstOrThrow();
    await changed(trx, c.get("ws").id, "cycle", row.id);
    return c.json(toCycle(row));
  })
  .delete("/cycles/:id", async (c) => {
    requireRole(c, "member");
    const trx = c.get("trx");
    const cur = await trx.selectFrom("cycles").select("teamId").where("id", "=", c.req.param("id")).executeTakeFirst();
    if (!cur) throw notFound("Cycle not found");
    if (c.get("ws").role === "guest") throw forbidden();
    await trx.deleteFrom("cycles").where("id", "=", c.req.param("id")).execute();
    await changed(trx, c.get("ws").id, "cycle", c.req.param("id"));
    return c.json({ ok: true });
  });
