import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { RESERVE_TARGET_MONTHS } from "@glasstrack/shared";
import { Download } from "lucide-react";
import { useEffect } from "react";
import { Empty, FullPageLoading } from "../../components/Feedback";
import { LineChart } from "../../components/LineChart";
import { ApiError, api, errorMessage, type FinanceDay, type PublicFinances } from "../../lib/api";
import { formatUsd, percent, shortDate, usdAxis } from "../../lib/money";
import { keys } from "../../lib/queries";

export function FinancesPage() {
  const q = useQuery({ queryKey: keys.publicFinances, queryFn: () => api.publicFinances(365), retry: false, staleTime: 5 * 60_000 });
  useEffect(() => {
    document.title = "Finances · Glasstrack";
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
        <Link to="/" className="btn btn-sm">
          Open Glasstrack
        </Link>
      </header>
      <main id="main" className="public-main">
        {q.isPending ? (
          <FullPageLoading />
        ) : q.error ? (
          q.error instanceof ApiError && q.error.status === 404 ? (
            <Empty title="This server doesn't publish finances">Self-hosted servers have no billing, so there is nothing to show.</Empty>
          ) : (
            <Empty title="Could not load the finances">{errorMessage(q.error)}</Empty>
          )
        ) : (
          <Finances f={q.data} />
        )}
      </main>
    </div>
  );
}

function sum(rows: FinanceDay[], pick: (r: FinanceDay) => number): number {
  return rows.reduce((a, r) => a + pick(r), 0);
}

export function costLines(rows: FinanceDay[]): { label: string; micro: number }[] {
  const by = new Map<string, number>();
  for (const r of rows) for (const [k, v] of Object.entries(r.costs)) by.set(k, (by.get(k) ?? 0) + v);
  return [...by.entries()].map(([label, micro]) => ({ label, micro })).sort((a, b) => b.micro - a.micro);
}

function Finances({ f }: { f: PublicFinances }) {
  const last30 = f.history.slice(-30);
  const latest = f.latest;
  const revenue = sum(last30, (r) => r.revenueMicro);
  const cost = sum(last30, (r) => r.totalCostMicro);
  const fees = sum(last30, (r) => r.paymentFeesMicro);
  const starter = sum(last30, (r) => r.starterCreditUsedMicro);
  const lines = costLines(last30);
  const maxLine = Math.max(1, fees, ...lines.map((l) => l.micro));
  const monthCost = latest && latest.reserveTargetMicro > 0 ? latest.reserveTargetMicro / RESERVE_TARGET_MONTHS : 0;
  const months = latest && monthCost > 0 ? latest.reserveMicro / monthCost : 0;
  const reservePct = latest && latest.reserveTargetMicro > 0 ? Math.min(100, Math.max(0, (latest.reserveMicro / latest.reserveTargetMicro) * 100)) : 0;
  const days = f.history.map((r) => r.day);
  const perWsDays = last30.filter((r) => r.costPerWorkspaceMicro > 0);
  const perWsMonth = perWsDays.length ? Math.round((sum(perWsDays, (r) => r.costPerWorkspaceMicro) / perWsDays.length) * 30) : 0;

  return (
    <div className="fin">
      <section className="fin-hero" aria-labelledby="fin-title">
        <div>
          <h1 id="fin-title" className="fin-title">
            Where the money goes
          </h1>
          <p className="fin-lead">
            Glasstrack is open source. The hosted service publishes every dollar in and out, updated daily. The price is the cost of
            running it per paying workspace plus 10%, until the reserve covers {RESERVE_TARGET_MONTHS} months of costs. Then it drops to
            cost plus 2%. The price never goes up.
          </p>
        </div>
        <div className="price-tile">
          <span className="price-big" data-testid="current-price">
            {formatUsd(f.currentPriceMicro)}
          </span>
          <span className="muted">per workspace per month, any number of members</span>
        </div>
      </section>

      {f.history.length === 0 ? (
        <Empty title="No daily figures yet">The first day shows up here after the first full day of billing.</Empty>
      ) : (
        <>
          <section aria-labelledby="fin-30">
            <h2 id="fin-30" className="fin-h2">
              Last {last30.length} {last30.length === 1 ? "day" : "days"}
            </h2>
            <dl className="tiles">
              <div className="tile">
                <dt>Revenue</dt>
                <dd>{formatUsd(revenue)}</dd>
              </div>
              <div className="tile">
                <dt>Total costs</dt>
                <dd>{formatUsd(cost)}</dd>
              </div>
              <div className="tile">
                <dt>Cost per workspace</dt>
                <dd>{perWsDays.length ? formatUsd(perWsMonth) : "None"}</dd>
                <span className="tile-note">a month, averaged over these days</span>
              </div>
              <div className="tile">
                <dt>Margin now</dt>
                <dd>{latest ? percent(latest.marginBp) : "None"}</dd>
                <span className="tile-note">
                  {latest ? `${latest.payingWorkspaces} paying of ${latest.activeWorkspaces} active workspaces` : ""}
                </span>
              </div>
            </dl>
            {starter > 0 && (
              <p className="muted small">
                Starter credit spent in this time: {formatUsd(starter)}. Free credit is not counted as revenue.
              </p>
            )}
          </section>

          <section aria-labelledby="fin-costs" className="fin-card">
            <h2 id="fin-costs" className="fin-h2">
              Costs, last {last30.length} {last30.length === 1 ? "day" : "days"}
            </h2>
            <table className="data-table cost-table">
              <thead>
                <tr>
                  <th scope="col">What</th>
                  <th scope="col" className="hide-mobile">
                    <span className="sr-only">Share</span>
                  </th>
                  <th scope="col" className="num">
                    Amount
                  </th>
                </tr>
              </thead>
              <tbody>
                {[...lines, { label: "Card payment fees", micro: fees }].map((l) => (
                  <tr key={l.label}>
                    <td>{l.label}</td>
                    <td className="bar-cell hide-mobile" aria-hidden="true">
                      <span className="hbar" style={{ width: `${(l.micro / maxLine) * 100}%` }} />
                    </td>
                    <td className="num nowrap">{formatUsd(l.micro)}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr>
                  <th scope="row">Total</th>
                  <td className="hide-mobile" />
                  <td className="num nowrap">{formatUsd(cost)}</td>
                </tr>
              </tfoot>
            </table>
          </section>

          {latest && (
            <section aria-labelledby="fin-reserve" className="fin-card">
              <h2 id="fin-reserve" className="fin-h2">
                Reserve
              </h2>
              {latest.reserveMicro < 0 ? (
                <p>
                  Costs so far are <strong>{formatUsd(-latest.reserveMicro)} more</strong> than revenue, so there is no reserve yet. The target
                  is {formatUsd(latest.reserveTargetMicro)}, which is {RESERVE_TARGET_MONTHS} months of costs.
                </p>
              ) : (
                <p>
                  {formatUsd(latest.reserveMicro)} saved of a {formatUsd(latest.reserveTargetMicro)} target. That is{" "}
                  <strong>
                    {months.toLocaleString("en-US", { maximumFractionDigits: 1 })} of {RESERVE_TARGET_MONTHS} months
                  </strong>{" "}
                  of costs.
                </p>
              )}
              <span
                className="progress progress-lg"
                role="progressbar"
                aria-label="Reserve saved of target"
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={Math.round(reservePct)}
              >
                <span className="progress-fill" style={{ width: `${reservePct}%` }} />
              </span>
              <p className="muted small">
                The reserve keeps the service running if revenue drops. Once it is full, the margin falls from 10% to 2%.
              </p>
            </section>
          )}

          <section aria-labelledby="fin-charts" className="fin-card">
            <h2 id="fin-charts" className="fin-h2">
              History
            </h2>
            <LineChart
              title="Revenue and costs per day"
              days={days}
              series={[
                { key: "rev", label: "Revenue", color: "var(--series-1)", values: f.history.map((r) => r.revenueMicro) },
                { key: "cost", label: "Costs", color: "var(--series-2)", values: f.history.map((r) => r.totalCostMicro) },
              ]}
              format={(v) => formatUsd(v, { precise: true })}
              axisFormat={usdAxis}
            />
            <LineChart
              title="Reserve over time"
              days={days}
              series={[
                { key: "res", label: "Reserve", color: "var(--series-1)", values: f.history.map((r) => r.reserveMicro) },
                { key: "target", label: "Target", color: "var(--chart-ref)", dashed: true, values: f.history.map((r) => r.reserveTargetMicro) },
              ]}
              format={(v) => formatUsd(v)}
              axisFormat={usdAxis}
            />
          </section>
        </>
      )}

      <section aria-labelledby="fin-how" className="fin-card">
        <h2 id="fin-how" className="fin-h2">
          How the numbers work
        </h2>
        <h3 className="fin-h3">Price</h3>
        <p>
          Take one month of costs and divide by the number of paying workspaces. Add 10% while the reserve is below {RESERVE_TARGET_MONTHS}{" "}
          months of costs, or 2% once it is full. Round up to the next cent. If that comes out lower than today's price, the price is
          lowered. It is never raised.
        </p>
        <p className="formula mono">{f.formula.price}</p>
        <h3 className="fin-h3">Cost per workspace</h3>
        <p>
          Shared costs are split by how many people are active in each workspace. Storage, email and card fees are charged to the
          workspace that used them.
        </p>
        <p className="formula mono">{f.formula.allocation}</p>
      </section>

      <section aria-labelledby="fin-prices" className="fin-card">
        <h2 id="fin-prices" className="fin-h2">
          Price history
        </h2>
        {f.priceHistory.length === 0 ? (
          <p className="muted">No price set yet.</p>
        ) : (
          <ol className="price-history">
            {[...f.priceHistory].reverse().map((p) => (
              <li key={p.from}>
                <span className="ph-price">{formatUsd(p.monthlyPriceMicro)}</span>
                <span className="muted small nowrap">from {shortDate(p.from)}</span>
                <span className="ph-reason">{p.reason}</span>
              </li>
            ))}
          </ol>
        )}
        <p className="muted small">The price has only ever gone down.</p>
      </section>

      <p className="fin-foot">
        <a className="btn" href="/api/v1/public/finances.csv" download>
          <Download size={14} aria-hidden="true" />
          Download CSV
        </a>
        <span className="muted small">Every day since the start, one row per day.</span>
      </p>
    </div>
  );
}
