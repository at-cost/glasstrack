import { loadConfig } from "../config";
import { createDatabases, ensureRoles, migrateToLatest, migrator } from "../db";
import { logger } from "../lib/logger";

const config = loadConfig();
const dbs = createDatabases(config);
const cmd = process.argv[2] ?? "latest";
try {
  await ensureRoles(dbs.owner, config);
  if (cmd === "down") {
    const { error, results } = await migrator(dbs.owner).migrateDown();
    for (const r of results ?? []) logger.info({ migration: r.migrationName, status: r.status }, "migrate down");
    if (error) throw error;
  } else {
    await migrateToLatest(dbs.owner);
  }
} finally {
  await dbs.close();
}
