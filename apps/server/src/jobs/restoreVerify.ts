import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import pg from "pg";
import type { Config } from "../config";
import { logger } from "../lib/logger";
import { migrations } from "../migrations";
import type { Storage } from "../storage";

function run(cmd: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: ["ignore", "ignore", "pipe"] });
    let err = "";
    p.stderr.on("data", (d) => (err += d));
    p.on("error", reject);
    p.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`${cmd} exited ${code}: ${err.slice(0, 2000)}`))));
  });
}

/**
 * Restores the newest backup into a throwaway database, checks it, drops it.
 * Exits non-zero on any failure so cron/systemd can alert.
 */
export async function restoreVerify(config: Config, storage: Storage): Promise<{ key: string; counts: Record<string, number> }> {
  const keys = (await storage.list("backups/")).filter((k) => k.endsWith(".dump"));
  const key = keys.at(-1);
  if (!key) throw new Error("No backups found under backups/");
  const dir = await mkdtemp(path.join(tmpdir(), "glasstrack-restore-"));
  const file = path.join(dir, "latest.dump");
  const scratch = `glasstrack_restore_check_${Date.now()}`;
  const admin = new pg.Client({ connectionString: config.DATABASE_URL });
  await admin.connect();
  const scratchUrl = new URL(config.DATABASE_URL);
  scratchUrl.pathname = `/${scratch}`;
  try {
    await pipeline(await storage.get(key), createWriteStream(file));
    await admin.query(`CREATE DATABASE ${scratch}`);
    await run("pg_restore", ["--no-owner", "--no-privileges", "--exit-on-error", "--dbname", scratchUrl.toString(), file]);
    const db = new pg.Client({ connectionString: scratchUrl.toString() });
    await db.connect();
    try {
      const applied = await db.query<{ n: string }>("SELECT count(*) AS n FROM kysely_migration");
      const expected = Object.keys(migrations).length;
      if (Number(applied.rows[0]!.n) > expected) {
        logger.warn({ applied: applied.rows[0]!.n, expected }, "backup has newer migrations than this build");
      }
      const counts: Record<string, number> = {};
      for (const t of ["users", "workspaces", "issues", "comments", "activity"]) {
        counts[t] = Number((await db.query<{ n: string }>(`SELECT count(*) AS n FROM ${t}`)).rows[0]!.n);
      }
      const orphans = await db.query<{ n: string }>(
        "SELECT count(*) AS n FROM issues i LEFT JOIN workspaces w ON w.id = i.workspace_id WHERE w.id IS NULL",
      );
      if (Number(orphans.rows[0]!.n) > 0) throw new Error("Restored data has issues without a workspace");
      return { key, counts };
    } finally {
      await db.end();
    }
  } finally {
    await admin.query(`DROP DATABASE IF EXISTS ${scratch} WITH (FORCE)`).catch(() => undefined);
    await admin.end();
    await rm(dir, { recursive: true, force: true });
  }
}
