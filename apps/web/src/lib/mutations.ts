import { type QueryClient, useMutation, useQueryClient } from "@tanstack/react-query";
import type { Issue, IssueDetail, Priority } from "@glasstrack/shared";
import { api, errorMessage, type IssueCreate, type IssuePatch } from "./api";
import { keys, type ListFilter } from "./queries";
import { toastError } from "./toast";

type ListData = { issues: Issue[]; hasMore: boolean };
type Snapshot = [readonly unknown[], unknown][];

function snapshot(qc: QueryClient, slug: string): Snapshot {
  return [...qc.getQueriesData({ queryKey: keys.issuesAll(slug) }), ...qc.getQueriesData({ queryKey: keys.issueAll(slug) })];
}

function restore(qc: QueryClient, snap: Snapshot | undefined) {
  if (!snap) return;
  for (const [key, data] of snap) qc.setQueryData(key, data);
}

/** Does an issue belong in a list with this filter? Used for optimistic inserts. */
export function matchesFilter(i: Issue, f: ListFilter, meId: string | undefined): boolean {
  if (f.team && i.teamId !== f.team) return false;
  if (!f.includeArchived && i.archivedAt) return false;
  if (f.status?.length && !f.status.includes(i.statusId)) return false;
  if (f.priority?.length && !f.priority.includes(i.priority)) return false;
  if (f.parent && i.parentId !== f.parent) return false;
  if (f.assignee?.length) {
    const ok = f.assignee.some((a) =>
      a === "none" ? i.assigneeIds.length === 0 : i.assigneeIds.includes(a === "me" ? (meId ?? "") : a),
    );
    if (!ok) return false;
  }
  if (f.label?.length && !f.label.some((l) => i.labelIds.includes(l))) return false;
  for (const spec of f.field ?? []) {
    const at = spec.indexOf(":");
    const v = i.fields[spec.slice(0, at)];
    const want = spec.slice(at + 1);
    const empty = v === undefined || v === null || (Array.isArray(v) && v.length === 0);
    if (want === "none" ? !empty : empty || !(Array.isArray(v) ? v.map(String).includes(want) : String(v) === want)) return false;
  }
  if (f.cycle === "none" && i.cycleId) return false;
  if (f.cycle && f.cycle !== "none" && f.cycle !== "active" && i.cycleId !== f.cycle) return false;
  if (f.q) return false;
  return true;
}

/** Applies a fields patch: null or empty clears a value. */
export function mergeFieldValues(cur: Record<string, unknown>, patch: Record<string, unknown>): Record<string, unknown> {
  const out = { ...cur };
  for (const [k, v] of Object.entries(patch)) {
    if (v === null || v === undefined || v === "" || (Array.isArray(v) && v.length === 0)) delete out[k];
    else out[k] = v;
  }
  return out;
}

async function cancelIssueQueries(qc: QueryClient, slug: string) {
  await qc.cancelQueries({ queryKey: keys.issuesAll(slug) });
  await qc.cancelQueries({ queryKey: keys.issueAll(slug) });
}

function patchEverywhere(qc: QueryClient, slug: string, id: string, fn: (i: Issue) => Issue) {
  qc.setQueriesData<ListData>({ queryKey: keys.issuesAll(slug) }, (d) =>
    d ? { ...d, issues: d.issues.map((i) => (i.id === id ? fn(i) : i)) } : d,
  );
  qc.setQueriesData<IssueDetail>({ queryKey: keys.issueAll(slug) }, (d) => {
    if (!d) return d;
    if (d.id === id) return { ...d, ...fn(d) };
    if (d.children.some((c) => c.id === id)) {
      return {
        ...d,
        children: d.children.map((c) => {
          if (c.id !== id) return c;
          const n = fn({ ...(c as unknown as Issue) });
          return { ...c, statusId: n.statusId, title: n.title, assigneeIds: n.assigneeIds };
        }),
      };
    }
    return d;
  });
}

function settle(qc: QueryClient, slug: string, id?: string) {
  qc.invalidateQueries({ queryKey: keys.issuesAll(slug) });
  qc.invalidateQueries({ queryKey: keys.issueAll(slug) });
  if (id) qc.invalidateQueries({ queryKey: keys.activity(slug, id) });
}

export function useUpdateIssue(slug: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ issue, patch }: { issue: Pick<Issue, "id">; patch: IssuePatch }) => api.ws(slug).updateIssue(issue.id, patch),
    onMutate: async ({ issue, patch }) => {
      await cancelIssueQueries(qc, slug);
      const snap = snapshot(qc, slug);
      patchEverywhere(qc, slug, issue.id, (i) => ({
        ...i,
        ...(patch as Partial<Issue>),
        priority: (patch.priority ?? i.priority) as Priority,
        fields: patch.fields ? mergeFieldValues(i.fields ?? {}, patch.fields) : i.fields,
        updatedAt: new Date().toISOString(),
      }));
      return { snap };
    },
    onError: (e, _v, ctx) => {
      restore(qc, ctx?.snap);
      toastError(errorMessage(e));
    },
    onSettled: (_d, _e, v) => settle(qc, slug, v.issue.id),
  });
}

export interface MoveVars {
  issue: Issue;
  statusId: string;
  afterId: string | null;
  beforeId: string | null;
  sortKey: string;
}

export function useMoveIssue(slug: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ issue, statusId, afterId, beforeId }: MoveVars) => api.ws(slug).moveIssue(issue.id, { statusId, afterId, beforeId }),
    onMutate: async ({ issue, statusId, sortKey }) => {
      await cancelIssueQueries(qc, slug);
      const snap = snapshot(qc, slug);
      patchEverywhere(qc, slug, issue.id, (i) => ({ ...i, statusId, sortKey }));
      // Keep manual-order lists sorted by the new key.
      qc.setQueriesData<ListData>({ queryKey: keys.issuesAll(slug) }, (d) => {
        if (!d) return d;
        return { ...d, issues: [...d.issues].sort((a, b) => (a.sortKey < b.sortKey ? -1 : a.sortKey > b.sortKey ? 1 : 0)) };
      });
      return { snap };
    },
    onError: (e, _v, ctx) => {
      restore(qc, ctx?.snap);
      toastError(`Could not move the issue. ${errorMessage(e)}`);
    },
    onSettled: (_d, _e, v) => settle(qc, slug, v.issue.id),
  });
}

export function useCreateIssue(slug: string, meId: string | undefined) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (b: IssueCreate) => api.ws(slug).createIssue(b),
    onMutate: async (b) => {
      await qc.cancelQueries({ queryKey: keys.issuesAll(slug) });
      const snap = snapshot(qc, slug);
      if (!b.statusId) return { snap };
      const now = new Date().toISOString();
      const temp: Issue = {
        id: `temp-${Math.random().toString(36).slice(2)}`,
        teamId: b.teamId,
        number: 0,
        identifier: "...",
        title: b.title,
        description: b.description ?? "",
        statusId: b.statusId,
        priority: (b.priority ?? 0) as Priority,
        assigneeIds: b.assigneeIds ?? [],
        fields: mergeFieldValues({}, b.fields ?? {}),
        creatorId: meId ?? "",
        parentId: b.parentId ?? null,
        cycleId: b.cycleId ?? null,
        dueDate: b.dueDate ?? null,
        estimate: b.estimate ?? null,
        sortKey: "zzzzzz",
        labelIds: b.labelIds ?? [],
        createdAt: now,
        updatedAt: now,
        completedAt: null,
        archivedAt: null,
      };
      for (const [key] of qc.getQueriesData<ListData>({ queryKey: keys.issuesAll(slug) })) {
        const f = (key[2] ?? {}) as ListFilter;
        if (!matchesFilter(temp, f, meId)) continue;
        qc.setQueryData<ListData>(key, (d) => (d ? { ...d, issues: [...d.issues, temp] } : d));
      }
      return { snap };
    },
    onError: (e, _v, ctx) => {
      restore(qc, ctx?.snap);
      toastError(errorMessage(e));
    },
    onSettled: () => settle(qc, slug),
  });
}

export function useArchiveIssue(slug: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ issue, archived }: { issue: Pick<Issue, "id">; archived: boolean }) => api.ws(slug).archiveIssue(issue.id, archived),
    onMutate: async ({ issue, archived }) => {
      await cancelIssueQueries(qc, slug);
      const snap = snapshot(qc, slug);
      const at = archived ? new Date().toISOString() : null;
      patchEverywhere(qc, slug, issue.id, (i) => ({ ...i, archivedAt: at }));
      if (archived) {
        for (const [key] of qc.getQueriesData<ListData>({ queryKey: keys.issuesAll(slug) })) {
          const f = (key[2] ?? {}) as ListFilter;
          if (f.includeArchived) continue;
          qc.setQueryData<ListData>(key, (d) => (d ? { ...d, issues: d.issues.filter((i) => i.id !== issue.id) } : d));
        }
      }
      return { snap };
    },
    onError: (e, _v, ctx) => {
      restore(qc, ctx?.snap);
      toastError(errorMessage(e));
    },
    onSettled: (_d, _e, v) => settle(qc, slug, v.issue.id),
  });
}

export function useDeleteIssue(slug: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (issue: Pick<Issue, "id">) => api.ws(slug).deleteIssue(issue.id),
    onMutate: async (issue) => {
      await qc.cancelQueries({ queryKey: keys.issuesAll(slug) });
      const snap = snapshot(qc, slug);
      qc.setQueriesData<ListData>({ queryKey: keys.issuesAll(slug) }, (d) =>
        d ? { ...d, issues: d.issues.filter((i) => i.id !== issue.id) } : d,
      );
      return { snap };
    },
    onError: (e, _v, ctx) => {
      restore(qc, ctx?.snap);
      toastError(errorMessage(e));
    },
    onSettled: () => qc.invalidateQueries({ queryKey: keys.issuesAll(slug) }),
  });
}
