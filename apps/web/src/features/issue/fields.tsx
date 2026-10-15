import type { CustomField, Member } from "@glasstrack/shared";
import { ExternalLink, Pencil } from "lucide-react";
import { useEffect, useState } from "react";
import { Avatar, LabelDot } from "../../components/icons";
import { type Option, PickerButton } from "../../components/Picker";

export const FIELD_TYPE_LABEL: Record<CustomField["type"], string> = {
  text: "Text",
  number: "Number",
  select: "Single select",
  multi_select: "Multi select",
  date: "Date",
  checkbox: "Checkbox",
  url: "Link",
  user: "Person",
};

/** Fields that apply to a team: its own plus workspace-wide ones. */
export const fieldsForTeam = (fields: CustomField[] | undefined, teamId: string | undefined) =>
  (fields ?? []).filter((f) => !f.teamId || f.teamId === teamId).sort((a, b) => a.position - b.position);

export const isEmptyValue = (v: unknown) => v === undefined || v === null || v === "" || (Array.isArray(v) && v.length === 0);

/** A short readable form of a value, for the timeline and reports. */
export function fieldValueText(field: CustomField | undefined, v: unknown, members: Member[] | undefined): string {
  if (isEmptyValue(v)) return "empty";
  if (!field) return String(v);
  const opt = (id: unknown) => field.options.find((o) => o.id === id)?.name ?? "a removed option";
  switch (field.type) {
    case "select":
      return opt(v);
    case "multi_select":
      return (Array.isArray(v) ? v : [v]).map(opt).join(", ");
    case "checkbox":
      return v ? "checked" : "unchecked";
    case "user":
      return members?.find((m) => m.userId === v)?.name ?? "a former member";
    case "date": {
      const d = new Date(`${String(v)}T00:00:00`);
      return Number.isNaN(d.getTime()) ? String(v) : d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
    }
    default:
      return String(v);
  }
}

function optionList(field: CustomField, withNone: boolean): Option[] {
  const opts: Option[] = field.options.map((o) => ({
    id: o.id,
    label: o.name,
    icon: <LabelDot color={o.color ?? "var(--text-3)"} />,
  }));
  return withNone ? [{ id: "__none", label: "None" }, ...opts] : opts;
}

function memberOptions(members: Member[] | undefined, meId: string | undefined): Option[] {
  const list = [...(members ?? [])].sort((a, b) => (a.userId === meId ? -1 : b.userId === meId ? 1 : a.name.localeCompare(b.name)));
  return [
    { id: "__none", label: "No one", icon: <Avatar member={null} size={16} /> },
    ...list.map((m) => ({
      id: m.userId,
      label: m.userId === meId ? `${m.name} (you)` : m.name,
      hint: `@${m.handle}`,
      keywords: m.email,
      icon: <Avatar member={m} size={16} />,
    })),
  ];
}

/** Text or number input that saves on blur or Enter, and resets on Escape. */
function CommitInput({
  value,
  type,
  label,
  disabled,
  onCommit,
  className,
  placeholder,
}: {
  value: string;
  type: "text" | "number" | "url";
  label: string;
  disabled?: boolean;
  onCommit: (v: string) => void;
  className: string;
  placeholder?: string;
}) {
  const [v, setV] = useState(value);
  useEffect(() => setV(value), [value]);
  return (
    <input
      className={className}
      type={type}
      inputMode={type === "number" ? "decimal" : type === "url" ? "url" : undefined}
      aria-label={label}
      placeholder={placeholder ?? "Empty"}
      value={v}
      disabled={disabled}
      maxLength={type === "number" ? undefined : 2000}
      onChange={(e) => setV(e.target.value)}
      onBlur={() => {
        if (v.trim() !== value) onCommit(v.trim());
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter") (e.target as HTMLInputElement).blur();
        if (e.key === "Escape") {
          setV(value);
          e.stopPropagation();
        }
      }}
    />
  );
}

function UrlEditor({
  value,
  label,
  disabled,
  onChange,
  compact,
}: {
  value: string;
  label: string;
  disabled?: boolean;
  onChange: (v: unknown) => void;
  compact?: boolean;
}) {
  const [editing, setEditing] = useState(false);
  const safe = /^https?:\/\//i.test(value);
  if (value && safe && !editing) {
    return (
      <span className="field-url">
        <a href={value} target="_blank" rel="noopener noreferrer" title={value}>
          <span className="field-url-text">{value.replace(/^https?:\/\//i, "")}</span>
          <ExternalLink size={12} aria-hidden="true" />
        </a>
        {!disabled && (
          <button type="button" className="icon-btn small" aria-label={`Edit ${label}`} onClick={() => setEditing(true)}>
            <Pencil size={12} />
          </button>
        )}
      </span>
    );
  }
  return (
    <CommitInput
      className={compact ? "input input-sm" : "input"}
      type="url"
      label={label}
      value={value}
      disabled={disabled}
      placeholder="https://"
      onCommit={(v) => {
        setEditing(false);
        onChange(v || null);
      }}
    />
  );
}

/**
 * Editor for one custom field value. `compact` is the sidebar style (prop buttons);
 * otherwise chips for the create form.
 */
export function FieldEditor({
  field,
  value,
  onChange,
  disabled,
  members,
  meId,
  compact = true,
}: {
  field: CustomField;
  value: unknown;
  onChange: (v: unknown) => void;
  disabled?: boolean;
  members?: Member[];
  meId?: string;
  compact?: boolean;
}) {
  const label = field.name;
  const btnClass = compact ? "prop-btn" : "chip-btn";
  switch (field.type) {
    case "text":
      return (
        <CommitInput
          className={compact ? "input input-sm" : "input"}
          type="text"
          label={label}
          value={typeof value === "string" ? value : ""}
          disabled={disabled}
          onCommit={(v) => onChange(v || null)}
        />
      );
    case "number":
      return (
        <CommitInput
          className={compact ? "input input-sm" : "input"}
          type="number"
          label={label}
          value={typeof value === "number" ? String(value) : ""}
          disabled={disabled}
          onCommit={(v) => {
            if (!v) return onChange(null);
            const n = Number(v);
            if (Number.isFinite(n)) onChange(n);
          }}
        />
      );
    case "url":
      return (
        <UrlEditor value={typeof value === "string" ? value : ""} label={label} disabled={disabled} onChange={onChange} compact={compact} />
      );
    case "date":
      return (
        <label className={`${btnClass} date-prop`}>
          <input
            type="date"
            className="date-input"
            aria-label={label}
            value={typeof value === "string" ? value : ""}
            disabled={disabled}
            onChange={(e) => onChange(e.target.value || null)}
          />
        </label>
      );
    case "checkbox":
      return (
        <label className="check-row field-check">
          <input type="checkbox" checked={value === true} disabled={disabled} onChange={(e) => onChange(e.target.checked ? true : null)} />
          <span className={value === true ? "" : "muted"}>{value === true ? "Yes" : "No"}</span>
          <span className="sr-only">{label}</span>
        </label>
      );
    case "select": {
      const opt = field.options.find((o) => o.id === value);
      return (
        <PickerButton
          label={label}
          className={btnClass}
          options={optionList(field, true)}
          selected={opt ? [opt.id] : ["__none"]}
          disabled={disabled}
          onPick={(id) => onChange(id === "__none" ? null : id)}
        >
          {opt ? (
            <>
              <LabelDot color={opt.color ?? "var(--text-3)"} />
              {opt.name}
            </>
          ) : (
            <span className="muted">{compact ? "Empty" : label}</span>
          )}
        </PickerButton>
      );
    }
    case "multi_select": {
      const ids = Array.isArray(value) ? (value as string[]) : [];
      const chosen = field.options.filter((o) => ids.includes(o.id));
      return (
        <PickerButton
          label={label}
          className={btnClass}
          multi
          options={optionList(field, false)}
          selected={ids}
          disabled={disabled}
          onPick={(id) => onChange(ids.includes(id) ? ids.filter((x) => x !== id) : [...ids, id])}
        >
          {chosen.length === 0 ? (
            <span className="muted">{compact ? "Empty" : label}</span>
          ) : compact ? (
            <span className="label-list">
              {chosen.map((o) => (
                <span key={o.id} className="label-chip">
                  <LabelDot color={o.color ?? "var(--text-3)"} />
                  {o.name}
                </span>
              ))}
            </span>
          ) : (
            <>
              {chosen.map((o) => (
                <LabelDot key={o.id} color={o.color ?? "var(--text-3)"} />
              ))}
              {chosen.length === 1 ? chosen[0]!.name : `${label}: ${chosen.length}`}
            </>
          )}
        </PickerButton>
      );
    }
    case "user": {
      const m = members?.find((x) => x.userId === value);
      return (
        <PickerButton
          label={label}
          className={btnClass}
          options={memberOptions(members, meId)}
          selected={m ? [m.userId] : ["__none"]}
          disabled={disabled}
          onPick={(id) => onChange(id === "__none" ? null : id)}
        >
          <Avatar member={m ?? null} size={compact ? 18 : 16} />
          {m ? m.name : <span className="muted">{compact ? "No one" : label}</span>}
        </PickerButton>
      );
    }
  }
}
