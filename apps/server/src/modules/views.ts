import { Hono } from "hono";
import { type IssueFilter, type SavedView, savedViewSchema, updateSavedViewSchema } from "@tracker/shared";
import { type AppEnv, requireRole, requireUser } from "../context";
import { notify } from "../db/tenant";
import { notFound } from "../lib/errors";
import { uuid7 } from "../lib/ids";
import { assertTeamAccess } from "./teams";

const COLS = ["id", "name", "teamId", "ownerId", "shared", "layout", "filters"] as const;
const toView = (r: { id: string; name: string; teamId: string | null; ownerId: string; shared: boolean; layout: "list" | "board"; filters: unknown }): SavedView => ({
  ...r,
  filters: r.filters as IssueFilter,
});

export const viewRoutes = new Hono<AppEnv>()
  .get("/views", async (c) => {
    const user = requireUser(c);
    const rows = await c.get("trx").selectFrom("savedViews").select(COLS)
      .where((eb) => eb.or([eb("ownerId", "=", user.id), eb("shared", "=", true)])).orderBy("name").execute();
    return c.json(rows.map(toView));
  })
  .post("/views", async (c) => {
    const user = requireUser(c);
    const body = savedViewSchema.parse(await c.req.json());
    if (body.teamId) await assertTeamAccess(c, body.teamId);
    if (body.shared) requireRole(c, "member");
    const row = await c.get("trx").insertInto("savedViews").values({
      id: uuid7(), workspaceId: c.get("ws").id, ownerId: user.id, name: body.name, teamId: body.teamId ?? null,
      shared: body.shared, layout: body.layout, filters: JSON.stringify(body.filters),
    }).returning(COLS).executeTakeFirstOrThrow();
    if (row.shared) await notify(c.get("trx"), c.get("ws").id, { t: "view", id: row.id });
    return c.json(toView(row), 201);
  })
  .patch("/views/:id", async (c) => {
    const user = requireUser(c);
    const body = updateSavedViewSchema.parse(await c.req.json());
    const trx = c.get("trx");
    const cur = await trx.selectFrom("savedViews").select(["ownerId"]).where("id", "=", c.req.param("id")).executeTakeFirst();
    if (!cur) throw notFound("View not found");
    if (cur.ownerId !== user.id) requireRole(c, "admin");
    const { filters, ...rest } = body;
    const row = await trx.updateTable("savedViews")
      .set({ ...rest, ...(filters ? { filters: JSON.stringify(filters) } : {}) })
      .where("id", "=", c.req.param("id")).returning(COLS).executeTakeFirstOrThrow();
    await notify(trx, c.get("ws").id, { t: "view", id: row.id });
    return c.json(toView(row));
  })
  .delete("/views/:id", async (c) => {
    const user = requireUser(c);
    const trx = c.get("trx");
    const cur = await trx.selectFrom("savedViews").select(["ownerId"]).where("id", "=", c.req.param("id")).executeTakeFirst();
    if (!cur) throw notFound("View not found");
    if (cur.ownerId !== user.id) requireRole(c, "admin");
    await trx.deleteFrom("savedViews").where("id", "=", c.req.param("id")).execute();
    await notify(trx, c.get("ws").id, { t: "view", id: c.req.param("id") });
    return c.json({ ok: true });
  });
