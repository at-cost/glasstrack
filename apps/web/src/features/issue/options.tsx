import {
  type Cycle,
  type Issue,
  type Label,
  type Member,
  PRIORITIES,
  PRIORITY_LABELS,
  type Priority,
  type WorkflowState,
} from "@glasstrack/shared";
import { Avatar, LabelDot, PriorityIcon, StatusIcon } from "../../components/icons";
import type { Option } from "../../components/Picker";
import type { IssuePatch } from "../../lib/api";
import { formatDateRange } from "../../lib/format";

export const teamStates = (states: WorkflowState[] | undefined, teamId: string) =>
  (states ?? []).filter((s) => s.teamId === teamId).sort((a, b) => a.position - b.position);

export function statusOptions(states: WorkflowState[] | undefined, teamId: string): Option[] {
  return teamStates(states, teamId).map((s) => ({ id: s.id, label: s.name, icon: <StatusIcon state={s} />, keywords: s.category }));
}

export function priorityOptions(): Option[] {
  // Urgent first, "No priority" last.
  const order: Priority[] = [1, 2, 3, 4, 0];
  return order
    .filter((p) => PRIORITIES.includes(p))
    .map((p) => ({ id: String(p), label: PRIORITY_LABELS[p], icon: <PriorityIcon priority={p} /> }));
}

export function assigneeOptions(members: Member[] | undefined, meId: string | undefined): Option[] {
  const list = members ?? [];
  const me = list.find((m) => m.userId === meId);
  const out: Option[] = [];
  if (me)
    out.push({ id: me.userId, label: "Assign to me", icon: <Avatar member={me} size={18} />, keywords: `${me.name} ${me.handle} me` });
  out.push({ id: "none", label: "Unassigned", icon: <Avatar member={null} size={18} /> });
  for (const m of list) {
    if (m.userId === meId) continue;
    out.push({ id: m.userId, label: m.name, icon: <Avatar member={m} size={18} />, hint: `@${m.handle}`, keywords: m.email });
  }
  return out;
}

export const teamLabels = (labels: Label[] | undefined, teamId: string | undefined) =>
  (labels ?? []).filter((l) => !l.teamId || !teamId || l.teamId === teamId);

export function labelOptions(labels: Label[] | undefined, teamId: string | undefined): Option[] {
  return teamLabels(labels, teamId).map((l) => ({ id: l.id, label: l.name, icon: <LabelDot color={l.color} /> }));
}

export function cycleLabel(c: Cycle): string {
  return c.name ? `Cycle ${c.number}: ${c.name}` : `Cycle ${c.number}`;
}

export function cycleOptions(cycles: Cycle[] | undefined, teamId: string): Option[] {
  const list = (cycles ?? []).filter((c) => c.teamId === teamId && !c.completedAt);
  return [
    { id: "none", label: "No cycle" },
    ...list.map((c) => ({ id: c.id, label: cycleLabel(c), hint: formatDateRange(c.startsOn, c.endsOn) })),
  ];
}

/** Adds or removes `id`; "none" clears the list. */
export function toggleAssignee(ids: string[], id: string): string[] {
  if (id === "none") return [];
  return ids.includes(id) ? ids.filter((x) => x !== id) : [...ids, id];
}

/** Turns a picker choice into an issue patch. Labels and assignees toggle. */
export function patchFor(
  kind: "status" | "priority" | "assignee" | "labels" | "cycle",
  issue: Pick<Issue, "labelIds" | "assigneeIds">,
  id: string,
): IssuePatch {
  switch (kind) {
    case "status":
      return { statusId: id };
    case "priority":
      return { priority: Number(id) };
    case "assignee":
      return { assigneeIds: toggleAssignee(issue.assigneeIds, id) };
    case "cycle":
      return { cycleId: id === "none" ? null : id };
    case "labels":
      return { labelIds: issue.labelIds.includes(id) ? issue.labelIds.filter((l) => l !== id) : [...issue.labelIds, id] };
  }
}

export function selectedFor(kind: "status" | "priority" | "assignee" | "labels" | "cycle", issue: Issue): string[] {
  switch (kind) {
    case "status":
      return [issue.statusId];
    case "priority":
      return [String(issue.priority)];
    case "assignee":
      return issue.assigneeIds.length ? issue.assigneeIds : ["none"];
    case "cycle":
      return [issue.cycleId ?? "none"];
    case "labels":
      return issue.labelIds;
  }
}
