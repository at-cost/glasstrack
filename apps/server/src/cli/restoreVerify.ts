/** Restores the latest backup into a scratch database and checks it. Exit code 1 on failure. */
import { loadConfig } from "../config";
import { restoreVerify } from "../jobs/restoreVerify";
import { createStorage } from "../storage";

const config = loadConfig();
try {
  const { key, counts } = await restoreVerify(config, createStorage(config));
  console.log(JSON.stringify({ ok: true, backup: key, counts }));
} catch (err) {
  console.error(JSON.stringify({ ok: false, error: String(err) }));
  process.exit(1);
}
