import type { MiddlewareHandler } from "hono";
import { sql } from "kysely";
import { type AppEnv, requireUser } from "../context";
import { enterWorkspace } from "../db/tenant";
import { ApiError, notFound } from "../lib/errors";

const MUTATING = new Set(["POST", "PUT", "PATCH", "DELETE"]);
/** Paths still writable when a workspace is read-only (export must always work). */
const READ_ONLY_ALLOWED = [/\/exports$/, /\/notifications\/read$/, /\/billing\/topup$/, /\/billing\/auto-topup$/];

/**
 * Wraps every /w/:slug request in one transaction as glasstrack_app with the
 * workspace entered through the membership-checking SQL function. Any error
 * (including HTTP 4xx thrown by handlers) rolls the transaction back.
 */
export const workspaceTx: MiddlewareHandler<AppEnv> = async (c, next) => {
  const user = requireUser(c);
  const deps = c.get("deps");
  const slug = c.req.param("slug");
  if (!slug) throw notFound();
  c.set("afterCommit", []);
  await deps.dbs.app.transaction().execute(async (trx) => {
    const ws = await enterWorkspace(trx, user.id, slug);
    if (ws.status === "deleting") throw notFound("Workspace not found");
    const tokenWs = c.get("tokenWorkspaceId");
    if (tokenWs && tokenWs !== ws.id) throw notFound("Workspace not found");
    if (
      ws.status === "read_only" &&
      MUTATING.has(c.req.method) &&
      !READ_ONLY_ALLOWED.some((r) => r.test(c.req.path))
    ) {
      throw new ApiError(402, "read_only", "This workspace is read-only until its balance is topped up.");
    }
    c.set("trx", trx);
    c.set("ws", ws);
    deps.meter.countApi(ws.id);
    // Activity for metering, written at most once an hour per member.
    await sql`UPDATE workspace_members SET last_active_at = now()
      WHERE workspace_id = ${ws.id} AND user_id = ${user.id} AND last_active_at < now() - interval '1 hour'`.execute(trx);
    await next();
    if (c.error) throw c.error;
  });
  for (const fn of c.get("afterCommit")) await fn();
};
