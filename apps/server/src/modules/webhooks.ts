import { createHmac } from "node:crypto";
import { Hono } from "hono";
import { sql } from "kysely";
import { z } from "zod";
import { type AppEnv, type Ctx, type Deps, requireRole, requireUser } from "../context";
import { badRequest, notFound } from "../lib/errors";
import { newToken, uuid7 } from "../lib/ids";
import { logger } from "../lib/logger";
import { assertPublicUrl } from "../lib/ssrf";
import { audit } from "./audit";

export const WEBHOOK_EVENTS = ["issue.created", "issue.updated", "issue.deleted", "comment.created"] as const;
export type WebhookEvent = (typeof WEBHOOK_EVENTS)[number];
const MAX_ATTEMPTS = 5;
const DISABLE_AFTER_FAILURES = 20;

/** Signature header: t=<unix seconds>,v1=<hex HMAC-SHA256 of "<t>.<body>">. */
export function signPayload(secret: string, body: string, ts = Math.floor(Date.now() / 1000)): string {
  return `t=${ts},v1=${createHmac("sha256", secret).update(`${ts}.${body}`).digest("hex")}`;
}

/** Records deliveries for every active webhook subscribed to `event` and queues them. */
export async function enqueueWebhookEvent(deps: Deps, ws: { id: string; slug: string }, event: WebhookEvent, data: Record<string, unknown>) {
  try {
    const hooks = await deps.dbs.system.selectFrom("webhooks").select("id").where("workspaceId", "=", ws.id).where("active", "=", true)
      .where(sql<boolean>`${event} = ANY(events)`).execute();
    for (const h of hooks) {
      const id = uuid7();
      const payload = { id, event, createdAt: new Date().toISOString(), workspace: { slug: ws.slug }, data };
      await deps.dbs.system.insertInto("webhookDeliveries").values({ id, workspaceId: ws.id, webhookId: h.id, event, payload: JSON.stringify(payload) }).execute();
      await deps.jobs.send("webhook.deliver", { deliveryId: id });
    }
  } catch (err) {
    logger.error({ err, event }, "could not queue webhooks");
  }
}

/** Queues deliveries after the request commits, so receivers never see rolled-back changes. */
export function queueWebhooks(c: Ctx, event: WebhookEvent, data: Record<string, unknown>) {
  const deps = c.get("deps");
  const ws = c.get("ws");
  c.get("afterCommit").push(() => enqueueWebhookEvent(deps, ws, event, data));
}

/** One delivery attempt. Throws on failure so the queue retries, until the last attempt. */
export async function deliverWebhook(deps: Deps, deliveryId: string): Promise<void> {
  const sys = deps.dbs.system;
  const d = await sys.selectFrom("webhookDeliveries as d").innerJoin("webhooks as w", "w.id", "d.webhookId")
    .select(["d.id", "d.payload", "d.attempts", "d.status", "d.event", "w.id as webhookId", "w.url", "w.secret", "w.active"])
    .where("d.id", "=", deliveryId).executeTakeFirst();
  if (!d || d.status !== "pending" || !d.active) return;
  const attempts = d.attempts + 1;
  const body = JSON.stringify(d.payload);
  let status: number | null = null;
  let error: string | null = null;
  try {
    const url = await assertPublicUrl(d.url, deps.config.WEBHOOK_ALLOW_PRIVATE);
    const res = await fetch(url, {
      method: "POST",
      redirect: "manual",
      signal: AbortSignal.timeout(10_000),
      headers: {
        "content-type": "application/json",
        "user-agent": "Glasstrack-Webhooks/1",
        "glasstrack-event": d.event,
        "glasstrack-delivery": d.id,
        "glasstrack-signature": signPayload(d.secret, body),
      },
      body,
    });
    status = res.status;
    await res.body?.cancel().catch(() => undefined);
    if (res.status < 200 || res.status >= 300) error = `HTTP ${res.status}`;
  } catch (err) {
    error = String((err as Error).message ?? err).slice(0, 300);
  }
  if (!error) {
    await sys.updateTable("webhookDeliveries").set({ status: "succeeded", attempts, responseStatus: status, error: null, deliveredAt: new Date() }).where("id", "=", d.id).execute();
    await sys.updateTable("webhooks").set({ consecutiveFailures: 0 }).where("id", "=", d.webhookId).execute();
    return;
  }
  const final = attempts >= MAX_ATTEMPTS;
  await sys.updateTable("webhookDeliveries").set({ attempts, responseStatus: status, error, ...(final ? { status: "failed" as const } : {}) }).where("id", "=", d.id).execute();
  if (final) {
    const w = await sys.updateTable("webhooks").set((eb) => ({ consecutiveFailures: eb("consecutiveFailures", "+", 1) }))
      .where("id", "=", d.webhookId).returning("consecutiveFailures").executeTakeFirst();
    if (w && w.consecutiveFailures >= DISABLE_AFTER_FAILURES) await sys.updateTable("webhooks").set({ active: false }).where("id", "=", d.webhookId).execute();
    return;
  }
  throw new Error(`webhook delivery failed: ${error}`);
}

const hookSchema = z.object({
  url: z.url().max(2000),
  events: z.array(z.enum(WEBHOOK_EVENTS)).min(1),
  active: z.boolean().default(true),
});

export const webhookRoutes = new Hono<AppEnv>()
  .get("/webhooks", async (c) => {
    requireRole(c, "admin");
    const rows = await c.get("trx").selectFrom("webhooks").select(["id", "url", "events", "active", "consecutiveFailures", "createdAt", "secret"]).orderBy("createdAt").execute();
    return c.json(rows.map((r) => ({ ...r, createdAt: r.createdAt.toISOString() })));
  })
  .post("/webhooks", async (c) => {
    requireRole(c, "admin");
    const user = requireUser(c);
    const body = hookSchema.parse(await c.req.json());
    try {
      await assertPublicUrl(body.url, c.get("deps").config.WEBHOOK_ALLOW_PRIVATE);
    } catch (err) {
      throw badRequest(String((err as Error).message));
    }
    const id = uuid7();
    const secret = `whsec_${newToken()}`;
    await c.get("trx").insertInto("webhooks").values({ id, workspaceId: c.get("ws").id, url: body.url, secret, events: body.events, active: body.active, createdBy: user.id }).execute();
    await audit(c, "webhook.created", "webhook", id, { url: body.url, events: body.events });
    return c.json({ id, url: body.url, events: body.events, active: body.active, secret }, 201);
  })
  .patch("/webhooks/:id", async (c) => {
    requireRole(c, "admin");
    const body = hookSchema.partial().parse(await c.req.json());
    if (body.url) {
      try {
        await assertPublicUrl(body.url, c.get("deps").config.WEBHOOK_ALLOW_PRIVATE);
      } catch (err) {
        throw badRequest(String((err as Error).message));
      }
    }
    const r = await c.get("trx").updateTable("webhooks").set({ ...body, ...(body.active ? { consecutiveFailures: 0 } : {}) })
      .where("id", "=", c.req.param("id")).executeTakeFirst();
    if (!r.numUpdatedRows) throw notFound("Webhook not found");
    await audit(c, "webhook.updated", "webhook", c.req.param("id"), body);
    return c.json({ ok: true });
  })
  .delete("/webhooks/:id", async (c) => {
    requireRole(c, "admin");
    await c.get("trx").deleteFrom("webhooks").where("id", "=", c.req.param("id")).execute();
    await audit(c, "webhook.deleted", "webhook", c.req.param("id"));
    return c.json({ ok: true });
  })
  .get("/webhooks/:id/deliveries", async (c) => {
    requireRole(c, "admin");
    const rows = await c.get("trx").selectFrom("webhookDeliveries").select(["id", "event", "status", "attempts", "responseStatus", "error", "createdAt", "deliveredAt"])
      .where("webhookId", "=", c.req.param("id")).orderBy("createdAt", "desc").limit(50).execute();
    return c.json(rows.map((r) => ({ ...r, createdAt: r.createdAt.toISOString(), deliveredAt: r.deliveredAt?.toISOString() ?? null })));
  });
