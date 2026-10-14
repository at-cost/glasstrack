import type { ColumnType, Generated, Insertable, Selectable, Updateable } from "kysely";

/** Timestamps come back as Date, accept Date or ISO string on write. */
type Ts = ColumnType<Date, Date | string, Date | string>;
type TsDefault = ColumnType<Date, Date | string | undefined, Date | string>;
/** date columns are returned as YYYY-MM-DD strings (see pg type parser in db/index.ts) */
type DateOnly = ColumnType<string, string, string>;
type Json<T> = ColumnType<T, T | string, T | string>;
/** numeric comes back as string from pg; we parse it in mappers */
type Numeric = ColumnType<string, number | string, number | string>;
type BigIntCol = ColumnType<string, number | bigint | string, number | bigint | string>;

export interface UsersTable {
  id: string;
  email: string;
  name: string;
  avatarUrl: string | null;
  emailVerifiedAt: Ts | null;
  createdAt: TsDefault;
  deletedAt: Ts | null;
}
export interface AuthIdentitiesTable {
  id: string;
  userId: string;
  provider: "google" | "github";
  providerUserId: string;
  email: string | null;
  createdAt: TsDefault;
}
export interface MagicLinksTable {
  id: string;
  email: string;
  tokenHash: string;
  redirectTo: string | null;
  expiresAt: Ts;
  usedAt: Ts | null;
  ip: string | null;
  createdAt: TsDefault;
}
export interface SessionsTable {
  id: string;
  userId: string;
  tokenHash: string;
  userAgent: string | null;
  createdAt: TsDefault;
  lastSeenAt: TsDefault;
  expiresAt: Ts;
}
export interface WorkspacesTable {
  id: string;
  slug: string;
  name: string;
  status: Generated<"active" | "grace" | "read_only" | "deleting">;
  createdBy: string | null;
  createdAt: TsDefault;
}
export interface WorkspaceMembersTable {
  workspaceId: string;
  userId: string;
  role: "admin" | "member" | "guest";
  joinedAt: TsDefault;
  lastActiveAt: TsDefault;
}
export interface InvitesTable {
  id: string;
  workspaceId: string;
  email: string | null;
  tokenHash: string;
  role: "admin" | "member" | "guest";
  invitedBy: string | null;
  createdAt: TsDefault;
  expiresAt: Ts;
  acceptedAt: Ts | null;
  revokedAt: Ts | null;
}
export interface TeamsTable {
  id: string;
  workspaceId: string;
  key: string;
  name: string;
  issueCounter: Generated<number>;
  createdAt: TsDefault;
  archivedAt: Ts | null;
}
export interface TeamKeyAliasesTable {
  workspaceId: string;
  key: string;
  teamId: string;
}
export interface TeamMembersTable {
  workspaceId: string;
  teamId: string;
  userId: string;
}
export interface WorkflowStatesTable {
  id: string;
  workspaceId: string;
  teamId: string;
  name: string;
  category: "backlog" | "unstarted" | "started" | "completed" | "canceled";
  color: string;
  position: number;
}
export interface LabelsTable {
  id: string;
  workspaceId: string;
  teamId: string | null;
  name: string;
  color: string;
}
export interface CyclesTable {
  id: string;
  workspaceId: string;
  teamId: string;
  number: number;
  name: string | null;
  startsOn: DateOnly;
  endsOn: DateOnly;
  completedAt: Ts | null;
  createdAt: TsDefault;
}
export interface IssuesTable {
  id: string;
  workspaceId: string;
  teamId: string;
  number: number;
  title: string;
  descriptionMd: Generated<string>;
  statusId: string;
  priority: Generated<number>;
  assigneeId: string | null;
  creatorId: string | null;
  parentId: string | null;
  cycleId: string | null;
  dueDate: DateOnly | null;
  estimate: Numeric | null;
  sortKey: string;
  createdAt: TsDefault;
  updatedAt: TsDefault;
  startedAt: Ts | null;
  completedAt: Ts | null;
  canceledAt: Ts | null;
  archivedAt: Ts | null;
  search: ColumnType<string, never, never>;
}
export interface IssueLabelsTable {
  workspaceId: string;
  issueId: string;
  labelId: string;
}
export interface IssueRelationsTable {
  id: string;
  workspaceId: string;
  issueId: string;
  relatedIssueId: string;
  type: "blocks" | "related" | "duplicate";
  createdAt: TsDefault;
}
export interface IssueSubscribersTable {
  workspaceId: string;
  issueId: string;
  userId: string;
}
export interface CommentsTable {
  id: string;
  workspaceId: string;
  issueId: string;
  authorId: string | null;
  bodyMd: string;
  createdAt: TsDefault;
  editedAt: Ts | null;
  deletedAt: Ts | null;
  search: ColumnType<string, never, never>;
}
export interface ActivityTable {
  id: Generated<string>;
  workspaceId: string;
  issueId: string;
  actorId: string | null;
  kind: string;
  data: Json<Record<string, unknown>>;
  createdAt: TsDefault;
}
export interface AttachmentsTable {
  id: string;
  workspaceId: string;
  issueId: string;
  uploaderId: string | null;
  storageKey: string;
  filename: string;
  contentType: string;
  sizeBytes: BigIntCol;
  uploadedAt: Ts | null;
  createdAt: TsDefault;
  deletedAt: Ts | null;
}
export interface SavedViewsTable {
  id: string;
  workspaceId: string;
  teamId: string | null;
  ownerId: string;
  name: string;
  shared: Generated<boolean>;
  layout: Generated<"list" | "board">;
  filters: Json<Record<string, unknown>>;
  createdAt: TsDefault;
}
export interface NotificationsTable {
  id: string;
  workspaceId: string;
  userId: string;
  issueId: string;
  kind: string;
  actorId: string | null;
  data: Json<Record<string, unknown>>;
  createdAt: TsDefault;
  readAt: Ts | null;
  emailedAt: Ts | null;
}
export interface NotificationSettingsTable {
  workspaceId: string;
  userId: string;
  digest: Generated<"off" | "hourly" | "daily">;
  events: Json<Record<string, boolean>>;
  lastDigestAt: Ts | null;
}
export interface ExportsTable {
  id: string;
  workspaceId: string;
  requestedBy: string | null;
  status: Generated<"pending" | "running" | "done" | "failed">;
  storageKey: string | null;
  sizeBytes: BigIntCol | null;
  error: string | null;
  createdAt: TsDefault;
  expiresAt: Ts | null;
}

export interface DB {
  users: UsersTable;
  authIdentities: AuthIdentitiesTable;
  magicLinks: MagicLinksTable;
  sessions: SessionsTable;
  workspaces: WorkspacesTable;
  workspaceMembers: WorkspaceMembersTable;
  invites: InvitesTable;
  teams: TeamsTable;
  teamKeyAliases: TeamKeyAliasesTable;
  teamMembers: TeamMembersTable;
  workflowStates: WorkflowStatesTable;
  labels: LabelsTable;
  cycles: CyclesTable;
  issues: IssuesTable;
  issueLabels: IssueLabelsTable;
  issueRelations: IssueRelationsTable;
  issueSubscribers: IssueSubscribersTable;
  comments: CommentsTable;
  activity: ActivityTable;
  attachments: AttachmentsTable;
  savedViews: SavedViewsTable;
  notifications: NotificationsTable;
  notificationSettings: NotificationSettingsTable;
  exports: ExportsTable;
}

export type UserRow = Selectable<UsersTable>;
export type IssueRow = Selectable<IssuesTable>;
export type NewIssue = Insertable<IssuesTable>;
export type IssueUpdate = Updateable<IssuesTable>;
