import { z } from "zod";
import { STATE_CATEGORIES, type StateCategory } from "./enums";

/**
 * Automation rules: "when <trigger>, if <conditions>, then <actions>".
 * Pure definitions and matching so the engine and the UI agree.
 */

const uuid = z.uuid();

export const AUTOMATION_TRIGGERS = [
  "issue_created",
  "status_changed",
  "label_added",
  "priority_changed",
  "assignees_changed",
  "comment_added",
  "due_date_passed",
  "no_activity",
] as const;
export type AutomationTrigger = (typeof AUTOMATION_TRIGGERS)[number];

export const triggerConfigSchema = z.object({
  /** status_changed: only when moving to one of these statuses or categories. */
  toStatusIds: z.array(uuid).max(20).optional(),
  toCategories: z.array(z.enum(STATE_CATEGORIES)).max(5).optional(),
  /** label_added: only these labels. */
  labelIds: z.array(uuid).max(20).optional(),
  /** no_activity: days without any update. */
  days: z.number().int().min(1).max(365).optional(),
});
export type TriggerConfig = z.infer<typeof triggerConfigSchema>;

export const conditionsSchema = z.object({
  statusIds: z.array(uuid).max(50).optional(),
  categories: z.array(z.enum(STATE_CATEGORIES)).max(5).optional(),
  priorities: z.array(z.number().int().min(0).max(4)).max(5).optional(),
  /** Has at least one of these labels. */
  labelIds: z.array(uuid).max(20).optional(),
  /** Has none of these labels. */
  notLabelIds: z.array(uuid).max(20).optional(),
  assignee: z.union([z.literal("none"), z.literal("any"), z.array(uuid).max(20)]).optional(),
  /** Custom field equals value (value null = empty). */
  fields: z.array(z.object({ fieldId: uuid, value: z.unknown() })).max(10).optional(),
});
export type Conditions = z.infer<typeof conditionsSchema>;

export const actionSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("set_status"), statusId: uuid }),
  z.object({ type: z.literal("set_priority"), priority: z.number().int().min(0).max(4) }),
  z.object({ type: z.literal("add_labels"), labelIds: z.array(uuid).min(1).max(20) }),
  z.object({ type: z.literal("remove_labels"), labelIds: z.array(uuid).min(1).max(20) }),
  z.object({ type: z.literal("set_assignees"), userIds: z.array(uuid).max(10) }),
  z.object({ type: z.literal("add_assignees"), userIds: z.array(uuid).min(1).max(10) }),
  z.object({ type: z.literal("set_field"), fieldId: uuid, value: z.unknown() }),
  z.object({ type: z.literal("comment"), body: z.string().trim().min(1).max(5000) }),
  z.object({ type: z.literal("set_due_in_days"), days: z.number().int().min(0).max(3650) }),
  z.object({ type: z.literal("add_to_active_cycle") }),
  z.object({ type: z.literal("archive") }),
]);
export type AutomationAction = z.infer<typeof actionSchema>;

const ruleFields = {
  name: z.string().trim().min(1).max(80),
  teamId: uuid.nullish(),
  enabled: z.boolean(),
  trigger: z.enum(AUTOMATION_TRIGGERS),
  triggerConfig: triggerConfigSchema,
  conditions: conditionsSchema,
  actions: z.array(actionSchema).min(1).max(10),
};
export const automationRuleSchema = z.object({
  ...ruleFields,
  enabled: ruleFields.enabled.default(true),
  triggerConfig: ruleFields.triggerConfig.default({}),
  conditions: ruleFields.conditions.default({}),
});
// Built without defaults: zod 4 applies .default() inside .partial().
export const updateAutomationRuleSchema = z.object(ruleFields).partial();

export interface AutomationRule {
  id: string;
  name: string;
  teamId: string | null;
  enabled: boolean;
  trigger: AutomationTrigger;
  triggerConfig: TriggerConfig;
  conditions: Conditions;
  actions: AutomationAction[];
  runCount: number;
  lastRunAt: string | null;
  lastError: string | null;
}

/** What the engine knows about an issue when deciding. */
export interface IssueSnapshot {
  teamId: string;
  statusId: string;
  category: StateCategory;
  priority: number;
  labelIds: string[];
  assigneeIds: string[];
  fields: Record<string, unknown>;
}

/** What happened. */
export type AutomationEvent =
  | { type: "issue_created" }
  | { type: "status_changed"; toStatusId: string; toCategory: StateCategory }
  | { type: "label_added"; labelIds: string[] }
  | { type: "priority_changed" }
  | { type: "assignees_changed" }
  | { type: "comment_added" }
  | { type: "due_date_passed" }
  | { type: "no_activity" };

export function triggerMatches(trigger: AutomationTrigger, config: TriggerConfig, event: AutomationEvent): boolean {
  if (trigger !== event.type) return false;
  if (event.type === "status_changed") {
    const byId = config.toStatusIds?.length ? config.toStatusIds.includes(event.toStatusId) : null;
    const byCat = config.toCategories?.length ? config.toCategories.includes(event.toCategory) : null;
    if (byId === null && byCat === null) return true;
    return Boolean(byId) || Boolean(byCat);
  }
  if (event.type === "label_added" && config.labelIds?.length) return event.labelIds.some((l) => config.labelIds!.includes(l));
  return true;
}

export function conditionsMatch(c: Conditions, s: IssueSnapshot): boolean {
  if (c.statusIds?.length && !c.statusIds.includes(s.statusId)) return false;
  if (c.categories?.length && !c.categories.includes(s.category)) return false;
  if (c.priorities?.length && !c.priorities.includes(s.priority)) return false;
  if (c.labelIds?.length && !s.labelIds.some((l) => c.labelIds!.includes(l))) return false;
  if (c.notLabelIds?.length && s.labelIds.some((l) => c.notLabelIds!.includes(l))) return false;
  if (c.assignee === "none" && s.assigneeIds.length > 0) return false;
  if (c.assignee === "any" && s.assigneeIds.length === 0) return false;
  if (Array.isArray(c.assignee) && c.assignee.length && !s.assigneeIds.some((a) => (c.assignee as string[]).includes(a))) return false;
  for (const f of c.fields ?? []) {
    const have = s.fields[f.fieldId] ?? null;
    const want = f.value ?? null;
    const ok = Array.isArray(have) && !Array.isArray(want) ? have.includes(want) : JSON.stringify(have) === JSON.stringify(want);
    if (!ok) return false;
  }
  return true;
}

/** Plain-words description for lists and logs. */
export function describeTrigger(trigger: AutomationTrigger, config: TriggerConfig): string {
  switch (trigger) {
    case "issue_created":
      return "When an issue is created";
    case "status_changed":
      return config.toCategories?.length || config.toStatusIds?.length ? "When an issue moves to a chosen status" : "When an issue changes status";
    case "label_added":
      return "When a label is added";
    case "priority_changed":
      return "When priority changes";
    case "assignees_changed":
      return "When assignees change";
    case "comment_added":
      return "When someone comments";
    case "due_date_passed":
      return "When the due date passes";
    case "no_activity":
      return `When an open issue has no updates for ${config.days ?? 14} days`;
  }
}
