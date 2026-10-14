import { Hono } from "hono";
import { z } from "zod";
import { type AppEnv, requireRole, requireUser } from "../context";
import { notFound } from "../lib/errors";
import { newToken, sha256, uuid7 } from "../lib/ids";

export const tokenRoutes = new Hono<AppEnv>()
  .get("/tokens", async (c) => {
    const user = requireUser(c);
    const rows = await c.get("trx").selectFrom("apiTokens")
      .select(["id", "name", "tokenPrefix", "createdAt", "lastUsedAt", "expiresAt"])
      .where("userId", "=", user.id).where("revokedAt", "is", null).orderBy("createdAt", "desc").execute();
    return c.json(rows.map((r) => ({ ...r, createdAt: r.createdAt.toISOString(), lastUsedAt: r.lastUsedAt?.toISOString() ?? null, expiresAt: r.expiresAt?.toISOString() ?? null })));
  })
  .post("/tokens", async (c) => {
    requireRole(c, "member");
    const user = requireUser(c);
    const body = z.object({ name: z.string().trim().min(1).max(60), expiresInDays: z.number().int().min(1).max(3650).nullish() }).parse(await c.req.json());
    const token = `gt_${newToken()}`;
    const id = uuid7();
    const expiresAt = body.expiresInDays ? new Date(Date.now() + body.expiresInDays * 86_400_000) : null;
    await c.get("trx").insertInto("apiTokens").values({
      id, workspaceId: c.get("ws").id, userId: user.id, name: body.name, tokenHash: sha256(token), tokenPrefix: token.slice(0, 10), expiresAt,
    }).execute();
    // The full token is shown once and never stored.
    return c.json({ id, name: body.name, token, expiresAt: expiresAt?.toISOString() ?? null }, 201);
  })
  .delete("/tokens/:id", async (c) => {
    const user = requireUser(c);
    const trx = c.get("trx");
    const t = await trx.selectFrom("apiTokens").select("userId").where("id", "=", c.req.param("id")).executeTakeFirst();
    if (!t) throw notFound("Token not found");
    if (t.userId !== user.id) requireRole(c, "admin");
    await trx.updateTable("apiTokens").set({ revokedAt: new Date() }).where("id", "=", c.req.param("id")).execute();
    return c.json({ ok: true });
  });
