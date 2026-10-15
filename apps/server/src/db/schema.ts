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
type BigIntDefault = ColumnType<string, number | bigint | string | undefined, number | bigint | string>;

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
  authMethod: Generated<string>;
  ssoWorkspaceId: string | null;
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

export interface PricingConfigTable {
  id: Generated<number>;
  effectiveFrom: TsDefault;
  monthlyPriceMicro: BigIntCol;
  reason: string;
  createdBy: Generated<string>;
}
export interface CreditLedgerTable {
  id: Generated<string>;
  workspaceId: string;
  kind: "starter_grant" | "topup" | "charge" | "storage_charge" | "refund" | "adjustment";
  amountMicro: BigIntCol;
  idempotencyKey: string;
  refType: string | null;
  refId: string | null;
  memo: string | null;
  createdBy: Generated<string>;
  createdAt: TsDefault;
}
export interface BillingAccountsTable {
  workspaceId: string;
  stripeCustomerId: string | null;
  defaultPaymentMethod: string | null;
  cardLabel: string | null;
  autoTopupEnabled: Generated<boolean>;
  autoTopupThresholdMicro: BigIntDefault;
  autoTopupAmountMicro: BigIntDefault;
  graceStartedAt: Ts | null;
  warningsSent: Generated<number>;
  lastChargedOn: DateOnly | null;
  updatedAt: TsDefault;
}
export interface PaymentsTable {
  id: string;
  workspaceId: string;
  kind: "topup" | "auto_topup";
  stripeCheckoutSessionId: string | null;
  stripePaymentIntentId: string | null;
  amountMicro: BigIntCol;
  feeMicro: BigIntCol | null;
  netMicro: BigIntCol | null;
  currency: Generated<string>;
  status: "pending" | "succeeded" | "failed" | "refunded";
  createdAt: TsDefault;
  succeededAt: Ts | null;
}
export interface StarterCreditClaimsTable {
  id: string;
  emailHash: string;
  domain: string;
  workspaceId: string;
  createdAt: TsDefault;
}
export interface StripeEventsTable {
  eventId: string;
  type: string;
  receivedAt: TsDefault;
  processedAt: Ts | null;
}
export interface UsageDailyTable {
  workspaceId: string;
  day: DateOnly;
  activeMembers: Generated<number>;
  storageBytes: BigIntDefault;
  emailsSent: Generated<number>;
  apiRequests: Generated<number>;
}
export interface WorkspaceCostDailyTable {
  workspaceId: string;
  day: DateOnly;
  sharedMicro: BigIntCol;
  storageMicro: BigIntCol;
  emailMicro: BigIntCol;
  feesMicro: BigIntCol;
  totalMicro: BigIntCol;
}
export interface CostEntriesTable {
  id: string;
  periodStart: DateOnly;
  periodEnd: DateOnly;
  category: "infrastructure" | "email" | "storage" | "domain" | "tools" | "ai" | "other";
  source: "aws" | "manual";
  amountMicro: BigIntCol;
  publicLabel: string;
  note: string | null;
  externalKey: string | null;
  createdBy: Generated<string>;
  createdAt: TsDefault;
}
export interface FinanceDailyTable {
  day: DateOnly;
  revenueMicro: BigIntCol;
  starterUsedMicro: BigIntCol;
  costs: Json<Record<string, number>>;
  paymentFeesMicro: BigIntCol;
  totalCostMicro: BigIntCol;
  activeWorkspaces: number;
  payingWorkspaces: number;
  costPerWorkspaceMicro: BigIntCol;
  reserveMicro: BigIntCol;
  reserveTargetMicro: BigIntCol;
  priceMicro: BigIntCol;
  recommendedPriceMicro: BigIntCol | null;
  marginBp: number;
  computedAt: TsDefault;
}

export interface ApiTokensTable {
  id: string;
  workspaceId: string;
  userId: string;
  name: string;
  tokenHash: string;
  tokenPrefix: string;
  createdAt: TsDefault;
  lastUsedAt: Ts | null;
  expiresAt: Ts | null;
  revokedAt: Ts | null;
}
export interface WebhooksTable {
  id: string;
  workspaceId: string;
  url: string;
  secret: string;
  events: string[];
  active: Generated<boolean>;
  consecutiveFailures: Generated<number>;
  createdBy: string | null;
  createdAt: TsDefault;
}
export interface WebhookDeliveriesTable {
  id: string;
  workspaceId: string;
  webhookId: string;
  event: string;
  payload: Json<Record<string, unknown>>;
  status: Generated<"pending" | "succeeded" | "failed">;
  attempts: Generated<number>;
  responseStatus: number | null;
  error: string | null;
  createdAt: TsDefault;
  deliveredAt: Ts | null;
}
export interface IssueLinksTable {
  id: string;
  workspaceId: string;
  issueId: string;
  provider: "github";
  url: string;
  title: string;
  state: "open" | "closed" | "merged";
  createdAt: TsDefault;
  updatedAt: TsDefault;
}
export interface GithubIntegrationsTable {
  workspaceId: string;
  secret: string;
  moveOnMerge: Generated<boolean>;
  createdBy: string | null;
  createdAt: TsDefault;
}

export interface IssueAssigneesTable {
  workspaceId: string;
  issueId: string;
  userId: string;
  createdAt: TsDefault;
}
export interface CustomFieldsTable {
  id: string;
  workspaceId: string;
  teamId: string | null;
  name: string;
  type: "text" | "number" | "select" | "multi_select" | "date" | "checkbox" | "url" | "user";
  options: Json<{ id: string; name: string; color?: string }[]>;
  position: Generated<number>;
  createdAt: TsDefault;
  archivedAt: Ts | null;
}
export interface IssueFieldValuesTable {
  workspaceId: string;
  issueId: string;
  fieldId: string;
  value: Json<unknown>;
}
export interface TimeEntriesTable {
  id: string;
  workspaceId: string;
  issueId: string;
  userId: string | null;
  spentOn: DateOnly;
  minutes: number;
  note: string | null;
  createdAt: TsDefault;
}
export interface ActiveTimersTable {
  workspaceId: string;
  userId: string;
  issueId: string;
  startedAt: TsDefault;
}
export interface IssueTemplatesTable {
  id: string;
  workspaceId: string;
  teamId: string;
  name: string;
  title: string;
  descriptionMd: Generated<string>;
  statusId: string | null;
  priority: Generated<number>;
  labelIds: ColumnType<string[], string[] | undefined, string[]>;
  assigneeIds: ColumnType<string[], string[] | undefined, string[]>;
  estimate: Numeric | null;
  fieldValues: Json<Record<string, unknown>>;
  createdBy: string | null;
  createdAt: TsDefault;
  updatedAt: TsDefault;
}
export interface RecurringIssuesTable {
  id: string;
  workspaceId: string;
  templateId: string;
  frequency: "daily" | "weekly" | "monthly" | "yearly";
  interval: Generated<number>;
  weekdays: ColumnType<number[], number[] | undefined, number[]>;
  monthDay: number | null;
  hour: Generated<number>;
  timezone: Generated<string>;
  startsOn: DateOnly;
  nextRunAt: Ts;
  lastRunAt: Ts | null;
  lastIssueId: string | null;
  active: Generated<boolean>;
  createdBy: string | null;
  createdAt: TsDefault;
}
export interface AuditLogTable {
  id: Generated<string>;
  workspaceId: string;
  actorId: string | null;
  actorLabel: string;
  action: string;
  targetType: string | null;
  targetId: string | null;
  data: Json<Record<string, unknown>>;
  ip: string | null;
  createdAt: TsDefault;
}
export interface SsoConfigsTable {
  workspaceId: string;
  issuer: string;
  clientId: string;
  clientSecretEnc: string;
  allowedDomains: ColumnType<string[], string[] | undefined, string[]>;
  autoJoinRole: "member" | "guest" | null;
  enforce: Generated<boolean>;
  enabled: Generated<boolean>;
  createdAt: TsDefault;
  updatedAt: TsDefault;
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
  pricingConfig: PricingConfigTable;
  creditLedger: CreditLedgerTable;
  billingAccounts: BillingAccountsTable;
  payments: PaymentsTable;
  starterCreditClaims: StarterCreditClaimsTable;
  stripeEvents: StripeEventsTable;
  usageDaily: UsageDailyTable;
  workspaceCostDaily: WorkspaceCostDailyTable;
  costEntries: CostEntriesTable;
  financeDaily: FinanceDailyTable;
  apiTokens: ApiTokensTable;
  webhooks: WebhooksTable;
  webhookDeliveries: WebhookDeliveriesTable;
  issueLinks: IssueLinksTable;
  githubIntegrations: GithubIntegrationsTable;
  issueAssignees: IssueAssigneesTable;
  customFields: CustomFieldsTable;
  issueFieldValues: IssueFieldValuesTable;
  timeEntries: TimeEntriesTable;
  activeTimers: ActiveTimersTable;
  issueTemplates: IssueTemplatesTable;
  recurringIssues: RecurringIssuesTable;
  auditLog: AuditLogTable;
  ssoConfigs: SsoConfigsTable;
}

export type UserRow = Selectable<UsersTable>;
export type IssueRow = Selectable<IssuesTable>;
export type NewIssue = Insertable<IssuesTable>;
export type IssueUpdate = Updateable<IssuesTable>;
