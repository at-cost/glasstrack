import { PRIORITY_LABELS, type Priority } from "@glasstrack/shared";
import { Calendar, ChevronDown, ChevronRight, FileText, Tag } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { Dialog } from "../../components/Dialog";
import { AvatarStack, LabelDot, PriorityIcon, StatusIcon } from "../../components/icons";
import { MarkdownEditor } from "../../components/MarkdownEditor";
import { PickerButton } from "../../components/Picker";
import { useCreateIssue } from "../../lib/mutations";
import { useFields, useLabels, useMembers, useStates, useTeams, useTemplates } from "../../lib/queries";
import type { CreateDefaults } from "../../lib/store";
import { toast } from "../../lib/toast";
import { useWs } from "../shell/context";
import { FieldEditor, fieldsForTeam, isEmptyValue } from "./fields";
import { assigneeOptions, labelOptions, priorityOptions, statusOptions, teamStates, toggleAssignee } from "./options";

export function CreateIssueDialog({ defaults, onClose }: { defaults: CreateDefaults; onClose: () => void }) {
  const { slug, me, canEdit } = useWs();
  const teams = useTeams(slug);
  const states = useStates(slug);
  const members = useMembers(slug);
  const labels = useLabels(slug);
  const fields = useFields(slug);
  const templates = useTemplates(slug);
  const create = useCreateIssue(slug, me.id);

  const [teamId, setTeamId] = useState(defaults.teamId ?? "");
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [statusId, setStatusId] = useState(defaults.statusId ?? "");
  const [priority, setPriority] = useState<Priority>(0);
  const [assigneeIds, setAssigneeIds] = useState<string[]>(defaults.assigneeIds ?? []);
  const [labelIds, setLabelIds] = useState<string[]>([]);
  const [dueDate, setDueDate] = useState("");
  const [startDate, setStartDate] = useState("");
  const [estimate, setEstimate] = useState<number | null>(null);
  const [values, setValues] = useState<Record<string, unknown>>({});
  const [templateId, setTemplateId] = useState<string | null>(null);
  const [moreOpen, setMoreOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!teamId && teams.data?.length) setTeamId(teams.data[0]!.id);
  }, [teams.data, teamId]);

  const tStates = useMemo(() => teamStates(states.data, teamId), [states.data, teamId]);
  // Default status: first backlog, else first unstarted, matching the server.
  useEffect(() => {
    if (!teamId || !tStates.length) return;
    if (statusId && tStates.some((s) => s.id === statusId)) return;
    const pick = tStates.find((s) => s.category === "backlog") ?? tStates.find((s) => s.category === "unstarted") ?? tStates[0]!;
    setStatusId(pick.id);
  }, [teamId, tStates, statusId]);

  const status = tStates.find((s) => s.id === statusId);
  const assignees = assigneeIds.map((id) => members.data?.find((m) => m.userId === id)).filter((m) => m !== undefined);
  const chosenLabels = (labels.data ?? []).filter((l) => labelIds.includes(l.id));
  const teamFields = fieldsForTeam(fields.data, teamId);
  const filledFields = teamFields.filter((f) => !isEmptyValue(values[f.id])).length;
  const template = templates.data?.find((t) => t.id === templateId);

  /** Fills the form from a template. The server records which template was used. */
  const applyTemplate = (id: string) => {
    if (id === "__none") {
      setTemplateId(null);
      return;
    }
    const t = templates.data?.find((x) => x.id === id);
    if (!t) return;
    setTemplateId(t.id);
    setTeamId(t.teamId);
    setTitle(t.title);
    setDescription(t.description);
    setStatusId(t.statusId ?? "");
    setPriority(t.priority as Priority);
    setLabelIds(t.labelIds);
    setAssigneeIds(t.assigneeIds);
    setEstimate(t.estimate);
    setValues(t.fields ?? {});
    if (Object.keys(t.fields ?? {}).length) setMoreOpen(true);
    setError(null);
  };
  const templateOptions = [
    { id: "__none", label: "No template" },
    ...(templates.data ?? [])
      .filter((t) => teams.data?.some((x) => x.id === t.teamId))
      .map((t) => ({ id: t.id, label: t.name, hint: teams.data?.find((x) => x.id === t.teamId)?.key })),
  ];

  const submit = () => {
    if (!title.trim()) {
      setError("Add a title.");
      return;
    }
    // Teams may still be loading right after sign-up; wait for them instead of failing.
    if (teams.isPending) return;
    if (!teamId) {
      setError("Pick a team.");
      return;
    }
    if (startDate && dueDate && startDate > dueDate) {
      setError("The start date must be on or before the due date.");
      setMoreOpen(true);
      return;
    }
    create.mutate(
      {
        teamId,
        title: title.trim(),
        description,
        statusId: statusId || undefined,
        priority,
        assigneeIds,
        labelIds,
        dueDate: dueDate || null,
        startDate: startDate || null,
        estimate,
        parentId: defaults.parentId ?? null,
        fields: Object.fromEntries(teamFields.filter((f) => !isEmptyValue(values[f.id])).map((f) => [f.id, values[f.id]])),
        ...(templateId ? { templateId } : {}),
      },
      {
        onSuccess: (issue) => toast(`Created ${issue.identifier}`, "success"),
      },
    );
    onClose();
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      submit();
    }
  };

  return (
    <Dialog
      title={defaults.parentId ? "New sub-issue" : "New issue"}
      onClose={onClose}
      size="lg"
      footer={
        <>
          <span className="muted small hide-mobile">Ctrl Enter to create</span>
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="btn btn-primary" onClick={submit} disabled={!canEdit || create.isPending || teams.isPending}>
            Create issue
          </button>
        </>
      }
    >
      {/* biome-ignore lint/a11y/noStaticElementInteractions: catches Ctrl+Enter from any field in the form */}
      <div className="create-form" onKeyDown={onKeyDown}>
        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
        {(templates.data?.length ?? 0) > 0 && (
          <div className="create-template">
            <PickerButton
              label="Template"
              className="chip-btn"
              options={templateOptions}
              selected={[templateId ?? "__none"]}
              onPick={applyTemplate}
              testId="template-picker"
            >
              <FileText size={14} aria-hidden="true" />
              {template ? `Template: ${template.name}` : "Template"}
            </PickerButton>
          </div>
        )}
        <input
          className="input title-input"
          aria-label="Issue title"
          placeholder="Issue title"
          value={title}
          maxLength={300}
          data-autofocus
          onChange={(e) => {
            setTitle(e.target.value);
            setError(null);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.metaKey && !e.ctrlKey) {
              e.preventDefault();
              submit();
            }
          }}
        />
        <MarkdownEditor
          value={description}
          onChange={setDescription}
          members={members.data}
          onSubmit={submit}
          label="Description"
          placeholder="Add a description"
          rows={5}
        />
        <div className="create-props">
          <label className="select-wrap">
            <span className="sr-only">Team</span>
            <select
              className="select"
              value={teamId}
              onChange={(e) => {
                setTeamId(e.target.value);
                setStatusId("");
                setLabelIds([]);
                setValues({});
              }}
            >
              {teams.data?.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.key} {t.name}
                </option>
              ))}
            </select>
          </label>
          <PickerButton
            label="Status"
            className="chip-btn"
            options={statusOptions(states.data, teamId)}
            selected={[statusId]}
            onPick={setStatusId}
          >
            <StatusIcon state={status} />
            {status?.name ?? "Status"}
          </PickerButton>
          <PickerButton
            label="Priority"
            className="chip-btn"
            options={priorityOptions()}
            selected={[String(priority)]}
            onPick={(id) => setPriority(Number(id) as Priority)}
          >
            <PriorityIcon priority={priority} />
            {priority === 0 ? "Priority" : PRIORITY_LABELS[priority]}
          </PickerButton>
          <PickerButton
            label="Assignees"
            className="chip-btn"
            multi
            options={assigneeOptions(members.data, me.id)}
            selected={assigneeIds.length ? assigneeIds : ["none"]}
            onPick={(id) => setAssigneeIds((ids) => toggleAssignee(ids, id))}
          >
            <AvatarStack ids={assigneeIds} members={members.data} size={16} />
            {assigneeIds.length === 0 ? "Assignee" : assignees.length === 1 && assigneeIds.length === 1 ? assignees[0]!.name : `${assigneeIds.length} assignees`}
          </PickerButton>
          <PickerButton
            label="Labels"
            className="chip-btn"
            multi
            options={labelOptions(labels.data, teamId)}
            selected={labelIds}
            onPick={(id) => setLabelIds((ids) => (ids.includes(id) ? ids.filter((x) => x !== id) : [...ids, id]))}
          >
            {chosenLabels.length ? chosenLabels.map((l) => <LabelDot key={l.id} color={l.color} />) : <Tag size={14} aria-hidden="true" />}
            {chosenLabels.length === 0 ? "Labels" : chosenLabels.length === 1 ? chosenLabels[0]!.name : `${chosenLabels.length} labels`}
          </PickerButton>
          <label className="chip-btn date-chip">
            <Calendar size={14} aria-hidden="true" />
            <span className="sr-only">Due date</span>
            <input
              type="date"
              className="date-input"
              value={dueDate}
              min={startDate || undefined}
              onChange={(e) => {
                setDueDate(e.target.value);
                setError(null);
              }}
              aria-label="Due date"
            />
          </label>
        </div>
        <div className="more-fields">
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            aria-expanded={moreOpen}
            aria-controls="create-more-fields"
            onClick={() => setMoreOpen((o) => !o)}
          >
            {moreOpen ? <ChevronDown size={14} aria-hidden="true" /> : <ChevronRight size={14} aria-hidden="true" />}
            More
            {filledFields + (startDate ? 1 : 0) > 0 && <span className="group-count">{filledFields + (startDate ? 1 : 0)} set</span>}
          </button>
          {moreOpen && (
            <div className="more-fields-grid" id="create-more-fields">
              <div className="prop-row">
                <label className="prop-label" htmlFor="create-start-date">
                  Start date
                </label>
                <div className="prop-value">
                  <span className="prop-btn date-prop">
                    <Calendar size={14} aria-hidden="true" />
                    <input
                      id="create-start-date"
                      type="date"
                      className="date-input"
                      value={startDate}
                      max={dueDate || undefined}
                      onChange={(e) => {
                        setStartDate(e.target.value);
                        setError(null);
                      }}
                    />
                  </span>
                </div>
              </div>
              {teamFields.map((f) => (
                <div key={f.id} className="prop-row">
                  <span className="prop-label" title={f.name}>
                    {f.name}
                  </span>
                  <div className="prop-value">
                    <FieldEditor
                      field={f}
                      value={values[f.id]}
                      members={members.data}
                      meId={me.id}
                      onChange={(v) => setValues((cur) => ({ ...cur, [f.id]: v }))}
                    />
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
      {defaults.parentId && <p className="muted small">This issue will be a sub-issue.</p>}
    </Dialog>
  );
}
