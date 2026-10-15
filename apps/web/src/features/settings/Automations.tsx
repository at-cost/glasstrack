import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import {
  AUTOMATION_TRIGGERS,
  type AutomationAction,
  type AutomationRule,
  type AutomationTrigger,
  type Conditions,
  describeTrigger,
  PRIORITY_LABELS,
  type Priority,
  STATE_CATEGORIES,
  type StateCategory,
  type TriggerConfig,
} from "@glasstrack/shared";
import { ArrowDown, ArrowUp, ChevronDown, ChevronRight, Pencil, Plus, Trash2, X } from "lucide-react";
import { type ReactNode, useId, useState } from "react";
import { Card } from "../../components/Card";
import { ConfirmDialog, Dialog } from "../../components/Dialog";
import { Empty, Skeleton } from "../../components/Feedback";
import { Avatar, LabelDot, StatusIcon } from "../../components/icons";
import { type Option, PickerButton } from "../../components/Picker";
import { type AutomationInput, api, errorMessage } from "../../lib/api";
import { fullTime, relativeTime } from "../../lib/format";
import { paths } from "../../lib/paths";
import { keys, useFields, useLabels, useMembers, useStates, useTeams } from "../../lib/queries";
import { toast, toastError } from "../../lib/toast";
import { FieldEditor } from "../issue/fields";
import { useWs } from "../shell/context";
import { CATEGORY_LABEL, type Names, ruleSummary } from "./automationText";

type ActionType = AutomationAction["type"];
const ACTION_LABEL: Record<ActionType, string> = {
  set_status: "Set status",
  set_priority: "Set priority",
  add_labels: "Add labels",
  remove_labels: "Remove labels",
  set_assignees: "Replace assignees",
  add_assignees: "Add assignees",
  set_field: "Set a custom field",
  comment: "Comment",
  set_due_in_days: "Set due date",
  add_to_active_cycle: "Add to active cycle",
  archive: "Archive",
};
const ACTION_TYPES = Object.keys(ACTION_LABEL) as ActionType[];
const MAX_ACTIONS = 10;

type CondKey = "statusIds" | "categories" | "priorities" | "labelIds" | "notLabelIds" | "assignee" | "fields";
const COND_LABEL: Record<CondKey, string> = {
  statusIds: "Status is",
  categories: "Status category is",
  priorities: "Priority is",
  labelIds: "Has label",
  notLabelIds: "Doesn't have label",
  assignee: "Assignee",
  fields: "Custom field equals",
};
const COND_KEYS = Object.keys(COND_LABEL) as CondKey[];

const emptyRule = (): AutomationInput => ({
  name: "",
  teamId: null,
  enabled: true,
  trigger: "status_changed",
  triggerConfig: {},
  conditions: {},
  actions: [{ type: "comment", body: "" }],
});

function useNames(): Names {
  const { slug } = useWs();
  return {
    teams: useTeams(slug).data,
    states: useStates(slug).data,
    labels: useLabels(slug).data,
    members: useMembers(slug).data,
    fields: useFields(slug).data,
  };
}

export function Automations() {
  const { slug, isAdmin, canEdit, me } = useWs();
  const qc = useQueryClient();
  const names = useNames();
  const list = useQuery({ queryKey: keys.automations(slug), queryFn: () => api.ws(slug).automations() });
  const [editing, setEditing] = useState<{ id: string | null; draft: AutomationInput } | null>(null);
  const editable = isAdmin && canEdit;

  const starters: { name: string; text: string; make: () => AutomationInput }[] = [
    {
      name: "Tag issues when done",
      text: "Adds a label and a comment when an issue is completed.",
      make: () => {
        const tag = (names.labels ?? []).find((l) => !l.teamId && /^(shipped|done|released)$/i.test(l.name));
        return {
          ...emptyRule(),
          name: "Tag issues when done",
          trigger: "status_changed",
          triggerConfig: { toCategories: ["completed"] },
          actions: [
            { type: "add_labels", labelIds: tag ? [tag.id] : [] },
            { type: "comment", body: "Marked as shipped." },
          ],
        };
      },
    },
    {
      name: "Assign urgent issues",
      text: "Assigns new urgent issues that have no one on them.",
      make: () => ({
        ...emptyRule(),
        name: "Assign urgent issues",
        trigger: "issue_created",
        conditions: { priorities: [1], assignee: "none" },
        actions: [{ type: "add_assignees", userIds: [me.id] }],
      }),
    },
    {
      name: "Nudge stale issues",
      text: "Comments on open issues with no updates for two weeks.",
      make: () => ({
        ...emptyRule(),
        name: "Nudge stale issues",
        trigger: "no_activity",
        triggerConfig: { days: 14 },
        actions: [{ type: "comment", body: "No updates for 14 days. Is this still needed? Update it or close it." }],
      }),
    },
  ];

  const toggle = async (rule: AutomationRule, enabled: boolean) => {
    const key = keys.automations(slug);
    const prev = qc.getQueryData<AutomationRule[]>(key);
    qc.setQueryData<AutomationRule[]>(key, (l) => l?.map((r) => (r.id === rule.id ? { ...r, enabled } : r)));
    try {
      await api.ws(slug).updateAutomation(rule.id, { enabled });
      toast(enabled ? `"${rule.name}" turned on` : `"${rule.name}" turned off`, "success");
    } catch (e) {
      qc.setQueryData(key, prev);
      toastError(errorMessage(e));
    } finally {
      qc.invalidateQueries({ queryKey: key });
    }
  };

  return (
    <>
      <Card
        title="Automations"
        actions={
          editable ? (
            <button type="button" className="btn btn-sm btn-primary" onClick={() => setEditing({ id: null, draft: emptyRule() })}>
              <Plus size={14} aria-hidden="true" />
              New automation
            </button>
          ) : undefined
        }
      >
        <p className="muted small">
          Rules run right after a change is saved: when something happens, if the issue matches, then do these things. Changes made
          by a rule never start other rules.
        </p>
        {!isAdmin && <p className="muted small">Only admins can change automations.</p>}
        {editable && (
          <div className="starter-list">
            <span className="field-label">Start from an example</span>
            <div className="starter-grid">
              {starters.map((s) => (
                <button key={s.name} type="button" className="starter" onClick={() => setEditing({ id: null, draft: s.make() })}>
                  <strong>{s.name}</strong>
                  <span className="muted small">{s.text}</span>
                </button>
              ))}
            </div>
          </div>
        )}
      </Card>
      <Card title="Rules">
        {list.isPending ? (
          <Skeleton rows={2} />
        ) : list.error ? (
          <Empty title="Could not load automations">{errorMessage(list.error)}</Empty>
        ) : list.data.length === 0 ? (
          <p className="muted small">No automations yet.</p>
        ) : (
          <ul className="rule-list">
            {list.data.map((r) => (
              <RuleItem
                key={r.id}
                rule={r}
                names={names}
                editable={editable}
                onToggle={(on) => toggle(r, on)}
                onEdit={() => setEditing({ id: r.id, draft: toInput(r) })}
              />
            ))}
          </ul>
        )}
      </Card>
      {editing && <RuleEditor id={editing.id} initial={editing.draft} onClose={() => setEditing(null)} />}
    </>
  );
}

const toInput = (r: AutomationRule): AutomationInput => ({
  name: r.name,
  teamId: r.teamId,
  enabled: r.enabled,
  trigger: r.trigger,
  triggerConfig: r.triggerConfig ?? {},
  conditions: r.conditions ?? {},
  actions: r.actions,
});

function RuleItem({
  rule,
  names,
  editable,
  onToggle,
  onEdit,
}: {
  rule: AutomationRule;
  names: Names;
  editable: boolean;
  onToggle: (on: boolean) => void;
  onEdit: () => void;
}) {
  const { slug, isAdmin } = useWs();
  const qc = useQueryClient();
  const [runsOpen, setRunsOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const runsId = useId();
  const remove = async () => {
    try {
      await api.ws(slug).deleteAutomation(rule.id);
      await qc.invalidateQueries({ queryKey: keys.automations(slug) });
      toast("Automation deleted", "success");
    } catch (e) {
      toastError(errorMessage(e));
    }
  };
  return (
    <li className={`rule${rule.enabled ? "" : " off"}`} data-testid="automation">
      <div className="rule-head">
        <span className="rule-name">{rule.name}</span>
        {editable ? (
          <label className="switch">
            <input
              type="checkbox"
              role="switch"
              aria-checked={rule.enabled}
              aria-label={rule.name}
              checked={rule.enabled}
              onChange={(e) => onToggle(e.target.checked)}
            />
            <span className="switch-track" aria-hidden="true" />
            <span aria-hidden="true">{rule.enabled ? "On" : "Off"}</span>
          </label>
        ) : (
          <span className={`badge${rule.enabled ? " badge-accent" : ""}`}>{rule.enabled ? "On" : "Off"}</span>
        )}
      </div>
      <p className="rule-summary">{ruleSummary(rule, names)}</p>
      <p className="muted small rule-stats">
        {rule.runCount > 0
          ? `Ran ${rule.runCount} ${rule.runCount === 1 ? "time" : "times"}`
          : rule.lastRunAt
            ? "No successful runs yet"
            : "Has not run yet"}
        {rule.lastRunAt && (
          <>
            {rule.runCount > 0 ? ", last " : ", last tried "}
            <time dateTime={rule.lastRunAt} title={fullTime(rule.lastRunAt)}>
              {relativeTime(rule.lastRunAt)}
            </time>
          </>
        )}
      </p>
      {rule.lastError && (
        <p className="rule-error" role="note">
          Last run failed: {rule.lastError}
        </p>
      )}
      {(isAdmin || editable) && (
        <div className="row wrap">
          {isAdmin && (
            <button type="button" className="btn btn-sm" aria-expanded={runsOpen} aria-controls={runsId} onClick={() => setRunsOpen((o) => !o)}>
              {runsOpen ? <ChevronDown size={13} aria-hidden="true" /> : <ChevronRight size={13} aria-hidden="true" />}
              Runs
            </button>
          )}
          {editable && (
            <>
              <button type="button" className="btn btn-sm" onClick={onEdit}>
                <Pencil size={13} aria-hidden="true" />
                Edit
              </button>
              <button type="button" className="btn btn-sm btn-ghost" onClick={() => setDeleting(true)}>
                <Trash2 size={13} aria-hidden="true" />
                Delete
              </button>
            </>
          )}
        </div>
      )}
      {runsOpen && (
        <div id={runsId}>
          <Runs ruleId={rule.id} />
        </div>
      )}
      {deleting && (
        <ConfirmDialog
          title={`Delete "${rule.name}"?`}
          message="The rule stops right away. Changes it already made stay."
          confirmLabel="Delete automation"
          danger
          onConfirm={remove}
          onClose={() => setDeleting(false)}
        />
      )}
    </li>
  );
}

function Runs({ ruleId }: { ruleId: string }) {
  const { slug } = useWs();
  const q = useQuery({ queryKey: keys.automationRuns(slug, ruleId), queryFn: () => api.ws(slug).automationRuns(ruleId), refetchInterval: 15_000 });
  if (q.isPending) return <Skeleton rows={2} />;
  if (q.error) return <p className="form-error">{errorMessage(q.error)}</p>;
  if (q.data.length === 0) return <p className="muted small">No runs yet.</p>;
  return (
    <div className="table-wrap">
      <table className="data-table">
        <caption className="sr-only">Recent runs</caption>
        <thead>
          <tr>
            <th scope="col">When</th>
            <th scope="col">Issue</th>
            <th scope="col">Result</th>
            <th scope="col">Details</th>
          </tr>
        </thead>
        <tbody>
          {q.data.map((r) => (
            <tr key={r.id}>
              <td className="nowrap" title={fullTime(r.createdAt)}>
                {relativeTime(r.createdAt)}
              </td>
              <td className="nowrap">
                {r.identifier ? (
                  <Link to={paths.issue(slug, r.identifier)} className="issue-id">
                    {r.identifier}
                  </Link>
                ) : (
                  <span className="muted">Deleted issue</span>
                )}
              </td>
              <td>
                <span className={`badge${r.status === "ok" ? " badge-accent" : " badge-danger"}`}>{r.status === "ok" ? "Ran" : "Failed"}</span>
              </td>
              <td className={`small${r.status === "error" ? " rule-error" : ""}`}>
                {r.status === "error"
                  ? (r.detail?.error ?? "Unknown error")
                  : r.detail?.changed?.length
                    ? `Changed: ${r.detail.changed.join(", ")}`
                    : "Nothing to change"}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Drops empty lists and settings that don't apply to the trigger. */
function clean(d: AutomationInput): AutomationInput {
  const tc: TriggerConfig = {};
  if (d.trigger === "status_changed") {
    if (d.triggerConfig.toStatusIds?.length) tc.toStatusIds = d.triggerConfig.toStatusIds;
    if (d.triggerConfig.toCategories?.length) tc.toCategories = d.triggerConfig.toCategories;
  }
  if (d.trigger === "label_added" && d.triggerConfig.labelIds?.length) tc.labelIds = d.triggerConfig.labelIds;
  if (d.trigger === "no_activity") tc.days = d.triggerConfig.days ?? 14;
  const c: Conditions = {};
  for (const [k, v] of Object.entries(d.conditions) as [keyof Conditions, unknown][]) {
    if (v === undefined || (Array.isArray(v) && v.length === 0)) continue;
    (c as Record<string, unknown>)[k] = v;
  }
  return { ...d, name: d.name.trim(), triggerConfig: tc, conditions: c };
}

/** Catches the common gaps before the server does, in plain words. */
function problem(d: AutomationInput): string | null {
  if (!d.name.trim()) return "Give the automation a name.";
  if (d.actions.length === 0) return "Add at least one action.";
  for (const [i, a] of d.actions.entries()) {
    const n = `Action ${i + 1}`;
    if (a.type === "set_status" && !d.teamId) return `${n}: statuses belong to a team. Pick a team under "Runs in".`;
    if (a.type === "set_status" && !a.statusId) return `${n}: pick a status.`;
    if ((a.type === "add_labels" || a.type === "remove_labels") && a.labelIds.length === 0) return `${n}: pick at least one label.`;
    if (a.type === "add_assignees" && a.userIds.length === 0) return `${n}: pick at least one person.`;
    if (a.type === "set_field" && !a.fieldId) return `${n}: pick a field.`;
    if (a.type === "comment" && !a.body.trim()) return `${n}: write the comment.`;
  }
  if (d.conditions.fields?.some((f) => !f.fieldId)) return "Pick a field for the custom field condition.";
  return null;
}

function RuleEditor({ id, initial, onClose }: { id: string | null; initial: AutomationInput; onClose: () => void }) {
  const { slug, me } = useWs();
  const qc = useQueryClient();
  const uid = useId();
  const teams = useTeams(slug);
  const states = useStates(slug);
  const labels = useLabels(slug);
  const members = useMembers(slug);
  const fields = useFields(slug);
  const [d, setD] = useState<AutomationInput>(initial);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const set = (patch: Partial<AutomationInput>) => {
    setD((cur) => ({ ...cur, ...patch }));
    setError(null);
  };
  const teamId = d.teamId ?? null;

  // Options limited to what the rule's scope can use.
  const stateOpts = (all: boolean): Option[] =>
    (states.data ?? [])
      .filter((s) => (all && !teamId ? true : s.teamId === teamId))
      .sort((a, b) => STATE_CATEGORIES.indexOf(a.category) - STATE_CATEGORIES.indexOf(b.category) || a.position - b.position)
      .map((s) => ({
        id: s.id,
        label: s.name,
        icon: <StatusIcon state={s} />,
        hint: teamId ? undefined : teams.data?.find((t) => t.id === s.teamId)?.key,
      }));
  const labelOpts: Option[] = (labels.data ?? [])
    .filter((l) => (teamId ? !l.teamId || l.teamId === teamId : !l.teamId))
    .map((l) => ({ id: l.id, label: l.name, icon: <LabelDot color={l.color} /> }));
  const peopleOpts: Option[] = (members.data ?? []).map((m) => ({
    id: m.userId,
    label: m.userId === me.id ? `${m.name} (you)` : m.name,
    icon: <Avatar member={m} size={16} />,
    keywords: m.email,
  }));
  const fieldList = (fields.data ?? []).filter((f) => (teamId ? !f.teamId || f.teamId === teamId : !f.teamId));

  const save = async () => {
    const p = problem(d);
    if (p) return setError(p);
    setBusy(true);
    try {
      const body = clean(d);
      if (id) await api.ws(slug).updateAutomation(id, body);
      else await api.ws(slug).createAutomation(body);
      await qc.invalidateQueries({ queryKey: keys.automations(slug) });
      toast(id ? "Automation saved" : "Automation created", "success");
      onClose();
    } catch (e) {
      setError(errorMessage(e));
      setBusy(false);
    }
  };

  const tc = d.triggerConfig;
  const c = d.conditions;
  const setCond = (patch: Partial<Conditions>) => set({ conditions: { ...c, ...patch } });
  const removeCond = (k: CondKey) => {
    const { [k]: _, ...rest } = c;
    set({ conditions: rest });
  };
  const usedConds = COND_KEYS.filter((k) => c[k] !== undefined);
  const addCond = (k: CondKey) => {
    const init: Partial<Conditions> = {
      statusIds: { statusIds: [] },
      categories: { categories: [] },
      priorities: { priorities: [] },
      labelIds: { labelIds: [] },
      notLabelIds: { notLabelIds: [] },
      assignee: { assignee: "none" as const },
      fields: { fields: [{ fieldId: fieldList[0]?.id ?? "", value: null }] },
    }[k];
    setCond(init);
  };

  const setAction = (i: number, a: AutomationAction) => set({ actions: d.actions.map((x, j) => (j === i ? a : x)) });
  const moveAction = (i: number, by: number) => {
    const next = [...d.actions];
    const [a] = next.splice(i, 1);
    next.splice(i + by, 0, a!);
    set({ actions: next });
  };
  const newAction = (type: ActionType): AutomationAction => {
    switch (type) {
      case "set_status":
        return { type, statusId: stateOpts(false)[0]?.id ?? "" };
      case "set_priority":
        return { type, priority: 1 };
      case "add_labels":
      case "remove_labels":
        return { type, labelIds: [] };
      case "set_assignees":
      case "add_assignees":
        return { type, userIds: [] };
      case "set_field":
        return { type, fieldId: fieldList[0]?.id ?? "", value: null };
      case "comment":
        return { type, body: "" };
      case "set_due_in_days":
        return { type, days: 7 };
      case "add_to_active_cycle":
        return { type };
      case "archive":
        return { type };
    }
  };

  const multi = (label: string, opts: Option[], selected: string[], onChange: (ids: string[]) => void, empty: string) => (
    <PickerButton
      label={label}
      className="prop-btn picker-field"
      multi
      options={opts}
      selected={selected}
      onPick={(pid) => onChange(selected.includes(pid) ? selected.filter((x) => x !== pid) : [...selected, pid])}
    >
      {selected.length === 0 ? (
        <span className="muted">{empty}</span>
      ) : (
        <span className="picked">{selected.map((s) => opts.find((o) => o.id === s)?.label ?? "Removed").join(", ")}</span>
      )}
      <ChevronDown size={12} aria-hidden="true" />
    </PickerButton>
  );
  const prioritySelect = (label: string, value: number, onChange: (p: number) => void) => (
    <select className="select select-sm" aria-label={label} value={value} onChange={(e) => onChange(Number(e.target.value))}>
      {[1, 2, 3, 4, 0].map((p) => (
        <option key={p} value={p}>
          {PRIORITY_LABELS[p as Priority]}
        </option>
      ))}
    </select>
  );

  const condEditor = (k: CondKey): ReactNode => {
    switch (k) {
      case "statusIds":
        return multi("Status is", stateOpts(true), c.statusIds ?? [], (ids) => setCond({ statusIds: ids }), "Pick statuses");
      case "categories":
        return (
          <CategoryChecks label="Status category is" value={c.categories ?? []} onChange={(v) => setCond({ categories: v })} />
        );
      case "priorities":
        return multi(
          "Priority is",
          [1, 2, 3, 4, 0].map((p) => ({ id: String(p), label: PRIORITY_LABELS[p as Priority] })),
          (c.priorities ?? []).map(String),
          (ids) => setCond({ priorities: ids.map(Number) }),
          "Pick priorities",
        );
      case "labelIds":
        return multi("Has label", labelOpts, c.labelIds ?? [], (ids) => setCond({ labelIds: ids }), "Pick labels");
      case "notLabelIds":
        return multi("Doesn't have label", labelOpts, c.notLabelIds ?? [], (ids) => setCond({ notLabelIds: ids }), "Pick labels");
      case "assignee": {
        const mode = Array.isArray(c.assignee) ? "people" : (c.assignee ?? "none");
        return (
          <div className="row wrap">
            <select
              className="select select-sm"
              aria-label="Assignee"
              value={mode}
              onChange={(e) => setCond({ assignee: e.target.value === "people" ? [] : (e.target.value as "none" | "any") })}
            >
              <option value="none">No one is assigned</option>
              <option value="any">Someone is assigned</option>
              <option value="people">Assigned to specific people</option>
            </select>
            {Array.isArray(c.assignee) &&
              multi("Assigned to", peopleOpts, c.assignee, (ids) => setCond({ assignee: ids }), "Pick people")}
          </div>
        );
      }
      case "fields":
        return (
          <div className="stack-sm">
            {(c.fields ?? []).map((f, i) => {
              const field = fieldList.find((x) => x.id === f.fieldId);
              const update = (patch: Partial<{ fieldId: string; value: unknown }>) =>
                setCond({ fields: (c.fields ?? []).map((x, j) => (j === i ? { ...x, ...patch } : x)) });
              return (
                // biome-ignore lint/suspicious/noArrayIndexKey: rows have no id of their own
                <div key={i} className="row wrap">
                  <select
                    className="select select-sm"
                    aria-label="Field"
                    value={f.fieldId}
                    onChange={(e) => update({ fieldId: e.target.value, value: null })}
                  >
                    {!f.fieldId && <option value="">Pick a field</option>}
                    {fieldList.map((x) => (
                      <option key={x.id} value={x.id}>
                        {x.name}
                      </option>
                    ))}
                  </select>
                  {field && (
                    <FieldEditor field={field} value={f.value} members={members.data} meId={me.id} onChange={(v) => update({ value: v })} />
                  )}
                  {(c.fields ?? []).length > 1 && (
                    <button
                      type="button"
                      className="icon-btn small"
                      aria-label="Remove this field"
                      onClick={() => setCond({ fields: (c.fields ?? []).filter((_, j) => j !== i) })}
                    >
                      <X size={13} />
                    </button>
                  )}
                </div>
              );
            })}
            {fieldList.length === 0 && <p className="muted small">No custom fields for this scope.</p>}
            {(c.fields ?? []).length < 10 && fieldList.length > 0 && (
              <div>
                <button
                  type="button"
                  className="btn btn-ghost btn-sm"
                  onClick={() => setCond({ fields: [...(c.fields ?? []), { fieldId: fieldList[0]!.id, value: null }] })}
                >
                  <Plus size={13} aria-hidden="true" />
                  Another field
                </button>
              </div>
            )}
          </div>
        );
    }
  };

  const actionEditor = (a: AutomationAction, i: number): ReactNode => {
    switch (a.type) {
      case "set_status":
        return teamId ? (
          <select
            className="select select-sm"
            aria-label="Status"
            value={a.statusId}
            onChange={(e) => setAction(i, { ...a, statusId: e.target.value })}
          >
            {!a.statusId && <option value="">Pick a status</option>}
            {stateOpts(false).map((o) => (
              <option key={o.id} value={o.id}>
                {o.label}
              </option>
            ))}
          </select>
        ) : (
          <p className="notice notice-warning small">Statuses belong to a team. Pick a team under "Runs in" to use this action.</p>
        );
      case "set_priority":
        return prioritySelect("Priority", a.priority, (p) => setAction(i, { ...a, priority: p }));
      case "add_labels":
      case "remove_labels":
        return (
          <>
            {multi("Labels", labelOpts, a.labelIds, (ids) => setAction(i, { ...a, labelIds: ids }), "Pick labels")}
            {!teamId && <p className="muted small">Rules for all teams can only use workspace labels.</p>}
          </>
        );
      case "set_assignees":
        return multi("People", peopleOpts, a.userIds, (ids) => setAction(i, { ...a, userIds: ids }), "No one (unassign everyone)");
      case "add_assignees":
        return multi("People", peopleOpts, a.userIds, (ids) => setAction(i, { ...a, userIds: ids }), "Pick people");
      case "set_field": {
        const field = fieldList.find((x) => x.id === a.fieldId);
        return fieldList.length === 0 ? (
          <p className="muted small">No custom fields for this scope.</p>
        ) : (
          <div className="row wrap">
            <select
              className="select select-sm"
              aria-label="Field"
              value={a.fieldId}
              onChange={(e) => setAction(i, { ...a, fieldId: e.target.value, value: null })}
            >
              {!a.fieldId && <option value="">Pick a field</option>}
              {fieldList.map((x) => (
                <option key={x.id} value={x.id}>
                  {x.name}
                </option>
              ))}
            </select>
            {field && (
              <FieldEditor field={field} value={a.value} members={members.data} meId={me.id} onChange={(v) => setAction(i, { ...a, value: v })} />
            )}
          </div>
        );
      }
      case "comment":
        return (
          <textarea
            className="input"
            aria-label="Comment text"
            rows={3}
            maxLength={5000}
            placeholder="What the comment says"
            value={a.body}
            onChange={(e) => setAction(i, { ...a, body: e.target.value })}
          />
        );
      case "set_due_in_days":
        return (
          <label className="row">
            <input
              className="input input-sm narrow-num"
              type="number"
              min={0}
              max={3650}
              value={a.days}
              onChange={(e) => setAction(i, { ...a, days: Math.max(0, Math.min(3650, Math.round(Number(e.target.value) || 0))) })}
            />
            <span>days after the rule runs (0 is the same day)</span>
          </label>
        );
      case "add_to_active_cycle":
        return <p className="muted small">Adds the issue to its team's current cycle, if there is one.</p>;
      case "archive":
        return <p className="muted small">Archives the issue. Later actions are skipped.</p>;
    }
  };

  return (
    <Dialog
      title={id ? "Edit automation" : "New automation"}
      onClose={onClose}
      size="lg"
      footer={
        <>
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="btn btn-primary" onClick={save} disabled={busy}>
            {id ? "Save" : "Create automation"}
          </button>
        </>
      }
    >
      <form
        className="stack rule-form"
        onSubmit={(e) => {
          e.preventDefault();
          save();
        }}
      >
        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
        <div className="field-row">
          <div className="field">
            <label className="field-label" htmlFor={`${uid}-name`}>
              Name
            </label>
            <input
              id={`${uid}-name`}
              className="input"
              data-autofocus
              maxLength={80}
              value={d.name}
              onChange={(e) => set({ name: e.target.value })}
            />
          </div>
          <div className="field">
            <label className="field-label" htmlFor={`${uid}-team`}>
              Runs in
            </label>
            <select
              id={`${uid}-team`}
              className="select"
              value={teamId ?? ""}
              onChange={(e) => set({ teamId: e.target.value || null })}
            >
              <option value="">All teams</option>
              {teams.data?.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </select>
          </div>
        </div>

        <fieldset className="fieldset rule-section">
          <legend className="rule-legend">When</legend>
          <select
            className="select"
            aria-label="Trigger"
            value={d.trigger}
            onChange={(e) => set({ trigger: e.target.value as AutomationTrigger, triggerConfig: {} })}
          >
            {AUTOMATION_TRIGGERS.map((t) => (
              <option key={t} value={t}>
                {t === "status_changed"
                  ? "When an issue changes status"
                  : t === "no_activity"
                    ? "When an open issue has no updates for a while"
                    : describeTrigger(t, {})}
              </option>
            ))}
          </select>
          {d.trigger === "status_changed" && (
            <div className="stack-sm">
              <span className="field-label">Only when it moves to (leave empty for any status)</span>
              <CategoryChecks
                label="Status categories"
                value={tc.toCategories ?? []}
                onChange={(v) => set({ triggerConfig: { ...tc, toCategories: v } })}
              />
              {multi(
                "Statuses",
                stateOpts(true),
                tc.toStatusIds ?? [],
                (ids) => set({ triggerConfig: { ...tc, toStatusIds: ids } }),
                "Or pick statuses",
              )}
            </div>
          )}
          {d.trigger === "label_added" && (
            <div className="stack-sm">
              <span className="field-label">Only these labels (leave empty for any label)</span>
              {multi("Labels", labelOpts, tc.labelIds ?? [], (ids) => set({ triggerConfig: { ...tc, labelIds: ids } }), "Any label")}
            </div>
          )}
          {d.trigger === "no_activity" && (
            <label className="row">
              <span>No updates for</span>
              <input
                className="input input-sm narrow-num"
                type="number"
                min={1}
                max={365}
                value={tc.days ?? 14}
                onChange={(e) => set({ triggerConfig: { days: Math.max(1, Math.min(365, Math.round(Number(e.target.value) || 1))) } })}
              />
              <span>days</span>
            </label>
          )}
          {(d.trigger === "no_activity" || d.trigger === "due_date_passed") && (
            <p className="muted small">Checked every hour. Runs once per issue each time it happens.</p>
          )}
        </fieldset>

        <fieldset className="fieldset rule-section">
          <legend className="rule-legend">If (all must match)</legend>
          {usedConds.length === 0 && <p className="muted small">No conditions. The rule runs for every matching issue.</p>}
          {usedConds.map((k) => (
            <div key={k} className="rule-cond">
              <span className="rule-cond-label">{COND_LABEL[k]}</span>
              <div className="rule-cond-editor">{condEditor(k)}</div>
              <button type="button" className="icon-btn small" aria-label={`Remove condition: ${COND_LABEL[k]}`} onClick={() => removeCond(k)}>
                <X size={14} />
              </button>
            </div>
          ))}
          {usedConds.length < COND_KEYS.length && (
            <select
              className="select select-sm add-select"
              aria-label="Add a condition"
              value=""
              onChange={(e) => e.target.value && addCond(e.target.value as CondKey)}
            >
              <option value="">Add a condition...</option>
              {COND_KEYS.filter((k) => !usedConds.includes(k)).map((k) => (
                <option key={k} value={k}>
                  {COND_LABEL[k]}
                </option>
              ))}
            </select>
          )}
        </fieldset>

        <fieldset className="fieldset rule-section">
          <legend className="rule-legend">Then</legend>
          <ol className="rule-actions">
            {d.actions.map((a, i) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: actions have no id; order is the identity
              <li key={i} className="rule-action">
                <div className="rule-action-head">
                  <span className="rule-step" aria-hidden="true">
                    {i + 1}
                  </span>
                  <select
                    className="select select-sm"
                    aria-label={`Action ${i + 1}`}
                    value={a.type}
                    onChange={(e) => setAction(i, newAction(e.target.value as ActionType))}
                  >
                    {ACTION_TYPES.map((t) => (
                      <option key={t} value={t}>
                        {ACTION_LABEL[t]}
                      </option>
                    ))}
                  </select>
                  <span className="filter-spacer" />
                  <button
                    type="button"
                    className="icon-btn small"
                    aria-label={`Move action ${i + 1} up`}
                    disabled={i === 0}
                    onClick={() => moveAction(i, -1)}
                  >
                    <ArrowUp size={14} />
                  </button>
                  <button
                    type="button"
                    className="icon-btn small"
                    aria-label={`Move action ${i + 1} down`}
                    disabled={i === d.actions.length - 1}
                    onClick={() => moveAction(i, 1)}
                  >
                    <ArrowDown size={14} />
                  </button>
                  <button
                    type="button"
                    className="icon-btn small"
                    aria-label={`Remove action ${i + 1}`}
                    disabled={d.actions.length === 1}
                    onClick={() => set({ actions: d.actions.filter((_, j) => j !== i) })}
                  >
                    <Trash2 size={14} />
                  </button>
                </div>
                <div className="rule-action-body">{actionEditor(a, i)}</div>
              </li>
            ))}
          </ol>
          {d.actions.length < MAX_ACTIONS ? (
            <select
              className="select select-sm add-select"
              aria-label="Add an action"
              value=""
              onChange={(e) => e.target.value && set({ actions: [...d.actions, newAction(e.target.value as ActionType)] })}
            >
              <option value="">Add an action...</option>
              {ACTION_TYPES.map((t) => (
                <option key={t} value={t}>
                  {ACTION_LABEL[t]}
                </option>
              ))}
            </select>
          ) : (
            <p className="muted small">A rule can have up to {MAX_ACTIONS} actions.</p>
          )}
        </fieldset>

        <label className="check-row">
          <input type="checkbox" checked={d.enabled} onChange={(e) => set({ enabled: e.target.checked })} />
          Turned on
        </label>
        <p className="rule-preview">
          <span className="field-label">Summary</span>
          {ruleSummary(clean(d), {
            teams: teams.data,
            states: states.data,
            labels: labels.data,
            members: members.data,
            fields: fields.data,
          })}
        </p>
        <button type="submit" hidden />
      </form>
    </Dialog>
  );
}

function CategoryChecks({ label, value, onChange }: { label: string; value: StateCategory[]; onChange: (v: StateCategory[]) => void }) {
  return (
    <fieldset className="radio-row plain-fieldset">
      <legend className="sr-only">{label}</legend>
      {STATE_CATEGORIES.map((cat) => (
        <label key={cat} className="check-row">
          <input
            type="checkbox"
            checked={value.includes(cat)}
            onChange={(e) => onChange(e.target.checked ? [...value, cat] : value.filter((x) => x !== cat))}
          />
          {CATEGORY_LABEL[cat]}
        </label>
      ))}
    </fieldset>
  );
}
