import { spawn } from "node:child_process";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Deps } from "../context";
import { logger } from "../lib/logger";

/**
 * pg_dump (custom format) to storage under backups/. Requires the pg_dump
 * binary (included in the Docker image). Old dumps beyond the retention
 * window are pruned by name, which embeds the date.
 */
export async function runBackup(deps: Deps): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "tracker-backup-"));
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const file = path.join(dir, `tracker-${stamp}.dump`);
  try {
    await new Promise<void>((resolve, reject) => {
      const p = spawn("pg_dump", ["--format=custom", "--no-owner", "--file", file, deps.config.DATABASE_URL], {
        stdio: ["ignore", "ignore", "pipe"],
      });
      let err = "";
      p.stderr.on("data", (d) => (err += d));
      p.on("error", reject);
      p.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`pg_dump exited ${code}: ${err}`))));
    });
    const size = (await stat(file)).size;
    const key = `backups/tracker-${stamp}.dump`;
    await deps.storage.put(key, { path: file, size }, "application/octet-stream");
    logger.info({ key, size }, "backup uploaded");
    return key;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
