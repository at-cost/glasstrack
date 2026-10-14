import { PRIORITY_LABELS, type Priority } from "@glasstrack/shared";
import { Calendar, Tag } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { Dialog } from "../../components/Dialog";
import { Avatar, LabelDot, PriorityIcon, StatusIcon } from "../../components/icons";
import { MarkdownEditor } from "../../components/MarkdownEditor";
import { PickerButton } from "../../components/Picker";
import { useCreateIssue } from "../../lib/mutations";
import { useLabels, useMembers, useStates, useTeams } from "../../lib/queries";
import type { CreateDefaults } from "../../lib/store";
import { toast } from "../../lib/toast";
import { useWs } from "../shell/context";
import { assigneeOptions, labelOptions, priorityOptions, statusOptions, teamStates } from "./options";

export function CreateIssueDialog({ defaults, onClose }: { defaults: CreateDefaults; onClose: () => void }) {
  const { slug, me, canEdit } = useWs();
  const teams = useTeams(slug);
  const states = useStates(slug);
  const members = useMembers(slug);
  const labels = useLabels(slug);
  const create = useCreateIssue(slug, me.id);

  const [teamId, setTeamId] = useState(defaults.teamId ?? "");
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [statusId, setStatusId] = useState(defaults.statusId ?? "");
  const [priority, setPriority] = useState<Priority>(0);
  const [assigneeId, setAssigneeId] = useState<string | null>(defaults.assigneeId ?? null);
  const [labelIds, setLabelIds] = useState<string[]>([]);
  const [dueDate, setDueDate] = useState("");
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
  const assignee = members.data?.find((m) => m.userId === assigneeId);
  const chosenLabels = (labels.data ?? []).filter((l) => labelIds.includes(l.id));

  const submit = () => {
    if (!title.trim()) {
      setError("Add a title.");
      return;
    }
    if (!teamId) {
      setError("Pick a team.");
      return;
    }
    create.mutate(
      {
        teamId,
        title: title.trim(),
        description,
        statusId: statusId || undefined,
        priority,
        assigneeId,
        labelIds,
        dueDate: dueDate || null,
        parentId: defaults.parentId ?? null,
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
          <button type="button" className="btn btn-primary" onClick={submit} disabled={!canEdit || create.isPending}>
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
            label="Assignee"
            className="chip-btn"
            options={assigneeOptions(members.data, me.id)}
            selected={[assigneeId ?? "none"]}
            onPick={(id) => setAssigneeId(id === "none" ? null : id)}
          >
            <Avatar member={assignee ?? null} size={16} />
            {assignee?.name ?? "Assignee"}
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
            <input type="date" className="date-input" value={dueDate} onChange={(e) => setDueDate(e.target.value)} aria-label="Due date" />
          </label>
        </div>
      </div>
      {defaults.parentId && <p className="muted small">This issue will be a sub-issue.</p>}
    </Dialog>
  );
}
