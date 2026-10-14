import { z } from "zod";
import { DIGEST_FREQUENCIES, NOTIFICATION_KINDS, RELATION_TYPES, ROLES, STATE_CATEGORIES } from "./enums";

const uuid = z.uuid();
const color = z.string().regex(/^#[0-9a-fA-F]{6}$/);
const dateOnly = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

export const emailSchema = z.email().max(254).transform((e) => e.trim().toLowerCase());

export const createWorkspaceSchema = z.object({
  name: z.string().trim().min(1).max(80),
  slug: z
    .string()
    .trim()
    .toLowerCase()
    .regex(/^[a-z0-9](?:[a-z0-9-]{1,38}[a-z0-9])$/, "3-40 chars: letters, digits, dashes"),
});
export const updateWorkspaceSchema = z.object({ name: z.string().trim().min(1).max(80) });

export const inviteSchema = z.object({
  email: emailSchema.optional(),
  role: z.enum(ROLES).default("member"),
});
export const updateMemberSchema = z.object({ role: z.enum(ROLES) });

export const teamKeySchema = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z][A-Z0-9]{1,4}$/, "2-5 letters/digits, starting with a letter");
export const createTeamSchema = z.object({ name: z.string().trim().min(1).max(60), key: teamKeySchema });
export const updateTeamSchema = createTeamSchema.partial();

export const stateSchema = z.object({
  name: z.string().trim().min(1).max(40),
  category: z.enum(STATE_CATEGORIES),
  color,
  position: z.number().optional(),
});
export const updateStateSchema = stateSchema.partial();

export const labelSchema = z.object({
  name: z.string().trim().min(1).max(40),
  color,
  teamId: uuid.nullish(),
});
export const updateLabelSchema = labelSchema.partial();

export const cycleSchema = z
  .object({ name: z.string().trim().max(60).optional(), startsOn: dateOnly, endsOn: dateOnly })
  .refine((c) => c.startsOn <= c.endsOn, "endsOn must be on or after startsOn");
export const updateCycleSchema = z.object({
  name: z.string().trim().max(60).optional(),
  startsOn: dateOnly.optional(),
  endsOn: dateOnly.optional(),
  completed: z.boolean().optional(),
});

export const priority = z.number().int().min(0).max(4);

export const createIssueSchema = z.object({
  teamId: uuid,
  title: z.string().trim().min(1).max(300),
  description: z.string().max(100_000).default(""),
  statusId: uuid.optional(),
  priority: priority.default(0),
  assigneeId: uuid.nullish(),
  labelIds: z.array(uuid).max(20).default([]),
  dueDate: dateOnly.nullish(),
  estimate: z.number().min(0).max(1000).nullish(),
  parentId: uuid.nullish(),
  cycleId: uuid.nullish(),
});
export const updateIssueSchema = z.object({
  title: z.string().trim().min(1).max(300).optional(),
  description: z.string().max(100_000).optional(),
  statusId: uuid.optional(),
  priority: priority.optional(),
  assigneeId: uuid.nullable().optional(),
  labelIds: z.array(uuid).max(20).optional(),
  dueDate: dateOnly.nullable().optional(),
  estimate: z.number().min(0).max(1000).nullable().optional(),
  parentId: uuid.nullable().optional(),
  cycleId: uuid.nullable().optional(),
});
export const moveIssueSchema = z.object({
  statusId: uuid.optional(),
  /** id of the issue this one should sit after (null = top) */
  afterId: uuid.nullable().optional(),
  beforeId: uuid.nullable().optional(),
});

export const issueFilterSchema = z.object({
  team: uuid.optional(),
  status: z.array(uuid).optional(),
  assignee: z.array(z.union([uuid, z.literal("none"), z.literal("me")])).optional(),
  label: z.array(uuid).optional(),
  priority: z.array(priority).optional(),
  cycle: z.union([uuid, z.literal("none"), z.literal("active")]).optional(),
  q: z.string().max(200).optional(),
  parent: uuid.optional(),
  includeArchived: z.boolean().optional(),
});
export type IssueFilter = z.infer<typeof issueFilterSchema>;

export const relationSchema = z.object({ relatedIssueId: uuid, type: z.enum(RELATION_TYPES) });
export const commentSchema = z.object({ body: z.string().trim().min(1).max(50_000) });

export const savedViewSchema = z.object({
  name: z.string().trim().min(1).max(60),
  teamId: uuid.nullish(),
  shared: z.boolean().default(false),
  layout: z.enum(["list", "board"]).default("list"),
  filters: issueFilterSchema.default({}),
});
export const updateSavedViewSchema = savedViewSchema.partial();

export const notificationSettingsSchema = z.object({
  digest: z.enum(DIGEST_FREQUENCIES),
  events: z.partialRecord(z.enum(NOTIFICATION_KINDS), z.boolean()),
});

export const attachmentRequestSchema = z.object({
  filename: z.string().trim().min(1).max(200),
  contentType: z.string().max(100),
  size: z.number().int().min(1).max(100 * 1024 * 1024),
});
