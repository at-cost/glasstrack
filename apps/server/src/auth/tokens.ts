import type { MiddlewareHandler } from "hono";
import type { AppEnv } from "../context";
import { ApiError, unauthorized } from "../lib/errors";
import { sha256 } from "../lib/ids";

/**
 * Personal API tokens: `Authorization: Bearer gt_...`. A token acts as its
 * owner inside one workspace only, and can't manage tokens or webhooks.
 */
export const bearerMiddleware: MiddlewareHandler<AppEnv> = async (c, next) => {
  c.set("tokenWorkspaceId", null);
  const auth = c.req.header("authorization");
  if (!auth?.startsWith("Bearer ")) return next();
  const token = auth.slice(7).trim();
  const deps = c.get("deps");
  const row = await deps.dbs.system
    .selectFrom("apiTokens as t")
    .innerJoin("users as u", "u.id", "t.userId")
    .innerJoin("workspaceMembers as m", (j) => j.onRef("m.userId", "=", "t.userId").onRef("m.workspaceId", "=", "t.workspaceId"))
    .select(["t.id as tokenId", "t.workspaceId", "t.lastUsedAt", "u.id", "u.email", "u.name", "u.avatarUrl"])
    .where("t.tokenHash", "=", sha256(token))
    .where("t.revokedAt", "is", null)
    .where((eb) => eb.or([eb("t.expiresAt", "is", null), eb("t.expiresAt", ">", new Date())]))
    .where("u.deletedAt", "is", null)
    .executeTakeFirst();
  if (!row) throw unauthorized();
  c.set("user", { id: row.id, email: row.email, name: row.name, avatarUrl: row.avatarUrl, sessionId: `token:${row.tokenId}` });
  c.set("tokenWorkspaceId", row.workspaceId);
  if (!row.lastUsedAt || Date.now() - row.lastUsedAt.getTime() > 3600_000) {
    await deps.dbs.system.updateTable("apiTokens").set({ lastUsedAt: new Date() }).where("id", "=", row.tokenId).execute();
  }
  const path = c.req.path;
  const allowed = (path.startsWith("/api/v1/w/") && !/\/w\/[^/]+\/(tokens|webhooks|integrations)(\/|$)/.test(path)) || (path === "/api/v1/me" && c.req.method === "GET");
  if (!allowed) throw new ApiError(403, "token_scope", "API tokens can only call workspace endpoints, and can't manage tokens, webhooks or integrations");
  return next();
};
