import {
  type AutomationAction,
  type AutomationRule,
  type Conditions,
  type CustomField,
  describeTrigger,
  type Label,
  type Member,
  PRIORITY_LABELS,
  type Priority,
  type StateCategory,
  type Team,
  type WorkflowState,
} from "@glasstrack/shared";
import { fieldValueText } from "../issue/fields";

export const CATEGORY_LABEL: Record<StateCategory, string> = {
  backlog: "Backlog",
  unstarted: "Not started",
  started: "Started",
  completed: "Completed",
  canceled: "Canceled",
};

export interface Names {
  teams?: Team[];
  states?: WorkflowState[];
  labels?: Label[];
  members?: Member[];
  fields?: CustomField[];
}

/** "a", "a or b", "a, b or c" */
export function joinWords(items: string[], word = "or"): string {
  if (items.length <= 1) return items[0] ?? "";
  return `${items.slice(0, -1).join(", ")} ${word} ${items[items.length - 1]}`;
}

const plural = (n: number, one: string, many: string) => (n === 1 ? one : many);

export function namer(n: Names) {
  return {
    state: (id: string) => n.states?.find((s) => s.id === id)?.name ?? "a removed status",
    label: (id: string) => n.labels?.find((l) => l.id === id)?.name ?? "a removed label",
    member: (id: string) => n.members?.find((m) => m.userId === id)?.name ?? "a former member",
    team: (id: string) => n.teams?.find((t) => t.id === id)?.name ?? "a removed team",
    field: (id: string) => n.fields?.find((f) => f.id === id),
  };
}

export function triggerText(rule: Pick<AutomationRule, "trigger" | "triggerConfig">, n: Names): string {
  const name = namer(n);
  const c = rule.triggerConfig;
  if (rule.trigger === "status_changed" && (c.toStatusIds?.length || c.toCategories?.length)) {
    const targets = [
      ...(c.toStatusIds ?? []).map(name.state),
      ...(c.toCategories ?? []).map((cat) => `any ${CATEGORY_LABEL[cat].toLowerCase()} status`),
    ];
    return `When an issue moves to ${joinWords(targets)}`;
  }
  if (rule.trigger === "label_added" && c.labelIds?.length) {
    return `When label ${joinWords(c.labelIds.map(name.label))} is added`;
  }
  return describeTrigger(rule.trigger, c);
}

export function conditionsText(c: Conditions, n: Names): string[] {
  const name = namer(n);
  const out: string[] = [];
  if (c.statusIds?.length) out.push(`status is ${joinWords(c.statusIds.map(name.state))}`);
  if (c.categories?.length) out.push(`status is ${joinWords(c.categories.map((x) => `any ${CATEGORY_LABEL[x].toLowerCase()} status`))}`);
  if (c.priorities?.length) out.push(`priority is ${joinWords(c.priorities.map((p) => PRIORITY_LABELS[p as Priority]))}`);
  if (c.labelIds?.length) out.push(`it has label ${joinWords(c.labelIds.map(name.label))}`);
  if (c.notLabelIds?.length) out.push(`it doesn't have label ${joinWords(c.notLabelIds.map(name.label))}`);
  if (c.assignee === "none") out.push("no one is assigned");
  else if (c.assignee === "any") out.push("someone is assigned");
  else if (Array.isArray(c.assignee) && c.assignee.length) out.push(`it's assigned to ${joinWords(c.assignee.map(name.member))}`);
  for (const f of c.fields ?? []) {
    const field = name.field(f.fieldId);
    out.push(`${field?.name ?? "a removed field"} is ${fieldValueText(field, f.value, n.members)}`);
  }
  return out;
}

export function actionText(a: AutomationAction, n: Names): string {
  const name = namer(n);
  switch (a.type) {
    case "set_status":
      return `move it to ${name.state(a.statusId)}`;
    case "set_priority":
      return `set priority to ${PRIORITY_LABELS[a.priority as Priority]}`;
    case "add_labels":
      return `add ${plural(a.labelIds.length, "label", "labels")} ${joinWords(a.labelIds.map(name.label), "and")}`;
    case "remove_labels":
      return `remove ${plural(a.labelIds.length, "label", "labels")} ${joinWords(a.labelIds.map(name.label), "and")}`;
    case "set_assignees":
      return a.userIds.length ? `assign it to ${joinWords(a.userIds.map(name.member), "and")} only` : "unassign everyone";
    case "add_assignees":
      return `also assign ${joinWords(a.userIds.map(name.member), "and")}`;
    case "set_field": {
      const f = name.field(a.fieldId);
      return `set ${f?.name ?? "a removed field"} to ${fieldValueText(f, a.value, n.members)}`;
    }
    case "comment":
      return "comment";
    case "set_due_in_days":
      return a.days === 0 ? "set the due date to today" : `set the due date ${a.days} ${plural(a.days, "day", "days")} out`;
    case "add_to_active_cycle":
      return "add it to the active cycle";
    case "archive":
      return "archive it";
  }
}

/** Plain-words summary: "When an issue moves to Done in Engineering, add label shipped and comment". */
export function ruleSummary(rule: Pick<AutomationRule, "trigger" | "triggerConfig" | "conditions" | "actions" | "teamId">, n: Names): string {
  const scope = rule.teamId ? ` in ${namer(n).team(rule.teamId)}` : "";
  const conds = conditionsText(rule.conditions, n);
  const acts = rule.actions.map((a) => actionText(a, n));
  return `${triggerText(rule, n)}${scope}${conds.length ? `, if ${joinWords(conds, "and")}` : ""}, ${joinWords(acts, "and")}`;
}
