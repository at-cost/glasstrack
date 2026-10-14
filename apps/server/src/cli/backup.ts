/** One-off backup: `node dist/backup.js` (or `pnpm --filter @tracker/server exec tsx src/cli/backup.ts`). */
import { loadConfig } from "../config";
import type { Deps } from "../context";
import { createDatabases } from "../db";
import { runBackup } from "../jobs/backup";
import { createStorage } from "../storage";

const config = loadConfig();
const dbs = createDatabases(config);
try {
  const key = await runBackup({ config, dbs, storage: createStorage(config) } as Deps);
  console.log(`Backup written to ${key}`);
} finally {
  await dbs.close();
}
