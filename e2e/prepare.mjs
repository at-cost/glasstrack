// Runs before the e2e server boots: fresh database, empty mailbox and files.
import { mkdirSync, rmSync } from "node:fs";
import pg from "pg";

const url = new URL(process.env.DATABASE_URL);
const dbName = url.pathname.slice(1);
rmSync("test-results/e2e-files", { recursive: true, force: true });
mkdirSync("test-results", { recursive: true });
rmSync("test-results/e2e-mail.jsonl", { force: true });
const adminUrl = new URL(url);
adminUrl.pathname = "/postgres";
const admin = new pg.Client({ connectionString: adminUrl.toString() });
await admin.connect();
await admin.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
await admin.query(`CREATE DATABASE ${dbName}`);
await admin.end();
