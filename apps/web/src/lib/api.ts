import type {
  Activity,
  Comment,
  Cycle,
  ExportJob,
  Invite,
  Issue,
  IssueDetail,
  IssueFilter,
  Label,
  Me,
  Member,
  Notification,
  NotificationSettings,
  Role,
  SavedView,
  SearchResult,
  StateCategory,
  Team,
  Workspace,
  WorkflowState,
} from "@tracker/shared";
import { setReadOnly } from "./store";

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
  }
}

const BASE = "/api/v1";

export async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(BASE + path, {
      method,
      credentials: "same-origin",
      headers: body === undefined ? { Accept: "application/json" } : { "Content-Type": "application/json", Accept: "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new ApiError(0, "network", "Could not reach the server. Check your connection.");
  }
  if (!res.ok) {
    let code = "error";
    let message = `Request failed (${res.status})`;
    try {
      const j = (await res.json()) as { error?: { code?: string; message?: string } };
      if (j.error?.code) code = j.error.code;
      if (j.error?.message) message = j.error.message;
    } catch {
      // not JSON
    }
    if (res.status === 402 && code === "read_only") setReadOnly(true);
    throw new ApiError(res.status, code, message);
  }
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  return (text ? JSON.parse(text) : undefined) as T;
}

const get = <T>(p: string) => request<T>("GET", p);
const post = <T>(p: string, b: unknown = {}) => request<T>("POST", p, b);
const patch = <T>(p: string, b: unknown) => request<T>("PATCH", p, b);
const put = <T>(p: string, b: unknown) => request<T>("PUT", p, b);
const del = <T>(p: string, b?: unknown) => request<T>("DELETE", p, b);

const enc = encodeURIComponent;

export function filterToQuery(f: IssueFilter & { order?: string; limit?: number }): string {
  const p = new URLSearchParams();
  if (f.team) p.set("team", f.team);
  if (f.status?.length) p.set("status", f.status.join(","));
  if (f.assignee?.length) p.set("assignee", f.assignee.join(","));
  if (f.label?.length) p.set("label", f.label.join(","));
  if (f.priority?.length) p.set("priority", f.priority.join(","));
  if (f.cycle) p.set("cycle", f.cycle);
  if (f.q) p.set("q", f.q);
  if (f.parent) p.set("parent", f.parent);
  if (f.includeArchived) p.set("includeArchived", "true");
  if (f.order) p.set("order", f.order);
  p.set("limit", String(f.limit ?? 500));
  return p.toString();
}

export type IssueCreate = {
  teamId: string;
  title: string;
  description?: string;
  statusId?: string;
  priority?: number;
  assigneeId?: string | null;
  labelIds?: string[];
  dueDate?: string | null;
  estimate?: number | null;
  parentId?: string | null;
  cycleId?: string | null;
};
export type IssuePatch = Partial<Omit<IssueCreate, "teamId">>;

export const api = {
  providers: () => get<{ google: boolean; github: boolean; magicLink: boolean }>("/auth/providers"),
  magicLink: (email: string, redirectTo?: string) => post<{ ok: true }>("/auth/magic-link", { email, redirectTo }),
  verifyMagicLink: (token: string) => post<{ redirectTo: string }>("/auth/magic-link/verify", { token }),
  logout: () => post<{ ok: true }>("/auth/logout"),

  me: () => get<Me>("/me"),
  updateMe: (name: string) => patch<{ ok: true }>("/me", { name }),
  createWorkspace: (name: string, slug: string) => post<{ id: string; slug: string; name: string }>("/workspaces", { name, slug }),
  invitePreview: (token: string) => get<{ workspaceName: string; slug: string; role: Role }>(`/invites/${enc(token)}`),
  acceptInvite: (token: string) => post<{ slug: string }>(`/invites/${enc(token)}/accept`),

  ws: (slug: string) => {
    const w = `/w/${enc(slug)}`;
    return {
      get: () => get<Workspace>(w),
      rename: (name: string) => patch<Workspace>(w, { name }),
      remove: (confirm: string) => del<{ ok: true }>(w, { confirm }),

      members: () => get<Member[]>(`${w}/members`),
      setRole: (userId: string, role: Role) => patch<{ ok: true }>(`${w}/members/${userId}`, { role }),
      removeMember: (userId: string) => del<{ ok: true }>(`${w}/members/${userId}`),

      invites: () => get<Invite[]>(`${w}/invites`),
      createInvite: (email: string | undefined, role: Role) => post<Invite>(`${w}/invites`, { email, role }),
      revokeInvite: (id: string) => del<{ ok: true }>(`${w}/invites/${id}`),

      teams: () => get<Team[]>(`${w}/teams`),
      createTeam: (name: string, key: string) => post<Team>(`${w}/teams`, { name, key }),
      updateTeam: (id: string, b: { name?: string; key?: string }) => patch<Team>(`${w}/teams/${id}`, b),
      archiveTeam: (id: string) => del<{ ok: true }>(`${w}/teams/${id}`),
      teamMembers: (teamId: string) => get<string[]>(`${w}/teams/${teamId}/members`),
      addTeamMember: (teamId: string, userId: string) => put<{ ok: true }>(`${w}/teams/${teamId}/members/${userId}`, {}),
      removeTeamMember: (teamId: string, userId: string) => del<{ ok: true }>(`${w}/teams/${teamId}/members/${userId}`),

      states: () => get<WorkflowState[]>(`${w}/states`),
      createState: (teamId: string, b: { name: string; category: StateCategory; color: string; position?: number }) =>
        post<WorkflowState>(`${w}/teams/${teamId}/states`, b),
      updateState: (id: string, b: Partial<{ name: string; category: StateCategory; color: string; position: number }>) =>
        patch<WorkflowState>(`${w}/states/${id}`, b),
      deleteState: (id: string, moveTo: string) => del<{ ok: true }>(`${w}/states/${id}`, { moveTo }),

      labels: () => get<Label[]>(`${w}/labels`),
      createLabel: (b: { name: string; color: string; teamId?: string | null }) => post<Label>(`${w}/labels`, b),
      updateLabel: (id: string, b: { name?: string; color?: string }) => patch<Label>(`${w}/labels/${id}`, b),
      deleteLabel: (id: string) => del<{ ok: true }>(`${w}/labels/${id}`),

      cycles: () => get<Cycle[]>(`${w}/cycles`),
      createCycle: (teamId: string, b: { name?: string; startsOn: string; endsOn: string }) =>
        post<Cycle>(`${w}/teams/${teamId}/cycles`, b),
      updateCycle: (id: string, b: { name?: string; startsOn?: string; endsOn?: string; completed?: boolean }) =>
        patch<Cycle>(`${w}/cycles/${id}`, b),
      deleteCycle: (id: string) => del<{ ok: true }>(`${w}/cycles/${id}`),

      issues: (f: IssueFilter & { order?: string; limit?: number }) =>
        get<{ issues: Issue[]; hasMore: boolean }>(`${w}/issues?${filterToQuery(f)}`),
      createIssue: (b: IssueCreate) => post<Issue>(`${w}/issues`, b),
      issue: (ref: string) => get<IssueDetail>(`${w}/issues/${enc(ref)}`),
      updateIssue: (ref: string, b: IssuePatch) => patch<Issue>(`${w}/issues/${enc(ref)}`, b),
      moveIssue: (ref: string, b: { statusId?: string; afterId?: string | null; beforeId?: string | null }) =>
        post<Issue>(`${w}/issues/${enc(ref)}/move`, b),
      archiveIssue: (ref: string, archived: boolean) => post<Issue>(`${w}/issues/${enc(ref)}/archive`, { archived }),
      deleteIssue: (ref: string) => del<{ ok: true }>(`${w}/issues/${enc(ref)}`),
      addRelation: (ref: string, relatedIssueId: string, type: string) =>
        post<{ id: string }>(`${w}/issues/${enc(ref)}/relations`, { relatedIssueId, type }),
      removeRelation: (ref: string, id: string) => del<{ ok: true }>(`${w}/issues/${enc(ref)}/relations/${id}`),
      subscribe: (ref: string, subscribed: boolean) => put<{ subscribed: boolean }>(`${w}/issues/${enc(ref)}/subscription`, { subscribed }),
      activity: (ref: string) => get<Activity[]>(`${w}/issues/${enc(ref)}/activity`),
      search: (q: string) => get<SearchResult>(`${w}/search?q=${enc(q)}`),

      comments: (ref: string) => get<Comment[]>(`${w}/issues/${enc(ref)}/comments`),
      addComment: (ref: string, body: string) => post<Comment>(`${w}/issues/${enc(ref)}/comments`, { body }),
      editComment: (id: string, body: string) => patch<Comment>(`${w}/comments/${id}`, { body }),
      deleteComment: (id: string) => del<{ ok: true }>(`${w}/comments/${id}`),

      startAttachment: (ref: string, b: { filename: string; contentType: string; size: number }) =>
        post<{ id: string; upload: { method: string; url: string; headers: Record<string, string> } }>(
          `${w}/issues/${enc(ref)}/attachments`,
          b,
        ),
      completeAttachment: (id: string) => post<{ ok: true }>(`${w}/attachments/${id}/complete`),
      deleteAttachment: (id: string) => del<{ ok: true }>(`${w}/attachments/${id}`),

      views: () => get<SavedView[]>(`${w}/views`),
      createView: (b: { name: string; teamId?: string | null; shared: boolean; layout: "list" | "board"; filters: IssueFilter }) =>
        post<SavedView>(`${w}/views`, b),
      updateView: (id: string, b: Partial<{ name: string; shared: boolean; layout: "list" | "board"; filters: IssueFilter }>) =>
        patch<SavedView>(`${w}/views/${id}`, b),
      deleteView: (id: string) => del<{ ok: true }>(`${w}/views/${id}`),

      notifications: () => get<Notification[]>(`${w}/notifications`),
      unreadCount: () => get<{ count: number }>(`${w}/notifications/unread-count`),
      markRead: (b: { ids?: string[]; all?: boolean; unread?: boolean }) => post<{ ok: true }>(`${w}/notifications/read`, b),
      notificationSettings: () => get<NotificationSettings>(`${w}/notification-settings`),
      saveNotificationSettings: (b: NotificationSettings) => put<NotificationSettings>(`${w}/notification-settings`, b),

      exports: () => get<ExportJob[]>(`${w}/exports`),
      startExport: () => post<ExportJob>(`${w}/exports`),
      exportJob: (id: string) => get<ExportJob>(`${w}/exports/${id}`),
    };
  },
};

/** Uploads one file with the presigned flow. */
export async function uploadAttachment(slug: string, ref: string, file: File): Promise<void> {
  const w = api.ws(slug);
  const contentType = file.type || "application/octet-stream";
  const { id, upload } = await w.startAttachment(ref, { filename: file.name, contentType, size: file.size });
  let res: Response;
  try {
    res = await fetch(upload.url, { method: upload.method || "PUT", headers: upload.headers, body: file, credentials: "same-origin" });
  } catch {
    throw new ApiError(0, "network", "Upload failed. Check your connection.");
  }
  if (!res.ok) throw new ApiError(res.status, "upload_failed", `Upload failed (${res.status})`);
  await w.completeAttachment(id);
}

export function errorMessage(e: unknown): string {
  if (e instanceof ApiError) return e.message;
  if (e instanceof Error) return e.message;
  return "Something went wrong";
}
