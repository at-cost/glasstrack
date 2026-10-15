import type { DigestFrequency, NotificationKind, Priority, RelationType, Role, StateCategory } from "./enums";
import type { IssueFilter } from "./schemas";

export interface Me {
  id: string;
  email: string;
  name: string;
  avatarUrl: string | null;
  workspaces: { id: string; slug: string; name: string; role: Role }[];
}
export interface Workspace {
  id: string;
  slug: string;
  name: string;
  status: "active" | "grace" | "read_only" | "deleting";
  role: Role;
}
export interface Member {
  userId: string;
  name: string;
  email: string;
  handle: string;
  avatarUrl: string | null;
  role: Role;
}
export interface Invite {
  id: string;
  email: string | null;
  role: Role;
  createdAt: string;
  expiresAt: string;
  /** Only returned once, at creation time */
  url?: string;
}
export interface Team {
  id: string;
  key: string;
  name: string;
}
export interface WorkflowState {
  id: string;
  teamId: string;
  name: string;
  category: StateCategory;
  color: string;
  position: number;
}
export interface Label {
  id: string;
  teamId: string | null;
  name: string;
  color: string;
}
export interface Cycle {
  id: string;
  teamId: string;
  number: number;
  name: string | null;
  startsOn: string;
  endsOn: string;
  completedAt: string | null;
}
export interface Issue {
  id: string;
  teamId: string;
  number: number;
  identifier: string;
  title: string;
  description: string;
  statusId: string;
  priority: Priority;
  assigneeIds: string[];
  /** Custom field values by field id. */
  fields: Record<string, unknown>;
  creatorId: string;
  parentId: string | null;
  cycleId: string | null;
  dueDate: string | null;
  estimate: number | null;
  sortKey: string;
  labelIds: string[];
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
  archivedAt: string | null;
}
export interface IssueRelation {
  id: string;
  type: RelationType;
  /** "outgoing": this issue blocks/relates to other. "incoming": other blocks this. */
  direction: "outgoing" | "incoming";
  issue: Pick<Issue, "id" | "identifier" | "title" | "statusId">;
}
export interface IssueLink {
  id: string;
  provider: "github";
  url: string;
  title: string;
  state: "open" | "closed" | "merged";
}
export interface IssueDetail extends Issue {
  links: IssueLink[];
  children: Pick<Issue, "id" | "identifier" | "title" | "statusId" | "assigneeIds">[];
  /** Total logged time in minutes, and the viewer's running timer on this issue. */
  timeSpentMinutes: number;
  myTimerStartedAt: string | null;
  relations: IssueRelation[];
  attachments: Attachment[];
  subscribed: boolean;
}
export interface Comment {
  id: string;
  issueId: string;
  authorId: string;
  body: string;
  createdAt: string;
  editedAt: string | null;
}
export interface Activity {
  id: string;
  issueId: string;
  actorId: string | null;
  kind: string;
  data: Record<string, unknown>;
  createdAt: string;
}
export interface Attachment {
  id: string;
  filename: string;
  contentType: string;
  size: number;
  url: string;
  createdAt: string;
}
export interface SavedView {
  id: string;
  name: string;
  teamId: string | null;
  ownerId: string;
  shared: boolean;
  layout: "list" | "board";
  filters: IssueFilter;
}
export interface Notification {
  id: string;
  kind: NotificationKind;
  issueId: string;
  issueIdentifier: string;
  issueTitle: string;
  actorId: string | null;
  data: Record<string, unknown>;
  createdAt: string;
  readAt: string | null;
}
export interface NotificationSettings {
  digest: DigestFrequency;
  events: Record<NotificationKind, boolean>;
}
export interface SearchResult {
  issues: Pick<Issue, "id" | "identifier" | "title" | "statusId" | "teamId">[];
}
export interface ExportJob {
  id: string;
  status: "pending" | "running" | "done" | "failed";
  createdAt: string;
  downloadUrl: string | null;
}
/** Server-sent event payload (ids only; clients refetch). */
export interface RealtimeEvent {
  t: "issue" | "comment" | "team" | "state" | "label" | "cycle" | "view" | "member" | "notification";
  id: string;
  issueId?: string;
  userId?: string;
}
export interface ApiError {
  error: { code: string; message: string };
}

export interface CustomField {
  id: string;
  teamId: string | null;
  name: string;
  type: "text" | "number" | "select" | "multi_select" | "date" | "checkbox" | "url" | "user";
  options: { id: string; name: string; color?: string }[];
  position: number;
}
export interface TimeEntry {
  id: string;
  issueId: string;
  userId: string | null;
  spentOn: string;
  minutes: number;
  note: string | null;
  createdAt: string;
}
export interface IssueTemplate {
  id: string;
  teamId: string;
  name: string;
  title: string;
  description: string;
  statusId: string | null;
  priority: number;
  labelIds: string[];
  assigneeIds: string[];
  estimate: number | null;
  fields: Record<string, unknown>;
}
export interface RecurringIssue {
  id: string;
  templateId: string;
  frequency: "daily" | "weekly" | "monthly" | "yearly";
  interval: number;
  weekdays: number[];
  monthDay: number | null;
  hour: number;
  timezone: string;
  startsOn: string;
  nextRunAt: string;
  lastRunAt: string | null;
  lastIssueId: string | null;
  active: boolean;
}
export interface AuditEntry {
  id: string;
  actorId: string | null;
  actorLabel: string;
  action: string;
  targetType: string | null;
  targetId: string | null;
  data: Record<string, unknown>;
  ip: string | null;
  createdAt: string;
}
export interface SsoConfig {
  enabled: boolean;
  issuer: string;
  clientId: string;
  hasSecret: boolean;
  allowedDomains: string[];
  autoJoinRole: "member" | "guest" | null;
  enforce: boolean;
  callbackUrl: string;
}
