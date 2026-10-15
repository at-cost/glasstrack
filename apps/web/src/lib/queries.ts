import { type QueryClient, queryOptions, useQuery } from "@tanstack/react-query";
import type { IssueFilter } from "@glasstrack/shared";
import { api } from "./api";

export type ListFilter = IssueFilter & { order?: string };

export const keys = {
  me: ["me"] as const,
  ws: (slug: string) => ["ws", slug] as const,
  members: (slug: string) => ["members", slug] as const,
  teams: (slug: string) => ["teams", slug] as const,
  states: (slug: string) => ["states", slug] as const,
  labels: (slug: string) => ["labels", slug] as const,
  cycles: (slug: string) => ["cycles", slug] as const,
  views: (slug: string) => ["views", slug] as const,
  issuesAll: (slug: string) => ["issues", slug] as const,
  issues: (slug: string, f: ListFilter) => ["issues", slug, f] as const,
  issueAll: (slug: string) => ["issue", slug] as const,
  issue: (slug: string, ref: string) => ["issue", slug, ref] as const,
  comments: (slug: string, issueId: string) => ["comments", slug, issueId] as const,
  activity: (slug: string, issueId: string) => ["activity", slug, issueId] as const,
  notifications: (slug: string) => ["notifications", slug] as const,
  unread: (slug: string) => ["unread", slug] as const,
  notifSettings: (slug: string) => ["notif-settings", slug] as const,
  invites: (slug: string) => ["invites", slug] as const,
  exports: (slug: string) => ["exports", slug] as const,
  teamMembers: (slug: string, teamId: string) => ["team-members", slug, teamId] as const,
  billing: (slug: string) => ["billing", slug] as const,
  tokens: (slug: string) => ["tokens", slug] as const,
  webhooks: (slug: string) => ["webhooks", slug] as const,
  deliveries: (slug: string, id: string) => ["deliveries", slug, id] as const,
  github: (slug: string) => ["github", slug] as const,
  fields: (slug: string) => ["fields", slug] as const,
  templates: (slug: string) => ["templates", slug] as const,
  recurring: (slug: string) => ["recurring", slug] as const,
  timer: (slug: string) => ["timer", slug] as const,
  timeEntries: (slug: string, issueId: string) => ["time-entries", slug, issueId] as const,
  timeReportAll: (slug: string) => ["time-report", slug] as const,
  audit: (slug: string, action: string) => ["audit", slug, action] as const,
  sso: (slug: string) => ["sso", slug] as const,
  relations: (slug: string, teamId: string) => ["relations", slug, teamId] as const,
  reportsAll: (slug: string) => ["reports", slug] as const,
  automations: (slug: string) => ["automations", slug] as const,
  automationRuns: (slug: string, id: string) => ["automation-runs", slug, id] as const,
  operator: ["operator"] as const,
  adminOverview: ["admin-overview"] as const,
  publicFinances: ["public-finances"] as const,
};

export const meQuery = queryOptions({ queryKey: keys.me, queryFn: api.me, staleTime: 60_000, retry: false });
export const useMe = () => useQuery(meQuery);

/** Billing summary. `enabled: false` on self-hosted servers. */
export const useBilling = (slug: string) =>
  useQuery({ queryKey: keys.billing(slug), queryFn: () => api.ws(slug).billing(), staleTime: 60_000, retry: false });

/** Whether the signed-in user is a server operator (hosted mode only). */
export const useOperator = () =>
  useQuery({ queryKey: keys.operator, queryFn: () => api.admin.me(), staleTime: 5 * 60_000, retry: false });

export const useWorkspace = (slug: string) => useQuery({ queryKey: keys.ws(slug), queryFn: () => api.ws(slug).get(), retry: false });
export const useMembers = (slug: string) =>
  useQuery({ queryKey: keys.members(slug), queryFn: () => api.ws(slug).members(), staleTime: 60_000 });
export const useTeams = (slug: string) => useQuery({ queryKey: keys.teams(slug), queryFn: () => api.ws(slug).teams(), staleTime: 60_000 });
export const useStates = (slug: string) =>
  useQuery({ queryKey: keys.states(slug), queryFn: () => api.ws(slug).states(), staleTime: 60_000 });
export const useLabels = (slug: string) =>
  useQuery({ queryKey: keys.labels(slug), queryFn: () => api.ws(slug).labels(), staleTime: 60_000 });
export const useCycles = (slug: string) =>
  useQuery({ queryKey: keys.cycles(slug), queryFn: () => api.ws(slug).cycles(), staleTime: 60_000 });
export const useViews = (slug: string) => useQuery({ queryKey: keys.views(slug), queryFn: () => api.ws(slug).views(), staleTime: 60_000 });

export const useFields = (slug: string) =>
  useQuery({ queryKey: keys.fields(slug), queryFn: () => api.ws(slug).fields(), staleTime: 60_000 });
export const useTemplates = (slug: string, enabled = true) =>
  useQuery({ queryKey: keys.templates(slug), queryFn: () => api.ws(slug).templates(), staleTime: 60_000, enabled });
export const useRecurring = (slug: string) =>
  useQuery({ queryKey: keys.recurring(slug), queryFn: () => api.ws(slug).recurring(), staleTime: 30_000 });
/** The signed-in user's running timer in this workspace, if any. */
export const useTimer = (slug: string) =>
  useQuery({ queryKey: keys.timer(slug), queryFn: () => api.ws(slug).timer(), staleTime: 30_000, refetchInterval: 120_000 });
export const useTimeEntries = (slug: string, issueId: string | undefined) =>
  useQuery({ queryKey: keys.timeEntries(slug, issueId ?? ""), queryFn: () => api.ws(slug).timeEntries(issueId!), enabled: Boolean(issueId) });

export const useIssues = (slug: string, f: ListFilter, enabled = true) =>
  useQuery({ queryKey: keys.issues(slug, f), queryFn: () => api.ws(slug).issues(f), enabled });

export const useIssue = (slug: string, ref: string) =>
  useQuery({
    queryKey: keys.issue(slug, ref),
    queryFn: () => api.ws(slug).issue(ref),
    retry: (n, e) => n < 1 && (e as { status?: number }).status !== 404,
  });

export const useComments = (slug: string, issueId: string | undefined) =>
  useQuery({ queryKey: keys.comments(slug, issueId ?? ""), queryFn: () => api.ws(slug).comments(issueId!), enabled: Boolean(issueId) });

export const useActivity = (slug: string, issueId: string | undefined) =>
  useQuery({ queryKey: keys.activity(slug, issueId ?? ""), queryFn: () => api.ws(slug).activity(issueId!), enabled: Boolean(issueId) });

export const useNotifications = (slug: string) =>
  useQuery({ queryKey: keys.notifications(slug), queryFn: () => api.ws(slug).notifications() });

export const useUnreadCount = (slug: string) =>
  useQuery({ queryKey: keys.unread(slug), queryFn: () => api.ws(slug).unreadCount(), refetchInterval: 120_000 });

/** Maps a realtime event batch to cache invalidations. */
export function invalidateFor(qc: QueryClient, slug: string, events: { t: string; id: string; issueId?: string }[]) {
  const done = new Set<string>();
  const once = (k: string, fn: () => void) => {
    if (done.has(k)) return;
    done.add(k);
    fn();
  };
  for (const e of events) {
    switch (e.t) {
      case "issue":
        once("issues", () => qc.invalidateQueries({ queryKey: keys.issuesAll(slug) }));
        once(`issue:${e.id}`, () => {
          qc.invalidateQueries({
            queryKey: keys.issueAll(slug),
            predicate: (q) => {
              const d = q.state.data as
                | { id?: string; children?: { id: string }[]; relations?: { issue: { id: string } }[]; parentId?: string }
                | undefined;
              if (!d) return true;
              return (
                d.id === e.id ||
                d.parentId === e.id ||
                Boolean(d.children?.some((c) => c.id === e.id)) ||
                Boolean(d.relations?.some((r) => r.issue.id === e.id))
              );
            },
          });
          qc.invalidateQueries({ queryKey: keys.activity(slug, e.id) });
          qc.invalidateQueries({ queryKey: keys.timeEntries(slug, e.id) });
          // Automations add comments without a comment event.
          qc.invalidateQueries({ queryKey: keys.comments(slug, e.id) });
        });
        once("timer", () => qc.invalidateQueries({ queryKey: keys.timer(slug) }));
        once("relations", () => qc.invalidateQueries({ queryKey: ["relations", slug] }));
        once("notifications", () => qc.invalidateQueries({ queryKey: keys.notifications(slug) }));
        break;
      case "comment":
        if (e.issueId) {
          once(`comments:${e.issueId}`, () => {
            qc.invalidateQueries({ queryKey: keys.comments(slug, e.issueId!) });
          });
        }
        break;
      case "notification":
        once("notifications", () => qc.invalidateQueries({ queryKey: keys.notifications(slug) }));
        once("unread", () => qc.invalidateQueries({ queryKey: keys.unread(slug) }));
        break;
      case "team":
        once("teams", () => qc.invalidateQueries({ queryKey: keys.teams(slug) }));
        // Custom field changes are announced as team events.
        once("fields", () => qc.invalidateQueries({ queryKey: keys.fields(slug) }));
        break;
      case "state":
        once("states", () => qc.invalidateQueries({ queryKey: keys.states(slug) }));
        once("issues", () => qc.invalidateQueries({ queryKey: keys.issuesAll(slug) }));
        break;
      case "label":
        once("labels", () => qc.invalidateQueries({ queryKey: keys.labels(slug) }));
        break;
      case "cycle":
        once("cycles", () => qc.invalidateQueries({ queryKey: keys.cycles(slug) }));
        break;
      case "view":
        once("views", () => qc.invalidateQueries({ queryKey: keys.views(slug) }));
        break;
      case "member":
        once("members", () => qc.invalidateQueries({ queryKey: keys.members(slug) }));
        once("ws", () => qc.invalidateQueries({ queryKey: keys.ws(slug) }));
        once("me", () => qc.invalidateQueries({ queryKey: keys.me }));
        break;
    }
  }
}
