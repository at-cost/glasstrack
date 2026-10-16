import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { Pencil, Plus, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import { Card } from "../../components/Card";
import { ConfirmDialog, Dialog } from "../../components/Dialog";
import { Empty, FullPageLoading, Spinner } from "../../components/Feedback";
import { type AdminOverview, api, type CostCategory, type CostEntry, type CostInput, errorMessage, type SavingEntry } from "../../lib/api";
import { addDays, todayISO } from "../../lib/format";
import { formatUsd, microToInput, shortDate } from "../../lib/money";
import { paths } from "../../lib/paths";
import { keys, useMe, useOperator } from "../../lib/queries";
import { toast, toastError } from "../../lib/toast";
import { PricingSettingsCard } from "./PricingSettingsCard";
import { RefundAllCard, RefundRequestsCard } from "./RefundsCards";

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
      {!o.billingEnabled && (
        <div className="notice notice-warning" role="status">
          Billing is off on this server. Workspaces are not charged and refunds can't be made.
        </div>
      )}
      <Snapshot o={o} />
      <RefundRequestsCard o={o} />
      <PricingSettingsCard o={o} />
      <Costs o={o} />
      <Savings o={o} />
      <Recompute o={o} />
      <RefundAllCard o={o} />
    </div>
  );
}

const monthName = (ym: string) => new Date(`${ym}-01T00:00:00`).toLocaleDateString("en-US", { month: "long", year: "numeric" });

function Snapshot({ o }: { o: AdminOverview }) {
  const f = o.finances;
  const t = f.thisMonth;
  const credits = t.costs.filter((c) => c.paidByCredits).reduce((a, c) => a + c.amountMicro, 0);
  const tiles: { label: string; value: string; note: string; id?: string }[] = [
    {
      label: "Costs this month",
      value: formatUsd(t.totalCostMicro),
      note: credits > 0 ? `${formatUsd(credits)} paid by provider credits` : `${formatUsd(t.paymentFeesMicro)} card fees`,
      id: "admin-costs",
    },
    { label: "Revenue", value: formatUsd(t.revenueMicro), note: `${t.payingWorkspaces} paying, ${t.activeWorkspaces} active workspaces` },
    { label: "Credit held", value: formatUsd(t.creditHeldMicro), note: "Unused prepaid balances, not income" },
    { label: "Covered by the founder", value: formatUsd(t.founderGapMicro), note: "Costs and fees not covered by revenue" },
    {
      label: "Reserve",
      value: formatUsd(f.reserve.balanceMicro),
      note: `Target ${formatUsd(f.reserve.targetMicro)} (${f.reserve.targetMonths} ${f.reserve.targetMonths === 1 ? "month" : "months"} of costs)`,
    },
    {
      label: "Server share cap",
      value: formatUsd(f.serverShareCapMicro, { precise: true }),
      note:
        f.recommendedCapMicro !== null
          ? `Recommended ${formatUsd(f.recommendedCapMicro, { precise: true })}`
          : "No lower cap recommended yet",
      id: "admin-cap",
    },
  ];
  return (
    <Card
      title={
        <>
          {monthName(t.month)}
          {f.example && (
            <span className="badge" style={{ marginLeft: 8 }} data-testid="admin-example">
              Example
            </span>
          )}
        </>
      }
      actions={
        <Link to={paths.finances()} className="btn btn-sm btn-ghost">
          Public finances
        </Link>
      }
    >
      {f.example ? (
        <p className="small">No real costs are recorded yet, so these are example figures. The public pages label them "Example" too.</p>
      ) : (
        <p className="muted small">
          {f.monthToDate ? `Month to date, ${shortDate(f.monthToDate.from)} to ${shortDate(f.monthToDate.to)}. ` : ""}Same figures as the
          public finances page. Updated {shortDate(f.updatedAt)}.
        </p>
      )}
      <dl className="tiles">
        {tiles.map((x) => (
          <div className="tile" key={x.label}>
            <dt>{x.label}</dt>
            <dd data-testid={x.id}>{x.value}</dd>
            <span className="tile-note">{x.note}</span>
          </div>
        ))}
      </dl>
    </Card>
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
        {o.awsConfigured
          ? "AWS costs are imported automatically and can't be edited here."
          : "AWS cost import is off. Add every cost by hand."}{" "}
        Each cost is spread evenly over its days. Costs paid with provider credits are still shown at list price.
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
                    {c.paidByCredits && <div className="muted small">Paid by credits</div>}
                  </td>
                  <td className="num nowrap">{formatUsd(c.amountMicro, { precise: true })}</td>
                  <td className="num nowrap">
                    {c.source === "manual" && (
                      <>
                        <button type="button" className="icon-btn small" aria-label={`Edit ${c.publicLabel}`} onClick={() => setEditing(c)}>
                          <Pencil size={13} />
                        </button>
                        <button
                          type="button"
                          className="icon-btn small"
                          aria-label={`Delete ${c.publicLabel}`}
                          onClick={() => setDeleting(c)}
                        >
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
  const [paidByCredits, setPaidByCredits] = useState(entry?.paidByCredits ?? false);
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
      paidByCredits,
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
            <input
              id="cost-start"
              className="input"
              type="date"
              value={periodStart}
              data-autofocus
              onChange={(e) => setStart(e.target.value)}
            />
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
        <label className="check-row">
          <input type="checkbox" checked={paidByCredits} onChange={(e) => setPaidByCredits(e.target.checked)} />
          Paid by provider credits (shown at list price)
        </label>
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
      <p className="muted small">
        Rebuilds revenue, costs, reserve and the recommended cap for each day in the range. Run it after changing costs.
      </p>
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

function Savings({ o }: { o: AdminOverview }) {
  const qc = useQueryClient();
  const [day, setDay] = useState(todayISO());
  const [change, setChange] = useState("");
  const [amount, setAmount] = useState("");
  const [busy, setBusy] = useState(false);
  const [deleting, setDeleting] = useState<SavingEntry | null>(null);
  const valid = day !== "" && change.trim().length >= 3 && amount !== "" && Number(amount) >= 0;
  const add = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!valid) return;
    setBusy(true);
    try {
      await api.admin.addSaving({ day, change: change.trim(), savingMonthUsd: Number(amount) });
      await qc.invalidateQueries({ queryKey: keys.adminOverview });
      qc.invalidateQueries({ queryKey: keys.publicFinances });
      setChange("");
      setAmount("");
      toast("Saving added", "success");
    } catch (err) {
      toastError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };
  const remove = async (s: SavingEntry) => {
    try {
      await api.admin.deleteSaving(s.id);
      await qc.invalidateQueries({ queryKey: keys.adminOverview });
      qc.invalidateQueries({ queryKey: keys.publicFinances });
      toast("Saving deleted", "success");
    } catch (err) {
      toastError(errorMessage(err));
    }
  };
  return (
    <Card title="Savings log">
      <p className="muted small">Changes that made running Glasstrack cheaper. Shown on the public finances page.</p>
      <form className="invite-form" onSubmit={add}>
        <div className="field">
          <label className="field-label" htmlFor="sv-day">
            Date
          </label>
          <input id="sv-day" className="input" type="date" value={day} onChange={(e) => setDay(e.target.value)} />
        </div>
        <div className="field grow">
          <label className="field-label" htmlFor="sv-change">
            What changed
          </label>
          <input id="sv-change" className="input" maxLength={300} value={change} onChange={(e) => setChange(e.target.value)} />
        </div>
        <div className="field">
          <label className="field-label" htmlFor="sv-amount">
            Saving a month
          </label>
          <div className="input-prefix narrow">
            <span className="prefix" aria-hidden="true">
              $
            </span>
            <input
              id="sv-amount"
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
        <div className="invite-buttons">
          <button type="submit" className="btn btn-primary" disabled={!valid || busy}>
            <Plus size={14} aria-hidden="true" />
            Add saving
          </button>
        </div>
      </form>
      {o.savings.length === 0 ? (
        <p className="muted small">No savings logged yet.</p>
      ) : (
        <div className="table-wrap">
          <table className="data-table" data-testid="savings">
            <thead>
              <tr>
                <th scope="col">Date</th>
                <th scope="col">Change</th>
                <th scope="col" className="num">
                  Saving a month
                </th>
                <th scope="col">
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {o.savings.map((s) => (
                <tr key={s.id}>
                  <td className="nowrap">{shortDate(s.day)}</td>
                  <td>
                    {s.change}
                    {s.createdBy && <div className="muted small">by {s.createdBy}</div>}
                  </td>
                  <td className="num nowrap">{formatUsd(s.savingMonthMicro, { precise: true })}</td>
                  <td className="num nowrap">
                    <button
                      type="button"
                      className="icon-btn small"
                      aria-label={`Delete saving: ${s.change}`}
                      onClick={() => setDeleting(s)}
                    >
                      <Trash2 size={13} />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {deleting && (
        <ConfirmDialog
          title="Delete this saving?"
          message={deleting.change}
          confirmLabel="Delete saving"
          danger
          onConfirm={() => remove(deleting)}
          onClose={() => setDeleting(null)}
        />
      )}
    </Card>
  );
}
