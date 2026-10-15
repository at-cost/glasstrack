import { useQueryClient } from "@tanstack/react-query";
import { type IssueTemplate, PRIORITY_LABELS, type Priority, type RecurringIssue, type Team } from "@glasstrack/shared";
import { Pause, Pencil, Play, Plus, Repeat, Tag, Trash2 } from "lucide-react";
import { useId, useState } from "react";
import { Card } from "../../components/Card";
import { ConfirmDialog, Dialog } from "../../components/Dialog";
import { Empty, Skeleton } from "../../components/Feedback";
import { AvatarStack, LabelDot, PriorityIcon, StatusIcon } from "../../components/icons";
import { MarkdownEditor } from "../../components/MarkdownEditor";
import { PickerButton } from "../../components/Picker";
import { api, errorMessage, type RecurringInput, type TemplateInput } from "../../lib/api";
import { todayISO } from "../../lib/format";
import { keys, useFields, useLabels, useMembers, useRecurring, useStates, useTeams, useTemplates } from "../../lib/queries";
import { toast, toastError } from "../../lib/toast";
import { FieldEditor, fieldsForTeam, isEmptyValue } from "../issue/fields";
import { assigneeOptions, labelOptions, priorityOptions, statusOptions, teamStates, toggleAssignee } from "../issue/options";
import { useWs } from "../shell/context";
import {
  browserTimeZone,
  describeSchedule,
  formatRunTime,
  hourLabel,
  previewNextRun,
  type Schedule,
  timeZones,
  WEEKDAY_ORDER,
  WEEKDAYS,
} from "./schedule";

export function Templates() {
  const { slug } = useWs();
  const teams = useTeams(slug);
  const templates = useTemplates(slug);
  const recurring = useRecurring(slug);
  if (teams.isPending || templates.isPending) return <Skeleton rows={4} />;
  if (templates.error) return <Empty title="Could not load templates">{errorMessage(templates.error)}</Empty>;
  return (
    <>
      <p className="muted small settings-intro">
        Templates pre-fill the new issue form. Add a schedule to create an issue from a template on a regular basis.
      </p>
      {teams.data?.map((t) => (
        <TeamTemplates
          key={t.id}
          team={t}
          templates={(templates.data ?? []).filter((x) => x.teamId === t.id)}
          schedules={recurring.data ?? []}
        />
      ))}
    </>
  );
}

function TeamTemplates({ team, templates, schedules }: { team: Team; templates: IssueTemplate[]; schedules: RecurringIssue[] }) {
  const { canEdit, workspace } = useWs();
  const [editing, setEditing] = useState<IssueTemplate | "new" | null>(null);
  const editable = canEdit && workspace.role !== "guest";
  return (
    <Card
      title={team.name}
      actions={
        editable ? (
          <button type="button" className="btn btn-sm" onClick={() => setEditing("new")}>
            <Plus size={13} aria-hidden="true" />
            New template
          </button>
        ) : undefined
      }
    >
      {templates.length === 0 ? (
        <p className="muted small">No templates for {team.name} yet.</p>
      ) : (
        <ul className="template-list">
          {templates.map((t) => (
            <TemplateRow
              key={t.id}
              template={t}
              editable={editable}
              schedules={schedules.filter((s) => s.templateId === t.id)}
              onEdit={() => setEditing(t)}
            />
          ))}
        </ul>
      )}
      {editing && <TemplateDialog team={team} template={editing === "new" ? null : editing} onClose={() => setEditing(null)} />}
    </Card>
  );
}

function TemplateRow({
  template,
  editable,
  schedules,
  onEdit,
}: {
  template: IssueTemplate;
  editable: boolean;
  schedules: RecurringIssue[];
  onEdit: () => void;
}) {
  const { slug } = useWs();
  const qc = useQueryClient();
  const members = useMembers(slug);
  const [deleting, setDeleting] = useState(false);
  const [repeat, setRepeat] = useState<RecurringIssue | "new" | null>(null);
  const remove = async () => {
    qc.setQueryData<IssueTemplate[]>(keys.templates(slug), (l) => l?.filter((x) => x.id !== template.id));
    try {
      await api.ws(slug).deleteTemplate(template.id);
      toast(`Deleted ${template.name}`, "success");
    } catch (e) {
      toastError(errorMessage(e));
    }
    qc.invalidateQueries({ queryKey: keys.templates(slug) });
    qc.invalidateQueries({ queryKey: keys.recurring(slug) });
  };
  return (
    <li className="template-row">
      <div className="template-head">
        <div className="template-info">
          <span className="template-name">{template.name}</span>
          <span className="muted small template-title">
            {template.priority > 0 && <PriorityIcon priority={template.priority as Priority} size={12} />}
            {template.title}
          </span>
        </div>
        {template.assigneeIds.length > 0 && <AvatarStack ids={template.assigneeIds} members={members.data} size={18} />}
        {editable && (
          <span className="edit-actions">
            <button type="button" className="btn btn-sm" onClick={() => setRepeat("new")}>
              <Repeat size={13} aria-hidden="true" />
              Repeat
            </button>
            <button type="button" className="icon-btn small" aria-label={`Edit template ${template.name}`} onClick={onEdit}>
              <Pencil size={13} />
            </button>
            <button
              type="button"
              className="icon-btn small"
              aria-label={`Delete template ${template.name}`}
              onClick={() => setDeleting(true)}
            >
              <Trash2 size={13} />
            </button>
          </span>
        )}
      </div>
      {schedules.length > 0 && (
        <ul className="schedule-list" aria-label={`Schedules for ${template.name}`}>
          {schedules.map((s) => (
            <ScheduleRow key={s.id} schedule={s} editable={editable} onEdit={() => setRepeat(s)} />
          ))}
        </ul>
      )}
      {deleting && (
        <ConfirmDialog
          title={`Delete template ${template.name}?`}
          message={schedules.length ? "Its schedules stop too. Issues already created stay." : "Issues already created from it stay."}
          confirmLabel="Delete template"
          danger
          onConfirm={remove}
          onClose={() => setDeleting(false)}
        />
      )}
      {repeat && <ScheduleDialog template={template} schedule={repeat === "new" ? null : repeat} onClose={() => setRepeat(null)} />}
    </li>
  );
}

function ScheduleRow({ schedule, editable, onEdit }: { schedule: RecurringIssue; editable: boolean; onEdit: () => void }) {
  const { slug } = useWs();
  const qc = useQueryClient();
  const [deleting, setDeleting] = useState(false);
  const refresh = () => qc.invalidateQueries({ queryKey: keys.recurring(slug) });
  const setActive = async (active: boolean) => {
    qc.setQueryData<RecurringIssue[]>(keys.recurring(slug), (l) => l?.map((x) => (x.id === schedule.id ? { ...x, active } : x)));
    try {
      // Send the whole schedule: the server's partial update fills missing keys with defaults.
      const { frequency, interval, weekdays, monthDay, hour, timezone, startsOn } = schedule;
      await api.ws(slug).updateRecurring(schedule.id, { frequency, interval, weekdays, monthDay, hour, timezone, startsOn, active });
      toast(active ? "Schedule resumed" : "Schedule paused", "success");
    } catch (e) {
      toastError(errorMessage(e));
    }
    refresh();
  };
  const remove = async () => {
    qc.setQueryData<RecurringIssue[]>(keys.recurring(slug), (l) => l?.filter((x) => x.id !== schedule.id));
    try {
      await api.ws(slug).deleteRecurring(schedule.id);
      toast("Schedule deleted", "success");
    } catch (e) {
      toastError(errorMessage(e));
    }
    refresh();
  };
  return (
    <li className={`schedule-row${schedule.active ? "" : " paused"}`}>
      <Repeat size={13} aria-hidden="true" className="schedule-icon" />
      <span className="schedule-text">
        <span>{describeSchedule(schedule)}</span>
        <span className="muted small">
          {schedule.active ? `Next: ${formatRunTime(schedule.nextRunAt, schedule.timezone)}` : "Paused"}
          {schedule.lastRunAt && ` · Last: ${formatRunTime(schedule.lastRunAt, schedule.timezone)}`}
        </span>
      </span>
      {editable && (
        <span className="edit-actions">
          <button type="button" className="btn btn-sm" onClick={() => setActive(!schedule.active)}>
            {schedule.active ? <Pause size={12} aria-hidden="true" /> : <Play size={12} aria-hidden="true" />}
            {schedule.active ? "Pause" : "Resume"}
          </button>
          <button type="button" className="icon-btn small" aria-label="Edit schedule" onClick={onEdit}>
            <Pencil size={13} />
          </button>
          <button type="button" className="icon-btn small" aria-label="Delete schedule" onClick={() => setDeleting(true)}>
            <Trash2 size={13} />
          </button>
        </span>
      )}
      {deleting && (
        <ConfirmDialog
          title="Delete this schedule?"
          message="No more issues are created from it. Issues already created stay."
          confirmLabel="Delete schedule"
          danger
          onConfirm={remove}
          onClose={() => setDeleting(false)}
        />
      )}
    </li>
  );
}

function TemplateDialog({ team, template, onClose }: { team: Team; template: IssueTemplate | null; onClose: () => void }) {
  const { slug, me } = useWs();
  const qc = useQueryClient();
  const id = useId();
  const states = useStates(slug);
  const members = useMembers(slug);
  const labels = useLabels(slug);
  const fields = useFields(slug);
  const [name, setName] = useState(template?.name ?? "");
  const [title, setTitle] = useState(template?.title ?? "");
  const [description, setDescription] = useState(template?.description ?? "");
  const [statusId, setStatusId] = useState<string | null>(template?.statusId ?? null);
  const [priority, setPriority] = useState<Priority>((template?.priority ?? 0) as Priority);
  const [assigneeIds, setAssigneeIds] = useState<string[]>(template?.assigneeIds ?? []);
  const [labelIds, setLabelIds] = useState<string[]>(template?.labelIds ?? []);
  const [estimate, setEstimate] = useState(template?.estimate == null ? "" : String(template.estimate));
  const [values, setValues] = useState<Record<string, unknown>>(template?.fields ?? {});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const tStates = teamStates(states.data, team.id);
  const status = tStates.find((s) => s.id === statusId);
  const chosenLabels = (labels.data ?? []).filter((l) => labelIds.includes(l.id));
  const teamFields = fieldsForTeam(fields.data, team.id);

  const save = async (e?: React.FormEvent) => {
    e?.preventDefault();
    if (!name.trim()) return setError("Add a template name.");
    if (!title.trim()) return setError("Add an issue title.");
    const est = estimate.trim() === "" ? null : Number(estimate);
    if (est !== null && (!Number.isFinite(est) || est < 0 || est > 1000)) return setError("The estimate must be a number from 0 to 1000.");
    const body: TemplateInput = {
      teamId: team.id,
      name: name.trim(),
      title: title.trim(),
      description,
      statusId,
      priority,
      labelIds,
      assigneeIds,
      estimate: est,
      fields: Object.fromEntries(teamFields.filter((f) => !isEmptyValue(values[f.id])).map((f) => [f.id, values[f.id]])),
    };
    setBusy(true);
    setError(null);
    try {
      if (template) {
        const { teamId: _t, ...patch } = body;
        await api.ws(slug).updateTemplate(template.id, patch);
      } else {
        await api.ws(slug).createTemplate(body);
      }
      await qc.invalidateQueries({ queryKey: keys.templates(slug) });
      toast(template ? "Template saved" : "Template created", "success");
      onClose();
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  };

  return (
    <Dialog
      title={template ? `Edit template ${template.name}` : `New template for ${team.name}`}
      onClose={onClose}
      size="lg"
      footer={
        <>
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="btn btn-primary" onClick={() => save()} disabled={busy}>
            {template ? "Save template" : "Create template"}
          </button>
        </>
      }
    >
      <form className="create-form" onSubmit={save}>
        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
        <div className="field">
          <label className="field-label" htmlFor={`${id}-name`}>
            Template name
          </label>
          <input
            id={`${id}-name`}
            className="input"
            data-autofocus
            value={name}
            maxLength={80}
            placeholder="Bug report"
            onChange={(e) => setName(e.target.value)}
          />
        </div>
        <div className="field">
          <label className="field-label" htmlFor={`${id}-title`}>
            Issue title
          </label>
          <input id={`${id}-title`} className="input" value={title} maxLength={300} onChange={(e) => setTitle(e.target.value)} />
        </div>
        <MarkdownEditor
          value={description}
          onChange={setDescription}
          members={members.data}
          label="Description"
          placeholder="Add a description"
          rows={5}
        />
        <div className="create-props">
          <PickerButton
            label="Status"
            className="chip-btn"
            options={[{ id: "__default", label: "Team default" }, ...statusOptions(states.data, team.id)]}
            selected={[statusId ?? "__default"]}
            onPick={(sid) => setStatusId(sid === "__default" ? null : sid)}
          >
            <StatusIcon state={status} />
            {status?.name ?? "Default status"}
          </PickerButton>
          <PickerButton
            label="Priority"
            className="chip-btn"
            options={priorityOptions()}
            selected={[String(priority)]}
            onPick={(p) => setPriority(Number(p) as Priority)}
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
            onPick={(uid) => setAssigneeIds((ids) => toggleAssignee(ids, uid))}
          >
            <AvatarStack ids={assigneeIds} members={members.data} size={16} />
            {assigneeIds.length === 0 ? "Assignee" : `${assigneeIds.length} assignee${assigneeIds.length === 1 ? "" : "s"}`}
          </PickerButton>
          <PickerButton
            label="Labels"
            className="chip-btn"
            multi
            options={labelOptions(labels.data, team.id)}
            selected={labelIds}
            onPick={(lid) => setLabelIds((ids) => (ids.includes(lid) ? ids.filter((x) => x !== lid) : [...ids, lid]))}
          >
            {chosenLabels.length ? chosenLabels.map((l) => <LabelDot key={l.id} color={l.color} />) : <Tag size={14} aria-hidden="true" />}
            {chosenLabels.length === 0 ? "Labels" : chosenLabels.length === 1 ? chosenLabels[0]!.name : `${chosenLabels.length} labels`}
          </PickerButton>
          <label className="chip-btn estimate-chip">
            <span>Estimate</span>
            <input
              className="date-input estimate-input"
              type="number"
              min={0}
              max={1000}
              step="0.5"
              inputMode="decimal"
              placeholder="None"
              value={estimate}
              onChange={(e) => setEstimate(e.target.value)}
            />
          </label>
        </div>
        {teamFields.length > 0 && (
          <fieldset className="fieldset more-fields-grid">
            <legend className="field-label">Fields</legend>
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
          </fieldset>
        )}
      </form>
    </Dialog>
  );
}

function ScheduleDialog({
  template,
  schedule,
  onClose,
}: {
  template: IssueTemplate;
  schedule: RecurringIssue | null;
  onClose: () => void;
}) {
  const { slug } = useWs();
  const qc = useQueryClient();
  const id = useId();
  const [frequency, setFrequency] = useState<Schedule["frequency"]>(schedule?.frequency ?? "weekly");
  const [interval, setEvery] = useState(String(schedule?.interval ?? 1));
  const [weekdays, setWeekdays] = useState<number[]>(schedule?.weekdays ?? [new Date().getDay()]);
  const [monthDay, setMonthDay] = useState(String(schedule?.monthDay ?? new Date().getDate()));
  const [hour, setHour] = useState(schedule?.hour ?? 9);
  const [timezone, setTimezone] = useState(schedule?.timezone ?? browserTimeZone());
  const [startsOn, setStartsOn] = useState(schedule?.startsOn ?? todayISO());
  const [active, setActive] = useState(schedule?.active ?? true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const zones = timeZones();

  const n = Number(interval);
  const intervalOk = Number.isInteger(n) && n >= 1 && n <= 365;
  const md = Number(monthDay);
  const monthDayOk = frequency !== "monthly" || (Number.isInteger(md) && md >= 1 && md <= 31);
  const draft: Schedule = {
    frequency,
    interval: intervalOk ? n : 1,
    weekdays: frequency === "weekly" ? weekdays : [],
    monthDay: frequency === "monthly" && monthDayOk ? md : null,
    hour,
    timezone,
    startsOn,
  };
  const tzOk = zones.includes(timezone) || timezone === "UTC";
  const next = intervalOk && monthDayOk && tzOk ? previewNextRun(draft) : null;
  const unit = { daily: "days", weekly: "weeks", monthly: "months", yearly: "years" }[frequency];

  const save = async (e?: React.FormEvent) => {
    e?.preventDefault();
    if (!intervalOk) return setError("Repeat every 1 to 365.");
    if (!monthDayOk) return setError("Pick a day of the month from 1 to 31.");
    if (frequency === "weekly" && weekdays.length === 0) return setError("Pick at least one day of the week.");
    if (!tzOk) return setError("Pick a time zone from the list.");
    if (!startsOn) return setError("Pick a start date.");
    const body: RecurringInput = { templateId: template.id, ...draft, active };
    setBusy(true);
    setError(null);
    try {
      if (schedule) {
        const { templateId: _t, ...patch } = body;
        await api.ws(slug).updateRecurring(schedule.id, patch);
      } else {
        await api.ws(slug).createRecurring(body);
      }
      await qc.invalidateQueries({ queryKey: keys.recurring(slug) });
      toast(schedule ? "Schedule saved" : "Schedule added", "success");
      onClose();
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  };

  return (
    <Dialog
      title={`Repeat ${template.name}`}
      onClose={onClose}
      size="md"
      footer={
        <>
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="btn btn-primary" onClick={() => save()} disabled={busy}>
            {schedule ? "Save schedule" : "Add schedule"}
          </button>
        </>
      }
    >
      <form className="stack" onSubmit={save}>
        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
        <div className="form-grid">
          <div className="field">
            <label className="field-label" htmlFor={`${id}-freq`}>
              Repeats
            </label>
            <select
              id={`${id}-freq`}
              className="select"
              data-autofocus
              value={frequency}
              onChange={(e) => setFrequency(e.target.value as Schedule["frequency"])}
            >
              <option value="daily">Daily</option>
              <option value="weekly">Weekly</option>
              <option value="monthly">Monthly</option>
              <option value="yearly">Yearly</option>
            </select>
          </div>
          <div className="field">
            <label className="field-label" htmlFor={`${id}-int`}>
              Every
            </label>
            <div className="input-suffix">
              <input
                id={`${id}-int`}
                className="input"
                type="number"
                min={1}
                max={365}
                inputMode="numeric"
                value={interval}
                aria-invalid={!intervalOk || undefined}
                onChange={(e) => setEvery(e.target.value)}
              />
              <span className="suffix">{unit}</span>
            </div>
          </div>
        </div>
        {frequency === "weekly" && (
          <fieldset className="fieldset">
            <legend className="field-label">On</legend>
            <div className="weekday-row">
              {WEEKDAY_ORDER.map((d) => (
                <label key={d} className={`weekday${weekdays.includes(d) ? " on" : ""}`}>
                  <input
                    type="checkbox"
                    className="sr-only"
                    checked={weekdays.includes(d)}
                    onChange={(e) => setWeekdays((w) => (e.target.checked ? [...w, d].sort() : w.filter((x) => x !== d)))}
                  />
                  <span aria-hidden="true">{WEEKDAYS[d]!.slice(0, 3)}</span>
                  <span className="sr-only">{WEEKDAYS[d]}</span>
                </label>
              ))}
            </div>
          </fieldset>
        )}
        {frequency === "monthly" && (
          <div className="field">
            <label className="field-label" htmlFor={`${id}-md`}>
              Day of the month
            </label>
            <input
              id={`${id}-md`}
              className="input input-narrow"
              type="number"
              min={1}
              max={31}
              inputMode="numeric"
              value={monthDay}
              aria-invalid={!monthDayOk || undefined}
              aria-describedby={`${id}-md-hint`}
              onChange={(e) => setMonthDay(e.target.value)}
            />
            <p className="field-hint" id={`${id}-md-hint`}>
              Short months use their last day.
            </p>
          </div>
        )}
        <div className="form-grid">
          <div className="field">
            <label className="field-label" htmlFor={`${id}-hour`}>
              At
            </label>
            <select id={`${id}-hour`} className="select" value={hour} onChange={(e) => setHour(Number(e.target.value))}>
              {Array.from({ length: 24 }, (_, h) => (
                <option key={hourLabel(h)} value={h}>
                  {hourLabel(h)}
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label className="field-label" htmlFor={`${id}-tz`}>
              Time zone
            </label>
            <input
              id={`${id}-tz`}
              className="input"
              list={`${id}-tzs`}
              value={timezone}
              aria-invalid={!tzOk || undefined}
              onChange={(e) => setTimezone(e.target.value)}
              autoComplete="off"
              spellCheck={false}
            />
            <datalist id={`${id}-tzs`}>
              {zones.map((z) => (
                <option key={z} value={z} />
              ))}
            </datalist>
          </div>
          <div className="field">
            <label className="field-label" htmlFor={`${id}-start`}>
              Starting
            </label>
            <input id={`${id}-start`} className="input" type="date" value={startsOn} onChange={(e) => setStartsOn(e.target.value)} />
          </div>
        </div>
        <label className="check-row">
          <input type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)} />
          Active
        </label>
        <div className="notice notice-accent" aria-live="polite">
          <strong>{describeSchedule(draft)}</strong>
          <span>{next ? `Next issue: ${formatRunTime(next, timezone)}` : "This schedule doesn't run. Check the settings above."}</span>
        </div>
      </form>
    </Dialog>
  );
}
