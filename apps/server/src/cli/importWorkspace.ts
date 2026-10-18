/**
 * Import a Glasstrack workspace export into a new workspace on this server.
 *
 *   docker compose cp ./acme-export.tar.gz app:/tmp/acme-export.tar.gz
 *   docker compose exec app node dist/import-workspace.js /tmp/acme-export.tar.gz --slug acme --owner you@example.com --dry-run
 *   docker compose exec app node dist/import-workspace.js /tmp/acme-export.tar.gz --slug acme --owner you@example.com
 *
 * Options: --slug <url> (required), --name "<name>", --owner <email>,
 * --members-as <admin|member|guest|viewer>, --dry-run
 */
import { ROLES } from "@glasstrack/shared";
import { loadConfig } from "../config";
import type { Deps } from "../context";
import { createDatabases } from "../db";
import { importWorkspaceArchive } from "../importers/workspaceArchive";
import { createStorage } from "../storage";

const USAGE = `Usage: node dist/import-workspace.js <export.tar.gz> --slug <new-workspace-url> [--name "Name"] [--owner you@example.com] [--members-as ${ROLES.join("|")}] [--dry-run]`;
const args = process.argv.slice(2);
const valued = new Set(["--slug", "--name", "--owner", "--members-as"]);
const flags: Record<string, string> = {};
const positional: string[] = [];
for (let i = 0; i < args.length; i++) {
  const a = args[i]!;
  if (valued.has(a)) {
    const v = args[i + 1];
    if (!v || v.startsWith("--")) {
      console.error(`${a} needs a value.\n${USAGE}`);
      process.exit(2);
    }
    flags[a.slice(2)] = v;
    i++;
  } else if (a === "--dry-run") flags["dry-run"] = "yes";
  else if (a.startsWith("--")) {
    console.error(`Unknown option ${a}.\n${USAGE}`);
    process.exit(2);
  } else positional.push(a);
}
const file = positional[0];
if (!file || !flags.slug || positional.length > 1) {
  console.error(USAGE);
  process.exit(2);
}

const config = loadConfig();
const dbs = createDatabases(config);
try {
  const r = await importWorkspaceArchive({ config, dbs, storage: createStorage(config) } as Deps, file, {
    slug: flags.slug, name: flags.name, ownerEmail: flags.owner, membersAs: flags["members-as"] as (typeof ROLES)[number] | undefined, dryRun: Boolean(flags["dry-run"]),
  });
  const c = r.counts;
  console.log(`${r.dryRun ? "Dry run, nothing was written. This would import" : "Imported"} "${r.workspace.name}" at /${r.workspace.slug}:`);
  console.log(`  ${c.issues} issues, ${c.comments} comments, ${c.activity} history entries, ${c.attachments} attachments, ${c.pullRequestLinks} pull request links`);
  console.log(`  ${c.teams} teams, ${c.members} members, ${c.labels} labels, ${c.cycles} cycles, ${c.customFields} custom fields, ${c.relations} links between issues`);
  console.log(`  ${c.timeEntries} time entries, ${c.templates} templates, ${c.recurring} recurring issues, ${c.automations} automations, ${c.savedViews} saved views, ${c.auditLog} audit log entries`);
  if (r.matchedAccounts.length) {
    console.log("  Existing accounts on this server that get access:");
    for (const m of r.matchedAccounts) console.log(`    ${m.email} (${m.role})`);
  }
  if (r.newAccounts.length) console.log(`  New accounts (they sign in with these emails): ${r.newAccounts.join(", ")}`);
  for (const w of r.warnings) console.log(`  Note: ${w}`);
} catch (err) {
  console.error(`Import failed, nothing was changed: ${(err as Error).message}`);
  process.exitCode = 1;
} finally {
  await dbs.close();
}
