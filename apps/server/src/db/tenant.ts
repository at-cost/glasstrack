import { type Transaction, sql } from "kysely";
import type { Role } from "@glasstrack/shared";
import { notFound } from "../lib/errors";
import type { Db } from "./index";
import type { DB } from "./schema";

export type Tx = Transaction<DB>;

export interface WorkspaceCtx {
  id: string;
  slug: string;
  name: string;
  status: "active" | "grace" | "read_only" | "deleting";
  role: Role;
}

/** Runs fn in a transaction as glasstrack_app with only the user context set. */
export async function asUser<T>(app: Db, userId: string, fn: (trx: Tx) => Promise<T>): Promise<T> {
  return app.transaction().execute(async (trx) => {
    await sql`SELECT set_config('app.user_id', ${userId}, true)`.execute(trx);
    return fn(trx);
  });
}

/**
 * Sets the user, then enters the workspace through app.enter_workspace(),
 * which checks membership before setting app.workspace_id. Non-members get
 * a 404 so workspace slugs can't be probed.
 */
export async function enterWorkspace(trx: Tx, userId: string, slug: string): Promise<WorkspaceCtx> {
  await sql`SELECT set_config('app.user_id', ${userId}, true)`.execute(trx);
  try {
    const r = await sql<WorkspaceCtx>`SELECT * FROM app.enter_workspace(${slug})`.execute(trx);
    const ws = r.rows[0];
    if (!ws) throw notFound("Workspace not found");
    return ws;
  } catch (e) {
    if ((e as { code?: string }).code === "P0002") throw notFound("Workspace not found");
    throw e;
  }
}

export async function inWorkspace<T>(
  app: Db,
  userId: string,
  slug: string,
  fn: (trx: Tx, ws: WorkspaceCtx) => Promise<T>,
): Promise<T> {
  return app.transaction().execute(async (trx) => fn(trx, await enterWorkspace(trx, userId, slug)));
}

/** For system jobs that act inside one workspace with RLS still enforced. */
export async function asWorkspace<T>(app: Db, workspaceId: string, fn: (trx: Tx) => Promise<T>): Promise<T> {
  return app.transaction().execute(async (trx) => {
    await sql`SELECT set_config('app.workspace_id', ${workspaceId}, true)`.execute(trx);
    return fn(trx);
  });
}

/** Queue a realtime event; Postgres delivers it only if the transaction commits. */
export async function notify(trx: Tx, workspaceId: string, event: Record<string, unknown>): Promise<void> {
  await sql`SELECT pg_notify('ws_events', ${JSON.stringify({ w: workspaceId, ...event })})`.execute(trx);
}
