import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Trash2 } from "lucide-react";
import { useState } from "react";
import { Card } from "../../components/Card";
import { CopyField } from "../../components/CopyField";
import { ConfirmDialog } from "../../components/Dialog";
import { Empty, Skeleton } from "../../components/Feedback";
import { type ApiToken, api, errorMessage } from "../../lib/api";
import { fullTime, relativeTime } from "../../lib/format";
import { shortDate } from "../../lib/money";
import { keys } from "../../lib/queries";
import { toast, toastError } from "../../lib/toast";
import { useWs } from "../shell/context";

const EXPIRY = [
  { days: 30, label: "30 days" },
  { days: 90, label: "90 days" },
  { days: 365, label: "1 year" },
  { days: 0, label: "Never" },
];

export function Tokens() {
  const { slug, workspace } = useWs();
  const qc = useQueryClient();
  const list = useQuery({ queryKey: keys.tokens(slug), queryFn: () => api.ws(slug).tokens() });
  const [name, setName] = useState("");
  const [expiry, setExpiry] = useState(90);
  const [busy, setBusy] = useState(false);
  const [created, setCreated] = useState<{ name: string; token: string } | null>(null);
  const [revoking, setRevoking] = useState<ApiToken | null>(null);
  const canCreate = workspace.role !== "guest" && workspace.role !== "viewer";

  const create = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      const t = await api.ws(slug).createToken(name.trim(), expiry || null);
      setCreated({ name: t.name, token: t.token });
      setName("");
      await qc.invalidateQueries({ queryKey: keys.tokens(slug) });
    } catch (err) {
      toastError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };
  const revoke = async (t: ApiToken) => {
    try {
      await api.ws(slug).revokeToken(t.id);
      await qc.invalidateQueries({ queryKey: keys.tokens(slug) });
      toast(`${t.name} revoked`, "success");
    } catch (err) {
      toastError(errorMessage(err));
    }
  };
  const origin = window.location.origin;

  return (
    <>
      <Card title="API tokens">
        <p className="muted small">
          A token lets scripts use the API as you, in this workspace only. It can't create tokens or change webhooks and integrations.
        </p>
        {canCreate ? (
          <form className="invite-form" onSubmit={create}>
            <div className="field grow">
              <label className="field-label" htmlFor="token-name">
                Name
              </label>
              <input
                id="token-name"
                className="input"
                placeholder="Deploy script"
                maxLength={60}
                value={name}
                onChange={(e) => setName(e.target.value)}
              />
            </div>
            <div className="field">
              <label className="field-label" htmlFor="token-expiry">
                Expires after
              </label>
              <select id="token-expiry" className="select" value={expiry} onChange={(e) => setExpiry(Number(e.target.value))}>
                {EXPIRY.map((x) => (
                  <option key={x.days} value={x.days}>
                    {x.label}
                  </option>
                ))}
              </select>
            </div>
            <div className="invite-buttons">
              <button type="submit" className="btn btn-primary" disabled={busy || !name.trim()}>
                Create token
              </button>
            </div>
          </form>
        ) : (
          <p className="muted small">Guests can't create tokens.</p>
        )}
        {created && (
          <div className="notice notice-warning" data-testid="new-token">
            <CopyField label={`Token "${created.name}"`} value={created.token} hint="Copy it now. It won't be shown again." />
            <div>
              <button type="button" className="btn btn-sm" onClick={() => setCreated(null)}>
                Done
              </button>
            </div>
          </div>
        )}
      </Card>
      <Card title="Your tokens">
        {list.isPending ? (
          <Skeleton rows={2} />
        ) : list.error ? (
          <Empty title="Could not load tokens">{errorMessage(list.error)}</Empty>
        ) : list.data.length === 0 ? (
          <p className="muted small">No tokens yet.</p>
        ) : (
          <div className="table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th scope="col">Name</th>
                  <th scope="col">Starts with</th>
                  <th scope="col">Created</th>
                  <th scope="col">Last used</th>
                  <th scope="col">Expires</th>
                  <th scope="col">
                    <span className="sr-only">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {list.data.map((t) => (
                  <tr key={t.id}>
                    <td>{t.name}</td>
                    <td className="mono nowrap">{t.tokenPrefix}...</td>
                    <td className="nowrap">{shortDate(t.createdAt)}</td>
                    <td className="nowrap" title={t.lastUsedAt ? fullTime(t.lastUsedAt) : undefined}>
                      {t.lastUsedAt ? relativeTime(t.lastUsedAt) : "Never"}
                    </td>
                    <td className="nowrap">
                      {t.expiresAt ? (new Date(t.expiresAt) < new Date() ? "Expired" : shortDate(t.expiresAt)) : "Never"}
                    </td>
                    <td className="num">
                      <button type="button" className="icon-btn small" aria-label={`Revoke ${t.name}`} onClick={() => setRevoking(t)}>
                        <Trash2 size={13} />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
      <Card title="Using a token">
        <p className="small">Send it as a bearer token. Every API path starts with /api/v1.</p>
        <pre className="code-block">
          <code>{`curl -H "Authorization: Bearer gt_..." \\\n  ${origin}/api/v1/w/${slug}/issues?assignee=me`}</code>
        </pre>
        <p className="muted small">
          The full list of endpoints is in docs/API.md in the{" "}
          <a href="https://github.com/transparent-ai-businesses/glasstrack/blob/main/docs/API.md" target="_blank" rel="noreferrer">
            Glasstrack repository
          </a>
          .
        </p>
      </Card>
      {revoking && (
        <ConfirmDialog
          title={`Revoke ${revoking.name}?`}
          message="Anything using it stops working right away."
          confirmLabel="Revoke token"
          danger
          onConfirm={() => revoke(revoking)}
          onClose={() => setRevoking(null)}
        />
      )}
    </>
  );
}
