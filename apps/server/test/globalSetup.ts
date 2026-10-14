import { sql } from "kysely";
import { loadConfig } from "../src/config";
import { createDatabases, ensureRoles, migrateToLatest, migrator } from "../src/db";
import { testEnv } from "./env";

/** Fresh schema per run: drop everything, then migrate up, down, and up again. */
export default async function setup() {
  process.env.LOG_LEVEL = "silent";
  const config = loadConfig(testEnv);
  const dbs = createDatabases(config);
  try {
    await sql.raw("DROP SCHEMA IF EXISTS public CASCADE; DROP SCHEMA IF EXISTS app CASCADE; DROP SCHEMA IF EXISTS pgboss CASCADE; CREATE SCHEMA public;")
      .execute(dbs.owner);
    await ensureRoles(dbs.owner, config);
    await migrateToLatest(dbs.owner);
    const down = await migrator(dbs.owner).migrateDown();
    if (down.error) throw down.error;
    await migrateToLatest(dbs.owner);
  } finally {
    await dbs.close();
  }
}
