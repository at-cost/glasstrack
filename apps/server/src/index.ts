import { serve } from "@hono/node-server";
import { createApp } from "./app";
import { disabledGateway, stripeGateway } from "./billing/gateway";
import { loadConfig } from "./config";
import type { Deps } from "./context";
import { createDatabases, ensureRoles, migrateToLatest } from "./db";
import { createMailer } from "./email";
import { createBossJobs } from "./jobs";
import { logger } from "./lib/logger";
import { RateLimiter } from "./lib/rateLimit";
import { RealtimeHub } from "./realtime/hub";
import { createStorage } from "./storage";

const config = loadConfig();
const dbs = createDatabases(config);

if (config.MIGRATE_ON_BOOT) {
  await ensureRoles(dbs.owner, config);
  await migrateToLatest(dbs.owner);
}

const jobs = await createBossJobs(config);
const hub = new RealtimeHub(dbs.systemPool);
const deps: Deps = {
  config,
  dbs,
  mailer: createMailer(config),
  storage: createStorage(config),
  hub,
  jobs,
  payments: config.STRIPE_SECRET_KEY ? stripeGateway(config) : disabledGateway(),
  limits: { auth: new RateLimiter(10, 15 * 60_000), api: new RateLimiter(600, 60_000) },
};

if (config.BILLING_ENABLED) {
  // Seed the price before anything can compare against it.
  const { currentPriceMicro } = await import("./billing/service");
  await currentPriceMicro(deps);
}
if (config.WORKER_MODE !== "off") await jobs.startWorkers(deps);

let server: ReturnType<typeof serve> | null = null;
if (config.WORKER_MODE !== "only") {
  await hub.start();
  server = serve({ fetch: createApp(deps).fetch, port: config.PORT }, (info) =>
    logger.info({ port: info.port, worker: config.WORKER_MODE }, "server listening"),
  );
}

async function shutdown(signal: string) {
  logger.info({ signal }, "shutting down");
  server?.close();
  await hub.stop();
  await jobs.stop();
  await dbs.close();
  process.exit(0);
}
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
