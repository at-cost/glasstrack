/** @jsxImportSource hono/jsx */
import type { PublicFinances } from "../../finances/public";
import { BarChart, LineChart, monthLabel } from "../charts";
import { int, usd, usdWhole } from "../fmt";
import { ExampleBadge, ExampleNote, Layout, type PageMeta, type SiteCtx } from "../layout";
import { Fig, Meter, periodLabel, updatedLabel } from "../ui";

export const financesMeta: PageMeta = {
  path: "/finances",
  title: "Open books: Glasstrack's finances",
  description:
    "Every cost of running hosted Glasstrack, what workspaces paid, how much the founder covered, and the reserve. Updated hourly, with a CSV download.",
  og: "finances",
};

export function FinancesPage(p: { finances: PublicFinances; site: SiteCtx }) {
  const f = p.finances;
  const m = f.thisMonth;
  const costLines = m.costs.reduce((a, c) => a + c.amountMicro, 0);
  const months = f.history.map((h) => h.month);
  const axis = (v: number) => usdWhole(v);
  return (
    <Layout meta={financesMeta} site={p.site}>
      <div class="wrap">
        <header class="page-head">
          <p class="eyebrow">Open books</p>
          <h1>Glasstrack's finances</h1>
          <p class="lede">
            What it costs to run hosted Glasstrack, what workspaces paid, and who covered the difference. Nothing here identifies a workspace.
          </p>
          <p class="small muted">
            Last updated {updatedLabel(f.updatedAt)}. Figures refresh hourly. <a href="/finances.csv">Download CSV</a>
          </p>
          <ExampleNote example={f.example} />
        </header>

        <section class="section" aria-labelledby="month-h">
          <h2 id="month-h">
            This month: {periodLabel(f)} <ExampleBadge example={f.example} />
          </h2>
          <dl class="figure-row">
            <Fig label="Revenue (credit used)" value={usd(m.revenueMicro)} />
            <Fig label="Total cost" value={usd(m.totalCostMicro)} />
            <Fig label="Covered by the founder" value={usd(m.founderGapMicro)} />
            <Fig label="Cost per workspace" value={usd(m.costPerWorkspaceMicro)} />
            <Fig label="Active workspaces" value={int(m.activeWorkspaces)} />
            <Fig label="Paying workspaces" value={int(m.payingWorkspaces)} />
          </dl>
          {m.founderGapMicro > 0 && (
            <p style="margin-top:16px">
              <strong>Covered by the founder this month: {usd(m.founderGapMicro)}</strong>
            </p>
          )}

          <div class="grid-2" style="margin-top:32px">
            <div>
              <table class="ledger">
                <caption>Costs</caption>
                <tbody>
                  {m.costs.map((c) => (
                    <tr>
                      <th scope="row">
                        {c.label}
                        {c.paidByCredits && <span class="tag">paid by AWS credits</span>}
                      </th>
                      <td class="r">{usd(c.amountMicro)}</td>
                    </tr>
                  ))}
                  <tr>
                    <th scope="row">
                      Payment fees<span class="note">Stripe's fees on top-ups</span>
                    </th>
                    <td class="r">{usd(m.paymentFeesMicro)}</td>
                  </tr>
                </tbody>
                <tfoot>
                  <tr>
                    <th scope="row">Total cost</th>
                    <td class="r">{usd(costLines + m.paymentFeesMicro)}</td>
                  </tr>
                </tfoot>
              </table>
              <p class="small muted" style="margin-top:10px">
                Lines marked "paid by AWS credits" are shown at list price. The AI and tooling line is what it costs to have AI do much of the
                work (see <a href="/how-its-run">how it's run</a>).
              </p>
            </div>
            <div>
              <table class="ledger">
                <caption>Money in and held</caption>
                <tbody>
                  <tr>
                    <th scope="row">
                      Revenue<span class="note">Credit workspaces actually used. Free signup credit is not counted.</span>
                    </th>
                    <td class="r">{usd(m.revenueMicro)}</td>
                  </tr>
                  <tr>
                    <th scope="row">
                      Credit held<span class="note">Unused prepaid balances. Not income, and never counts toward the reserve.</span>
                    </th>
                    <td class="r">{usd(m.creditHeldMicro)}</td>
                  </tr>
                  <tr>
                    <th scope="row">Current server share cap</th>
                    <td class="r">{usd(f.serverShareCapMicro)}</td>
                  </tr>
                  {f.recommendedCapMicro !== null && (
                    <tr>
                      <th scope="row">
                        Recommended cap<span class="note">The reserve target is met, so the operator may lower the cap to this.</span>
                      </th>
                      <td class="r">{usd(f.recommendedCapMicro)}</td>
                    </tr>
                  )}
                </tbody>
              </table>
              <div style="margin-top:22px">
                <p class="small">
                  Reserve: <span class="num">{usd(f.reserve.balanceMicro)}</span> of <span class="num">{usd(f.reserve.targetMicro)}</span>{" "}
                  ({f.reserve.targetMonths} months of costs)
                </p>
                <Meter value={f.reserve.balanceMicro} max={f.reserve.targetMicro} label="Reserve towards its target" />
              </div>
            </div>
          </div>
        </section>

        <section class="section" aria-labelledby="hist-h">
          <h2 id="hist-h">
            Month by month <ExampleBadge example={f.example} />
          </h2>
          <div class="grid-2">
            <div>
              <h3>Revenue and costs</h3>
              <LineChart
                id="c-rev"
                title="Revenue and total costs by month"
                months={months}
                fmt={axis}
                series={[
                  { name: "Revenue", cls: "a", values: f.history.map((h) => h.revenueMicro) },
                  { name: "Costs", cls: "b", dashed: true, values: f.history.map((h) => h.totalCostMicro) },
                ]}
              />
            </div>
            <div>
              <h3>Covered by the founder</h3>
              <BarChart id="c-gap" title="Amount covered by the founder by month" months={months} name="Covered by the founder" cls="b" values={f.history.map((h) => h.founderGapMicro)} fmt={axis} />
            </div>
            <div>
              <h3>Reserve</h3>
              <LineChart id="c-res" title="Reserve balance at the end of each month" months={months} fmt={axis} series={[{ name: "Reserve", cls: "a", values: f.history.map((h) => h.reserveMicro) }]} />
            </div>
          </div>
          <div class="table-scroll">
            <table class="ledger">
              <caption>Monthly figures</caption>
              <thead>
                <tr>
                  <th scope="col">Month</th>
                  <th scope="col" class="r">Revenue</th>
                  <th scope="col" class="r">Costs</th>
                  <th scope="col" class="r">Founder</th>
                  <th scope="col" class="r">Reserve</th>
                  <th scope="col" class="r">Active</th>
                  <th scope="col" class="r">Paying</th>
                  <th scope="col" class="r">Cap</th>
                </tr>
              </thead>
              <tbody>
                {[...f.history].reverse().map((h) => (
                  <tr>
                    <th scope="row">{monthLabel(h.month)}</th>
                    <td class="r">{usd(h.revenueMicro)}</td>
                    <td class="r">{usd(h.totalCostMicro)}</td>
                    <td class="r">{usd(h.founderGapMicro)}</td>
                    <td class="r">{usd(h.reserveMicro)}</td>
                    <td class="r">{int(h.activeWorkspaces)}</td>
                    <td class="r">{int(h.payingWorkspaces)}</td>
                    <td class="r">{usd(h.serverShareCapMicro)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>

        <section class="section grid-2" aria-label="Cap history and savings">
          <div>
            <h2>Server share cap history</h2>
            <p class="muted">The cap only ever goes down.</p>
            <table class="ledger">
              <thead>
                <tr>
                  <th scope="col">From</th>
                  <th scope="col">Reason</th>
                  <th scope="col" class="r">Cap</th>
                </tr>
              </thead>
              <tbody>
                {f.capHistory.map((c) => (
                  <tr>
                    <td class="num">{c.from.slice(0, 10)}</td>
                    <td>{c.reason}</td>
                    <td class="r">{usd(c.capMicro)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div>
            <h2>Cost savings</h2>
            <p class="muted">Changes that made Glasstrack cheaper to run. Every saving is passed on.</p>
            {f.savings.length === 0 ? (
              <p>No savings recorded yet.</p>
            ) : (
              <table class="ledger">
                <thead>
                  <tr>
                    <th scope="col">Date</th>
                    <th scope="col">Change</th>
                    <th scope="col" class="r">Saving a month</th>
                  </tr>
                </thead>
                <tbody>
                  {f.savings.map((s) => (
                    <tr>
                      <td class="num">{s.date.slice(0, 10)}</td>
                      <td>{s.change}</td>
                      <td class="r">{usd(s.savingMonthMicro)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </section>
      </div>
    </Layout>
  );
}
