import { Hono } from "hono";
import type { ExportJob } from "@tracker/shared";
import { type AppEnv, requireRole, requireUser } from "../context";
import { ApiError, notFound } from "../lib/errors";
import { uuid7 } from "../lib/ids";

export const exportRoutes = new Hono<AppEnv>()
  .get("/exports", async (c) => {
    requireRole(c, "admin");
    const rows = await c.get("trx").selectFrom("exports").select(["id", "status", "createdAt", "storageKey", "expiresAt"])
      .orderBy("createdAt", "desc").limit(10).execute();
    const storage = c.get("deps").storage;
    const ws = c.get("ws");
    return c.json(
      await Promise.all(
        rows.map(async (r): Promise<ExportJob> => ({
          id: r.id,
          status: r.status,
          createdAt: r.createdAt.toISOString(),
          downloadUrl:
            r.status === "done" && r.storageKey && (!r.expiresAt || r.expiresAt > new Date())
              ? await storage.downloadUrl(r.storageKey, `${ws.slug}-export.tar.gz`)
              : null,
        })),
      ),
    );
  })
  .post("/exports", async (c) => {
    requireRole(c, "admin");
    const user = requireUser(c);
    const trx = c.get("trx");
    const running = await trx.selectFrom("exports").select("id").where("status", "in", ["pending", "running"]).executeTakeFirst();
    if (running) throw new ApiError(409, "export_running", "An export is already being prepared");
    const id = uuid7();
    await trx.insertInto("exports").values({ id, workspaceId: c.get("ws").id, requestedBy: user.id }).execute();
    const workspaceId = c.get("ws").id;
    c.get("afterCommit").push(() => c.get("deps").jobs.send("export.workspace", { exportId: id, workspaceId }));
    return c.json({ id, status: "pending", createdAt: new Date().toISOString(), downloadUrl: null } satisfies ExportJob, 202);
  })
  .get("/exports/:id", async (c) => {
    requireRole(c, "admin");
    const r = await c.get("trx").selectFrom("exports").select(["id", "status", "createdAt", "storageKey", "error"])
      .where("id", "=", c.req.param("id")).executeTakeFirst();
    if (!r) throw notFound("Export not found");
    return c.json({
      id: r.id,
      status: r.status,
      createdAt: r.createdAt.toISOString(),
      downloadUrl: r.status === "done" && r.storageKey ? await c.get("deps").storage.downloadUrl(r.storageKey, `${c.get("ws").slug}-export.tar.gz`) : null,
    } satisfies ExportJob);
  });
