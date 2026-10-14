import type { Context } from "hono";
import type { Role } from "@glasstrack/shared";
import type { PaymentGateway } from "./billing/gateway";
import type { Config } from "./config";
import type { Databases } from "./db";
import type { Tx, WorkspaceCtx } from "./db/tenant";
import type { Mailer } from "./email";
import type { Jobs } from "./jobs/types";
import { forbidden, unauthorized } from "./lib/errors";
import type { UsageMeter } from "./lib/meter";
import type { RateLimiter } from "./lib/rateLimit";
import type { RealtimeHub } from "./realtime/hub";
import type { Storage } from "./storage";

export interface Deps {
  config: Config;
  dbs: Databases;
  mailer: Mailer;
  storage: Storage;
  hub: RealtimeHub;
  jobs: Jobs;
  payments: PaymentGateway;
  meter: UsageMeter;
  limits: { auth: RateLimiter; api: RateLimiter };
}

export interface SessionUser {
  id: string;
  email: string;
  name: string;
  avatarUrl: string | null;
  sessionId: string;
}

export type AppEnv = {
  Variables: {
    deps: Deps;
    user: SessionUser | null;
    trx: Tx;
    ws: WorkspaceCtx;
    /** Callbacks run after the request transaction commits (e.g. enqueue jobs). */
    afterCommit: (() => Promise<unknown>)[];
  };
};
export type Ctx = Context<AppEnv>;

export function requireUser(c: Ctx): SessionUser {
  const u = c.get("user");
  if (!u) throw unauthorized();
  return u;
}

const RANK: Record<Role, number> = { guest: 0, member: 1, admin: 2 };
export function requireRole(c: Ctx, min: Role): void {
  if (RANK[c.get("ws").role] < RANK[min]) throw forbidden();
}
