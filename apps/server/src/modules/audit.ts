import { Hono } from "hono";
import type { AuditEntry } from "@glasstrack/shared";
import { type AppEnv, type Ctx, requireRole } from "../context";
import type { Db } from "../db";
import type { Tx } from "../db/tenant";
import { toCsv } from "../lib/csv";

/** Caller IP as seen behind the proxy (Caddy sets X-Forwarded-For to the visitor IP). */
export function requestIp(c: Ctx): string | null {
  return c.req.header("x-forwarded-for")?.split(",").pop()?.trim() || c.req.header("x-real-ip") || null;
}

/** Records an admin or security event in the current workspace (inside the request transaction). */
export async function audit(c: Ctx, action: string, targetType: string | null = null, targetId: string | null = null, data: Record<string, unknown> = {}) {
  const user = c.get("user");
  const via = c.get("tokenWorkspaceId") ? "api token" : null;
  await c.get("trx").insertInto("auditLog").values({
    workspaceId: c.get("ws").id,
    actorId: user?.id ?? null,
    actorLabel: user ? `${user.email}${via ? ` (${via})` : ""}` : "system",
    action,
    targetType,
    targetId,
    data: JSON.stringify(data),
    ip: requestIp(c),
  }).execute();
}

/** For events outside a workspace request (SSO sign-in, invite acceptance, jobs). */
export async function auditSystem(
  db: Db | Tx,
  p: { workspaceId: string; actorId?: string | null; actorLabel: string; action: string; targetType?: string; targetId?: string; data?: Record<string, unknown>; ip?: string | null },
) {
  await db.insertInto("auditLog").values({
    workspaceId: p.workspaceId, actorId: p.actorId ?? null, actorLabel: p.actorLabel, action: p.action,
    targetType: p.targetType ?? null, targetId: p.targetId ?? null, data: JSON.stringify(p.data ?? {}), ip: p.ip ?? null,
  }).execute();
}

const COLS = ["id", "actorId", "actorLabel", "action", "targetType", "targetId", "data", "ip", "createdAt"] as const;

export const auditRoutes = new Hono<AppEnv>()
  .get("/audit", async (c) => {
    requireRole(c, "admin");
    const before = c.req.query("before");
    const action = c.req.query("action");
    let q = c.get("trx").selectFrom("auditLog").select(COLS).orderBy("id", "desc").limit(100);
    if (before && /^\d+$/.test(before)) q = q.where("id", "<", before);
    if (action) q = q.where("action", "like", `${action.replace(/[%_\\]/g, "")}%`);
    const rows = await q.execute();
    return c.json({
      entries: rows.map((r): AuditEntry => ({ ...r, createdAt: r.createdAt.toISOString() })),
      next: rows.length === 100 ? rows.at(-1)!.id : null,
    });
  })
  .get("/audit.csv", async (c) => {
    requireRole(c, "admin");
    const rows = await c.get("trx").selectFrom("auditLog").select(COLS).orderBy("id").limit(100_000).execute();
    c.header("Content-Type", "text/csv; charset=utf-8");
    c.header("Content-Disposition", `attachment; filename="${c.get("ws").slug}-audit-log.csv"`);
    return c.body(toCsv(rows.map((r) => ({ ...r, data: JSON.stringify(r.data) })), ["createdAt", "actorLabel", "action", "targetType", "targetId", "data", "ip"]));
  });
