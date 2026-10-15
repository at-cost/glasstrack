import { z } from "zod";

export const INTAKE_KINDS = ["form", "email"] as const;
export type IntakeKind = (typeof INTAKE_KINDS)[number];

/** A public request form or an email inbox that turns messages into issues. */
export interface IntakeChannel {
  id: string;
  teamId: string;
  kind: IntakeKind;
  name: string;
  /** Text shown above the form. */
  intro: string;
  enabled: boolean;
  /** Status new issues get; null = the team's first backlog status. */
  statusId: string | null;
  labelIds: string[];
  /** Form only: the submitter must give an email address. */
  requireEmail: boolean;
  /** Email only: accept mail only from workspace members' addresses. */
  membersOnly: boolean;
  /** Email the submitter once when their issue is done or canceled. */
  notifySubmitter: boolean;
  /** Public form URL or inbound email address; null when inbound email isn't set up on this server. */
  address: string | null;
  createdAt: string;
}

const uuid = z.uuid();

export const intakeChannelSchema = z.object({
  teamId: uuid,
  kind: z.enum(INTAKE_KINDS),
  name: z.string().trim().min(1).max(80),
  intro: z.string().max(2000).optional(),
  enabled: z.boolean().optional(),
  statusId: uuid.nullable().optional(),
  labelIds: z.array(uuid).max(10).optional(),
  requireEmail: z.boolean().optional(),
  membersOnly: z.boolean().optional(),
  notifySubmitter: z.boolean().optional(),
});
export const updateIntakeChannelSchema = intakeChannelSchema.omit({ kind: true }).partial().extend({ rotateToken: z.boolean().optional() });
export type IntakeChannelInput = z.infer<typeof intakeChannelSchema>;

/** What the public form page needs (no internal ids beyond the token). */
export interface PublicForm {
  name: string;
  intro: string;
  workspaceName: string;
  requireEmail: boolean;
}

export const formSubmissionSchema = z.object({
  title: z.string().trim().min(3).max(200),
  description: z.string().max(10_000).default(""),
  email: z.email().max(200).optional().or(z.literal("").transform(() => undefined)),
  name: z.string().trim().max(100).optional(),
  /** Honeypot: people never fill this in. */
  website: z.string().optional(),
});

export const GIT_PROVIDERS = ["gitlab", "gitea"] as const;
export type GitProvider = (typeof GIT_PROVIDERS)[number];

export interface GitIntegration {
  provider: GitProvider;
  enabled: boolean;
  webhookUrl: string;
  secret?: string;
  moveOnMerge?: boolean;
}
