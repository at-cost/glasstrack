import { useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate, useSearch } from "@tanstack/react-router";
import { MICRO } from "@glasstrack/shared";
import { CreditCard } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import { Card } from "../../components/Card";
import { Empty, Skeleton, Spinner } from "../../components/Feedback";
import { type BillingOn, api, errorMessage } from "../../lib/api";
import { formatBytes } from "../../lib/format";
import { formatUsd, microToInput, shortDate, signedUsd } from "../../lib/money";
import { paths } from "../../lib/paths";
import { keys, useBilling } from "../../lib/queries";
import { toast, toastError } from "../../lib/toast";
import { useWs } from "../shell/context";

const gb = (bytes: number) => `${(bytes / 1024 ** 3).toLocaleString("en-US", { maximumFractionDigits: 1 })} GB`;

const PRESETS = [10, 25, 50, 100];

const LEDGER_LABEL: Record<string, string> = {
  starter_grant: "Starter credit",
  topup: "Top-up",
  charge: "Daily charge",
  storage_charge: "Extra storage",
  refund: "Refund",
  adjustment: "Adjustment",
};
const PAYMENT_LABEL: Record<string, string> = { topup: "Top-up", auto_topup: "Automatic top-up" };

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
      {isAdmin ? (
        <>
          <TopUp b={b} />
          <AutoTopUp b={b} />
        </>
      ) : (
        <p className="muted small">Only workspace admins can add credit or change automatic top-up.</p>
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

function Balance({ b }: { b: BillingOn }) {
  const used = b.storage.bytes;
  const free = b.storage.freeBytes;
  const pct = free > 0 ? Math.min(100, (used / free) * 100) : 100;
  return (
    <Card title="Balance">
      <div className="balance-row">
        <div>
          <div className={`balance-big${b.balanceMicro <= 0 ? " negative" : ""}`} data-testid="billing-balance">
            {formatUsd(b.balanceMicro)}
          </div>
          <p className="muted">
            {b.daysRemaining === null
              ? "Nothing is being charged right now."
              : b.daysRemaining === 0
                ? "Less than a day of credit left."
                : `Lasts about ${b.daysRemaining} ${b.daysRemaining === 1 ? "day" : "days"} at ${formatUsd(b.dailyChargeMicro, { precise: true })} a day.`}
          </p>
        </div>
        <dl className="stat-list">
          <div>
            <dt>Monthly price</dt>
            <dd>{formatUsd(b.monthlyPriceMicro)}</dd>
          </div>
          <div>
            <dt>Charged per day</dt>
            <dd>{formatUsd(b.dailyChargeMicro, { precise: true })}</dd>
          </div>
        </dl>
      </div>
      <p className="small">
        One flat price per workspace, with unlimited members. It is taken from your balance a little each day.{" "}
        <Link to={paths.finances()}>See what it pays for</Link>.
      </p>
      <div className="subsection">
        <h3 className="subsection-title">Storage</h3>
        <div className="meter-row">
          <span
            className="progress"
            role="progressbar"
            aria-label="Storage used of the free allowance"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.round(pct)}
          >
            <span className="progress-fill" style={{ width: `${pct}%` }} />
          </span>
          <span className="small">
            {formatBytes(used)} used of {gb(free)} free
          </span>
        </div>
        {b.storage.overageDailyMicro > 0 ? (
          <p className="muted small">
            Storage above the free allowance costs {formatUsd(b.storage.ratePerGbMonthMicro)} per GB a month. Right now that adds{" "}
            {formatUsd(b.storage.overageDailyMicro, { precise: true })} a day.
          </p>
        ) : (
          <p className="muted small">
            Files above the free allowance cost {formatUsd(b.storage.ratePerGbMonthMicro)} per GB a month, charged daily.
          </p>
        )}
      </div>
    </Card>
  );
}

function TopUp({ b }: { b: BillingOn }) {
  const { slug } = useWs();
  const min = b.limits.minTopupMicro / MICRO;
  const max = b.limits.maxTopupMicro / MICRO;
  const [choice, setChoice] = useState<number | "custom">(PRESETS.find((p) => p >= min && p <= max) ?? "custom");
  const [custom, setCustom] = useState("");
  const [saveCard, setSaveCard] = useState(!b.card);
  const [busy, setBusy] = useState(false);
  const customId = useId();
  const amount = choice === "custom" ? Number(custom) : choice;
  const valid = Number.isFinite(amount) && amount >= min && amount <= max && Math.round(amount * 100) === amount * 100;
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!valid) return;
    setBusy(true);
    try {
      const { url } = await api.ws(slug).topup(amount, saveCard);
      window.location.assign(url);
    } catch (err) {
      toastError(errorMessage(err));
      setBusy(false);
    }
  };
  return (
    <Card title="Add credit">
      <form className="stack" onSubmit={submit}>
        <fieldset className="fieldset">
          <legend className="field-label">Amount</legend>
          <div className="preset-row">
            {PRESETS.filter((p) => p >= min && p <= max).map((p) => (
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
              Between {formatUsd(b.limits.minTopupMicro)} and {formatUsd(b.limits.maxTopupMicro)}.
            </p>
          </div>
        )}
        <label className="check-row">
          <input type="checkbox" checked={saveCard} onChange={(e) => setSaveCard(e.target.checked)} />
          Save this card for automatic top-ups
        </label>
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
  const [busy, setBusy] = useState(false);
  const noCard = !b.card;
  const t = Number(threshold);
  const a = Number(amount);
  const valid = threshold !== "" && t >= 0 && t <= 1000 && a >= min && a <= max;
  const dirty =
    enabled !== b.autoTopup.enabled ||
    Math.round(t * MICRO) !== b.autoTopup.thresholdMicro ||
    Math.round(a * MICRO) !== b.autoTopup.amountMicro;
  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      await api.ws(slug).autoTopup({ enabled, thresholdUsd: t, amountUsd: a });
      await qc.invalidateQueries({ queryKey: keys.billing(slug) });
      toast(enabled ? "Automatic top-up is on" : "Automatic top-up saved", "success");
    } catch (err) {
      toastError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };
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
              aria-invalid={enabled && !valid}
              onChange={(e) => setAmount(e.target.value)}
            />
          </div>
        </div>
        <div>
          <button type="submit" className="btn btn-primary" disabled={busy || !dirty || (enabled && !valid)}>
            Save
          </button>
        </div>
      </form>
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
                  <td>{l.memo || LEDGER_LABEL[l.kind] || l.kind}</td>
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
                <td className="num nowrap">{p.feeMicro !== null ? formatUsd(p.feeMicro) : p.status === "succeeded" ? "Pending" : "None"}</td>
                <td>
                  <span className={`badge${p.status === "succeeded" ? " badge-accent" : ""}`}>{p.status}</span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="muted small">You get the full amount as credit. Card fees are counted as a cost on the public finances page.</p>
    </Card>
  );
}
