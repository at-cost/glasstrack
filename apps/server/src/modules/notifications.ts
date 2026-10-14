import { Hono } from "hono";
import { z } from "zod";
import {
  NOTIFICATION_KINDS,
  type Notification,
  type NotificationKind,
  type NotificationSettings,
  notificationSettingsSchema,
} from "@tracker/shared";
import { type AppEnv, requireUser } from "../context";

export const DEFAULT_EVENTS = Object.fromEntries(NOTIFICATION_KINDS.map((k) => [k, true])) as Record<NotificationKind, boolean>;

export const notificationRoutes = new Hono<AppEnv>()
  .get("/notifications", async (c) => {
    const user = requireUser(c);
    const rows = await c.get("trx").selectFrom("notifications as n")
      .innerJoin("issues as i", "i.id", "n.issueId")
      .innerJoin("teams as t", "t.id", "i.teamId")
      .select(["n.id", "n.kind", "n.issueId", "n.actorId", "n.data", "n.createdAt", "n.readAt", "i.number", "t.key", "i.title"])
      .where("n.userId", "=", user.id)
      .orderBy("n.createdAt", "desc")
      .limit(200)
      .execute();
    return c.json(
      rows.map((r): Notification => ({
        id: r.id,
        kind: r.kind as NotificationKind,
        issueId: r.issueId,
        issueIdentifier: `${r.key}-${r.number}`,
        issueTitle: r.title,
        actorId: r.actorId,
        data: r.data,
        createdAt: r.createdAt.toISOString(),
        readAt: r.readAt?.toISOString() ?? null,
      })),
    );
  })
  .get("/notifications/unread-count", async (c) => {
    const user = requireUser(c);
    const r = await c.get("trx").selectFrom("notifications").select((eb) => eb.fn.countAll<string>().as("n"))
      .where("userId", "=", user.id).where("readAt", "is", null).executeTakeFirstOrThrow();
    return c.json({ count: Number(r.n) });
  })
  .post("/notifications/read", async (c) => {
    const user = requireUser(c);
    const body = z.object({ ids: z.array(z.uuid()).max(500).optional(), all: z.boolean().optional(), unread: z.boolean().optional() })
      .parse(await c.req.json());
    let q = c.get("trx").updateTable("notifications").set({ readAt: body.unread ? null : new Date() }).where("userId", "=", user.id);
    if (!body.all) q = q.where("id", "in", body.ids?.length ? body.ids : ["00000000-0000-0000-0000-000000000000"]);
    await q.execute();
    return c.json({ ok: true });
  })
  .get("/notification-settings", async (c) => {
    const user = requireUser(c);
    const row = await c.get("trx").selectFrom("notificationSettings").select(["digest", "events"])
      .where("userId", "=", user.id).executeTakeFirst();
    const out: NotificationSettings = { digest: row?.digest ?? "daily", events: { ...DEFAULT_EVENTS, ...(row?.events ?? {}) } };
    return c.json(out);
  })
  .put("/notification-settings", async (c) => {
    const user = requireUser(c);
    const body = notificationSettingsSchema.parse(await c.req.json());
    const events = JSON.stringify({ ...DEFAULT_EVENTS, ...body.events });
    await c.get("trx").insertInto("notificationSettings")
      .values({ workspaceId: c.get("ws").id, userId: user.id, digest: body.digest, events })
      .onConflict((oc) => oc.columns(["workspaceId", "userId"]).doUpdateSet({ digest: body.digest, events }))
      .execute();
    return c.json(body);
  });
