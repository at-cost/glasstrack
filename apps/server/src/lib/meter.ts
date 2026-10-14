import { sql } from "kysely";
import type { Db } from "../db";
import { logger } from "./logger";

/**
 * Per-workspace usage counters kept in memory and flushed to usage_daily once a
 * minute, so metering adds no write to each request. A crash loses at most a
 * minute of API-request counts, which only feed cost allocation.
 */
export class UsageMeter {
  private api = new Map<string, number>();
  private emails = new Map<string, number>();
  private timer: NodeJS.Timeout | null = null;

  constructor(private enabled: boolean) {}

  countApi(workspaceId: string) {
    if (this.enabled) this.api.set(workspaceId, (this.api.get(workspaceId) ?? 0) + 1);
  }

  countEmail(workspaceId: string | undefined) {
    if (this.enabled && workspaceId) this.emails.set(workspaceId, (this.emails.get(workspaceId) ?? 0) + 1);
  }

  start(db: Db, everyMs = 60_000) {
    if (!this.enabled || this.timer) return;
    this.timer = setInterval(() => void this.flush(db), everyMs);
    this.timer.unref();
  }

  async flush(db: Db, day = new Date().toISOString().slice(0, 10)): Promise<void> {
    const ids = new Set([...this.api.keys(), ...this.emails.keys()]);
    if (ids.size === 0) return;
    const api = this.api;
    const emails = this.emails;
    this.api = new Map();
    this.emails = new Map();
    for (const id of ids) {
      const a = api.get(id) ?? 0;
      const e = emails.get(id) ?? 0;
      try {
        await sql`INSERT INTO usage_daily (workspace_id, day, api_requests, emails_sent)
          SELECT ${id}::uuid, ${day}::date, ${a}, ${e} WHERE EXISTS (SELECT 1 FROM workspaces WHERE id = ${id}::uuid)
          ON CONFLICT (workspace_id, day) DO UPDATE SET
            api_requests = usage_daily.api_requests + EXCLUDED.api_requests,
            emails_sent = usage_daily.emails_sent + EXCLUDED.emails_sent`.execute(db);
      } catch (err) {
        logger.warn({ err, workspaceId: id }, "usage flush failed");
      }
    }
  }

  async stop(db: Db) {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.flush(db);
  }
}
