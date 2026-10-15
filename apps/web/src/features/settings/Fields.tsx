import { useQueryClient } from "@tanstack/react-query";
import { CUSTOM_FIELD_TYPES, type CustomField } from "@glasstrack/shared";
import { ArrowDown, ArrowUp, ListChecks, Plus, Trash2, X } from "lucide-react";
import { useId, useState } from "react";
import { Card } from "../../components/Card";
import { ConfirmDialog } from "../../components/Dialog";
import { Empty, Skeleton } from "../../components/Feedback";
import { api, errorMessage } from "../../lib/api";
import { keys, useFields, useTeams } from "../../lib/queries";
import { toast, toastError } from "../../lib/toast";
import { FIELD_TYPE_LABEL } from "../issue/fields";
import { useWs } from "../shell/context";
import { InlineText } from "./InlineText";

type FieldOption = CustomField["options"][number];

export const OPTION_COLORS = ["#c0553f", "#d08a2e", "#b8a23a", "#5c9a5a", "#3f8f8a", "#4f74b5", "#7a5fb0", "#b05f8f", "#7d7a72"];
export const newOptionId = () => Math.random().toString(36).slice(2, 10);
const hasOptions = (t: CustomField["type"]) => t === "select" || t === "multi_select";

const TYPE_HINT: Record<CustomField["type"], string> = {
  text: "A line of text",
  number: "A number, like story points or cost",
  select: "One choice from a list",
  multi_select: "Any number of choices from a list",
  date: "A calendar date",
  checkbox: "Yes or no",
  url: "A web link",
  user: "A workspace member",
};

export function Fields() {
  const { slug, isAdmin, canEdit } = useWs();
  const fields = useFields(slug);
  const teams = useTeams(slug);
  const editable = isAdmin && canEdit;
  const list = [...(fields.data ?? [])].sort((a, b) => a.position - b.position);
  return (
    <>
      <Card title="Custom fields">
        <p className="muted small">
          Fields show on every issue in their team, in the issue sidebar and the new issue form. Select, checkbox and person fields can be
          used as filters.
        </p>
        {fields.isPending ? (
          <Skeleton rows={3} />
        ) : fields.error ? (
          <Empty title="Could not load fields">{errorMessage(fields.error)}</Empty>
        ) : list.length === 0 ? (
          <p className="muted">No custom fields yet.</p>
        ) : (
          <ul className="field-admin-list">
            {list.map((f, i) => (
              <FieldRow
                key={f.id}
                field={f}
                editable={editable}
                teamName={f.teamId ? (teams.data?.find((t) => t.id === f.teamId)?.name ?? "A removed team") : "All teams"}
                prev={list[i - 1]}
                next={list[i + 1]}
                after={list[i + 2]}
                before={list[i - 2]}
              />
            ))}
          </ul>
        )}
      </Card>
      {editable && <NewField />}
    </>
  );
}

function useFieldActions() {
  const { slug } = useWs();
  const qc = useQueryClient();
  const refresh = () => {
    qc.invalidateQueries({ queryKey: keys.fields(slug) });
    qc.invalidateQueries({ queryKey: keys.issuesAll(slug) });
    qc.invalidateQueries({ queryKey: keys.issueAll(slug) });
  };
  const update = async (f: CustomField, b: Partial<Pick<CustomField, "name" | "options" | "position">>) => {
    qc.setQueryData<CustomField[]>(keys.fields(slug), (all) => all?.map((x) => (x.id === f.id ? { ...x, ...b } : x)));
    try {
      await api.ws(slug).updateField(f.id, b);
    } catch (e) {
      toastError(errorMessage(e));
    }
    refresh();
  };
  const remove = async (f: CustomField) => {
    qc.setQueryData<CustomField[]>(keys.fields(slug), (all) => all?.filter((x) => x.id !== f.id));
    try {
      await api.ws(slug).deleteField(f.id);
      toast(`Deleted ${f.name}`, "success");
    } catch (e) {
      toastError(errorMessage(e));
    }
    refresh();
  };
  return { update, remove };
}

function FieldRow({
  field,
  editable,
  teamName,
  prev,
  next,
  before,
  after,
}: {
  field: CustomField;
  editable: boolean;
  teamName: string;
  prev?: CustomField;
  next?: CustomField;
  before?: CustomField;
  after?: CustomField;
}) {
  const { update, remove } = useFieldActions();
  const [optionsOpen, setOptionsOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const panelId = useId();
  // Positions are numbers; moving puts the field halfway between its new neighbours.
  const moveUp = () => prev && update(field, { position: before ? (before.position + prev.position) / 2 : prev.position - 1 });
  const moveDown = () => next && update(field, { position: after ? (next.position + after.position) / 2 : next.position + 1 });
  return (
    <li className="field-admin">
      <div className="edit-row">
        <InlineText
          value={field.name}
          label={`Name of field ${field.name}`}
          disabled={!editable}
          maxLength={60}
          onSave={(n) => update(field, { name: n })}
        />
        <span className="badge">{FIELD_TYPE_LABEL[field.type]}</span>
        <span className="muted small nowrap field-scope">{teamName}</span>
        {editable && (
          <span className="edit-actions">
            {hasOptions(field.type) && (
              <button
                type="button"
                className="btn btn-sm"
                aria-expanded={optionsOpen}
                aria-controls={panelId}
                onClick={() => setOptionsOpen((o) => !o)}
              >
                <ListChecks size={13} aria-hidden="true" />
                Options <span className="group-count">{field.options.length}</span>
              </button>
            )}
            <button type="button" className="icon-btn small" aria-label={`Move ${field.name} up`} disabled={!prev} onClick={moveUp}>
              <ArrowUp size={13} />
            </button>
            <button type="button" className="icon-btn small" aria-label={`Move ${field.name} down`} disabled={!next} onClick={moveDown}>
              <ArrowDown size={13} />
            </button>
            <button type="button" className="icon-btn small" aria-label={`Delete field ${field.name}`} onClick={() => setDeleting(true)}>
              <Trash2 size={13} />
            </button>
          </span>
        )}
      </div>
      {optionsOpen && (
        <div id={panelId} className="field-options-panel">
          <OptionsEditor options={field.options} fieldName={field.name} confirmRemove onChange={(options) => update(field, { options })} />
        </div>
      )}
      {deleting && (
        <ConfirmDialog
          title={`Delete field ${field.name}?`}
          message="Its values are removed from every issue. This cannot be undone."
          confirmLabel="Delete field"
          danger
          onConfirm={() => remove(field)}
          onClose={() => setDeleting(false)}
        />
      )}
    </li>
  );
}

/** Add, rename, recolour and remove options. `confirmRemove` warns that removing clears it from issues. */
export function OptionsEditor({
  options,
  onChange,
  fieldName,
  confirmRemove,
}: {
  options: FieldOption[];
  onChange: (o: FieldOption[]) => void;
  fieldName: string;
  confirmRemove?: boolean;
}) {
  const [name, setName] = useState("");
  const [removing, setRemoving] = useState<FieldOption | null>(null);
  const color = OPTION_COLORS[options.length % OPTION_COLORS.length]!;
  const add = (e?: React.FormEvent) => {
    e?.preventDefault();
    const n = name.trim();
    if (!n) return;
    if (options.some((o) => o.name.toLowerCase() === n.toLowerCase())) {
      toastError(`${n} is already an option`);
      return;
    }
    onChange([...options, { id: newOptionId(), name: n, color }]);
    setName("");
  };
  const set = (o: FieldOption, b: Partial<FieldOption>) => onChange(options.map((x) => (x.id === o.id ? { ...x, ...b } : x)));
  const drop = (o: FieldOption) => onChange(options.filter((x) => x.id !== o.id));
  return (
    <div className="options-editor">
      {options.length === 0 && <p className="muted small">No options yet.</p>}
      <ul className="edit-list">
        {options.map((o) => (
          <li key={o.id} className="edit-row">
            <label className="color-swatch" style={{ background: o.color ?? "#7d7a72" }}>
              <span className="sr-only">Colour for {o.name}</span>
              <input type="color" value={o.color ?? "#7d7a72"} onChange={(e) => set(o, { color: e.target.value })} />
            </label>
            <InlineText value={o.name} label={`Name of option ${o.name}`} maxLength={60} onSave={(n) => set(o, { name: n })} />
            <button
              type="button"
              className="icon-btn small"
              aria-label={`Remove option ${o.name}`}
              onClick={() => (confirmRemove ? setRemoving(o) : drop(o))}
            >
              <X size={13} />
            </button>
          </li>
        ))}
      </ul>
      {/* A div, not a form: this editor can sit inside another form. */}
      <div className="add-row">
        <span className="color-swatch" style={{ background: color }} aria-hidden="true" />
        <input
          className="input input-sm"
          placeholder="New option"
          aria-label={`New option for ${fieldName || "this field"}`}
          value={name}
          maxLength={60}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              add();
            }
          }}
        />
        <button type="button" className="btn btn-sm" disabled={!name.trim()} onClick={() => add()}>
          <Plus size={13} aria-hidden="true" />
          Add option
        </button>
      </div>
      {removing && (
        <ConfirmDialog
          title={`Remove ${removing.name}?`}
          message={`Removing it clears ${removing.name} from every issue that has it.`}
          confirmLabel="Remove option"
          danger
          onConfirm={() => drop(removing)}
          onClose={() => setRemoving(null)}
        />
      )}
    </div>
  );
}

function NewField() {
  const { slug } = useWs();
  const qc = useQueryClient();
  const teams = useTeams(slug);
  const id = useId();
  const [name, setName] = useState("");
  const [type, setType] = useState<CustomField["type"]>("select");
  const [teamId, setTeamId] = useState("");
  const [options, setOptions] = useState<FieldOption[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const create = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return setError("Add a name.");
    if (hasOptions(type) && options.length === 0) return setError("Add at least one option.");
    setBusy(true);
    setError(null);
    try {
      await api.ws(slug).createField({ name: name.trim(), type, teamId: teamId || null, options: hasOptions(type) ? options : [] });
      await qc.invalidateQueries({ queryKey: keys.fields(slug) });
      toast(`Added ${name.trim()}`, "success");
      setName("");
      setOptions([]);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Card title="New field">
      <form className="stack" onSubmit={create}>
        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
        <div className="form-grid">
          <div className="field">
            <label className="field-label" htmlFor={`${id}-name`}>
              Name
            </label>
            <input
              id={`${id}-name`}
              className="input"
              value={name}
              maxLength={60}
              placeholder="Severity"
              onChange={(e) => setName(e.target.value)}
            />
          </div>
          <div className="field">
            <label className="field-label" htmlFor={`${id}-type`}>
              Type
            </label>
            <select
              id={`${id}-type`}
              className="select"
              value={type}
              onChange={(e) => setType(e.target.value as CustomField["type"])}
              aria-describedby={`${id}-type-hint`}
            >
              {CUSTOM_FIELD_TYPES.map((t) => (
                <option key={t} value={t}>
                  {FIELD_TYPE_LABEL[t]}
                </option>
              ))}
            </select>
            <p className="field-hint" id={`${id}-type-hint`}>
              {TYPE_HINT[type]}
            </p>
          </div>
          <div className="field">
            <label className="field-label" htmlFor={`${id}-team`}>
              Shows on
            </label>
            <select id={`${id}-team`} className="select" value={teamId} onChange={(e) => setTeamId(e.target.value)}>
              <option value="">All teams</option>
              {teams.data?.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name} only
                </option>
              ))}
            </select>
          </div>
        </div>
        {hasOptions(type) && (
          <fieldset className="fieldset">
            <legend className="field-label">Options</legend>
            <OptionsEditor options={options} onChange={setOptions} fieldName={name} />
          </fieldset>
        )}
        <div>
          <button type="submit" className="btn btn-primary" disabled={busy || !name.trim()}>
            Add field
          </button>
        </div>
      </form>
    </Card>
  );
}
