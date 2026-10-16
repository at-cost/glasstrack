import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Card } from "../../components/Card";
import { ConfirmDialog } from "../../components/Dialog";
import { Spinner } from "../../components/Feedback";
import { type AdminOverview, ApiError, api, errorMessage, type RefundRequest } from "../../lib/api";
import { formatUsd, shortDate } from "../../lib/money";
import { keys } from "../../lib/queries";

type Result = { kind: "ok" | "error"; text: string };

/** The refund route passes payment provider errors through as a bare 500, so explain the likely cause. */
function refundError(err: unknown): string {
  if (err instanceof ApiError && err.status >= 500) {
    return "the payment provider refused or isn't set up on this server (no STRIPE_SECRET_KEY?). Nothing was refunded. Check the server log.";
  }
  return errorMessage(err);
}

export function RefundRequestsCard({ o }: { o: AdminOverview }) {
  const qc = useQueryClient();
  const [confirm, setConfirm] = useState<RefundRequest | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [result, setResult] = useState<Result | null>(null);
  const run = async (r: RefundRequest) => {
    setBusy(r.workspaceId);
    setResult(null);
    try {
      const { refundedMicro } = await api.admin.refund(r.workspaceId);
      setResult({
        kind: "ok",
        text:
          refundedMicro > 0
            ? `Refunded ${formatUsd(refundedMicro)} to ${r.name}. Automatic top-up is now off for that workspace.`
            : `Nothing was refunded to ${r.name}: it has no unused paid credit left. The request is cleared.`,
      });
      await qc.invalidateQueries({ queryKey: keys.adminOverview });
    } catch (err) {
      setResult({ kind: "error", text: `Refund for ${r.name} failed: ${refundError(err)}` });
    } finally {
      setBusy(null);
    }
  };
  return (
    <Card title="Refund requests">
      {!o.billingEnabled && <p className="muted small">Billing is off on this server, so refunds can't be made.</p>}
      {o.refundRequests.length === 0 ? (
        <p className="muted small">No open requests.</p>
      ) : (
        <div className="table-wrap">
          <table className="data-table" data-testid="refund-requests">
            <thead>
              <tr>
                <th scope="col">Workspace</th>
                <th scope="col">Requested</th>
                <th scope="col" className="num">
                  Balance
                </th>
                <th scope="col" className="num">
                  Refundable
                </th>
                <th scope="col">
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {o.refundRequests.map((r) => (
                <tr key={r.workspaceId}>
                  <td>
                    {r.name}
                    <div className="muted small">{r.slug}</div>
                  </td>
                  <td className="nowrap">{shortDate(r.requestedAt)}</td>
                  <td className="num nowrap">{formatUsd(r.balanceMicro)}</td>
                  <td className="num nowrap">{formatUsd(r.refundableMicro)}</td>
                  <td className="num nowrap">
                    <button
                      type="button"
                      className="btn btn-sm btn-primary"
                      disabled={busy !== null || !o.billingEnabled}
                      onClick={() => setConfirm(r)}
                    >
                      {busy === r.workspaceId && <Spinner label="Refunding" />}
                      Refund {formatUsd(r.refundableMicro)}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {result && (
        <div className={`notice ${result.kind === "ok" ? "notice-accent" : "notice-danger"}`} role="status" data-testid="refund-result">
          {result.text}
        </div>
      )}
      {confirm && (
        <ConfirmDialog
          title={`Refund ${confirm.name}?`}
          message={`This refunds ${formatUsd(confirm.refundableMicro)} of unused paid credit to the card through Stripe and turns off automatic top-up. The signup credit stays. It can't be undone.`}
          confirmLabel={`Refund ${formatUsd(confirm.refundableMicro)}`}
          danger
          onConfirm={() => run(confirm)}
          onClose={() => setConfirm(null)}
        />
      )}
    </Card>
  );
}

const PHRASE = "refund every workspace";

export function RefundAllCard({ o }: { o: AdminOverview }) {
  const qc = useQueryClient();
  const names = new Map(o.refundRequests.map((r) => [r.workspaceId, r.name]));
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<Result | null>(null);
  const run = async (e: React.FormEvent) => {
    e.preventDefault();
    if (typed !== PHRASE) return;
    setBusy(true);
    setResult(null);
    try {
      const r = await api.admin.refundAll(typed);
      setResult({
        kind: r.failed.length ? "error" : "ok",
        text: `Refunded ${formatUsd(r.refundedMicro)} across ${r.workspaces} ${r.workspaces === 1 ? "workspace" : "workspaces"}.${
          r.failed.length
            ? ` ${r.failed.length} failed: ${r.failed.map((id) => names.get(id) ?? id).join(", ")}. Nothing was taken from those. Check the server log (often Stripe isn't set up), then run it again to retry them.`
            : ""
        }`,
      });
      setTyped("");
      await qc.invalidateQueries({ queryKey: keys.adminOverview });
    } catch (err) {
      setResult({ kind: "error", text: errorMessage(err) });
    } finally {
      setBusy(false);
    }
  };
  return (
    <Card title="Danger zone" danger>
      <h3 className="subsection-title">Refund every workspace (service closing)</h3>
      <p className="small">
        Only for shutting the service down. Refunds every workspace's unused paid credit to its card through Stripe and turns off automatic
        top-up everywhere. It can't be undone.
      </p>
      <form className="invite-form" onSubmit={run}>
        <div className="field grow">
          <label className="field-label" htmlFor="refund-all-confirm">
            Type <strong>{PHRASE}</strong> to confirm
          </label>
          <input
            id="refund-all-confirm"
            className="input"
            autoComplete="off"
            spellCheck={false}
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
          />
        </div>
        <div className="invite-buttons">
          <button type="submit" className="btn btn-danger" disabled={typed !== PHRASE || busy || !o.billingEnabled}>
            {busy && <Spinner label="Refunding" />}
            Refund every workspace
          </button>
        </div>
      </form>
      {!o.billingEnabled && <p className="muted small">Billing is off on this server.</p>}
      {result && (
        <div className={`notice ${result.kind === "ok" ? "notice-accent" : "notice-danger"}`} role="status" data-testid="refund-all-result">
          {result.text}
        </div>
      )}
    </Card>
  );
}
