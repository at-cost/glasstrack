import { useQuery, useQueryClient } from "@tanstack/react-query";
import { type IntakeChannel, type IntakeKind, STATE_CATEGORIES } from "@glasstrack/shared";
import { ChevronDown, ExternalLink, FileText, Mail, Pencil, Plus, RefreshCw, Trash2 } from "lucide-react";
import { useId, useState } from "react";
import { Card } from "../../components/Card";
import { CopyField } from "../../components/CopyField";
import { ConfirmDialog, Dialog } from "../../components/Dialog";
import { Empty, Skeleton } from "../../components/Feedback";
import { LabelDot, LockIcon, teamOptionLabel } from "../../components/icons";
import { type Option, PickerButton } from "../../components/Picker";
import { api, errorMessage, type IntakeInput, type IntakePatch } from "../../lib/api";
import { keys, useLabels, useStates, useTeams } from "../../lib/queries";
import { toast, toastError } from "../../lib/toast";
import { useWs } from "../shell/context";

export const EMAIL_DOCS_URL = "https://github.com/transparent-ai-businesses/glasstrack/blob/main/docs/EMAIL-TO-ISSUE.md";
const KIND_LABEL: Record<IntakeKind, string> = { form: "Form", email: "Email inbox" };
const MAX_LABELS = 10;

/** Settings > Requests: public request forms and email inboxes that turn requests into issues. */
export function Requests() {
  const { slug, isAdmin, canEdit } = useWs();
  const list = useQuery({ queryKey: keys.intake(slug), queryFn: () => api.ws(slug).intake() });
  const [editing, setEditing] = useState<{ channel: IntakeChannel | null; kind: IntakeKind } | null>(null);
  const editable = isAdmin && canEdit;

  return (
    <>
      <Card
        title="Requests"
        actions={
          editable ? (
            <>
              <button type="button" className="btn btn-sm btn-primary" onClick={() => setEditing({ channel: null, kind: "form" })}>
                <Plus size={14} aria-hidden="true" />
                New form
              </button>
              <button type="button" className="btn btn-sm" onClick={() => setEditing({ channel: null, kind: "email" })}>
                <Plus size={14} aria-hidden="true" />
                New email inbox
              </button>
            </>
          ) : undefined
        }
      >
        <p className="muted small">
          Let people outside the workspace send you requests. Each request becomes an issue in the team you pick. A form is a web page anyone
          with the link can use, no account needed. An email inbox turns each email into an issue, and replies into comments.
        </p>
        {!isAdmin && <p className="muted small">Only admins can change forms and inboxes.</p>}
      </Card>
      <Card title="Forms and inboxes">
        {list.isPending ? (
          <Skeleton rows={2} />
        ) : list.error ? (
          <Empty title="Could not load requests">{errorMessage(list.error)}</Empty>
        ) : list.data.length === 0 ? (
          <p className="muted small">No forms or inboxes yet.</p>
        ) : (
          <ul className="rule-list">
            {list.data.map((ch) => (
              <ChannelItem key={ch.id} channel={ch} editable={editable} onEdit={() => setEditing({ channel: ch, kind: ch.kind })} />
            ))}
          </ul>
        )}
      </Card>
      {editing && <ChannelEditor channel={editing.channel} kind={editing.kind} onClose={() => setEditing(null)} />}
    </>
  );
}

function ChannelItem({ channel: ch, editable, onEdit }: { channel: IntakeChannel; editable: boolean; onEdit: () => void }) {
  const { slug } = useWs();
  const qc = useQueryClient();
  const teams = useTeams(slug);
  const states = useStates(slug);
  const labels = useLabels(slug);
  const [confirm, setConfirm] = useState<"rotate" | "delete" | null>(null);
  const team = teams.data?.find((t) => t.id === ch.teamId);
  const status = states.data?.find((s) => s.id === ch.statusId);
  const labelNames = ch.labelIds.map((id) => labels.data?.find((l) => l.id === id)?.name).filter(Boolean);
  const key = keys.intake(slug);

  const patch = async (b: IntakePatch, msg: string) => {
    const prev = qc.getQueryData<IntakeChannel[]>(key);
    if (b.enabled !== undefined) qc.setQueryData<IntakeChannel[]>(key, (l) => l?.map((x) => (x.id === ch.id ? { ...x, enabled: Boolean(b.enabled) } : x)));
    try {
      await api.ws(slug).updateIntake(ch.id, b);
      toast(msg, "success");
    } catch (e) {
      qc.setQueryData(key, prev);
      toastError(errorMessage(e));
    } finally {
      qc.invalidateQueries({ queryKey: key });
    }
  };
  const remove = async () => {
    try {
      await api.ws(slug).deleteIntake(ch.id);
      await qc.invalidateQueries({ queryKey: key });
      toast(`"${ch.name}" deleted`, "success");
    } catch (e) {
      toastError(errorMessage(e));
    }
  };
  const isForm = ch.kind === "form";

  return (
    <li className={`rule intake${ch.enabled ? "" : " off"}`} data-testid="intake-channel">
      <div className="rule-head">
        <span className="intake-name">
          {isForm ? <FileText size={15} aria-hidden="true" /> : <Mail size={15} aria-hidden="true" />}
          <span className="rule-name">{ch.name}</span>
        </span>
        {editable ? (
          <label className="switch">
            <input
              type="checkbox"
              role="switch"
              aria-checked={ch.enabled}
              aria-label={`${ch.name} is on`}
              checked={ch.enabled}
              onChange={(e) => patch({ enabled: e.target.checked }, e.target.checked ? `"${ch.name}" turned on` : `"${ch.name}" turned off`)}
            />
            <span className="switch-track" aria-hidden="true" />
            <span aria-hidden="true">{ch.enabled ? "On" : "Off"}</span>
          </label>
        ) : (
          <span className={`badge${ch.enabled ? " badge-accent" : ""}`}>{ch.enabled ? "On" : "Off"}</span>
        )}
      </div>
      <p className="intake-meta small">
        <span className="badge">{KIND_LABEL[ch.kind]}</span>
        <span>
          Team: {team?.name ?? "Unknown team"}
          {team?.private && <LockIcon label="Private team" />}
        </span>
        <span className="muted">
          New issues go to {status ? status.name : "the team's first backlog status"}
          {labelNames.length > 0 && ` with ${labelNames.join(", ")}`}
        </span>
      </p>
      {!ch.enabled && <p className="muted small">Off: new requests are turned away.</p>}
      {ch.address ? (
        <div className="intake-address">
          <CopyField label={isForm ? "Form link" : "Email address"} value={ch.address} />
          {isForm && (
            <a className="btn btn-sm intake-open" href={ch.address} target="_blank" rel="noreferrer">
              <ExternalLink size={13} aria-hidden="true" />
              Open form
              <span className="sr-only">(opens in a new tab)</span>
            </a>
          )}
        </div>
      ) : (
        <p className="intake-note small" role="note">
          Inbound email isn't set up on this server, so this inbox has no address yet.{" "}
          <a href={EMAIL_DOCS_URL} target="_blank" rel="noreferrer">
            How to set up email to issue
          </a>
          .
        </p>
      )}
      {editable && (
        <div className="row wrap">
          <button type="button" className="btn btn-sm" onClick={onEdit}>
            <Pencil size={13} aria-hidden="true" />
            Edit
          </button>
          {(isForm || ch.address) && (
            <button type="button" className="btn btn-sm" onClick={() => setConfirm("rotate")}>
              <RefreshCw size={13} aria-hidden="true" />
              {isForm ? "New link" : "New address"}
            </button>
          )}
          <button type="button" className="btn btn-sm btn-ghost" onClick={() => setConfirm("delete")}>
            <Trash2 size={13} aria-hidden="true" />
            Delete
          </button>
        </div>
      )}
      {confirm === "rotate" && (
        <ConfirmDialog
          title={isForm ? "Create a new link?" : "Create a new address?"}
          message={
            isForm
              ? "The current link stops working right away. Anyone you shared it with needs the new one."
              : "Mail to the current address stops arriving right away. Update it everywhere you shared or forward it."
          }
          confirmLabel={isForm ? "Create new link" : "Create new address"}
          onConfirm={() => patch({ rotateToken: true }, isForm ? "New link created" : "New address created")}
          onClose={() => setConfirm(null)}
        />
      )}
      {confirm === "delete" && (
        <ConfirmDialog
          title={`Delete "${ch.name}"?`}
          message={`The ${isForm ? "form" : "inbox"} stops working right away. Issues it already created stay.`}
          confirmLabel="Delete"
          danger
          onConfirm={remove}
          onClose={() => setConfirm(null)}
        />
      )}
    </li>
  );
}

type Draft = Required<Omit<IntakeInput, "enabled">>;

function ChannelEditor({ channel, kind, onClose }: { channel: IntakeChannel | null; kind: IntakeKind; onClose: () => void }) {
  const { slug } = useWs();
  const qc = useQueryClient();
  const uid = useId();
  const teams = useTeams(slug);
  const states = useStates(slug);
  const labels = useLabels(slug);
  const [d, setD] = useState<Draft>(() => ({
    teamId: channel?.teamId ?? teams.data?.[0]?.id ?? "",
    kind,
    name: channel?.name ?? "",
    intro: channel?.intro ?? "",
    statusId: channel?.statusId ?? null,
    labelIds: channel?.labelIds ?? [],
    requireEmail: channel?.requireEmail ?? false,
    membersOnly: channel?.membersOnly ?? false,
    notifySubmitter: channel?.notifySubmitter ?? true,
  }));
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const set = (patch: Partial<Draft>) => {
    setD((cur) => ({ ...cur, ...patch }));
    setError(null);
  };
  const isForm = d.kind === "form";

  const teamStates = (states.data ?? [])
    .filter((s) => s.teamId === d.teamId)
    .sort((a, b) => STATE_CATEGORIES.indexOf(a.category) - STATE_CATEGORIES.indexOf(b.category) || a.position - b.position);
  const labelOpts: Option[] = (labels.data ?? [])
    .filter((l) => !l.teamId || l.teamId === d.teamId)
    .map((l) => ({ id: l.id, label: l.name, icon: <LabelDot color={l.color} /> }));

  const save = async () => {
    if (!d.name.trim()) return setError("Give it a name.");
    if (!d.teamId) return setError("Pick a team.");
    setBusy(true);
    try {
      const body = { ...d, name: d.name.trim(), intro: isForm ? d.intro : "" };
      if (channel) {
        const { kind: _k, ...rest } = body;
        await api.ws(slug).updateIntake(channel.id, rest);
      } else {
        await api.ws(slug).createIntake(body);
      }
      await qc.invalidateQueries({ queryKey: keys.intake(slug) });
      toast(channel ? "Saved" : isForm ? "Form created" : "Email inbox created", "success");
      onClose();
    } catch (e) {
      setError(errorMessage(e));
      setBusy(false);
    }
  };

  const title = channel ? `Edit ${isForm ? "form" : "email inbox"}` : isForm ? "New form" : "New email inbox";
  return (
    <Dialog
      title={title}
      onClose={onClose}
      size="md"
      footer={
        <>
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="btn btn-primary" onClick={save} disabled={busy}>
            {channel ? "Save" : isForm ? "Create form" : "Create inbox"}
          </button>
        </>
      }
    >
      <form
        className="stack intake-form"
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
        <div className="field">
          <label className="field-label" htmlFor={`${uid}-name`}>
            Name
          </label>
          <input
            id={`${uid}-name`}
            className="input"
            data-autofocus
            maxLength={80}
            placeholder={isForm ? "Feature requests" : "Support"}
            value={d.name}
            onChange={(e) => set({ name: e.target.value })}
          />
          {isForm && <p className="field-hint">Shown as the form's heading.</p>}
        </div>
        <div className="field-row">
          <div className="field">
            <label className="field-label" htmlFor={`${uid}-team`}>
              Team
            </label>
            <select
              id={`${uid}-team`}
              className="select"
              value={d.teamId}
              onChange={(e) => set({ teamId: e.target.value, statusId: null, labelIds: [] })}
            >
              {teams.data?.map((t) => (
                <option key={t.id} value={t.id}>
                  {teamOptionLabel(t)}
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <span className="field-label">Kind</span>
            <span className="readonly-value">{KIND_LABEL[d.kind]}</span>
          </div>
        </div>
        {isForm && (
          <div className="field">
            <label className="field-label" htmlFor={`${uid}-intro`}>
              Intro
            </label>
            <textarea
              id={`${uid}-intro`}
              className="input"
              rows={3}
              maxLength={2000}
              placeholder="Tell us what you need. We read every request."
              aria-describedby={`${uid}-intro-hint`}
              value={d.intro}
              onChange={(e) => set({ intro: e.target.value })}
            />
            <p className="field-hint" id={`${uid}-intro-hint`}>
              Shown above the form. Plain text.
            </p>
          </div>
        )}
        <div className="field-row">
          <div className="field">
            <label className="field-label" htmlFor={`${uid}-status`}>
              Status for new issues
            </label>
            <select
              id={`${uid}-status`}
              className="select"
              value={d.statusId ?? ""}
              onChange={(e) => set({ statusId: e.target.value || null })}
            >
              <option value="">Team's first backlog status</option>
              {teamStates.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <span className="field-label">Labels</span>
            <PickerButton
              label="Labels for new issues"
              className="prop-btn picker-field"
              multi
              options={labelOpts}
              selected={d.labelIds}
              onPick={(id) =>
                set({
                  labelIds: d.labelIds.includes(id)
                    ? d.labelIds.filter((x) => x !== id)
                    : d.labelIds.length < MAX_LABELS
                      ? [...d.labelIds, id]
                      : d.labelIds,
                })
              }
            >
              {d.labelIds.length === 0 ? (
                <span className="muted">No labels</span>
              ) : (
                <span className="picked">{d.labelIds.map((id) => labelOpts.find((o) => o.id === id)?.label ?? "Removed").join(", ")}</span>
              )}
              <ChevronDown size={12} aria-hidden="true" />
            </PickerButton>
          </div>
        </div>
        <fieldset className="fieldset">
          <legend className="field-label">Options</legend>
          {isForm ? (
            <label className="check-row">
              <input type="checkbox" checked={d.requireEmail} onChange={(e) => set({ requireEmail: e.target.checked })} />
              Ask for an email address
            </label>
          ) : (
            <div>
              <label className="check-row">
                <input
                  type="checkbox"
                  checked={d.membersOnly}
                  aria-describedby={`${uid}-members-hint`}
                  onChange={(e) => set({ membersOnly: e.target.checked })}
                />
                Only accept mail from workspace members
              </label>
              <p className="field-hint" id={`${uid}-members-hint`}>
                Checks the From address, which senders can fake. Treat it as a spam filter, not proof of who sent it.
              </p>
            </div>
          )}
          <div>
            <label className="check-row">
              <input
                type="checkbox"
                checked={d.notifySubmitter}
                aria-describedby={`${uid}-notify-hint`}
                onChange={(e) => set({ notifySubmitter: e.target.checked })}
              />
              Email the requester when the issue is done or closed
            </label>
            <p className="field-hint" id={`${uid}-notify-hint`}>
              {isForm ? "Only when they gave an email address. " : ""}One short email, nothing else.
            </p>
          </div>
        </fieldset>
      </form>
    </Dialog>
  );
}
