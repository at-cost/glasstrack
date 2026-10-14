import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronDown, ChevronRight, Trash2 } from "lucide-react";
import { useState } from "react";
import { Card } from "../../components/Card";
import { CopyField } from "../../components/CopyField";
import { ConfirmDialog } from "../../components/Dialog";
import { Empty, Skeleton } from "../../components/Feedback";
import { api, errorMessage, WEBHOOK_EVENTS, type Webhook, type WebhookEvent } from "../../lib/api";
import { fullTime, relativeTime } from "../../lib/format";
import { keys } from "../../lib/queries";
import { toast, toastError } from "../../lib/toast";
import { useWs } from "../shell/context";

const EVENT_LABEL: Record<WebhookEvent, string> = {
  "issue.created": "Issue created",
  "issue.updated": "Issue updated",
  "issue.deleted": "Issue deleted",
  "comment.created": "Comment added",
};

export function Webhooks() {
  const { slug, isAdmin } = useWs();
  const list = useQuery({ queryKey: keys.webhooks(slug), queryFn: () => api.ws(slug).webhooks(), enabled: isAdmin });
  if (!isAdmin) {
    return (
      <Card title="Webhooks">
        <p className="muted">Only admins can manage webhooks.</p>
      </Card>
    );
  }
  return (
    <>
      <NewWebhook />
      <Card title="Endpoints">
        {list.isPending ? (
          <Skeleton rows={2} />
        ) : list.error ? (
          <Empty title="Could not load webhooks">{errorMessage(list.error)}</Empty>
        ) : list.data.length === 0 ? (
          <p className="muted small">No webhooks yet.</p>
        ) : (
          <ul className="hook-list">
            {list.data.map((h) => (
              <WebhookItem key={h.id} hook={h} />
            ))}
          </ul>
        )}
        <p className="muted small">
          Each delivery is signed. The <span className="mono">Glasstrack-Signature</span> header is{" "}
          <span className="mono">t=&lt;unix seconds&gt;,v1=&lt;hex HMAC-SHA256 of "t.body"&gt;</span> using the endpoint secret.
        </p>
      </Card>
    </>
  );
}

function NewWebhook() {
  const { slug, canEdit } = useWs();
  const qc = useQueryClient();
  const [url, setUrl] = useState("");
  const [events, setEvents] = useState<WebhookEvent[]>([...WEBHOOK_EVENTS]);
  const [busy, setBusy] = useState(false);
  const create = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      await api.ws(slug).createWebhook({ url: url.trim(), events, active: true });
      await qc.invalidateQueries({ queryKey: keys.webhooks(slug) });
      setUrl("");
      toast("Webhook added", "success");
    } catch (err) {
      toastError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Card title="Add a webhook">
      <form className="stack" onSubmit={create}>
        <div className="field">
          <label className="field-label" htmlFor="hook-url">
            Endpoint URL
          </label>
          <input
            id="hook-url"
            className="input"
            type="url"
            placeholder="https://example.com/glasstrack"
            value={url}
            disabled={!canEdit}
            onChange={(e) => setUrl(e.target.value)}
          />
        </div>
        <EventPicker value={events} onChange={setEvents} legend="Send these events" />
        <div>
          <button type="submit" className="btn btn-primary" disabled={busy || !canEdit || !url.trim() || events.length === 0}>
            Add webhook
          </button>
        </div>
      </form>
    </Card>
  );
}

function EventPicker({ value, onChange, legend }: { value: WebhookEvent[]; onChange: (v: WebhookEvent[]) => void; legend: string }) {
  return (
    <fieldset className="fieldset">
      <legend className="field-label">{legend}</legend>
      <div className="radio-row">
        {WEBHOOK_EVENTS.map((ev) => (
          <label key={ev} className="check-row">
            <input
              type="checkbox"
              checked={value.includes(ev)}
              onChange={(e) => onChange(e.target.checked ? [...value, ev] : value.filter((x) => x !== ev))}
            />
            {EVENT_LABEL[ev]}
          </label>
        ))}
      </div>
    </fieldset>
  );
}

function WebhookItem({ hook }: { hook: Webhook }) {
  const { slug, canEdit } = useWs();
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [events, setEvents] = useState<WebhookEvent[]>(hook.events);
  const refresh = () => qc.invalidateQueries({ queryKey: keys.webhooks(slug) });
  const update = async (b: Partial<{ active: boolean; events: WebhookEvent[] }>, msg: string) => {
    try {
      await api.ws(slug).updateWebhook(hook.id, b);
      await refresh();
      toast(msg, "success");
    } catch (err) {
      toastError(errorMessage(err));
    }
  };
  const remove = async () => {
    try {
      await api.ws(slug).deleteWebhook(hook.id);
      await refresh();
      toast("Webhook deleted", "success");
    } catch (err) {
      toastError(errorMessage(err));
    }
  };
  const eventsDirty = [...events].sort().join() !== [...hook.events].sort().join();
  return (
    <li className={`hook${hook.active ? "" : " off"}`} data-testid="webhook">
      <div className="hook-head">
        <span className="hook-url mono">{hook.url}</span>
        {hook.active ? <span className="badge badge-accent">Active</span> : <span className="badge badge-danger">Turned off</span>}
      </div>
      {!hook.active && (
        <div className="notice notice-warning">
          <span>
            This endpoint gets no deliveries.
            {(hook.consecutiveFailures ?? 0) > 0 && ` It was turned off after ${hook.consecutiveFailures} failed deliveries in a row.`}
          </span>
          {canEdit && (
            <div>
              <button type="button" className="btn btn-sm btn-primary" onClick={() => update({ active: true }, "Webhook turned back on")}>
                Turn back on
              </button>
            </div>
          )}
        </div>
      )}
      <CopyField label="Signing secret" value={hook.secret} secret />
      <EventPicker value={events} onChange={setEvents} legend="Events" />
      <div className="row wrap">
        {eventsDirty && (
          <button
            type="button"
            className="btn btn-sm btn-primary"
            disabled={!canEdit || events.length === 0}
            onClick={() => update({ events }, "Events saved")}
          >
            Save events
          </button>
        )}
        <button type="button" className="btn btn-sm" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
          {open ? <ChevronDown size={13} aria-hidden="true" /> : <ChevronRight size={13} aria-hidden="true" />}
          Recent deliveries
        </button>
        {hook.active && canEdit && (
          <button type="button" className="btn btn-sm btn-ghost" onClick={() => update({ active: false }, "Webhook turned off")}>
            Turn off
          </button>
        )}
        {canEdit && (
          <button type="button" className="btn btn-sm btn-ghost" onClick={() => setDeleting(true)}>
            <Trash2 size={13} aria-hidden="true" />
            Delete
          </button>
        )}
      </div>
      {open && <Deliveries hookId={hook.id} />}
      {deleting && (
        <ConfirmDialog
          title="Delete this webhook?"
          message="Deliveries stop right away."
          confirmLabel="Delete webhook"
          danger
          onConfirm={remove}
          onClose={() => setDeleting(false)}
        />
      )}
    </li>
  );
}

function Deliveries({ hookId }: { hookId: string }) {
  const { slug } = useWs();
  const q = useQuery({ queryKey: keys.deliveries(slug, hookId), queryFn: () => api.ws(slug).deliveries(hookId), refetchInterval: 10_000 });
  if (q.isPending) return <Skeleton rows={2} />;
  if (q.error) return <p className="form-error">{errorMessage(q.error)}</p>;
  if (q.data.length === 0) return <p className="muted small">No deliveries yet.</p>;
  return (
    <div className="table-wrap">
      <table className="data-table">
        <thead>
          <tr>
            <th scope="col">When</th>
            <th scope="col">Event</th>
            <th scope="col">Result</th>
            <th scope="col" className="num">
              Tries
            </th>
            <th scope="col">Response</th>
          </tr>
        </thead>
        <tbody>
          {q.data.map((d) => (
            <tr key={d.id}>
              <td className="nowrap" title={fullTime(d.createdAt)}>
                {relativeTime(d.createdAt)}
              </td>
              <td className="mono nowrap">{d.event}</td>
              <td>
                <span className={`badge${d.status === "succeeded" ? " badge-accent" : d.status === "failed" ? " badge-danger" : ""}`}>
                  {d.status === "succeeded" ? "Delivered" : d.status === "failed" ? "Failed" : d.attempts === 0 ? "Queued" : "Retrying"}
                </span>
              </td>
              <td className="num">{d.attempts}</td>
              <td className="small">
                {d.responseStatus ? `HTTP ${d.responseStatus}` : ""}
                {d.error && d.error !== `HTTP ${d.responseStatus}` ? `${d.responseStatus ? ". " : ""}${d.error}` : ""}
                {d.deliveredAt ? ` at ${new Date(d.deliveredAt).toLocaleTimeString()}` : ""}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
