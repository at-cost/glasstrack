import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { sql } from "kysely";
import { createWorkspaceSchema, emailSchema, ROLES } from "@glasstrack/shared";
import { ensureBillingAccount, grantStarterCredit } from "../billing/service";
import type { Deps } from "../context";
import type { Tx } from "../db/tenant";
import { uuid7 } from "../lib/ids";
import { extractTarGz, type TarEntry } from "../lib/tar";
import { safeFilename } from "../modules/attachments";
import { workspacePrefix } from "../storage";

/**
 * Imports a Glasstrack workspace export (the .tar.gz from Settings → Export)
 * into a NEW workspace on this server: keeps issue identifiers (ENG-12 stays
 * ENG-12), comments, activity history, attachments, custom fields, time,
 * templates, saved views, pull request links and the audit log. People are
 * matched by email (accounts are created for unknown emails; they sign in
 * with that email). Every record gets a new internal id, so an export can be
 * imported on the server it came from too. Recurring issues and automations
 * arrive paused. Never changes an existing workspace.
 */

type Role = (typeof ROLES)[number];
type Row = Record<string, unknown> & { id: string };
interface Person {
  id: string;
  name: string;
  email: string;
}
interface Archive {
  format: string;
  version: number;
  exportedAt: string;
  workspace: { id: string; slug: string; name: string };
  members: (Person & { role: string; joinedAt: string })[];
  /** Everyone the rows refer to, including people who left (exports from 18 Oct 2026). */
  people?: Person[];
  teams: (Row & { key: string; name: string; private?: boolean; issueCounter?: number; createdAt: string; archivedAt: string | null })[];
  teamKeyAliases: { key: string; teamId: string }[];
  teamMembers: { teamId: string; userId: string }[];
  states: (Row & { teamId: string; name: string; category: string; color: string; position: number })[];
  labels: (Row & { teamId: string | null; name: string; color: string })[];
  cycles: (Row & { teamId: string; number: number; name: string | null; startsOn: string; endsOn: string; completedAt: string | null })[];
  issues: (Row & {
    teamId: string; identifier: string; title: string; descriptionMd: string; statusId: string; priority: number; creatorId: string | null;
    parentId: string | null; cycleId: string | null; startDate?: string | null; dueDate: string | null; estimate: string | number | null; sortKey: string;
    createdAt: string; updatedAt: string; startedAt: string | null; completedAt: string | null; canceledAt: string | null; archivedAt: string | null;
    labelIds: string[] | null; assigneeIds: string[] | null; fields: Record<string, unknown> | null;
  })[];
  relations: (Row & { issueId: string; relatedIssueId: string; type: string; createdAt: string })[];
  comments: (Row & { issueId: string; authorId: string | null; bodyMd: string; createdAt: string; editedAt: string | null })[];
  activity: (Row & { issueId: string; actorId: string | null; kind: string; data: unknown; createdAt: string })[];
  savedViews: (Row & { name: string; teamId: string | null; ownerId: string; shared: boolean; layout: string; filters: unknown })[];
  customFields: (Row & { teamId: string | null; name: string; type: string; options: unknown; position: number; archivedAt: string | null })[];
  timeEntries: (Row & { issueId: string; userId: string | null; spentOn: string; minutes: number; note: string | null; createdAt: string })[];
  templates: (Row & { teamId: string; name: string; title: string; descriptionMd: string; statusId: string | null; priority: number; labelIds: string[]; assigneeIds: string[]; estimate: string | number | null; fieldValues: unknown })[];
  recurring: (Row & { templateId: string; frequency: string; interval: number; weekdays: number[]; monthDay: number | null; hour: number; timezone: string; startsOn: string; nextRunAt: string; active: boolean })[];
  automationRules?: (Row & { teamId: string | null; name: string; enabled: boolean; trigger: string; triggerConfig: unknown; conditions: unknown; actions: unknown; createdAt: string })[];
  issueLinks?: (Row & { issueId: string; provider: string; url: string; title: string; state: string; createdAt: string })[];
  auditLog: (Row & { actorLabel: string; action: string; targetType: string | null; targetId: string | null; data: unknown; createdAt: string })[];
  attachments: (Row & { issueId: string; filename: string; contentType: string; sizeBytes: string | number; createdAt: string; path?: string })[];
}

export interface ImportOptions {
  slug: string;
  name?: string;
  /** Make this person (by email) an admin of the new workspace, creating the account if needed. */
  ownerEmail?: string;
  /** Give every imported member this role instead of the one in the archive (the owner stays admin). */
  membersAs?: Role;
  /** Run the whole import, then roll it back: nothing is written, but every problem shows up. */
  dryRun?: boolean;
}

export interface ImportReport {
  workspace: { slug: string; name: string; id: string | null };
  counts: Record<string, number>;
  /** Accounts already on this server that the archive's members are matched to, with the role they get. */
  matchedAccounts: { email: string; role: Role }[];
  /** Accounts that will be created (members and former members). */
  newAccounts: string[];
  warnings: string[];
  dryRun: boolean;
}

class DryRunDone extends Error {}

/** Replaces every old id (as a string value or an object key) with its new id. */
function remapDeep(v: unknown, map: Map<string, string>): unknown {
  if (typeof v === "string") {
    const direct = map.get(v);
    if (direct) return direct;
    // Composite values such as saved-view field filters ("<fieldId>:<value>").
    return v.includes(":") ? v.split(":").map((part) => map.get(part) ?? part).join(":") : v;
  }
  if (Array.isArray(v)) return v.map((x) => remapDeep(x, map));
  if (v && typeof v === "object") {
    return Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, x]) => [map.get(k) ?? k, remapDeep(x, map)]));
  }
  return v;
}

const numberOf = (identifier: string) => {
  const n = Number(identifier.slice(identifier.lastIndexOf("-") + 1));
  if (!Number.isInteger(n) || n < 1) throw new Error(`Unexpected issue identifier "${identifier}"`);
  return n;
};

/** Multi-row inserts in batches, staying far below Postgres's 65,535 parameter limit. */
async function insertMany(trx: Tx, table: string, rows: Record<string, unknown>[], batch = 500) {
  for (let i = 0; i < rows.length; i += batch) {
    await trx.insertInto(table as never).values(rows.slice(i, i + batch) as never).execute();
  }
}

const UUID_IN_NAME = /attachments\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i;

export async function importWorkspaceArchive(deps: Deps, file: string, opts: ImportOptions): Promise<ImportReport> {
  const target = createWorkspaceSchema.safeParse({ slug: opts.slug, name: opts.name ?? "x" });
  if (!target.success) throw new Error(`Invalid workspace URL "${opts.slug}": ${target.error.issues[0]?.message}`);
  if (opts.ownerEmail && !emailSchema.safeParse(opts.ownerEmail).success) throw new Error(`"${opts.ownerEmail}" isn't an email address`);
  if (opts.membersAs && !ROLES.includes(opts.membersAs)) throw new Error(`Unknown role "${opts.membersAs}" (use ${ROLES.join(", ")})`);
  const slug = target.data.slug;
  const sys = deps.dbs.system;
  if (await sys.selectFrom("workspaces").select("id").where("slug", "=", slug).executeTakeFirst()) {
    throw new Error(`A workspace with the URL "${slug}" already exists. Pick a new one: import never changes an existing workspace.`);
  }

  const dir = await mkdtemp(path.join(tmpdir(), "glasstrack-import-"));
  const uploaded: string[] = [];
  try {
    // A dry run only needs workspace.json on disk; attachments are read past, not written.
    const entries = await extractTarGz(file, dir, opts.dryRun ? { keep: (n) => n.endsWith("workspace.json") } : {});
    const json = entries.find((e) => e.name.endsWith("/workspace.json") || e.name === "workspace.json");
    if (!json) throw new Error("This isn't a Glasstrack export: workspace.json is missing");
    const a = JSON.parse(await readFile(json.path, "utf8")) as Archive;
    if (a.format !== "glasstrack-export") throw new Error("This isn't a Glasstrack export (unknown format)");
    if (a.version !== 1) throw new Error(`Unsupported export version ${a.version}; update this server and try again`);
    const name = opts.name?.trim() || a.workspace.name;
    const warnings: string[] = [];
    const skipped: Record<string, number> = {};
    /** Counts a row that refers to something missing from the export; always false, for use in filters. */
    const orSkip = (what: string) => {
      skipped[what] = (skipped[what] ?? 0) + 1;
      return false;
    };

    // New id for every record; the export's ids are only used to connect things.
    const ids = new Map<string, string>();
    for (const list of [a.teams, a.states, a.labels, a.cycles, a.issues, a.relations, a.comments, a.savedViews, a.customFields, a.timeEntries, a.templates, a.recurring, a.automationRules ?? [], a.issueLinks ?? [], a.attachments]) {
      for (const r of list) ids.set(r.id, uuid7());
    }
    const wsId = uuid7();
    ids.set(a.workspace.id, wsId);

    // People: members, plus former members the rows refer to (newer exports list them in `people`).
    const people = new Map<string, Person>();
    for (const p of [...(a.people ?? []), ...a.members]) people.set(p.id, { id: p.id, name: p.name, email: p.email.toLowerCase() });
    const ownerEmail = opts.ownerEmail?.toLowerCase();
    const emails = [...new Set([...[...people.values()].map((p) => p.email), ...(ownerEmail ? [ownerEmail] : [])])];
    const existing = emails.length ? await sys.selectFrom("users").select(["id", "email", "deletedAt"]).where(sql<string>`lower(email)`, "in", emails).execute() : [];
    const deleted = existing.filter((u) => u.deletedAt);
    if (deleted.length) throw new Error(`These emails belong to deleted accounts on this server: ${deleted.map((u) => u.email).join(", ")}`);
    const userByEmail = new Map(existing.map((u) => [u.email.toLowerCase(), u.id]));
    const newAccounts: { id: string; email: string; name: string }[] = [];
    const accountFor = (email: string, displayName: string) => {
      let id = userByEmail.get(email);
      if (!id) {
        id = uuid7();
        userByEmail.set(email, id);
        newAccounts.push({ id, email, name: displayName || email.split("@")[0]! });
      }
      return id;
    };
    for (const p of people.values()) ids.set(p.id, accountFor(p.email, p.name));
    if (ownerEmail) accountFor(ownerEmail, "");
    const user = (old: string | null | undefined) => (old && people.has(old) ? ids.get(old)! : null);
    const R = (v: unknown) => remapDeep(v, ids);

    // Roles in the new workspace.
    const roles = new Map<string, Role>();
    for (const m of a.members) roles.set(ids.get(m.id)!, opts.membersAs ?? ((ROLES as readonly string[]).includes(m.role) ? (m.role as Role) : "member"));
    if (ownerEmail) roles.set(userByEmail.get(ownerEmail)!, "admin");
    if (![...roles.values()].includes("admin")) warnings.push("Nobody in the new workspace is an admin. Re-run with --owner <your email>.");
    const existingIds = new Set(existing.map((u) => u.id));
    const matchedAccounts = [...roles].filter(([uid]) => existingIds.has(uid)).map(([uid, role]) => ({ email: [...userByEmail].find(([, v]) => v === uid)![0], role }));

    // Attachments: find each file in the archive by its id (older exports may have cut long names; then match name and size).
    const byId = new Map<string, TarEntry>();
    for (const e of entries) {
      const m = UUID_IN_NAME.exec(e.name);
      if (m) byId.set(m[1]!.toLowerCase(), e);
    }
    const fileFor = new Map<string, TarEntry>();
    for (const at of a.attachments) {
      const e = byId.get(at.id.toLowerCase())
        ?? entries.find((x) => x.name.includes("/attachments/") && x.size === Number(at.sizeBytes) && at.filename.endsWith(x.name.slice(x.name.lastIndexOf("/") + 1).slice(-20)));
      if (e) fileFor.set(at.id, e);
      else warnings.push(`Attachment "${at.filename}" is missing from the archive and was skipped`);
    }
    if (!a.people) {
      const lost = a.comments.filter((c) => c.authorId && !user(c.authorId)).length + a.timeEntries.filter((t) => t.userId && !user(t.userId)).length;
      if (lost) warnings.push(`This export is from an older version: ${lost} comments and time entries by people who had left are kept without a name`);
    }
    if (!a.automationRules) warnings.push("This export is from an older version and has no automations or pull request links; set those up again if you had any.");
    if (a.teams.some((t) => t.issueCounter === undefined)) warnings.push("This export is from an older version: numbers of issues deleted from the end of a team may be reused.");
    if (a.recurring.some((r) => r.active)) warnings.push("Recurring issues were imported paused. Turn them back on in Settings → Templates when ready.");
    if ((a.automationRules ?? []).some((r) => r.enabled)) warnings.push("Automations were imported switched off. Turn them back on in Settings → Automations when ready.");

    const issueOk = (old: string) => ids.has(old) && a.issues.some((i) => i.id === old);
    const counts: Record<string, number> = {};

    if (!opts.dryRun) {
      // Files first; if the database step fails they are removed again.
      for (const at of a.attachments) {
        const e = fileFor.get(at.id);
        if (!e || !issueOk(at.issueId)) continue;
        const key = `${workspacePrefix(wsId)}attachments/${ids.get(at.id)}/${safeFilename(at.filename)}`;
        await deps.storage.put(key, { path: e.path, size: e.size }, at.contentType || "application/octet-stream");
        uploaded.push(key);
      }
    }

    const run = sys.transaction().execute(async (trx) => {
      if (newAccounts.length) await insertMany(trx, "users", newAccounts);
      const owner = ownerEmail ? userByEmail.get(ownerEmail)! : ([...roles].find(([, r]) => r === "admin")?.[0] ?? null);
      await trx.insertInto("workspaces").values({ id: wsId, slug, name, createdBy: owner }).execute();
      const joined = new Map(a.members.map((m) => [ids.get(m.id)!, m.joinedAt]));
      await insertMany(trx, "workspaceMembers", [...roles].map(([userId, role]) => ({
        workspaceId: wsId, userId, role, joinedAt: new Date(joined.get(userId) ?? Date.now()),
      })));
      counts.members = roles.size;

      const teamIds = new Set(a.teams.map((t) => t.id));
      for (const t of a.teams) {
        const maxNumber = Math.max(0, ...a.issues.filter((i) => i.teamId === t.id).map((i) => numberOf(i.identifier)));
        await trx.insertInto("teams").values({
          id: ids.get(t.id)!, workspaceId: wsId, key: t.key, name: t.name, private: Boolean(t.private),
          issueCounter: Math.max(maxNumber, t.issueCounter ?? 0), createdAt: new Date(t.createdAt), archivedAt: t.archivedAt ? new Date(t.archivedAt) : null,
        }).execute();
      }
      counts.teams = a.teams.length;
      await insertMany(trx, "teamKeyAliases", a.teamKeyAliases.filter((x) => teamIds.has(x.teamId) && !a.teams.some((t) => t.key === x.key))
        .map((x) => ({ workspaceId: wsId, key: x.key, teamId: ids.get(x.teamId)! })));
      await insertMany(trx, "teamMembers", a.teamMembers.filter((x) => teamIds.has(x.teamId) && roles.has(user(x.userId) ?? ""))
        .map((x) => ({ workspaceId: wsId, teamId: ids.get(x.teamId)!, userId: user(x.userId)! })));
      const states = a.states.filter((s) => teamIds.has(s.teamId) || orSkip("statuses"));
      await insertMany(trx, "workflowStates", states.map((s) => ({
        id: ids.get(s.id)!, workspaceId: wsId, teamId: ids.get(s.teamId)!, name: s.name, category: s.category, color: s.color, position: s.position,
      })));
      const stateIds = new Set(states.map((s) => s.id));
      await insertMany(trx, "labels", a.labels.filter((l) => !l.teamId || teamIds.has(l.teamId)).map((l) => ({
        id: ids.get(l.id)!, workspaceId: wsId, teamId: l.teamId ? ids.get(l.teamId)! : null, name: l.name, color: l.color,
      })));
      counts.labels = a.labels.length;
      const cycles = a.cycles.filter((c) => teamIds.has(c.teamId));
      await insertMany(trx, "cycles", cycles.map((c) => ({
        id: ids.get(c.id)!, workspaceId: wsId, teamId: ids.get(c.teamId)!, number: c.number, name: c.name, startsOn: c.startsOn, endsOn: c.endsOn,
        completedAt: c.completedAt ? new Date(c.completedAt) : null,
      })));
      counts.cycles = cycles.length;
      const cycleIds = new Set(cycles.map((c) => c.id));
      const fields = a.customFields.filter((f) => !f.teamId || teamIds.has(f.teamId));
      await insertMany(trx, "customFields", fields.map((f) => ({
        id: ids.get(f.id)!, workspaceId: wsId, teamId: f.teamId ? ids.get(f.teamId)! : null, name: f.name, type: f.type,
        options: JSON.stringify(f.options ?? []), position: f.position, archivedAt: f.archivedAt ? new Date(f.archivedAt) : null,
      })));
      counts.customFields = fields.length;
      const fieldIds = new Set(fields.map((f) => f.id));

      // Issues (parents linked after every issue exists).
      const issues = a.issues.filter((i) => (teamIds.has(i.teamId) && stateIds.has(i.statusId)) || orSkip("issues"));
      const issueIds = new Set(issues.map((i) => i.id));
      await insertMany(trx, "issues", issues.map((i) => ({
        id: ids.get(i.id)!, workspaceId: wsId, teamId: ids.get(i.teamId)!, number: numberOf(i.identifier), title: i.title, descriptionMd: i.descriptionMd ?? "",
        statusId: ids.get(i.statusId)!, priority: i.priority, creatorId: user(i.creatorId), parentId: null,
        cycleId: i.cycleId && cycleIds.has(i.cycleId) ? ids.get(i.cycleId)! : null, startDate: i.startDate ?? null, dueDate: i.dueDate,
        estimate: i.estimate === null ? null : Number(i.estimate), sortKey: i.sortKey, createdAt: new Date(i.createdAt), updatedAt: new Date(i.updatedAt),
        startedAt: i.startedAt ? new Date(i.startedAt) : null, completedAt: i.completedAt ? new Date(i.completedAt) : null,
        canceledAt: i.canceledAt ? new Date(i.canceledAt) : null, archivedAt: i.archivedAt ? new Date(i.archivedAt) : null,
      })));
      counts.issues = issues.length;
      const labelIds = new Set(a.labels.filter((l) => !l.teamId || teamIds.has(l.teamId)).map((l) => l.id));
      await insertMany(trx, "issueLabels", issues.flatMap((i) => [...new Set(i.labelIds ?? [])].filter((l) => labelIds.has(l))
        .map((l) => ({ workspaceId: wsId, issueId: ids.get(i.id)!, labelId: ids.get(l)! }))));
      await insertMany(trx, "issueAssignees", issues.flatMap((i) => [...new Set((i.assigneeIds ?? []).map((u) => user(u)).filter((u): u is string => Boolean(u)))]
        .map((u) => ({ workspaceId: wsId, issueId: ids.get(i.id)!, userId: u }))));
      await insertMany(trx, "issueFieldValues", issues.flatMap((i) => Object.entries(i.fields ?? {}).filter(([fid]) => fieldIds.has(fid))
        .map(([fid, value]) => ({ workspaceId: wsId, issueId: ids.get(i.id)!, fieldId: ids.get(fid)!, value: JSON.stringify(R(value)) }))));
      for (const i of issues.filter((x) => x.parentId && issueIds.has(x.parentId))) {
        await trx.updateTable("issues").set({ parentId: ids.get(i.parentId!)! }).where("id", "=", ids.get(i.id)!).execute();
      }
      const relations = a.relations.filter((r) => (issueIds.has(r.issueId) && issueIds.has(r.relatedIssueId)) || orSkip("issue links"));
      await insertMany(trx, "issueRelations", relations.map((r) => ({
        id: ids.get(r.id)!, workspaceId: wsId, issueId: ids.get(r.issueId)!, relatedIssueId: ids.get(r.relatedIssueId)!, type: r.type, createdAt: new Date(r.createdAt),
      })));
      counts.relations = relations.length;
      const comments = a.comments.filter((c) => issueIds.has(c.issueId) || orSkip("comments"));
      await insertMany(trx, "comments", comments.map((c) => ({
        id: ids.get(c.id)!, workspaceId: wsId, issueId: ids.get(c.issueId)!, authorId: user(c.authorId), bodyMd: c.bodyMd,
        createdAt: new Date(c.createdAt), editedAt: c.editedAt ? new Date(c.editedAt) : null,
      })));
      counts.comments = comments.length;
      const activity = a.activity.filter((x) => issueIds.has(x.issueId) || orSkip("history entries"));
      await insertMany(trx, "activity", activity.map((x) => ({
        workspaceId: wsId, issueId: ids.get(x.issueId)!, actorId: user(x.actorId), kind: x.kind, data: JSON.stringify(R(x.data ?? {})), createdAt: new Date(x.createdAt),
      })));
      counts.activity = activity.length;
      // Members involved in an issue follow it, so notifications keep working.
      const subs = new Set<string>();
      for (const i of issues) for (const u of [i.creatorId, ...(i.assigneeIds ?? [])]) if (roles.has(user(u) ?? "")) subs.add(`${ids.get(i.id)}|${user(u)}`);
      for (const c of comments) if (roles.has(user(c.authorId) ?? "")) subs.add(`${ids.get(c.issueId)}|${user(c.authorId)}`);
      await insertMany(trx, "issueSubscribers", [...subs].map((s) => {
        const [issueId, userId] = s.split("|") as [string, string];
        return { workspaceId: wsId, issueId, userId };
      }));
      const time = a.timeEntries.filter((t) => issueIds.has(t.issueId) || orSkip("time entries"));
      await insertMany(trx, "timeEntries", time.map((t) => ({
        id: ids.get(t.id)!, workspaceId: wsId, issueId: ids.get(t.issueId)!, userId: user(t.userId), spentOn: t.spentOn, minutes: t.minutes, note: t.note, createdAt: new Date(t.createdAt),
      })));
      counts.timeEntries = time.length;
      const views = a.savedViews.filter((v) => (!v.teamId || teamIds.has(v.teamId)) && roles.has(user(v.ownerId) ?? ""));
      if (views.length < a.savedViews.length) warnings.push(`${a.savedViews.length - views.length} personal saved views of people who had left were not imported`);
      await insertMany(trx, "savedViews", views.map((v) => ({
        id: ids.get(v.id)!, workspaceId: wsId, teamId: v.teamId ? ids.get(v.teamId)! : null, ownerId: user(v.ownerId)!, name: v.name, shared: v.shared,
        layout: v.layout, filters: JSON.stringify(R(v.filters ?? {})),
      })));
      counts.savedViews = views.length;
      const templates = a.templates.filter((t) => teamIds.has(t.teamId) || orSkip("templates"));
      await insertMany(trx, "issueTemplates", templates.map((t) => ({
        id: ids.get(t.id)!, workspaceId: wsId, teamId: ids.get(t.teamId)!, name: t.name, title: t.title, descriptionMd: t.descriptionMd ?? "",
        statusId: t.statusId && stateIds.has(t.statusId) ? ids.get(t.statusId)! : null, priority: t.priority,
        labelIds: (t.labelIds ?? []).filter((x) => labelIds.has(x)).map((x) => ids.get(x)!),
        assigneeIds: (t.assigneeIds ?? []).map((u) => user(u)).filter((u): u is string => roles.has(u ?? "")), estimate: t.estimate === null ? null : Number(t.estimate),
        fieldValues: JSON.stringify(R(t.fieldValues ?? {})), createdBy: null,
      })));
      counts.templates = templates.length;
      const templateIds = new Set(templates.map((t) => t.id));
      const recurring = a.recurring.filter((r) => templateIds.has(r.templateId));
      await insertMany(trx, "recurringIssues", recurring.map((r) => ({
        id: ids.get(r.id)!, workspaceId: wsId, templateId: ids.get(r.templateId)!, frequency: r.frequency, interval: r.interval, weekdays: r.weekdays ?? [],
        monthDay: r.monthDay, hour: r.hour, timezone: r.timezone, startsOn: r.startsOn, nextRunAt: new Date(r.nextRunAt), active: false, createdBy: null,
      })));
      counts.recurring = recurring.length;
      const rules = (a.automationRules ?? []).filter((r) => !r.teamId || teamIds.has(r.teamId));
      await insertMany(trx, "automationRules", rules.map((r) => ({
        id: ids.get(r.id)!, workspaceId: wsId, teamId: r.teamId ? ids.get(r.teamId)! : null, name: r.name, enabled: false, trigger: r.trigger,
        triggerConfig: JSON.stringify(R(r.triggerConfig ?? {})), conditions: JSON.stringify(R(r.conditions ?? {})), actions: JSON.stringify(R(r.actions ?? [])),
        createdBy: null, createdAt: new Date(r.createdAt),
      })));
      counts.automations = rules.length;
      const links = (a.issueLinks ?? []).filter((l) => issueIds.has(l.issueId));
      await insertMany(trx, "issueLinks", links.map((l) => ({
        id: ids.get(l.id)!, workspaceId: wsId, issueId: ids.get(l.issueId)!, provider: l.provider, url: l.url, title: l.title, state: l.state, createdAt: new Date(l.createdAt),
      })));
      counts.pullRequestLinks = links.length;
      const atts = a.attachments.filter((at) => fileFor.has(at.id) && issueOk(at.issueId) && issueIds.has(at.issueId));
      await insertMany(trx, "attachments", atts.map((at) => ({
        id: ids.get(at.id)!, workspaceId: wsId, issueId: ids.get(at.issueId)!, uploaderId: null,
        storageKey: `${workspacePrefix(wsId)}attachments/${ids.get(at.id)}/${safeFilename(at.filename)}`, filename: safeFilename(at.filename),
        contentType: at.contentType || "application/octet-stream", sizeBytes: Number(at.sizeBytes), uploadedAt: new Date(at.createdAt), createdAt: new Date(at.createdAt),
      })));
      counts.attachments = atts.length;
      await insertMany(trx, "auditLog", a.auditLog.map((x) => ({
        workspaceId: wsId, actorId: null, actorLabel: x.actorLabel, action: x.action, targetType: x.targetType,
        targetId: x.targetId ? (ids.get(x.targetId) ?? x.targetId) : null, data: JSON.stringify(R(x.data ?? {})), createdAt: new Date(x.createdAt),
      })));
      counts.auditLog = a.auditLog.length;
      await trx.insertInto("auditLog").values({
        workspaceId: wsId, actorId: null, actorLabel: "import", action: "workspace.imported", targetType: "workspace", targetId: wsId,
        data: JSON.stringify({ from: a.workspace.slug, exportedAt: a.exportedAt, counts }),
      }).execute();
      if (opts.dryRun) throw new DryRunDone();
    });
    try {
      await run;
    } catch (err) {
      if (!(err instanceof DryRunDone)) throw err;
    }
    for (const [what, n] of Object.entries(skipped)) warnings.push(`${n} ${what} referred to something missing from the export and were skipped`);
    uploaded.length = 0;

    // Hosted servers: the owner's signup credit, as for any new workspace.
    if (!opts.dryRun && deps.config.BILLING_ENABLED) {
      await ensureBillingAccount(sys, wsId);
      const owner = ownerEmail ? userByEmail.get(ownerEmail) : [...roles].find(([, r]) => r === "admin")?.[0];
      if (owner) await grantStarterCredit(deps, { workspaceId: wsId, userId: owner });
    }
    return {
      workspace: { slug, name, id: opts.dryRun ? null : wsId },
      counts, matchedAccounts, newAccounts: newAccounts.map((u) => u.email), warnings, dryRun: Boolean(opts.dryRun),
    };
  } finally {
    // Remove files of a failed import; always remove the extracted archive.
    for (const key of uploaded) await deps.storage.delete(key).catch(() => undefined);
    await rm(dir, { recursive: true, force: true });
  }
}
