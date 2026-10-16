import type { PricingSettings } from "@glasstrack/shared";
import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Card } from "../../components/Card";
import { Spinner } from "../../components/Feedback";
import { type AdminOverview, api, errorMessage } from "../../lib/api";
import { formatUsd, MICRO, shortDate } from "../../lib/money";
import { keys } from "../../lib/queries";
import { toast } from "../../lib/toast";

type Key = keyof PricingSettings;
type Unit = "usd" | "percent" | "months";

/** Every operator-editable setting. Percent fields are fractions on the server (0.2 = 20%). */
const FIELDS: { key: Key; label: string; unit: Unit; hint: string }[] = [
  {
    key: "serverShareCapUsd",
    label: "Server share cap",
    unit: "usd",
    hint: "Most a workspace pays for shared servers a month. Can only go down.",
  },
  { key: "feeMarkup", label: "Fees and reserve", unit: "percent", hint: "Added on top of cost for card fees and the reserve." },
  { key: "storageUsdPerGbMonth", label: "Storage, per GB a month", unit: "usd", hint: "At cost." },
  { key: "emailUsdPer1000", label: "Email, per 1,000", unit: "usd", hint: "At cost." },
  { key: "signupCreditUsd", label: "Signup credit", unit: "usd", hint: "Given to each new workspace. Not refundable as cash." },
  { key: "minTopupUsd", label: "Smallest top-up", unit: "usd", hint: "At least $1." },
  { key: "maxTopupUsd", label: "Largest top-up", unit: "usd", hint: "" },
  { key: "stripeFeePercent", label: "Stripe fee, percent", unit: "percent", hint: "Used to estimate card fees." },
  { key: "stripeFeeFixedUsd", label: "Stripe fee, fixed part", unit: "usd", hint: "Per top-up." },
  {
    key: "reserveTargetMonths",
    label: "Reserve target",
    unit: "months",
    hint: "Months of running costs to hold before a lower cap is recommended.",
  },
];

const toInput = (unit: Unit, v: number) => String(unit === "percent" ? Math.round(v * 100 * 1e6) / 1e6 : v);
const fromInput = (unit: Unit, s: string) => (unit === "percent" ? Math.round((Number(s) / 100) * 1e8) / 1e8 : Number(s));
const show = (unit: Unit, v: number) =>
  unit === "usd"
    ? formatUsd(Math.round(v * MICRO), { precise: true })
    : unit === "percent"
      ? `${(v * 100).toLocaleString("en-US", { maximumFractionDigits: 4 })}%`
      : `${v} ${v === 1 ? "month" : "months"}`;

function initial(s: PricingSettings): Record<Key, string> {
  return Object.fromEntries(FIELDS.map((f) => [f.key, toInput(f.unit, s[f.key])])) as Record<Key, string>;
}

export function PricingSettingsCard({ o }: { o: AdminOverview }) {
  const qc = useQueryClient();
  const s = o.settings;
  const [values, setValues] = useState<Record<Key, string>>(() => initial(s));
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const rec = o.finances.recommendedCapMicro;

  const changes: Partial<PricingSettings> = {};
  let bad = false;
  for (const f of FIELDS) {
    const raw = values[f.key].trim();
    if (raw === "" || !Number.isFinite(Number(raw)) || Number(raw) < 0) {
      bad = true;
      continue;
    }
    const v = fromInput(f.unit, raw);
    if (v !== s[f.key]) changes[f.key] = v;
  }
  const changed = Object.keys(changes) as Key[];
  const capUp = changes.serverShareCapUsd !== undefined && changes.serverShareCapUsd > s.serverShareCapUsd;
  const canSave = !bad && changed.length > 0 && reason.trim().length >= 3 && !busy;

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!canSave) return;
    setBusy(true);
    setError(null);
    try {
      const next = await api.admin.updatePricing({ ...changes, reason: reason.trim() });
      await qc.invalidateQueries({ queryKey: keys.adminOverview });
      qc.invalidateQueries({ queryKey: keys.publicFinances });
      setValues(initial(next));
      setReason("");
      toast("Pricing settings saved", "success");
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card title="Pricing settings">
      <p className="muted small">
        {s.effectiveFrom ? `Current settings since ${shortDate(s.effectiveFrom)}.` : "No settings saved yet. These are the defaults."}{" "}
        Saving creates a new version that applies from the next daily charge. The server share cap can only go down: the server and the
        database both refuse a higher one.
      </p>
      {rec !== null && (
        <div className="notice notice-accent" data-testid="recommended-cap">
          <span>
            <strong>Recommended cap: {formatUsd(rec, { precise: true })}</strong> (now {show("usd", s.serverShareCapUsd)}). The reserve has
            reached its target, so a lower cap still covers the servers. Recommended, never applied automatically.
          </span>
          <div>
            <button
              type="button"
              className="btn btn-sm btn-primary"
              onClick={() => {
                setValues((v) => ({ ...v, serverShareCapUsd: String(rec / MICRO) }));
                if (!reason.trim())
                  setReason(
                    `Reserve target reached. Lowering the server share cap to the recommended ${formatUsd(rec, { precise: true })}.`,
                  );
              }}
            >
              Use this cap
            </button>
          </div>
        </div>
      )}
      <form className="stack" onSubmit={save}>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))", gap: 12 }}>
          {FIELDS.map((f) => {
            const id = `ps-${f.key}`;
            const raw = values[f.key];
            const invalid =
              raw.trim() === "" || !Number.isFinite(Number(raw)) || Number(raw) < 0 || (f.key === "serverShareCapUsd" && capUp);
            return (
              <div className="field" key={f.key}>
                <label className="field-label" htmlFor={id}>
                  {f.label}
                </label>
                <div className="input-prefix">
                  <span className="prefix" aria-hidden="true">
                    {f.unit === "usd" ? "$" : f.unit === "percent" ? "%" : "mo"}
                  </span>
                  <input
                    id={id}
                    className="input"
                    type="number"
                    inputMode="decimal"
                    min={0}
                    step="any"
                    value={raw}
                    aria-invalid={invalid}
                    aria-describedby={`${id}-hint`}
                    onChange={(e) => setValues((v) => ({ ...v, [f.key]: e.target.value }))}
                  />
                </div>
                <p className="field-hint" id={`${id}-hint`}>
                  {f.key === "serverShareCapUsd" && capUp
                    ? `Higher than now (${show("usd", s.serverShareCapUsd)}). This will be refused. `
                    : ""}
                  {f.hint} Now {show(f.unit, s[f.key])}
                  {o.defaults[f.key] !== s[f.key] ? `, default ${show(f.unit, o.defaults[f.key])}` : ""}.
                </p>
              </div>
            );
          })}
        </div>
        <div className="field">
          <label className="field-label" htmlFor="ps-reason">
            Reason (required, shown publicly for cap changes)
          </label>
          <textarea
            id="ps-reason"
            className="textarea"
            rows={2}
            maxLength={300}
            value={reason}
            aria-describedby="ps-reason-hint"
            onChange={(e) => setReason(e.target.value)}
          />
          <p className="field-hint" id="ps-reason-hint">
            {changed.length === 0
              ? "Change at least one value."
              : `Changing: ${changed.map((k) => FIELDS.find((f) => f.key === k)?.label ?? k).join(", ")}.`}
          </p>
        </div>
        {error && (
          <div className="notice notice-danger" role="alert" data-testid="pricing-error">
            {error}
          </div>
        )}
        <div className="row">
          <button type="submit" className="btn btn-primary" disabled={!canSave}>
            {busy && <Spinner label="Saving" />}
            Save new settings
          </button>
          <button type="button" className="btn btn-ghost" disabled={busy} onClick={() => setValues(initial(s))}>
            Reset
          </button>
        </div>
      </form>
      <div className="subsection">
        <h3 className="subsection-title">Settings history</h3>
        {o.settingsHistory.length === 0 ? (
          <p className="muted small">No changes yet.</p>
        ) : (
          <ol className="price-history">
            {o.settingsHistory.map((h) => (
              <li key={h.id}>
                <span className="ph-price">{formatUsd(Math.round(h.serverShareCapUsd * MICRO), { precise: true })} cap</span>
                <span className="muted small nowrap">from {shortDate(h.effectiveFrom)}</span>
                <span className="ph-reason">
                  {h.reason}
                  {h.createdBy && <span className="muted small"> by {h.createdBy}</span>}
                </span>
              </li>
            ))}
          </ol>
        )}
      </div>
    </Card>
  );
}
