import { parseCsv } from "../lib/csv";

/** Common shape every importer produces. */
export interface ImportIssue {
  externalId: string;
  title: string;
  description: string;
  status: string;
  priority: number;
  assignee: string | null;
  labels: string[];
  createdAt: string | null;
  dueDate: string | null;
  estimate: number | null;
  parentExternalId: string | null;
  comments: { author: string; body: string; createdAt: string | null }[];
}

export interface ParsedImport {
  issues: ImportIssue[];
  /** Status names in source order, so new statuses get a sensible position. */
  statuses: string[];
}

const PRIORITY_WORDS: Record<string, number> = {
  urgent: 1, highest: 1, critical: 1, blocker: 1,
  high: 2, major: 2,
  medium: 3, normal: 3,
  low: 4, lowest: 4, minor: 4, trivial: 4,
};
export const mapPriority = (s: string | undefined | null) => PRIORITY_WORDS[(s ?? "").trim().toLowerCase()] ?? 0;

const toIso = (s: string | undefined | null): string | null => {
  if (!s?.trim()) return null;
  const t = Date.parse(s);
  return Number.isNaN(t) ? null : new Date(t).toISOString();
};
const toDay = (s: string | undefined | null) => toIso(s)?.slice(0, 10) ?? null;
const num = (s: string | undefined | null) => {
  const n = Number(s);
  return s && Number.isFinite(n) && n >= 0 ? Math.min(n, 1000) : null;
};

function table(text: string): { header: string[]; rows: string[][] } {
  const all = parseCsv(text);
  const header = (all[0] ?? []).map((h) => h.trim());
  return { header, rows: all.slice(1) };
}

const uniq = (xs: string[]) => [...new Set(xs.filter(Boolean))];

/** Linear CSV export (Settings > Import/export > Export CSV). Comments are not part of Linear's CSV. */
export function parseLinearCsv(text: string): ParsedImport {
  const { header, rows } = table(text);
  const col = (name: string) => header.findIndex((h) => h.toLowerCase() === name.toLowerCase());
  const c = {
    id: col("ID"), title: col("Title"), desc: col("Description"), status: col("Status"), priority: col("Priority"),
    assignee: col("Assignee"), labels: col("Labels"), created: col("Created"), due: col("Due Date"), estimate: col("Estimate"), parent: col("Parent issue"),
  };
  if (c.title < 0 || c.status < 0) throw new Error("This doesn't look like a Linear CSV export (missing Title or Status columns)");
  const issues = rows.map((r, i) => ({
    externalId: (c.id >= 0 && r[c.id]) || `row-${i + 1}`,
    title: (r[c.title] ?? "").trim() || "(untitled)",
    description: c.desc >= 0 ? (r[c.desc] ?? "") : "",
    status: (r[c.status] ?? "").trim() || "Backlog",
    priority: mapPriority(c.priority >= 0 ? r[c.priority] : ""),
    assignee: c.assignee >= 0 && r[c.assignee]?.trim() ? r[c.assignee]!.trim() : null,
    labels: c.labels >= 0 ? uniq((r[c.labels] ?? "").split(",").map((l) => l.trim())) : [],
    createdAt: c.created >= 0 ? toIso(r[c.created]) : null,
    dueDate: c.due >= 0 ? toDay(r[c.due]) : null,
    estimate: c.estimate >= 0 ? num(r[c.estimate]) : null,
    parentExternalId: c.parent >= 0 && r[c.parent]?.trim() ? r[c.parent]!.trim() : null,
    comments: [],
  }));
  return { issues, statuses: uniq(issues.map((i) => i.status)) };
}

/**
 * Jira CSV export ("Export Excel CSV (all fields)"). Repeated columns such as
 * Labels and Comment are collected; comments look like "date;authorId;text".
 */
export function parseJiraCsv(text: string): ParsedImport {
  const { header, rows } = table(text);
  const all = (name: string) => header.map((h, i) => (h.toLowerCase() === name.toLowerCase() ? i : -1)).filter((i) => i >= 0);
  const one = (name: string) => all(name)[0] ?? -1;
  const c = {
    key: one("Issue key"), summary: one("Summary"), desc: one("Description"), status: one("Status"), priority: one("Priority"),
    assignee: one("Assignee"), created: one("Created"), due: one("Due date"), parent: one("Parent") >= 0 ? one("Parent") : one("Parent id"),
    estimate: one("Custom field (Story Points)"), labels: all("Labels"), comments: all("Comment"),
  };
  if (c.summary < 0 || c.status < 0) throw new Error("This doesn't look like a Jira CSV export (missing Summary or Status columns)");
  const idCol = one("Issue id");
  const keyById = new Map<string, string>();
  if (idCol >= 0 && c.key >= 0) for (const r of rows) keyById.set(r[idCol] ?? "", r[c.key] ?? "");
  const issues = rows.map((r, i) => ({
    externalId: (c.key >= 0 && r[c.key]) || `row-${i + 1}`,
    title: (r[c.summary] ?? "").trim() || "(untitled)",
    description: c.desc >= 0 ? (r[c.desc] ?? "") : "",
    status: (r[c.status] ?? "").trim() || "To Do",
    priority: mapPriority(c.priority >= 0 ? r[c.priority] : ""),
    assignee: c.assignee >= 0 && r[c.assignee]?.trim() ? r[c.assignee]!.trim() : null,
    labels: uniq(c.labels.map((k) => (r[k] ?? "").trim())),
    createdAt: c.created >= 0 ? toIso(r[c.created]) : null,
    dueDate: c.due >= 0 ? toDay(r[c.due]) : null,
    estimate: c.estimate >= 0 ? num(r[c.estimate]) : null,
    parentExternalId: c.parent >= 0 && r[c.parent]?.trim() ? (keyById.get(r[c.parent]!.trim()) ?? r[c.parent]!.trim()) : null,
    comments: c.comments.map((k) => r[k] ?? "").filter((v) => v.trim()).map((v) => {
      const [date, author, ...rest] = v.split(";");
      return rest.length ? { author: author ?? "unknown", body: rest.join(";"), createdAt: toIso(date) } : { author: "unknown", body: v, createdAt: null };
    }),
  }));
  return { issues, statuses: uniq(issues.map((i) => i.status)) };
}

interface TrelloBoard {
  lists?: { id: string; name: string; closed?: boolean }[];
  cards?: { id: string; idShort?: number; name: string; desc?: string; idList: string; idLabels?: string[]; idMembers?: string[]; closed?: boolean; due?: string | null; dateLastActivity?: string }[];
  labels?: { id: string; name?: string; color?: string }[];
  members?: { id: string; fullName?: string; username?: string }[];
  actions?: { type: string; date?: string; data?: { card?: { id: string }; text?: string }; memberCreator?: { fullName?: string; username?: string } }[];
}

/** Trello board JSON export (Board menu > Print, export and share > Export as JSON). Lists become statuses. */
export function parseTrelloJson(text: string): ParsedImport {
  let board: TrelloBoard;
  try {
    board = JSON.parse(text);
  } catch {
    throw new Error("This isn't valid JSON. Export the board from Trello as JSON.");
  }
  if (!Array.isArray(board.cards) || !Array.isArray(board.lists)) throw new Error("This doesn't look like a Trello board export (no lists or cards)");
  const lists = new Map(board.lists.map((l) => [l.id, l.name]));
  const labels = new Map((board.labels ?? []).map((l) => [l.id, l.name || l.color || "label"]));
  const members = new Map((board.members ?? []).map((m) => [m.id, m.fullName || m.username || "member"]));
  const comments = new Map<string, ImportIssue["comments"]>();
  for (const a of board.actions ?? []) {
    if (a.type !== "commentCard" || !a.data?.card?.id || !a.data.text) continue;
    const list = comments.get(a.data.card.id) ?? [];
    list.push({ author: a.memberCreator?.fullName || a.memberCreator?.username || "unknown", body: a.data.text, createdAt: toIso(a.date) });
    comments.set(a.data.card.id, list);
  }
  const issues = board.cards.filter((c) => !c.closed).map((c) => ({
    externalId: c.id,
    title: c.name.trim() || "(untitled)",
    description: c.desc ?? "",
    status: lists.get(c.idList) ?? "Backlog",
    priority: 0,
    assignee: c.idMembers?.[0] ? (members.get(c.idMembers[0]) ?? null) : null,
    labels: uniq((c.idLabels ?? []).map((id) => labels.get(id) ?? "")),
    createdAt: null,
    dueDate: toDay(c.due),
    estimate: null,
    parentExternalId: null,
    comments: (comments.get(c.id) ?? []).reverse(),
  }));
  const order = board.lists.filter((l) => !l.closed).map((l) => l.name);
  return { issues, statuses: uniq([...order, ...issues.map((i) => i.status)]) };
}

/** Guesses a workflow category for a status name from another tool. */
export function guessCategory(name: string): "backlog" | "unstarted" | "started" | "completed" | "canceled" {
  const n = name.toLowerCase();
  if (/(cancel|won.?t|duplicate|declined|rejected|obsolete)/.test(n)) return "canceled";
  if (/(done|complete|closed|resolved|shipped|released|merged|finished)/.test(n)) return "completed";
  if (/(progress|review|doing|testing|qa|develop|active|started|blocked)/.test(n)) return "started";
  if (/(backlog|icebox|someday|triage|idea)/.test(n)) return "backlog";
  return "unstarted";
}
