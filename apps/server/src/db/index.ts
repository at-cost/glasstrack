import { CamelCasePlugin, Kysely, PostgresDialect, sql } from "kysely";
import { Migrator } from "kysely/migration";
import pg from "pg";
import type { Config } from "../config";
import { logger } from "../lib/logger";
import { migrations } from "../migrations";
import type { DB } from "./schema";

// Return DATE columns as plain YYYY-MM-DD strings, not JS Dates in local time.
pg.types.setTypeParser(1082, (v) => v);
// int8 (bigint) as string to avoid precision loss; counts are cast in SQL.
pg.types.setTypeParser(20, (v) => v);

export type Db = Kysely<DB>;

export interface Databases {
  /** Owner: migrations and pg-boss only. Never used for request handling. */
  owner: Db;
  ownerPool: pg.Pool;
  /** glasstrack_app: subject to row-level security. */
  app: Db;
  /** glasstrack_system: cross-workspace jobs and pre-auth lookups. */
  system: Db;
  /** Raw pool on the system role, for LISTEN. */
  systemPool: pg.Pool;
  close(): Promise<void>;
}

function withUser(url: string, user: string, password: string): string {
  const u = new URL(url);
  u.username = user;
  u.password = encodeURIComponent(password);
  return u.toString();
}

function kysely(pool: pg.Pool): Db {
  return new Kysely<DB>({ dialect: new PostgresDialect({ pool }), plugins: [new CamelCasePlugin()] });
}

export function createDatabases(config: Config): Databases {
  const ownerPool = new pg.Pool({ connectionString: config.DATABASE_URL, max: 3 });
  const appPool = new pg.Pool({
    connectionString: withUser(config.DATABASE_URL, "glasstrack_app", config.DB_APP_PASSWORD),
    max: config.DB_POOL_SIZE,
  });
  const systemPool = new pg.Pool({
    connectionString: withUser(config.DATABASE_URL, "glasstrack_system", config.DB_SYSTEM_PASSWORD),
    max: Math.max(3, Math.floor(config.DB_POOL_SIZE / 2)),
  });
  for (const p of [ownerPool, appPool, systemPool]) {
    p.on("error", (err) => {
      // 57P01: the server is restarting or was told to drop connections; the pool reconnects.
      const expected = (err as { code?: string }).code === "57P01";
      logger[expected ? "warn" : "error"]({ err }, "idle postgres client error");
    });
  }
  const owner = kysely(ownerPool);
  const app = kysely(appPool);
  const system = kysely(systemPool);
  return {
    owner,
    ownerPool,
    app,
    system,
    systemPool,
    async close() {
      await Promise.all([app.destroy(), system.destroy(), owner.destroy()]);
    },
  };
}

/**
 * Creates or updates the runtime login roles. Idempotent; runs before
 * migrations on every boot so password rotation is just an env change.
 */
export async function ensureRoles(owner: Db, config: Config): Promise<void> {
  const roles: [string, string][] = [
    ["glasstrack_app", config.DB_APP_PASSWORD],
    ["glasstrack_system", config.DB_SYSTEM_PASSWORD],
  ];
  for (const [role, password] of roles) {
    const exists = await sql<{ n: number }>`SELECT 1 AS n FROM pg_roles WHERE rolname = ${role}`.execute(owner);
    const verb = exists.rows.length ? "ALTER" : "CREATE";
    // Role names are constants; password is passed as a literal via format().
    const stmt = await sql<{ q: string }>`SELECT format(${`${verb} ROLE ${role} LOGIN NOBYPASSRLS PASSWORD %L`}, ${password}::text) AS q`.execute(owner);
    await sql.raw(stmt.rows[0]!.q).execute(owner);
  }
  const db = await sql<{ d: string }>`SELECT current_database() AS d`.execute(owner);
  await sql.raw(`GRANT CONNECT ON DATABASE "${db.rows[0]!.d}" TO glasstrack_app, glasstrack_system`).execute(owner);
  // The owner must be able to hand functions over to glasstrack_system.
  await sql.raw("GRANT glasstrack_system TO CURRENT_USER").execute(owner).catch(() => undefined);
}

export function migrator(owner: Db): Migrator {
  return new Migrator({ db: owner, provider: { getMigrations: async () => migrations } });
}

export async function migrateToLatest(owner: Db): Promise<void> {
  const { error, results } = await migrator(owner).migrateToLatest();
  for (const r of results ?? []) {
    if (r.status === "Success") logger.info({ migration: r.migrationName }, "migration applied");
    if (r.status === "Error") logger.error({ migration: r.migrationName }, "migration failed");
  }
  if (error) throw error;
}
