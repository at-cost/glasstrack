import type {
  Activity,
  AutomationRule,
  AuditEntry,
  Comment,
  CustomField,
  Cycle,
  ExportJob,
  Invite,
  Issue,
  IssueDetail,
  IssueFilter,
  GitIntegration,
  GitProvider,
  IntakeChannel,
  IssueTemplate,
  Label,
  Me,
  Member,
  Notification,
  NotificationSettings,
  PublicForm,
  RecurringIssue,
  Role,
  SavedView,
  SearchResult,
  SsoConfig,
  StateCategory,
  Team,
  TimeEntry,
  Workspace,
  WorkflowState,
} from "@glasstrack/shared";
import { setReadOnly, ssoRequiredStore } from "./store";
import { toastError } from "./toast";

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
    // Viewers are read-only; a write that slips past the hidden controls gets the server's own words.
    if (res.status === 403 && code === "read_only_viewer") toastError(message);
    if (res.status === 403 && code === "sso_required") {
      const m = /^\/w\/([^/?]+)/.exec(path);
      if (m) ssoRequiredStore.set(decodeURIComponent(m[1]!));
    }
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
  for (const spec of f.field ?? []) p.append("field", spec);
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
  assigneeIds?: string[];
  /** Custom field values by field id; null clears a value. */
  fields?: Record<string, unknown>;
  templateId?: string;
  labelIds?: string[];
  startDate?: string | null;
  dueDate?: string | null;
  estimate?: number | null;
  parentId?: string | null;
  cycleId?: string | null;
};
export type IssuePatch = Partial<Omit<IssueCreate, "teamId" | "templateId">>;

export type CustomFieldInput = { name: string; type: CustomField["type"]; teamId?: string | null; options: CustomField["options"] };
export type TemplateInput = Omit<IssueTemplate, "id">;
export type RecurringInput = Omit<RecurringIssue, "id" | "nextRunAt" | "lastRunAt" | "lastIssueId">;

export interface RunningTimer {
  issueId: string;
  identifier: string;
  title: string;
  startedAt: string;
}
export interface TimeReport {
  totalMinutes: number;
  byUser: { userId: string | null; minutes: number }[];
  byIssue: { issueId: string; identifier: string; title: string; minutes: number }[];
  entries: (TimeEntry & { identifier: string; title: string })[];
  truncated: boolean;
}
export type SsoSettings = SsoConfig | { enabled: false; callbackUrl: string };
export interface SsoInput {
  issuer: string;
  clientId: string;
  clientSecret?: string;
  allowedDomains: string[];
  autoJoinRole: "member" | "guest" | null;
  enforce: boolean;
  enabled: boolean;
}

export interface LedgerEntry {
  id: string;
  kind: "starter_grant" | "topup" | "charge" | "storage_charge" | "refund" | "adjustment" | string;
  amountMicro: number;
  memo: string | null;
  /** Day a daily charge covers (YYYY-MM-DD); null for other entries. */
  day: string | null;
  createdAt: string;
}
export interface PaymentRow {
  id: string;
  kind: "topup" | "auto_topup" | string;
  amountMicro: number;
  feeMicro: number | null;
  status: string;
  createdAt: string;
}
export type Billing =
  | { enabled: false }
  | {
      enabled: true;
      status: "active" | "grace" | "read_only" | "deleting";
      balanceMicro: number;
      monthlyPriceMicro: number;
      dailyChargeMicro: number;
      daysRemaining: number | null;
      storage: { bytes: number; freeBytes: number; overageDailyMicro: number; ratePerGbMonthMicro: number };
      card: string | null;
      graceStartedAt: string | null;
      autoTopup: { enabled: boolean; thresholdMicro: number; amountMicro: number };
      limits: { minTopupMicro: number; maxTopupMicro: number };
      ledger: LedgerEntry[];
      payments: PaymentRow[];
    };
export type BillingOn = Extract<Billing, { enabled: true }>;

export interface ApiToken {
  id: string;
  name: string;
  tokenPrefix: string;
  createdAt: string;
  lastUsedAt: string | null;
  expiresAt: string | null;
}

export const WEBHOOK_EVENTS = ["issue.created", "issue.updated", "issue.deleted", "comment.created"] as const;
export type WebhookEvent = (typeof WEBHOOK_EVENTS)[number];
export interface Webhook {
  id: string;
  url: string;
  events: WebhookEvent[];
  active: boolean;
  consecutiveFailures?: number;
  createdAt?: string;
  secret: string;
}
export interface WebhookDelivery {
  id: string;
  event: string;
  status: "pending" | "succeeded" | "failed" | string;
  attempts: number;
  responseStatus: number | null;
  error: string | null;
  createdAt: string;
  deliveredAt: string | null;
}

export type ImportSource = "linear" | "jira" | "trello";
export interface ImportSummary {
  issues: number;
  comments: number;
  labelsCreated: string[];
  statusesCreated: string[];
  unmatchedAssignees: string[];
  dryRun: boolean;
}

export interface GithubIntegration {
  enabled: boolean;
  webhookUrl: string;
  secret?: string;
  moveOnMerge?: boolean;
}

export type IntakeInput = {
  teamId: string;
  kind: IntakeChannel["kind"];
  name: string;
  intro?: string;
  enabled?: boolean;
  statusId?: string | null;
  labelIds?: string[];
  requireEmail?: boolean;
  membersOnly?: boolean;
  notifySubmitter?: boolean;
};
export type IntakePatch = Partial<Omit<IntakeInput, "kind">> & { rotateToken?: boolean };
export type FormSubmission = { title: string; description: string; email?: string; name?: string; website: string };

export interface RelationLink {
  id: string;
  /** The blocker. */
  issueId: string;
  /** The blocked issue. */
  relatedIssueId: string;
  type: string;
}

export interface Percentiles {
  p50: number | null;
  p75: number | null;
  p90: number | null;
}
export interface ReportOverview {
  completed: number;
  cycleTimeHours: Percentiles;
  leadTimeHours: Percentiles;
  cycleTimeHistogram: { bucket: string; count: number }[];
  weekly: { week: string; created: number; completed: number; open: number }[];
  byAssignee: { userId: string | null; completed: number }[];
  byLabel: { labelId: string; completed: number }[];
}
export interface CycleReport {
  cycle: { id: string; teamId: string; number: number; name: string | null; startsOn: string; endsOn: string; completedAt: string | null };
  unit: "points" | "issues";
  totalDays: number;
  days: { day: string; scope: number; completed: number; remaining: number; ideal: number }[];
}

export type AutomationInput = Pick<AutomationRule, "name" | "teamId" | "enabled" | "trigger" | "triggerConfig" | "conditions" | "actions">;
export interface AutomationRun {
  id: string;
  status: "ok" | "error";
  detail: { changed?: string[]; error?: string } | null;
  createdAt: string;
  issueId: string | null;
  identifier: string | null;
}

export interface FinanceDay {
  day: string;
  revenueMicro: number;
  starterCreditUsedMicro: number;
  costs: Record<string, number>;
  paymentFeesMicro: number;
  totalCostMicro: number;
  activeWorkspaces: number;
  payingWorkspaces: number;
  costPerWorkspaceMicro: number;
  reserveMicro: number;
  reserveTargetMicro: number;
  priceMicro: number;
  recommendedPriceMicro: number | null;
  marginBp: number;
}
export interface PublicFinances {
  currency: string;
  currentPriceMicro: number;
  latest: FinanceDay | null;
  formula: { allocation: string; price: string };
  priceHistory: { from: string; monthlyPriceMicro: number; reason: string }[];
  history: FinanceDay[];
}
export type CostCategory = "infrastructure" | "email" | "storage" | "domain" | "tools" | "ai" | "other";
export interface CostEntry {
  id: string;
  periodStart: string;
  periodEnd: string;
  category: CostCategory;
  source: "aws" | "manual";
  amountMicro: number;
  publicLabel: string;
  note: string | null;
  createdAt: string;
}
export interface CostInput {
  periodStart: string;
  periodEnd: string;
  category: CostCategory;
  amountUsd: number;
  publicLabel?: string;
  note?: string;
}
export interface AdminOverview {
  currentPriceMicro: number;
  latest: FinanceDay | null;
  canLower: boolean;
  awsConfigured: boolean;
  categories: Record<string, string>;
  costs: CostEntry[];
  pricing: { id: string | number; effectiveFrom: string; monthlyPriceMicro: number; reason: string; createdBy: string | null }[];
  history: FinanceDay[];
}

export const api = {
  publicFinances: (days = 365) => get<PublicFinances>(`/public/finances?days=${days}`),
  publicForm: (token: string) => get<PublicForm>(`/forms/${enc(token)}`),
  submitForm: (token: string, b: FormSubmission) => post<{ ok: true }>(`/forms/${enc(token)}`, b),
  admin: {
    me: () => get<{ operator: boolean }>("/admin/me"),
    overview: () => get<AdminOverview>("/admin/overview"),
    addCost: (b: CostInput) => post<{ id: string }>("/admin/costs", b),
    updateCost: (id: string, b: CostInput) => patch<{ ok: true }>(`/admin/costs/${id}`, b),
    deleteCost: (id: string) => del<{ ok: true }>(`/admin/costs/${id}`),
    recompute: (from: string, to?: string) => post<{ days: number }>("/admin/finances/recompute", { from, to }),
    lowerPrice: (monthlyUsd: number, reason: string) => post<{ monthlyPriceMicro: number }>("/admin/pricing/lower", { monthlyUsd, reason }),
  },

  providers: () => get<{ google: boolean; github: boolean; magicLink: boolean }>("/auth/providers"),
  magicLink: (email: string, redirectTo?: string) => post<{ ok: true }>("/auth/magic-link", { email, redirectTo }),
  verifyMagicLink: (token: string) => post<{ redirectTo: string }>("/auth/magic-link/verify", { token }),
  logout: () => post<{ ok: true }>("/auth/logout"),
  ssoDiscover: (email: string) => post<{ workspaces: { slug: string; name: string }[] }>("/auth/sso/discover", { email }),

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
      createTeam: (name: string, key: string, isPrivate = false) => post<Team>(`${w}/teams`, { name, key, private: isPrivate }),
      updateTeam: (id: string, b: { name?: string; key?: string; private?: boolean }) => patch<Team>(`${w}/teams/${id}`, b),
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
      relations: (teamId: string, type = "blocks") => get<RelationLink[]>(`${w}/relations?team=${enc(teamId)}&type=${enc(type)}`),

      reportOverview: (q: { from: string; to: string; team?: string }) => {
        const p = new URLSearchParams({ from: q.from, to: q.to });
        if (q.team) p.set("team", q.team);
        return get<ReportOverview>(`${w}/reports/overview?${p}`);
      },
      cycleReport: (id: string) => get<CycleReport>(`${w}/reports/cycles/${enc(id)}`),

      automations: () => get<AutomationRule[]>(`${w}/automations`),
      createAutomation: (b: AutomationInput) => post<AutomationRule>(`${w}/automations`, b),
      updateAutomation: (id: string, b: Partial<AutomationInput>) => patch<AutomationRule>(`${w}/automations/${id}`, b),
      deleteAutomation: (id: string) => del<{ ok: true }>(`${w}/automations/${id}`),
      automationRuns: (id: string) => get<AutomationRun[]>(`${w}/automations/${id}/runs`),

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

      billing: () => get<Billing>(`${w}/billing`),
      topup: (amountUsd: number, saveCard: boolean) => post<{ url: string }>(`${w}/billing/topup`, { amountUsd, saveCard }),
      autoTopup: (b: { enabled: boolean; thresholdUsd: number; amountUsd: number }) => put<{ ok: true }>(`${w}/billing/auto-topup`, b),

      tokens: () => get<ApiToken[]>(`${w}/tokens`),
      createToken: (name: string, expiresInDays: number | null) =>
        post<{ id: string; name: string; token: string; expiresAt: string | null }>(`${w}/tokens`, { name, expiresInDays }),
      revokeToken: (id: string) => del<{ ok: true }>(`${w}/tokens/${id}`),

      webhooks: () => get<Webhook[]>(`${w}/webhooks`),
      createWebhook: (b: { url: string; events: WebhookEvent[]; active: boolean }) => post<Webhook>(`${w}/webhooks`, b),
      updateWebhook: (id: string, b: Partial<{ url: string; events: WebhookEvent[]; active: boolean }>) =>
        patch<{ ok: true }>(`${w}/webhooks/${id}`, b),
      deleteWebhook: (id: string) => del<{ ok: true }>(`${w}/webhooks/${id}`),
      deliveries: (id: string) => get<WebhookDelivery[]>(`${w}/webhooks/${id}/deliveries`),

      runImport: (b: { source: ImportSource; teamId: string; content: string; dryRun: boolean }) => post<ImportSummary>(`${w}/import`, b),

      github: () => get<GithubIntegration>(`${w}/integrations/github`),
      saveGithub: (b: { moveOnMerge: boolean; rotateSecret?: boolean }) => put<GithubIntegration>(`${w}/integrations/github`, b),
      disableGithub: () => del<{ ok: true }>(`${w}/integrations/github`),
      gitForge: (p: GitProvider) => get<GitIntegration>(`${w}/integrations/${p}`),
      saveGitForge: (p: GitProvider, b: { moveOnMerge: boolean; rotateSecret?: boolean }) => put<GitIntegration>(`${w}/integrations/${p}`, b),
      disableGitForge: (p: GitProvider) => del<{ ok: true }>(`${w}/integrations/${p}`),

      intake: () => get<IntakeChannel[]>(`${w}/intake`),
      createIntake: (b: IntakeInput) => post<IntakeChannel>(`${w}/intake`, b),
      updateIntake: (id: string, b: IntakePatch) => patch<IntakeChannel>(`${w}/intake/${id}`, b),
      deleteIntake: (id: string) => del<{ ok: true }>(`${w}/intake/${id}`),

      fields: () => get<CustomField[]>(`${w}/fields`),
      createField: (b: CustomFieldInput) => post<CustomField>(`${w}/fields`, b),
      updateField: (id: string, b: Partial<Pick<CustomField, "name" | "options" | "position">>) => patch<CustomField>(`${w}/fields/${id}`, b),
      deleteField: (id: string) => del<{ ok: true }>(`${w}/fields/${id}`),

      timeEntries: (ref: string) => get<TimeEntry[]>(`${w}/issues/${enc(ref)}/time`),
      logTime: (ref: string, b: { minutes: number; spentOn: string; note?: string }) => post<TimeEntry>(`${w}/issues/${enc(ref)}/time`, b),
      updateTime: (id: string, b: Partial<{ minutes: number; spentOn: string; note: string }>) => patch<TimeEntry>(`${w}/time/${id}`, b),
      deleteTime: (id: string) => del<{ ok: true }>(`${w}/time/${id}`),
      timer: () => get<RunningTimer | null>(`${w}/timer`),
      startTimer: (ref: string) => post<{ started: true; stopped: TimeEntry | null }>(`${w}/issues/${enc(ref)}/timer/start`),
      stopTimer: () => post<TimeEntry>(`${w}/timer/stop`),
      timeReport: (q: { from: string; to: string; team?: string; user?: string }) => {
        const p = new URLSearchParams({ from: q.from, to: q.to });
        if (q.team) p.set("team", q.team);
        if (q.user) p.set("user", q.user);
        return get<TimeReport>(`${w}/time?${p}`);
      },

      templates: () => get<IssueTemplate[]>(`${w}/templates`),
      createTemplate: (b: TemplateInput) => post<IssueTemplate>(`${w}/templates`, b),
      updateTemplate: (id: string, b: Partial<Omit<TemplateInput, "teamId">>) => patch<IssueTemplate>(`${w}/templates/${id}`, b),
      deleteTemplate: (id: string) => del<{ ok: true }>(`${w}/templates/${id}`),
      recurring: () => get<RecurringIssue[]>(`${w}/recurring`),
      createRecurring: (b: RecurringInput) => post<RecurringIssue>(`${w}/recurring`, b),
      updateRecurring: (id: string, b: Partial<Omit<RecurringInput, "templateId">>) => patch<RecurringIssue>(`${w}/recurring/${id}`, b),
      deleteRecurring: (id: string) => del<{ ok: true }>(`${w}/recurring/${id}`),

      audit: (q: { before?: string; action?: string }) => {
        const p = new URLSearchParams();
        if (q.before) p.set("before", q.before);
        if (q.action) p.set("action", q.action);
        const qs = p.toString();
        return get<{ entries: AuditEntry[]; next: string | null }>(`${w}/audit${qs ? `?${qs}` : ""}`);
      },
      auditCsvUrl: () => `${BASE}${w}/audit.csv`,

      sso: () => get<SsoSettings>(`${w}/sso`),
      saveSso: (b: SsoInput) => put<SsoSettings>(`${w}/sso`, b),
      removeSso: () => del<{ ok: true }>(`${w}/sso`),
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
