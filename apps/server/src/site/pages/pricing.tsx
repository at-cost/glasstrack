/** @jsxImportSource hono/jsx */
import { AVG_DAYS_PER_MONTH, creditLastsDays, dailyCharge, estimateEmails, serverShareMicro } from "@glasstrack/shared/pricing";
import type { PublicFinances, PublicPricing } from "../../finances/public";
import { COMPETITORS, competitorMonthly } from "../competitors";
import { estimate, TYPICAL } from "../estimate";
import { centsSplit, int, usd } from "../fmt";
import { ExampleBadge, ExampleNote, GITHUB_URL, Layout, type PageMeta, type SiteCtx } from "../layout";
import { DataScript, Meter, periodLabel } from "../ui";
import { calcData } from "./home";

export const pricingMeta: PageMeta = {
  path: "/pricing",
  title: "Pricing: pay what it costs to run | Glasstrack",
  description:
    "Work out what your team would pay for hosted Glasstrack, line by line: a capped share of the servers, your own storage and email, plus 20% for payment fees and a reserve.",
  og: "pricing",
};

export const PRICING_SOURCE = `${GITHUB_URL}/blob/main/packages/shared/src/money/pricing.ts`;
const WHAT_IF_DEFAULT = 100;

export function PricingPage(p: { pricing: PublicPricing; finances: PublicFinances; site: SiteCtx }) {
  const { pricing, finances: f } = p;
  const s = pricing.settings;
  const people = TYPICAL.people;
  const emails = estimateEmails(people);
  const b = estimate(pricing, people, TYPICAL.storageGb, emails);
  const [server, storage, email, fees] = centsSplit([b.serverShareMicro, b.storageMicro, b.emailMicro, b.feesAndReserveMicro], b.totalMicro);
  const day = dailyCharge(b, AVG_DAYS_PER_MONTH);
  const lasts = creditLastsDays(s.signupCreditUsd * 1_000_000, b.totalMicro);
  const share = serverShareMicro(s, pricing.sharedFixedMonthMicro, pricing.activeWorkspaces);
  const whatIf = serverShareMicro(s, pricing.sharedFixedMonthMicro, WHAT_IF_DEFAULT);
  const costTotal = f.thisMonth.costs.reduce((a, c) => a + c.amountMicro, 0);
  const pct = Math.round(s.feeMarkup * 100);
  const shownTotal = server! + storage! + email! + fees!;
  return (
    <Layout meta={pricingMeta} site={p.site} scripts={["js/calc.js"]}>
      <div class="wrap">
        <header class="page-head">
          <p class="eyebrow">Pricing</p>
          <h1>Pay what it costs to run. Nothing more.</h1>
          <p class="lede">
            Hosted Glasstrack is prepaid and charged daily, at cost. Every new workspace gets ${s.signupCreditUsd} of credit. Self-hosting is
            free.
          </p>
        </header>

        <section class="section" aria-labelledby="calc-h" id="estimate">
          <div class="section-head">
            <h2 id="calc-h">What would my team pay?</h2>
            <p>Move the sliders. The breakdown always adds up to the total.</p>
          </div>
          <div class="grid-2" data-calc>
            <fieldset class="card">
              <legend class="sr-only">Your team</legend>
              <div class="field">
                <label for="c-team">
                  <span>Team members</span>
                  <output for="c-team" data-out="team">
                    {people}
                  </output>
                </label>
                <input type="range" id="c-team" min="1" max="500" value={String(people)} data-in="team" />
              </div>
              <div class="field">
                <label for="c-storage">
                  <span>File storage</span>
                  <output for="c-storage" data-out="storage">
                    {TYPICAL.storageGb} GB
                  </output>
                </label>
                <input type="range" id="c-storage" min="0" max="200" value={String(TYPICAL.storageGb)} data-in="storage" />
              </div>
              <div class="field">
                <label for="c-emails">Emails per month</label>
                <div class="inline-row">
                  <input type="number" id="c-emails" min="0" max="1000000" step="100" value={String(emails)} data-in="emails" aria-describedby="c-emails-hint" />
                  <button type="button" class="linkish" data-reset-emails hidden>
                    Match team size
                  </button>
                </div>
                <span class="hint" id="c-emails-hint">
                  Worked out from team size ({int(100)} per person for notifications and digests). Type a number to set your own.
                </span>
              </div>
              <p class="hint">
                Inputs used: this month's shared costs <span class="num">{usd(pricing.sharedFixedMonthMicro)}</span>, active workspaces{" "}
                <span class="num">{int(pricing.activeWorkspaces)}</span>. <ExampleBadge example={pricing.example} />
              </p>
            </fieldset>
            <div class="card price-card" aria-live="polite">
              <p class="eyebrow">Estimated monthly cost</p>
              <p class="big" data-out="total">
                {usd(shownTotal)}
              </p>
              <table class="ledger">
                <caption class="sr-only">Monthly cost breakdown</caption>
                <tbody>
                  <tr>
                    <th scope="row">
                      Server share<span class="note">Capped at {usd(s.serverShareCapUsd * 1_000_000)} a month</span>
                    </th>
                    <td class="r" data-out="server">
                      {usd(server!)}
                    </td>
                  </tr>
                  <tr>
                    <th scope="row">
                      File storage<span class="note">${s.storageUsdPerGbMonth} per GB a month</span>
                    </th>
                    <td class="r" data-out="storageCost">
                      {usd(storage!)}
                    </td>
                  </tr>
                  <tr>
                    <th scope="row">
                      Email<span class="note">${s.emailUsdPer1000.toFixed(2)} per 1,000</span>
                    </th>
                    <td class="r" data-out="email">
                      {usd(email!)}
                    </td>
                  </tr>
                  <tr>
                    <th scope="row">
                      Payment fees and reserve<span class="note">{pct}% on top</span>
                    </th>
                    <td class="r" data-out="fees">
                      {usd(fees!)}
                    </td>
                  </tr>
                </tbody>
                <tfoot>
                  <tr>
                    <th scope="row">Total per month</th>
                    <td class="r" data-out="total2">
                      {usd(shownTotal)}
                    </td>
                  </tr>
                </tfoot>
              </table>
              <p style="margin-top:16px">
                Charged daily: about <span class="num" data-out="daily">{usd(day.totalMicro)}</span> a day.
                <br />
                ${s.signupCreditUsd} of credit lasts about{" "}
                <span class="num" data-out="lasts">
                  {lasts === null ? "forever" : `${int(lasts)} days`}
                </span>
                .
              </p>
            </div>
          </div>

          <div id="compare" style="margin-top:36px">
            <h3>
              The same team on per-seat tools (<span data-out="team2">{people}</span> people)
            </h3>
            <div class="table-scroll">
              <table class="ledger">
                <thead>
                  <tr>
                    <th scope="col">Tool and plan</th>
                    <th scope="col" class="r">
                      Per person
                    </th>
                    <th scope="col" class="r">
                      Per month
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {COMPETITORS.map((c, i) => (
                    <tr>
                      <th scope="row">
                        {c.vendor} {c.plan}
                        <a class="fn" href={`#src-${i + 1}`} aria-label={`Source for ${c.vendor}`}>
                          {i + 1}
                        </a>
                      </th>
                      <td class="r">
                        ${c.perUserMonthUsd}
                        {c.freeUpToUsers ? <span class="muted small">{` (free up to ${c.freeUpToUsers} users)`}</span> : null}
                      </td>
                      <td class="r" data-competitor={c.vendor}>
                        ${int(competitorMonthly(c, people))}
                      </td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr>
                    <th scope="row">Glasstrack (estimate above)</th>
                    <td class="r">no seats</td>
                    <td class="r" data-out="total3">
                      {usd(shownTotal)}
                    </td>
                  </tr>
                </tfoot>
              </table>
            </div>
            <ol class="small muted" style="margin-top:12px">
              {COMPETITORS.map((c, i) => (
                <li id={`src-${i + 1}`}>
                  {c.vendor} {c.plan}: ${c.perUserMonthUsd} {c.basis}. Source: <a href={c.source}>{c.source.replace("https://", "")}</a>, checked{" "}
                  {c.checkedOn}.
                </li>
              ))}
            </ol>
          </div>
        </section>

        <section class="section" aria-labelledby="set-h">
          <div class="section-head">
            <h2 id="set-h">How the price is set</h2>
            <p>
              Each active workspace pays an equal share of the fixed costs, capped at {usd(f.serverShareCapMicro)} a month, plus its own storage
              and email, plus {pct}%. Workspaces with no activity in 30 days pay only their storage and email.
            </p>
          </div>
          <ExampleNote example={f.example || pricing.example} />
          <div class="grid-2">
            <div>
              <table class="ledger">
                <caption>
                  Fixed costs, {periodLabel(f)} <ExampleBadge example={f.example} />
                </caption>
                <tbody>
                  {f.thisMonth.costs.map((c) => (
                    <tr>
                      <th scope="row">
                        {c.label}
                        {c.paidByCredits && <span class="tag">paid by AWS credits</span>}
                      </th>
                      <td class="r">{usd(c.amountMicro)}</td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr>
                    <th scope="row">Total</th>
                    <td class="r">{usd(costTotal)}</td>
                  </tr>
                </tfoot>
              </table>
              <p class="small muted" style="margin-top:10px">
                Costs paid by AWS credits are shown at list price, because that is what they will cost once the credits run out.
              </p>
            </div>
            <div>
              <table class="ledger">
                <caption>This month's server share</caption>
                <tbody>
                  <tr>
                    <th scope="row">Shared fixed costs</th>
                    <td class="r">{usd(pricing.sharedFixedMonthMicro)}</td>
                  </tr>
                  <tr>
                    <th scope="row">Active workspaces</th>
                    <td class="r">{int(pricing.activeWorkspaces)}</td>
                  </tr>
                  <tr>
                    <th scope="row">Current cap</th>
                    <td class="r">{usd(f.serverShareCapMicro)}</td>
                  </tr>
                  {f.recommendedCapMicro !== null && (
                    <tr>
                      <th scope="row">
                        Recommended cap<span class="note">The reserve target is met; the operator may lower the cap to this.</span>
                      </th>
                      <td class="r">{usd(f.recommendedCapMicro)}</td>
                    </tr>
                  )}
                </tbody>
                <tfoot>
                  <tr>
                    <th scope="row">
                      Server share<span class="note">min(cap, costs &divide; active workspaces)</span>
                    </th>
                    <td class="r">{usd(share)}</td>
                  </tr>
                </tfoot>
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

          <div class="card" style="margin-top:32px" data-what-if>
            <div class="field">
              <label for="w-teams">
                <span>Teams using Glasstrack</span>
                <output for="w-teams" data-out="teams">
                  {WHAT_IF_DEFAULT}
                </output>
              </label>
              <input type="range" id="w-teams" min="1" max="1000" value={String(WHAT_IF_DEFAULT)} data-in="teams" />
            </div>
            <p style="margin:0" aria-live="polite">
              If <span data-out="teams2">{WHAT_IF_DEFAULT}</span> teams were using Glasstrack, the server share would be about{" "}
              <strong class="num" data-out="share">
                {usd(whatIf)}
              </strong>{" "}
              a month, at this month's costs.
            </p>
          </div>

          <div class="prose" style="margin-top:32px">
            <h3>In plain English</h3>
            <p>
              Running Glasstrack costs about the same whether 10 teams use it or 500: servers, the database, the domain, monitoring, and the AI
              and tools that do much of the work. Those fixed costs are split equally between active workspaces, and no workspace pays more than
              the cap. Storage and email are charged at what they cost us. On top, {pct}% covers card payment fees (Stripe takes{" "}
              {(s.stripeFeePercent * 100).toFixed(2)}% plus ${s.stripeFeeFixedUsd.toFixed(2)} per top-up) and builds a small reserve.
            </p>
            <p>
              The cap only goes down. Once the reserve holds {s.reserveTargetMonths} months of running costs, the operator may lower it. That is
              shown on the <a href="/finances">finances page</a> and is never automatic.
            </p>
            <details class="maths">
              <summary>Show the maths</summary>
              <div>
                <pre>
                  <code>{`server_share  = min(cap ${usd(s.serverShareCapUsd * 1_000_000)}, shared_fixed_costs / active_workspaces)
usage         = storage_GB × $${s.storageUsdPerGbMonth} + emails / 1000 × $${s.emailUsdPer1000.toFixed(2)}
monthly       = (server_share + usage) × ${(1 + s.feeMarkup).toFixed(2)}
daily_charge  = monthly / days in the month
credit_lasts  = credit / (monthly / ${AVG_DAYS_PER_MONTH.toFixed(2)}) days`}</code>
                </pre>
                <p>
                  Money is worked out in millionths of a dollar so every line adds up exactly. The same code runs the calculator above and the
                  nightly charge: <a href={PRICING_SOURCE}>pricing.ts on GitHub</a>.
                </p>
              </div>
            </details>
            <p>
              <a href="/finances">See this month's finances</a> &middot; <a href={PRICING_SOURCE}>Read the pricing source</a>
            </p>
          </div>
        </section>
      </div>
      <DataScript id="pricing-data" data={calcData(pricing)} />
    </Layout>
  );
}
