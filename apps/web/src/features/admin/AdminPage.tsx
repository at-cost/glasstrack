import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { Pencil, Plus, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import { Card } from "../../components/Card";
import { ConfirmDialog, Dialog } from "../../components/Dialog";
import { Empty, FullPageLoading, Spinner } from "../../components/Feedback";
import { LineChart } from "../../components/LineChart";
import { type AdminOverview, api, type CostCategory, type CostEntry, type CostInput, errorMessage } from "../../lib/api";
import { addDays, todayISO } from "../../lib/format";
import { formatUsd, MICRO, microToInput, percent, shortDate, usdAxis } from "../../lib/money";
import { paths } from "../../lib/paths";
import { keys, useMe, useOperator } from "../../lib/queries";
import { toast, toastError } from "../../lib/toast";

export function AdminPage() {
  const me = useMe();
  const op = useOperator();
  useEffect(() => {
    document.title = "Operator admin · Glasstrack";
    return () => {
      document.title = "Glasstrack";
    };
  }, []);
  return (
    <div className="public-page">
      <header className="public-bar">
        <Link to="/" className="public-brand">
          <img src="/favicon.svg" alt="" width={22} height={22} />
          Glasstrack
        </Link>
        <nav className="row" aria-label="Admin">
          <Link to={paths.finances()} className="btn btn-sm btn-ghost">
            Public page
          </Link>
          <Link to="/" className="btn btn-sm">
            Back to app
          </Link>
        </nav>
      </header>
      <main id="main" className="public-main">
        {me.isPending || op.isPending ? (
          <FullPageLoading />
        ) : !op.data?.operator ? (
          <Empty title="Operators only">This page is for the people who run this server.</Empty>
        ) : (
          <Overview />
        )}
      </main>
    </div>
  );
}

function Overview() {
  const q = useQuery({ queryKey: keys.adminOverview, queryFn: () => api.admin.overview() });
  if (q.isPending) return <FullPageLoading />;
  if (q.error) return <Empty title="Could not load">{errorMessage(q.error)}</Empty>;
  const o = q.data;
  return (
    <div className="fin admin">
      <h1 className="fin-title">Operator admin</h1>
      <Pricing o={o} />
      <Costs o={o} />
      <Recompute o={o} />
      {o.history.length > 0 && (
        <Card title="Last 90 days">
          <LineChart
            title="Revenue and costs per day"
            days={o.history.map((r) => r.day)}
            series={[
              { key: "rev", label: "Revenue", color: "var(--series-1)", values: o.history.map((r) => r.revenueMicro) },
              { key: "cost", label: "Costs", color: "var(--series-2)", values: o.history.map((r) => r.totalCostMicro) },
            ]}
            format={(v) => formatUsd(v, { precise: true })}
            axisFormat={usdAxis}
          />
        </Card>
      )}
    </div>
  );
}

function Pricing({ o }: { o: AdminOverview }) {
  const [lowering, setLowering] = useState(false);
  const rec = o.latest?.recommendedPriceMicro ?? null;
  return (
    <Card title="Price">
      <dl className="tiles">
        <div className="tile">
          <dt>Current price</dt>
          <dd data-testid="admin-price">{formatUsd(o.currentPriceMicro)}</dd>
          <span className="tile-note">per workspace per month</span>
        </div>
        <div className="tile">
          <dt>Recommended</dt>
          <dd>{rec === null ? "None yet" : formatUsd(rec)}</dd>
          <span className="tile-note">{o.latest ? `as of ${shortDate(o.latest.day)}` : "run a recompute first"}</span>
        </div>
        <div className="tile">
          <dt>Margin</dt>
          <dd>{o.latest ? percent(o.latest.marginBp) : "None"}</dd>
          <span className="tile-note">{o.latest ? `${o.latest.payingWorkspaces} paying workspaces` : ""}</span>
        </div>
      </dl>
      {o.canLower && rec !== null ? (
        <div className="notice notice-accent">
          <span>
            Costs allow a lower price: {formatUsd(rec)} instead of {formatUsd(o.currentPriceMicro)}.
          </span>
          <div>
            <button type="button" className="btn btn-primary" onClick={() => setLowering(true)}>
              Lower price
            </button>
          </div>
        </div>
      ) : (
        <p className="muted small">The recommendation is not below the current price, so there is nothing to lower.</p>
      )}
      <div className="subsection">
        <h3 className="subsection-title">Price history</h3>
        <ol className="price-history">
          {o.pricing.map((p) => (
            <li key={p.id}>
              <span className="ph-price">{formatUsd(p.monthlyPriceMicro)}</span>
              <span className="muted small nowrap">from {shortDate(p.effectiveFrom)}</span>
              <span className="ph-reason">
                {p.reason}
                {p.createdBy && <span className="muted small"> by {p.createdBy}</span>}
              </span>
            </li>
          ))}
        </ol>
      </div>
      {lowering && <LowerPriceDialog o={o} onClose={() => setLowering(false)} />}
    </Card>
  );
}

function LowerPriceDialog({ o, onClose }: { o: AdminOverview; onClose: () => void }) {
  const qc = useQueryClient();
  const rec = o.latest?.recommendedPriceMicro ?? o.currentPriceMicro;
  const [amount, setAmount] = useState(microToInput(rec));
  const [reason, setReason] = useState(
    o.latest ? `Costs fell. Recommended price on ${o.latest.day} at ${percent(o.latest.marginBp)} margin.` : "",
  );
  const [step, setStep] = useState<"edit" | "confirm">("edit");
  const [busy, setBusy] = useState(false);
  const micro = Math.round(Number(amount) * MICRO);
  const valid = amount !== "" && micro >= 0 && micro < o.currentPriceMicro && reason.trim().length >= 3;
  const run = async () => {
    setBusy(true);
    try {
      await api.admin.lowerPrice(Number(amount), reason.trim());
      await qc.invalidateQueries({ queryKey: keys.adminOverview });
      qc.invalidateQueries({ queryKey: keys.publicFinances });
      toast(`Price lowered to ${formatUsd(micro)}`, "success");
      onClose();
    } catch (e) {
      toastError(errorMessage(e));
      setBusy(false);
    }
  };
  return (
    <Dialog
      title={step === "edit" ? "Lower the price" : "Lower the price for good?"}
      onClose={onClose}
      size="sm"
      footer={
        step === "edit" ? (
          <>
            <button type="button" className="btn" onClick={onClose}>
              Cancel
            </button>
            <button type="button" className="btn btn-primary" disabled={!valid} onClick={() => setStep("confirm")}>
              Continue
            </button>
          </>
        ) : (
          <>
            <button type="button" className="btn" onClick={() => setStep("edit")}>
              Back
            </button>
            <button type="button" className="btn btn-danger" disabled={busy} onClick={run} data-autofocus>
              {busy && <Spinner label="Saving" />}
              Lower to {formatUsd(micro)}
            </button>
          </>
        )
      }
    >
      {step === "edit" ? (
        <div className="stack">
          <div className="field">
            <label className="field-label" htmlFor="lower-amount">
              New monthly price
            </label>
            <div className="input-prefix narrow">
              <span className="prefix" aria-hidden="true">
                $
              </span>
              <input
                id="lower-amount"
                className="input"
                type="number"
                min={0}
                step="0.01"
                value={amount}
                data-autofocus
                aria-invalid={amount !== "" && micro >= o.currentPriceMicro}
                onChange={(e) => setAmount(e.target.value)}
              />
            </div>
            <p className="field-hint">Must be below {formatUsd(o.currentPriceMicro)}.</p>
          </div>
          <div className="field">
            <label className="field-label" htmlFor="lower-reason">
              Reason (shown publicly)
            </label>
            <textarea id="lower-reason" className="textarea" rows={3} maxLength={300} value={reason} onChange={(e) => setReason(e.target.value)} />
          </div>
        </div>
      ) : (
        <p>
          The price goes from {formatUsd(o.currentPriceMicro)} to <strong>{formatUsd(micro)}</strong> a month for every workspace.{" "}
          <strong>It can never be raised again.</strong>
        </p>
      )}
    </Dialog>
  );
}

function Costs({ o }: { o: AdminOverview }) {
  const qc = useQueryClient();
  const [editing, setEditing] = useState<CostEntry | "new" | null>(null);
  const [deleting, setDeleting] = useState<CostEntry | null>(null);
  const remove = async (c: CostEntry) => {
    try {
      await api.admin.deleteCost(c.id);
      await qc.invalidateQueries({ queryKey: keys.adminOverview });
      toast("Cost deleted. Recompute to update the daily figures.", "success");
    } catch (e) {
      toastError(errorMessage(e));
    }
  };
  return (
    <Card
      title="Costs"
      actions={
        <button type="button" className="btn btn-sm btn-primary" onClick={() => setEditing("new")}>
          <Plus size={14} aria-hidden="true" />
          Add cost
        </button>
      }
    >
      <p className="muted small">
        {o.awsConfigured ? "AWS costs are imported automatically and can't be edited here." : "AWS cost import is off. Add every cost by hand."}{" "}
        Each cost is spread evenly over its days.
      </p>
      {o.costs.length === 0 ? (
        <p className="muted small">No costs yet.</p>
      ) : (
        <div className="table-wrap">
          <table className="data-table">
            <thead>
              <tr>
                <th scope="col">Period</th>
                <th scope="col">Public label</th>
                <th scope="col">Category</th>
                <th scope="col">Source</th>
                <th scope="col" className="num">
                  Amount
                </th>
                <th scope="col">
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {o.costs.map((c) => (
                <tr key={c.id}>
                  <td className="nowrap">
                    {c.periodStart === c.periodEnd ? shortDate(c.periodStart) : `${shortDate(c.periodStart)} to ${shortDate(c.periodEnd)}`}
                  </td>
                  <td>
                    {c.publicLabel}
                    {c.note && <div className="muted small">{c.note}</div>}
                  </td>
                  <td>{o.categories[c.category] ?? c.category}</td>
                  <td>
                    <span className="badge">{c.source === "aws" ? "AWS" : "Manual"}</span>
                  </td>
                  <td className="num nowrap">{formatUsd(c.amountMicro, { precise: true })}</td>
                  <td className="num nowrap">
                    {c.source === "manual" && (
                      <>
                        <button type="button" className="icon-btn small" aria-label={`Edit ${c.publicLabel}`} onClick={() => setEditing(c)}>
                          <Pencil size={13} />
                        </button>
                        <button type="button" className="icon-btn small" aria-label={`Delete ${c.publicLabel}`} onClick={() => setDeleting(c)}>
                          <Trash2 size={13} />
                        </button>
                      </>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {editing && <CostDialog o={o} entry={editing === "new" ? null : editing} onClose={() => setEditing(null)} />}
      {deleting && (
        <ConfirmDialog
          title={`Delete ${deleting.publicLabel}?`}
          message="The daily figures keep the old amount until you recompute."
          confirmLabel="Delete cost"
          danger
          onConfirm={() => remove(deleting)}
          onClose={() => setDeleting(null)}
        />
      )}
    </Card>
  );
}

function CostDialog({ o, entry, onClose }: { o: AdminOverview; entry: CostEntry | null; onClose: () => void }) {
  const qc = useQueryClient();
  const first = `${todayISO().slice(0, 8)}01`;
  const [periodStart, setStart] = useState(entry?.periodStart ?? first);
  const [periodEnd, setEnd] = useState(entry?.periodEnd ?? todayISO());
  const [category, setCategory] = useState<CostCategory>(entry?.category ?? "infrastructure");
  const [amount, setAmount] = useState(entry ? microToInput(entry.amountMicro) : "");
  const [label, setLabel] = useState(entry?.publicLabel ?? "");
  const [note, setNote] = useState(entry?.note ?? "");
  const [busy, setBusy] = useState(false);
  const valid = periodStart && periodEnd && periodStart <= periodEnd && amount !== "" && Number(amount) >= 0;
  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!valid) return;
    setBusy(true);
    const body: CostInput = {
      periodStart,
      periodEnd,
      category,
      amountUsd: Number(amount),
      publicLabel: label.trim() || undefined,
      note: note.trim() || undefined,
    };
    try {
      if (entry) await api.admin.updateCost(entry.id, body);
      else await api.admin.addCost(body);
      await qc.invalidateQueries({ queryKey: keys.adminOverview });
      toast(entry ? "Cost saved" : "Cost added. Recompute to update the daily figures.", "success");
      onClose();
    } catch (err) {
      toastError(errorMessage(err));
      setBusy(false);
    }
  };
  return (
    <Dialog title={entry ? "Edit cost" : "Add a cost"} onClose={onClose} size="sm">
      <form className="stack" onSubmit={save}>
        <div className="field-row">
          <div className="field">
            <label className="field-label" htmlFor="cost-start">
              From
            </label>
            <input id="cost-start" className="input" type="date" value={periodStart} data-autofocus onChange={(e) => setStart(e.target.value)} />
          </div>
          <div className="field">
            <label className="field-label" htmlFor="cost-end">
              To (inclusive)
            </label>
            <input
              id="cost-end"
              className="input"
              type="date"
              value={periodEnd}
              min={periodStart}
              aria-invalid={periodEnd < periodStart}
              onChange={(e) => setEnd(e.target.value)}
            />
          </div>
        </div>
        <div className="field-row">
          <div className="field">
            <label className="field-label" htmlFor="cost-cat">
              Category
            </label>
            <select id="cost-cat" className="select" value={category} onChange={(e) => setCategory(e.target.value as CostCategory)}>
              {Object.entries(o.categories).map(([k, v]) => (
                <option key={k} value={k}>
                  {v}
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label className="field-label" htmlFor="cost-amount">
              Amount
            </label>
            <div className="input-prefix">
              <span className="prefix" aria-hidden="true">
                $
              </span>
              <input
                id="cost-amount"
                className="input"
                type="number"
                min={0}
                step="0.01"
                inputMode="decimal"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
              />
            </div>
          </div>
        </div>
        <div className="field">
          <label className="field-label" htmlFor="cost-label">
            Public label
          </label>
          <input
            id="cost-label"
            className="input"
            maxLength={60}
            placeholder={o.categories[category]}
            value={label}
            aria-describedby="cost-label-hint"
            onChange={(e) => setLabel(e.target.value)}
          />
          <p className="field-hint" id="cost-label-hint">
            Shown on the public finances page. Leave empty to use the category name.
          </p>
        </div>
        <div className="field">
          <label className="field-label" htmlFor="cost-note">
            Private note
          </label>
          <input id="cost-note" className="input" maxLength={500} value={note} onChange={(e) => setNote(e.target.value)} />
        </div>
        <div className="row-end">
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="btn btn-primary" disabled={!valid || busy}>
            {entry ? "Save" : "Add cost"}
          </button>
        </div>
      </form>
    </Dialog>
  );
}

function Recompute({ o }: { o: AdminOverview }) {
  const qc = useQueryClient();
  const earliest = o.costs.reduce<string | null>((m, c) => (m === null || c.periodStart < m ? c.periodStart : m), null);
  const yesterday = addDays(todayISO(), -1);
  const [from, setFrom] = useState(earliest && earliest < yesterday ? earliest : addDays(todayISO(), -30));
  const [to, setTo] = useState(yesterday);
  const [busy, setBusy] = useState(false);
  const run = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      const r = await api.admin.recompute(from, to || undefined);
      await qc.invalidateQueries({ queryKey: keys.adminOverview });
      qc.invalidateQueries({ queryKey: keys.publicFinances });
      toast(`Recomputed ${r.days} ${r.days === 1 ? "day" : "days"}`, "success");
    } catch (err) {
      toastError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Card title="Recompute daily figures">
      <p className="muted small">Rebuilds revenue, costs, reserve and the recommended price for each day in the range. Run it after changing costs.</p>
      <form className="invite-form" onSubmit={run}>
        <div className="field">
          <label className="field-label" htmlFor="rc-from">
            From
          </label>
          <input id="rc-from" className="input" type="date" value={from} max={to || undefined} onChange={(e) => setFrom(e.target.value)} />
        </div>
        <div className="field">
          <label className="field-label" htmlFor="rc-to">
            To
          </label>
          <input id="rc-to" className="input" type="date" value={to} min={from} onChange={(e) => setTo(e.target.value)} />
        </div>
        <div className="invite-buttons">
          <button type="submit" className="btn btn-primary" disabled={busy || !from || (to !== "" && to < from)}>
            {busy && <Spinner label="Recomputing" />}
            Recompute
          </button>
        </div>
      </form>
    </Card>
  );
}
