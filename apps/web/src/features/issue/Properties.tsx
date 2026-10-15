import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { type IssueDetail, PRIORITY_LABELS } from "@glasstrack/shared";
import { Calendar, X } from "lucide-react";
import { useEffect, useState } from "react";
import { AvatarStack, LabelDot, PriorityIcon, StatusIcon } from "../../components/icons";
import { OptionList, Popover, PickerButton } from "../../components/Picker";
import { api } from "../../lib/api";
import { useUpdateIssue } from "../../lib/mutations";
import { paths } from "../../lib/paths";
import { useCycles, useFields, useLabels, useMembers, useStates } from "../../lib/queries";
import { useWs } from "../shell/context";
import { FieldEditor, fieldsForTeam } from "./fields";
import { assigneeOptions, cycleLabel, cycleOptions, labelOptions, patchFor, priorityOptions, statusOptions } from "./options";
import { useIssueById } from "./QuickPicker";

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="prop-row">
      <span className="prop-label" title={label}>
        {label}
      </span>
      <div className="prop-value">{children}</div>
    </div>
  );
}

export function useIssueSearch(query: string, excludeIds: string[] = []) {
  const { slug } = useWs();
  const [debounced, setDebounced] = useState(query);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(query.trim()), 180);
    return () => clearTimeout(t);
  }, [query]);
  const q = useQuery({
    queryKey: ["search", slug, debounced],
    queryFn: () => api.ws(slug).search(debounced),
    enabled: debounced.length > 0,
    staleTime: 10_000,
  });
  return { results: (q.data?.issues ?? []).filter((i) => !excludeIds.includes(i.id)), loading: q.isFetching };
}

/** Popover listing issues found by /search. */
export function IssueSearchPopover({
  anchor,
  onClose,
  onPick,
  exclude,
  label,
}: {
  anchor: HTMLElement | null;
  onClose: () => void;
  onPick: (issue: { id: string; identifier: string; title: string }) => void;
  exclude: string[];
  label: string;
}) {
  const { slug } = useWs();
  const states = useStates(slug);
  const [query, setQuery] = useState("");
  const { results, loading } = useIssueSearch(query, exclude);
  return (
    <Popover anchor={anchor} onClose={onClose} label={label} width={340}>
      <OptionList
        label={label}
        placeholder="Search by title or key, like ENG-12"
        filter={false}
        query={query}
        onQueryChange={setQuery}
        options={results.map((r) => ({
          id: r.id,
          label: r.title,
          hint: r.identifier,
          icon: <StatusIcon state={states.data?.find((s) => s.id === r.statusId)} />,
        }))}
        onPick={(id) => {
          const r = results.find((x) => x.id === id);
          if (r) onPick(r);
        }}
        onClose={onClose}
        emptyText={query.trim() ? (loading ? "Searching..." : "No issues found") : "Type to search"}
      />
    </Popover>
  );
}

function ParentPicker({ issue, disabled }: { issue: IssueDetail; disabled: boolean }) {
  const { slug } = useWs();
  const update = useUpdateIssue(slug);
  const parent = useIssueById(slug, issue.parentId ?? "");
  const [anchor, setAnchor] = useState<HTMLButtonElement | null>(null);
  const [open, setOpen] = useState(false);
  return (
    <div className="prop-inline">
      {issue.parentId && parent ? (
        <Link to={paths.issue(slug, parent.identifier)} className="link-chip" title={parent.title}>
          {parent.identifier}
        </Link>
      ) : null}
      <button
        ref={setAnchor}
        type="button"
        className="prop-btn"
        disabled={disabled}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen(true)}
      >
        {issue.parentId ? "Change" : "Set parent"}
      </button>
      {issue.parentId && !disabled && (
        <button
          type="button"
          className="icon-btn small"
          aria-label="Remove parent"
          onClick={() => update.mutate({ issue, patch: { parentId: null } })}
        >
          <X size={13} />
        </button>
      )}
      {open && (
        <IssueSearchPopover
          anchor={anchor}
          label="Parent issue"
          exclude={[issue.id, ...issue.children.map((c) => c.id)]}
          onClose={() => {
            setOpen(false);
            anchor?.focus();
          }}
          onPick={(r) => {
            update.mutate({ issue, patch: { parentId: r.id } });
            setOpen(false);
          }}
        />
      )}
    </div>
  );
}

export function Properties({ issue }: { issue: IssueDetail }) {
  const { slug, me, canEdit } = useWs();
  const states = useStates(slug);
  const members = useMembers(slug);
  const labels = useLabels(slug);
  const cycles = useCycles(slug);
  const fields = useFields(slug);
  const update = useUpdateIssue(slug);
  const [estimate, setEstimate] = useState(issue.estimate === null ? "" : String(issue.estimate));
  useEffect(() => setEstimate(issue.estimate === null ? "" : String(issue.estimate)), [issue.estimate]);

  const state = states.data?.find((s) => s.id === issue.statusId);
  const assignees = issue.assigneeIds.map((id) => members.data?.find((m) => m.userId === id)).filter((m) => m !== undefined);
  const teamFields = fieldsForTeam(fields.data, issue.teamId);
  const issueLabels = (labels.data ?? []).filter((l) => issue.labelIds.includes(l.id));
  const cycle = cycles.data?.find((c) => c.id === issue.cycleId);
  const pick = (kind: "status" | "priority" | "assignee" | "labels" | "cycle") => (id: string) =>
    update.mutate({ issue, patch: patchFor(kind, issue, id) });
  const disabled = !canEdit;

  const saveEstimate = () => {
    const v = estimate.trim();
    const n = v === "" ? null : Number(v);
    if (n !== null && (Number.isNaN(n) || n < 0 || n > 1000)) {
      setEstimate(issue.estimate === null ? "" : String(issue.estimate));
      return;
    }
    if (n !== issue.estimate) update.mutate({ issue, patch: { estimate: n } });
  };

  return (
    <aside className="props" aria-label="Properties">
      <Row label="Status">
        <PickerButton
          label="Status"
          options={statusOptions(states.data, issue.teamId)}
          selected={[issue.statusId]}
          onPick={pick("status")}
          disabled={disabled}
          testId="status-picker"
        >
          <StatusIcon state={state} />
          {state?.name ?? "Status"}
        </PickerButton>
      </Row>
      <Row label="Priority">
        <PickerButton
          label="Priority"
          options={priorityOptions()}
          selected={[String(issue.priority)]}
          onPick={pick("priority")}
          disabled={disabled}
        >
          <PriorityIcon priority={issue.priority} />
          {PRIORITY_LABELS[issue.priority]}
        </PickerButton>
      </Row>
      <Row label="Assignees">
        <PickerButton
          label="Assignees"
          multi
          options={assigneeOptions(members.data, me.id)}
          selected={issue.assigneeIds.length ? issue.assigneeIds : ["none"]}
          onPick={pick("assignee")}
          disabled={disabled}
          testId="assignee-picker"
        >
          <AvatarStack ids={issue.assigneeIds} members={members.data} size={18} />
          <span className="prop-text">
            {issue.assigneeIds.length === 0
              ? "Unassigned"
              : assignees.length === issue.assigneeIds.length
                ? assignees.map((m) => m.name).join(", ")
                : `${issue.assigneeIds.length} people`}
          </span>
        </PickerButton>
      </Row>
      <Row label="Labels">
        <PickerButton
          label="Labels"
          multi
          options={labelOptions(labels.data, issue.teamId)}
          selected={issue.labelIds}
          onPick={pick("labels")}
          disabled={disabled}
        >
          {issueLabels.length === 0 ? (
            <span className="muted">Add labels</span>
          ) : (
            <span className="label-list">
              {issueLabels.map((l) => (
                <span key={l.id} className="label-chip">
                  <LabelDot color={l.color} />
                  {l.name}
                </span>
              ))}
            </span>
          )}
        </PickerButton>
      </Row>
      <Row label="Cycle">
        <PickerButton
          label="Cycle"
          options={cycleOptions(cycles.data, issue.teamId)}
          selected={[issue.cycleId ?? "none"]}
          onPick={pick("cycle")}
          disabled={disabled}
        >
          {cycle ? cycleLabel(cycle) : <span className="muted">No cycle</span>}
        </PickerButton>
      </Row>
      <Row label="Due date">
        <label className="prop-btn date-prop">
          <Calendar size={14} aria-hidden="true" />
          <input
            type="date"
            className="date-input"
            aria-label="Due date"
            value={issue.dueDate ?? ""}
            disabled={disabled}
            onChange={(e) => update.mutate({ issue, patch: { dueDate: e.target.value || null } })}
          />
        </label>
      </Row>
      <Row label="Estimate">
        <input
          className="input input-sm"
          type="number"
          min={0}
          max={1000}
          step="0.5"
          inputMode="decimal"
          aria-label="Estimate"
          placeholder="None"
          value={estimate}
          disabled={disabled}
          onChange={(e) => setEstimate(e.target.value)}
          onBlur={saveEstimate}
          onKeyDown={(e) => {
            if (e.key === "Enter") (e.target as HTMLInputElement).blur();
          }}
        />
      </Row>
      <Row label="Parent">
        <ParentPicker issue={issue} disabled={disabled} />
      </Row>
      {teamFields.length > 0 && (
        <div className="props-fields">
          {teamFields.map((f) => (
            <Row key={f.id} label={f.name}>
              <FieldEditor
                field={f}
                value={issue.fields?.[f.id]}
                members={members.data}
                meId={me.id}
                disabled={disabled}
                onChange={(v) => update.mutate({ issue, patch: { fields: { [f.id]: v } } })}
              />
            </Row>
          ))}
        </div>
      )}
    </aside>
  );
}
