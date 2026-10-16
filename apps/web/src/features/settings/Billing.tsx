import { useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate, useSearch } from "@tanstack/react-router";
import { MICRO } from "@glasstrack/shared";
import { CreditCard } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import { Card } from "../../components/Card";
import { ConfirmDialog } from "../../components/Dialog";
import { Empty, Skeleton, Spinner } from "../../components/Feedback";
import { type BillingOn, api, errorMessage } from "../../lib/api";
import { formatUsd, microToInput, shortDate, signedUsd } from "../../lib/money";
import { paths } from "../../lib/paths";
import { keys, useBilling } from "../../lib/queries";
import { toast } from "../../lib/toast";
import { useWs } from "../shell/context";

const PRESETS = [10, 25, 50, 100];

const LEDGER_LABEL: Record<string, string> = {
  starter_grant: "Starter credit",
  topup: "Top-up",
  charge: "Daily charge",
  storage_charge: "Storage",
  refund: "Refund",
  adjustment: "Adjustment",
};
const PAYMENT_LABEL: Record<string, string> = { topup: "Top-up", auto_topup: "Automatic top-up" };

const precise = (micro: number) => formatUsd(micro, { precise: true });
const usdSetting = (usd: number) => formatUsd(Math.round(usd * MICRO), { precise: true });
const pct = (fraction: number) => `${(fraction * 100).toLocaleString("en-US", { maximumFractionDigits: 2 })}%`;
const longDate = (iso: string) => new Date(iso).toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" });
/** Whole dollars and cents only. */
const isCents = (n: number) => Number.isFinite(n) && Math.abs(Math.round(n * 100) - n * 100) < 1e-6;

export function Billing() {
  const { slug, isAdmin } = useWs();
  const q = useBilling(slug);
  useTopupReturn(slug);
  if (q.isPending) return <Skeleton rows={4} />;
  if (q.error) return <Empty title="Could not load billing">{errorMessage(q.error)}</Empty>;
  if (!q.data.enabled) return <Empty title="Billing is off on this server">Self-hosted servers have no billing.</Empty>;
  const b = q.data;
  return (
    <>
      <StatusNotice b={b} />
      <Balance b={b} />
      <Costs b={b} />
      {isAdmin ? (
        <>
          <TopUp b={b} />
          <AutoTopUp b={b} />
          <Refund b={b} />
        </>
      ) : (
        <p className="muted small">Only workspace admins can add credit, change automatic top-up or ask for a refund.</p>
      )}
      <Ledger b={b} />
      <Payments b={b} />
    </>
  );
}

/** Handles ?topup=success|cancelled after Stripe Checkout and polls until the webhook lands. */
function useTopupReturn(slug: string) {
  const search = useSearch({ strict: false }) as { topup?: string };
  const navigate = useNavigate();
  const qc = useQueryClient();
  const handled = useRef(false);
  useEffect(() => {
    const result = search.topup;
    if (!result || handled.current) return;
    handled.current = true;
    navigate({ to: paths.settings(slug, "billing"), search: {}, replace: true });
    if (result === "cancelled") {
      toast("Top-up cancelled. You were not charged.");
      return;
    }
    if (result !== "success") return;
    toast("Payment received. Your balance updates in a few seconds.", "success");
    const before = (qc.getQueryData(keys.billing(slug)) as BillingOn | undefined)?.balanceMicro;
    let tries = 0;
    const timer = window.setInterval(async () => {
      tries++;
      await qc.invalidateQueries({ queryKey: keys.billing(slug) });
      const now = (qc.getQueryData(keys.billing(slug)) as BillingOn | undefined)?.balanceMicro;
      if ((before !== undefined && now !== undefined && now > before) || tries >= 8) window.clearInterval(timer);
    }, 2500);
    return () => window.clearInterval(timer);
  }, [search.topup, slug, navigate, qc]);
}

function StatusNotice({ b }: { b: BillingOn }) {
  if (b.status === "grace") {
    const ends = b.graceStartedAt ? new Date(new Date(b.graceStartedAt).getTime() + 7 * 86_400_000) : null;
    return (
      <div className="notice notice-warning" role="status">
        <strong>The balance has run out.</strong> Everything keeps working until{" "}
        {ends ? ends.toLocaleDateString("en-US", { month: "long", day: "numeric" }) : "the 7-day grace period ends"}. After that the
        workspace becomes read-only until someone tops up. Nothing is deleted.
      </div>
    );
  }
  if (b.status === "read_only") {
    return (
      <div className="notice notice-danger" role="status">
        <strong>This workspace is read-only.</strong> You can still view and export everything. Add credit to turn editing back on.
      </div>
    );
  }
  return null;
}

function lastsText(b: BillingOn): string {
  const days = b.creditLastsDays;
  if (days === null || b.dailyChargeMicro <= 0) return "Nothing is being charged right now.";
  if (b.balanceMicro <= 0) return "No credit left.";
  if (days === 0) return "Less than a day of credit left.";
  return `Lasts about ${days.toLocaleString("en-US")} ${days === 1 ? "day" : "days"} at today's rate.`;
}

function Balance({ b }: { b: BillingOn }) {
  return (
    <Card title="Balance">
      <div className="balance-row">
        <div>
          <div className={`balance-big${b.balanceMicro <= 0 ? " negative" : ""}`} data-testid="billing-balance">
            {formatUsd(b.balanceMicro)}
          </div>
          <p className="muted" data-testid="billing-lasts">
            {lastsText(b)}
          </p>
        </div>
        <dl className="stat-list">
          <div>
            <dt>Charged today</dt>
            <dd>{precise(b.dailyChargeMicro)}</dd>
          </div>
          <div>
            <dt>About a month</dt>
            <dd>{formatUsd(b.estimate.monthly.totalMicro)}</dd>
          </div>
        </dl>
      </div>
      <p className="small">
        You pay what this workspace costs to run, from prepaid credit, charged once a day. Members are unlimited. New workspaces start with{" "}
        {usdSetting(b.pricing.signupCreditUsd)} of credit.
      </p>
      <p className="muted small">
        We email the admins when the balance drops below 25% of the last amount added. At $0 everything keeps working for 7 days, then the
        workspace becomes read-only until someone tops up. Nothing is ever deleted.
      </p>
    </Card>
  );
}

function Costs({ b }: { b: BillingOn }) {
  const { monthly: m, daily: d, storageGb, emailsPerMonth, active } = b.estimate;
  const s = b.pricing;
  const rows: { label: string; note: string; month: number; day: number }[] = [
    {
      label: "Server share",
      note: active
        ? `Shared server costs split across active workspaces, at most ${usdSetting(s.serverShareCapUsd)} a month`
        : "None while the workspace is inactive",
      month: m.serverShareMicro,
      day: d.serverShareMicro,
    },
    {
      label: "Storage",
      note: `${storageGb.toLocaleString("en-US", { maximumFractionDigits: 2 })} GB at ${usdSetting(s.storageUsdPerGbMonth)} per GB a month`,
      month: m.storageMicro,
      day: d.storageMicro,
    },
    {
      label: "Email",
      note: `${emailsPerMonth.toLocaleString("en-US")} ${emailsPerMonth === 1 ? "email" : "emails"} a month at ${usdSetting(s.emailUsdPer1000)} per 1,000`,
      month: m.emailMicro,
      day: d.emailMicro,
    },
    {
      label: `Fees and reserve (${pct(s.feeMarkup)})`,
      note: "Card fees and a small reserve for the service",
      month: m.feesAndReserveMicro,
      day: d.feesAndReserveMicro,
    },
  ];
  return (
    <Card title="What this workspace costs">
      {!active && (
        <div className="notice" role="status" data-testid="billing-inactive">
          No activity in the last 30 days, so this workspace counts as inactive and pays only for storage and email.
        </div>
      )}
      <div className="table-wrap">
        <table className="data-table" data-testid="billing-costs">
          <thead>
            <tr>
              <th scope="col">Item</th>
              <th scope="col" className="num">
                Per month
              </th>
              <th scope="col" className="num">
                Today
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.label}>
                <th scope="row" style={{ fontWeight: 500 }}>
                  {r.label}
                  <div className="muted small">{r.note}</div>
                </th>
                <td className="num nowrap">{precise(r.month)}</td>
                <td className="num nowrap">{precise(r.day)}</td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr>
              <th scope="row">Total</th>
              <td className="num nowrap">{precise(m.totalMicro)}</td>
              <td className="num nowrap">{precise(d.totalMicro)}</td>
            </tr>
          </tfoot>
        </table>
      </div>
      <p className="small">
        The monthly figure is an estimate from today's usage. Each day is charged at the month's amount divided by the days in the month.{" "}
        <a href="/pricing">How the price is worked out</a> · <a href="/finances">Our costs</a>
      </p>
    </Card>
  );
}

function TopUp({ b }: { b: BillingOn }) {
  const { slug } = useWs();
  const min = b.limits.minTopupMicro / MICRO;
  const max = b.limits.maxTopupMicro / MICRO;
  const presets = PRESETS.filter((p) => p >= min && p <= max);
  const [choice, setChoice] = useState<number | "custom">(presets[0] ?? "custom");
  const [custom, setCustom] = useState("");
  const [saveCard, setSaveCard] = useState(!b.card);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const customId = useId();
  const amount = choice === "custom" ? Number(custom) : choice;
  const valid = (choice !== "custom" || custom.trim() !== "") && isCents(amount) && amount >= min && amount <= max;
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!valid) return;
    setBusy(true);
    setError(null);
    try {
      const { url } = await api.ws(slug).topup(amount, saveCard);
      window.location.assign(url);
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  };
  return (
    <Card title="Add credit">
      <form className="stack" onSubmit={submit}>
        <fieldset className="fieldset">
          <legend className="field-label">Amount</legend>
          <div className="preset-row">
            {presets.map((p) => (
              <label key={p} className={`preset${choice === p ? " on" : ""}`}>
                <input type="radio" name="topup-amount" checked={choice === p} onChange={() => setChoice(p)} />${p}
              </label>
            ))}
            <label className={`preset${choice === "custom" ? " on" : ""}`}>
              <input type="radio" name="topup-amount" checked={choice === "custom"} onChange={() => setChoice("custom")} />
              Other
            </label>
          </div>
        </fieldset>
        {choice === "custom" && (
          <div className="field">
            <label className="field-label" htmlFor={customId}>
              Other amount
            </label>
            <div className="input-prefix narrow">
              <span className="prefix" aria-hidden="true">
                $
              </span>
              <input
                id={customId}
                className="input"
                type="number"
                inputMode="decimal"
                min={min}
                max={max}
                step="0.01"
                value={custom}
                aria-invalid={custom !== "" && !valid}
                aria-describedby={`${customId}-hint`}
                onChange={(e) => setCustom(e.target.value)}
              />
            </div>
            <p className="field-hint" id={`${customId}-hint`}>
              {custom !== "" && !valid ? "Enter an amount " : ""}Between {formatUsd(b.limits.minTopupMicro)} and{" "}
              {formatUsd(b.limits.maxTopupMicro)}.
            </p>
          </div>
        )}
        {valid && b.estimate.monthly.totalMicro > 0 && (
          <p className="muted small">
            At today's rate {formatUsd(Math.round(amount * MICRO))} lasts about{" "}
            {Math.floor((amount * MICRO) / (b.estimate.monthly.totalMicro / (365 / 12))).toLocaleString("en-US")} days.
          </p>
        )}
        <label className="check-row">
          <input type="checkbox" checked={saveCard} onChange={(e) => setSaveCard(e.target.checked)} />
          Save this card for automatic top-ups
        </label>
        {error && (
          <div className="notice notice-danger" role="alert" data-testid="topup-error">
            <span>
              <strong>Checkout could not start.</strong> {error}
            </span>
            <span>Nothing was charged. Try again in a few minutes. If it keeps happening, the server's payment setup needs fixing.</span>
          </div>
        )}
        <div className="row">
          <button type="submit" className="btn btn-primary" disabled={!valid || busy}>
            {busy ? <Spinner label="Opening checkout" /> : <CreditCard size={14} aria-hidden="true" />}
            {valid ? `Pay ${formatUsd(Math.round(amount * MICRO))}` : "Pay"}
          </button>
          <span className="muted small">You pay on a secure Stripe page, then come back here.</span>
        </div>
      </form>
    </Card>
  );
}

function AutoTopUp({ b }: { b: BillingOn }) {
  const { slug } = useWs();
  const qc = useQueryClient();
  const min = b.limits.minTopupMicro / MICRO;
  const max = b.limits.maxTopupMicro / MICRO;
  const [enabled, setEnabled] = useState(b.autoTopup.enabled);
  const [threshold, setThreshold] = useState(b.autoTopup.thresholdMicro ? microToInput(b.autoTopup.thresholdMicro) : "5");
  const [amount, setAmount] = useState(b.autoTopup.amountMicro ? microToInput(b.autoTopup.amountMicro) : "25");
  const [cap, setCap] = useState(b.monthlyCapMicro === null ? "" : microToInput(b.monthlyCapMicro));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const noCard = !b.card;
  const t = Number(threshold);
  const a = Number(amount);
  const c = cap.trim() === "" ? null : Number(cap);
  const amountOk = amount !== "" && isCents(a) && a >= min && a <= max;
  const capOk = c === null || (isCents(c) && c > 0 && (!amountOk || c >= a));
  const valid = threshold !== "" && t >= 0 && t <= 1000 && amountOk && capOk;
  const capMicro = c === null ? null : Math.round(c * MICRO);
  const dirty =
    enabled !== b.autoTopup.enabled ||
    Math.round(t * MICRO) !== b.autoTopup.thresholdMicro ||
    Math.round(a * MICRO) !== b.autoTopup.amountMicro ||
    capMicro !== b.monthlyCapMicro;
  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.ws(slug).autoTopup({ enabled, thresholdUsd: t, amountUsd: a, monthlyCapUsd: c });
      await qc.invalidateQueries({ queryKey: keys.billing(slug) });
      toast(enabled ? "Automatic top-up is on" : "Automatic top-up saved", "success");
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };
  const spent = b.topupsThisMonthMicro;
  const capReached = b.monthlyCapMicro !== null && spent + b.autoTopup.amountMicro > b.monthlyCapMicro;
  return (
    <Card title="Automatic top-up">
      <form className="stack" onSubmit={save}>
        <p className="small">{b.card ? `Saved card: ${b.card}` : "No saved card yet."}</p>
        <label className="check-row">
          <input
            type="checkbox"
            checked={enabled}
            disabled={noCard && !enabled}
            aria-describedby={noCard ? "auto-topup-hint" : undefined}
            onChange={(e) => setEnabled(e.target.checked)}
          />
          Top up automatically
        </label>
        {noCard && (
          <p className="field-hint" id="auto-topup-hint">
            Add credit once with "Save this card" ticked to turn this on.
          </p>
        )}
        <div className="sentence-form">
          <label htmlFor="auto-threshold">When the balance falls below</label>
          <div className="input-prefix narrow">
            <span className="prefix" aria-hidden="true">
              $
            </span>
            <input
              id="auto-threshold"
              className="input"
              type="number"
              inputMode="decimal"
              min={0}
              max={1000}
              step="0.01"
              value={threshold}
              onChange={(e) => setThreshold(e.target.value)}
            />
          </div>
          <label htmlFor="auto-amount">add</label>
          <div className="input-prefix narrow">
            <span className="prefix" aria-hidden="true">
              $
            </span>
            <input
              id="auto-amount"
              className="input"
              type="number"
              inputMode="decimal"
              min={min}
              max={max}
              step="0.01"
              value={amount}
              aria-invalid={amount !== "" && !amountOk}
              aria-describedby="auto-amount-hint"
              onChange={(e) => setAmount(e.target.value)}
            />
          </div>
        </div>
        <p className="field-hint" id="auto-amount-hint">
          Each automatic top-up is between {formatUsd(b.limits.minTopupMicro)} and {formatUsd(b.limits.maxTopupMicro)}.
        </p>
        <div className="field">
          <label className="field-label" htmlFor="auto-cap">
            Monthly spending cap (optional)
          </label>
          <div className="input-prefix narrow">
            <span className="prefix" aria-hidden="true">
              $
            </span>
            <input
              id="auto-cap"
              className="input"
              type="number"
              inputMode="decimal"
              min={0}
              step="0.01"
              placeholder="No cap"
              value={cap}
              aria-invalid={!capOk}
              aria-describedby="auto-cap-hint"
              onChange={(e) => setCap(e.target.value)}
            />
          </div>
          <p className="field-hint" id="auto-cap-hint">
            {!capOk
              ? "The cap must be at least one automatic top-up."
              : "Automatic top-ups stop once this month's top-ups would go over the cap. Leave empty for no cap."}
          </p>
        </div>
        <p className="small" data-testid="topups-this-month">
          Top-ups this month: <strong>{formatUsd(spent)}</strong>
          {b.monthlyCapMicro !== null ? ` of a ${formatUsd(b.monthlyCapMicro)} cap.` : ". No cap set."}
          {capReached && b.autoTopup.enabled ? " The next automatic top-up would go over the cap, so it won't run until next month." : ""}
        </p>
        {error && (
          <div className="notice notice-danger" role="alert">
            {error}
          </div>
        )}
        <div>
          <button type="submit" className="btn btn-primary" disabled={busy || !dirty || !valid}>
            Save
          </button>
        </div>
      </form>
    </Card>
  );
}

function Refund({ b }: { b: BillingOn }) {
  const { slug } = useWs();
  const qc = useQueryClient();
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const request = async () => {
    setBusy(true);
    setError(null);
    try {
      await api.ws(slug).refundRequest();
      await qc.invalidateQueries({ queryKey: keys.billing(slug) });
      toast("Refund requested", "success");
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Card title="Refund">
      <p className="small">Unused credit you paid for can be refunded to your card. The signup credit is not cash, so it isn't refunded.</p>
      <dl className="stat-list">
        <div>
          <dt>Refundable now</dt>
          <dd data-testid="billing-refundable">{formatUsd(b.refundableMicro)}</dd>
        </div>
      </dl>
      {b.refundRequestedAt ? (
        <div className="notice notice-accent" role="status" data-testid="refund-requested">
          Refund requested on {longDate(b.refundRequestedAt)}. We will refund the unused paid credit to your card and turn off automatic
          top-up.
        </div>
      ) : (
        <div>
          <button type="button" className="btn" disabled={busy} onClick={() => setConfirming(true)}>
            {busy && <Spinner label="Sending" />}
            Request a refund of unused credit
          </button>
        </div>
      )}
      {error && (
        <div className="notice notice-danger" role="alert" data-testid="refund-error">
          {error}
        </div>
      )}
      {confirming && (
        <ConfirmDialog
          title="Request a refund?"
          message={
            <>
              We will refund up to {formatUsd(b.refundableMicro)} of unused paid credit to your card and turn off automatic top-up. The
              workspace keeps running on any credit left until the refund is made.
            </>
          }
          confirmLabel="Request refund"
          onConfirm={request}
          onClose={() => setConfirming(false)}
        />
      )}
    </Card>
  );
}

function Ledger({ b }: { b: BillingOn }) {
  return (
    <Card title="Balance history">
      {b.ledger.length === 0 ? (
        <p className="muted small">Nothing yet.</p>
      ) : (
        <div className="table-wrap">
          <table className="data-table">
            <thead>
              <tr>
                <th scope="col">Date</th>
                <th scope="col">Description</th>
                <th scope="col" className="num">
                  Amount
                </th>
              </tr>
            </thead>
            <tbody>
              {b.ledger.map((l) => (
                <tr key={l.id}>
                  <td className="nowrap">{shortDate(l.day ?? l.createdAt)}</td>
                  <td>
                    {LEDGER_LABEL[l.kind] ?? l.kind}
                    {l.memo && l.memo !== LEDGER_LABEL[l.kind] && <div className="muted small">{l.memo}</div>}
                  </td>
                  <td className={`num nowrap ${l.amountMicro >= 0 ? "amount-plus" : "amount-minus"}`}>{signedUsd(l.amountMicro)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}

function Payments({ b }: { b: BillingOn }) {
  if (b.payments.length === 0) return null;
  return (
    <Card title="Recent payments">
      <div className="table-wrap">
        <table className="data-table">
          <thead>
            <tr>
              <th scope="col">Date</th>
              <th scope="col">Type</th>
              <th scope="col" className="num">
                Amount
              </th>
              <th scope="col" className="num">
                Card fee
              </th>
              <th scope="col">Status</th>
            </tr>
          </thead>
          <tbody>
            {b.payments.map((p) => (
              <tr key={p.id}>
                <td className="nowrap">{shortDate(p.createdAt)}</td>
                <td>{PAYMENT_LABEL[p.kind] ?? p.kind}</td>
                <td className="num nowrap">{formatUsd(p.amountMicro)}</td>
                <td className="num nowrap">
                  {p.feeMicro !== null ? formatUsd(p.feeMicro) : p.status === "succeeded" ? "Pending" : "None"}
                </td>
                <td>
                  <span className={`badge${p.status === "succeeded" ? " badge-accent" : ""}`}>{p.status}</span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="muted small">You get the full amount as credit. Card fees are paid from the fees and reserve part of each charge.</p>
    </Card>
  );
}
