import type { IssueFilter, Priority } from "@glasstrack/shared";

/** Filter fields kept in the URL. Lists are comma separated. */
export interface FilterSearch {
  status?: string;
  assignee?: string;
  label?: string;
  priority?: string;
  cycle?: string;
  q?: string;
  /** Custom field filters, "fieldId:value" joined by commas. */
  field?: string;
}

export const FILTER_KEYS = ["status", "assignee", "label", "priority", "cycle", "q", "field"] as const;

const str = (v: unknown): string | undefined => {
  if (v === undefined || v === null || v === "") return undefined;
  return String(v);
};

export function readFilterSearch(search: Record<string, unknown>): FilterSearch {
  const out: FilterSearch = {};
  for (const k of FILTER_KEYS) {
    const v = str(search[k]);
    if (v !== undefined) out[k] = v;
  }
  return out;
}

const list = (v?: string) => (v ? v.split(",").filter(Boolean) : undefined);

export function searchToFilter(s: FilterSearch): IssueFilter {
  const f: IssueFilter = {};
  const status = list(s.status);
  if (status) f.status = status;
  const assignee = list(s.assignee);
  if (assignee) f.assignee = assignee;
  const label = list(s.label);
  if (label) f.label = label;
  const priority = list(s.priority)
    ?.map(Number)
    .filter((n) => n >= 0 && n <= 4) as Priority[] | undefined;
  if (priority?.length) f.priority = priority;
  if (s.cycle) f.cycle = s.cycle;
  if (s.q) f.q = s.q;
  const field = list(s.field)?.filter((x) => x.includes(":"));
  if (field?.length) f.field = field;
  return f;
}

export function filterToSearch(f: IssueFilter): FilterSearch {
  const s: FilterSearch = {};
  if (f.status?.length) s.status = f.status.join(",");
  if (f.assignee?.length) s.assignee = f.assignee.join(",");
  if (f.label?.length) s.label = f.label.join(",");
  if (f.priority?.length) s.priority = f.priority.join(",");
  if (f.cycle) s.cycle = f.cycle;
  if (f.q) s.q = f.q;
  if (f.field?.length) s.field = f.field.join(",");
  return s;
}

/** URL filters win over the page's base filter for the fields they set. */
export function mergeFilters(base: IssueFilter, url: IssueFilter): IssueFilter {
  const out: IssueFilter = { ...base };
  for (const [k, v] of Object.entries(url)) {
    if (v !== undefined) (out as Record<string, unknown>)[k] = v;
  }
  return out;
}

export function isEmptyFilter(s: FilterSearch): boolean {
  return FILTER_KEYS.every((k) => !s[k]);
}
