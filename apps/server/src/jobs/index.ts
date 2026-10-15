import { PgBoss } from "pg-boss";
import type { Config } from "../config";
import type { Deps } from "../context";
import { logger } from "../lib/logger";
import { handlers } from "./handlers";
import type { JobName, JobPayloads, Jobs } from "./types";

const QUEUES = Object.keys(handlers) as JobName[];

/** pg-boss backed jobs: the queue lives in Postgres (schema "pgboss"). */
export async function createBossJobs(config: Config): Promise<Jobs & { boss: PgBoss; startWorkers(deps: Deps): Promise<void>; stop(): Promise<void> }> {
  const boss = new PgBoss({ connectionString: config.DATABASE_URL, schema: "pgboss", max: 3 });
  boss.on("error", (err) => logger.error({ err }, "pg-boss error"));
  await boss.start();
  for (const q of QUEUES) {
    // Webhooks retry 5 times with backoff (about 30s, 1m, 2m, 4m, 8m).
    const retryLimit = q === "webhook.deliver" ? 4 : 3;
    await boss.createQueue(q, { retryLimit, retryDelay: 30, retryBackoff: true });
  }
  return {
    boss,
    async send(name, data) {
      await boss.send(name, data);
    },
    async startWorkers(deps) {
      for (const name of QUEUES) {
        await boss.work(name, async (jobs) => {
          for (const job of jobs) {
            const handler = handlers[name] as (d: Deps, data: unknown) => Promise<void>;
            await handler(deps, job.data);
          }
        });
      }
      await boss.schedule("notifications.digest", "*/15 * * * *");
      await boss.schedule("maintenance.cleanup", "30 * * * *");
      await boss.schedule("recurring.tick", "*/5 * * * *");
      if (config.BILLING_ENABLED) {
        await boss.schedule("billing.daily", "10 0 * * *", null, { tz: "UTC" });
        await boss.schedule("billing.fees", "20 * * * *");
        await boss.schedule("finances.daily", "40 0 * * *", null, { tz: "UTC" });
      } else {
        await boss.unschedule("billing.daily").catch(() => undefined);
        await boss.unschedule("billing.fees").catch(() => undefined);
        await boss.unschedule("finances.daily").catch(() => undefined);
      }
      if (config.BACKUP_ENABLED) await boss.schedule("backup.run", config.BACKUP_CRON);
      else await boss.unschedule("backup.run").catch(() => undefined);
      logger.info("job workers started");
    },
    async stop() {
      await boss.stop({ graceful: true, timeout: 20_000 });
    },
  };
}

/** Runs jobs immediately in-process. Used by tests. */
export function createInlineJobs(getDeps: () => Deps): Jobs & { ran: { name: JobName; data: unknown }[] } {
  const ran: { name: JobName; data: unknown }[] = [];
  return {
    ran,
    async send<N extends JobName>(name: N, data: JobPayloads[N]) {
      ran.push({ name, data });
      await (handlers[name] as (d: Deps, data: JobPayloads[N]) => Promise<void>)(getDeps(), data);
    },
  };
}
