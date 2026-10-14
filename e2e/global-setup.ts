import { mkdirSync, rmSync } from "node:fs";
import pg from "pg";
import { E2E } from "../playwright.config";

/** Empty database and mailbox before the server boots and migrates. */
export default async function globalSetup() {
  rmSync("test-results/e2e-files", { recursive: true, force: true });
  mkdirSync("test-results", { recursive: true });
  rmSync(E2E.mailFile, { force: true });
  const url = new URL(E2E.databaseUrl);
  const dbName = url.pathname.slice(1);
  const admin = new pg.Client({ connectionString: Object.assign(new URL(url), { pathname: "/postgres" }).toString() });
  await admin.connect();
  await admin.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
  await admin.query(`CREATE DATABASE ${dbName}`);
  await admin.end();
}
