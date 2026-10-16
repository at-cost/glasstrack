/** @jsxImportSource hono/jsx */
import { estimateEmails } from "@glasstrack/shared/pricing";
import type { PublicFinances, PublicPricing } from "../../finances/public";
import { COMPETITORS } from "../competitors";
import { estimate, TYPICAL, typicalMonthly } from "../estimate";
import { int, usd, usdWhole } from "../fmt";
import { ExampleBadge, ExampleNote, GITHUB_URL, Layout, type PageMeta, type SiteCtx } from "../layout";
import { ArrowLink, DataScript, Fig, Meter, periodLabel, Shot } from "../ui";

export const homeMeta = (p: PublicPricing): PageMeta => ({
  path: "/",
  title: "Glasstrack: open-source issue tracking, at cost",
  description: `An open-source issue tracker. Self-host it free, or let us host it and pay only what it costs to run: about ${usdWhole(typicalMonthly(p).totalMicro)} a month for most teams.`,
  og: "home",
});

const TOUR: { shot: string; title: string; text: string; alt: string }[] = [
  {
    shot: "list",
    title: "Board and list views",
    text: "Drag issues across a board, or work through a dense list. Filter by status, priority, assignee or label and save the view for your team.",
    alt: "The issue list in Glasstrack, grouped by status, with priorities, labels and assignees.",
  },
  {
    shot: "palette",
    title: "Keyboard first",
    text: "Press Cmd or Ctrl and K for the command palette. C creates an issue, S sets the status, A assigns, P sets the priority. Press ? for the rest.",
    alt: "The command palette open over the issue list, listing actions and shortcuts.",
  },
  {
    shot: "cycles",
    title: "Cycles",
    text: "Plan work in time-boxed cycles, keep a backlog for the rest, and see how each cycle is going.",
    alt: "The cycles page showing the current cycle with its issues and progress.",
  },
  {
    shot: "search",
    title: "Fast search",
    text: "Full-text search across titles and descriptions, from the same palette. Results arrive as you type.",
    alt: "The command palette with a search query and matching issues.",
  },
  {
    shot: "github",
    title: "GitHub, GitLab, Gitea and Forgejo",
    text: "Mention an issue key in a branch or pull request to link it. Merging moves the issue to Done.",
    alt: "The GitHub settings page for a workspace, with the webhook address and secret.",
  },
  {
    shot: "export",
    title: "One-click export",
    text: "Download your whole workspace at any time: JSON with everything, CSV files for issues, comments and time, and every attachment.",
    alt: "The data settings page with the Export workspace button.",
  },
];

export function HomePage(p: { pricing: PublicPricing; finances: PublicFinances; site: SiteCtx }) {
  const { pricing, finances: f } = p;
  const typical = typicalMonthly(pricing);
  const credit = pricing.settings.signupCreditUsd;
  const people = TYPICAL.people;
  const gs = estimate(pricing, people, TYPICAL.storageGb);
  const example = pricing.example || f.example;
  const reservePct = f.reserve.targetMicro > 0 ? Math.round((f.reserve.balanceMicro / f.reserve.targetMicro) * 100) : 0;
  return (
    <Layout meta={homeMeta(pricing)} site={p.site} scripts={["js/calc.js"]}>
      <section class="hero">
        <div class="wrap">
          <h1>Software should be pay-as-you-go, at cost.</h1>
          <p class="lede">
            Glasstrack is an open-source issue tracker. Self-host it free, or let us host it and pay only what it costs to run: most teams
            pay about{" "}
            <span class="num" data-typical>
              {usdWhole(typical.totalMicro)}
            </span>{" "}
            a month
            <a class="fn" href="#estimate-note" aria-label="How this estimate is worked out">
              *
            </a>
            . Every new workspace gets ${credit} of credit.
          </p>
          <div class="actions">
            {p.site.signedIn ? (
              <a class="btn btn-primary" href="/app">
                Open app
              </a>
            ) : (
              <a class="btn btn-primary" href="/login?signup=1">
                Start free (${credit} credit)
              </a>
            )}
            <a class="btn" href="/self-host">
              Self-host it
            </a>
          </div>
          <p class="small muted" id="estimate-note">
            * Estimate for a team of {people} with {TYPICAL.storageGb} GB of files and {int(estimateEmails(people))} emails a month, at this
            month's costs{example ? " (example figures)" : ""}. <a href="/pricing">Work out your own</a>.
          </p>
          <figure class="shot">
            <Shot name="board" priority alt="The Glasstrack board view: issues in columns by status, with priorities, labels and assignees." />
          </figure>
        </div>
      </section>

      <section class="section" aria-labelledby="seat-h">
        <div class="wrap mini-calc" data-mini-calc>
          <div>
            <h2 id="seat-h">One price per workspace, not per seat</h2>
            <p class="muted">
              Per-seat tools charge for every person you add. Glasstrack charges each workspace for its share of the servers plus its own
              storage and email, so a bigger team costs about the same.
            </p>
            <ArrowLink href="/pricing">See the full calculator</ArrowLink>
          </div>
          <div class="card price-card">
            <div class="field">
              <label for="mc-team">
                <span>Team size</span>
                <output for="mc-team" data-out="team">
                  {people} people
                </output>
              </label>
              <input type="range" id="mc-team" min="1" max="500" value={String(people)} data-in="team" />
            </div>
            <ul class="compare" aria-live="polite">
              {COMPETITORS.map((c) => (
                <li>
                  <span>
                    {c.vendor} {c.plan}
                  </span>
                  <span class="num" data-competitor={c.vendor}>
                    ${int(c.perUserMonthUsd * people)}/mo
                  </span>
                </li>
              ))}
              <li class="us">
                <span>Glasstrack</span>
                <span class="num" data-out="gt">
                  ~{usdWhole(gs.totalMicro)}/mo
                </span>
              </li>
            </ul>
            <p class="hint">
              Glasstrack figure assumes {TYPICAL.storageGb} GB of files. Other prices are list prices billed yearly, checked{" "}
              {COMPETITORS[0]!.checkedOn}; see <a href="/pricing#compare">sources</a>. <ExampleBadge example={pricing.example} />
            </p>
          </div>
        </div>
      </section>

      <section class="section" aria-labelledby="tour-h">
        <div class="wrap">
          <div class="section-head">
            <h2 id="tour-h">Everything a team needs to track work</h2>
            <p>Fast, keyboard-first and real-time across tabs and teammates.</p>
          </div>
          <div class="tour">
            {TOUR.map((t) => (
              <div class="tour-item">
                <div class="tour-text">
                  <h3>{t.title}</h3>
                  <p class="muted">{t.text}</p>
                </div>
                <figure class="shot">
                  <Shot name={t.shot} alt={t.alt} sizes="(min-width: 860px) 40rem, 100vw" />
                </figure>
              </div>
            ))}
          </div>
          <p class="also">
            Also included on every server: a timeline with dependencies, reports, automations, custom fields, time tracking, request forms,
            email to issue, private teams, free read-only viewers, and single sign-on with OIDC.
          </p>
        </div>
      </section>

      <section class="section" aria-labelledby="books-h">
        <div class="wrap">
          <div class="section-head">
            <h2 id="books-h">Open books</h2>
            <p>
              What it costs to run Glasstrack this month, and who pays for it.
            </p>
          </div>
          <ExampleNote example={f.example} />
          <p class="small muted">{periodLabel(f)}</p>
          <dl class="figure-row">
            <Fig label="Running costs" value={usd(f.thisMonth.totalCostMicro)} />
            <Fig label="Paying workspaces" value={int(f.thisMonth.payingWorkspaces)} />
            <Fig label="Server share cap" value={`${usd(f.serverShareCapMicro)}/mo`} />
            <Fig label="Covered by the founder" value={usd(f.thisMonth.founderGapMicro)} />
          </dl>
          <div style="max-width:32rem;margin-top:22px">
            <p class="small">
              Reserve: <span class="num">{usd(f.reserve.balanceMicro)}</span> of <span class="num">{usd(f.reserve.targetMicro)}</span> (
              {f.reserve.targetMonths} months of costs), {reservePct}%
            </p>
            <Meter value={f.reserve.balanceMicro} max={f.reserve.targetMicro} label="Reserve towards its target" />
          </div>
          <ArrowLink href="/finances">See every cost line</ArrowLink>
        </div>
      </section>

      <section class="section" aria-labelledby="run-h">
        <div class="wrap grid-2">
          <div>
            <h2 id="run-h">How it's run</h2>
            <p class="muted">One person, using AI to do the work of a team.</p>
            <ArrowLink href="/how-its-run">How it works</ArrowLink>
          </div>
          <ol class="points">
            <li>
              <strong>AI handles routine work.</strong> It already helps build and fix Glasstrack. An hourly loop to triage reports and ship
              small fixes is being set up; it isn't running yet.
            </li>
            <li>
              <strong>Savings are passed on.</strong> Lower running costs lower the price. The server share cap only goes down.
            </li>
            <li>
              <strong>A human is accountable.</strong> Billing, sign-in, data migrations and security changes always need a person, and you
              can always reach one.
            </li>
          </ol>
        </div>
      </section>

      <section class="section" aria-labelledby="free-h">
        <div class="wrap grid-2">
          <div>
            <h2 id="free-h">Free forever if you host it</h2>
            <p class="muted">
              MIT licensed, with every feature. No paid tiers, no licence keys. Postgres is the only other thing it needs.
            </p>
            <p>
              <a href="/self-host">Self-hosting guide</a> &middot; <a href={GITHUB_URL}>Source on GitHub</a>
            </p>
          </div>
          <div class="code">
            <pre>
              <code>{"sh scripts/init-env.sh\ndocker compose up -d"}</code>
            </pre>
          </div>
        </div>
      </section>

      <section class="section" aria-labelledby="faq-h">
        <div class="wrap">
          <h2 id="faq-h">Questions</h2>
          <details>
            <summary>Is it really free?</summary>
            <div>
              <p>
                Self-hosting is free, with every feature, under the MIT licence. Hosted Glasstrack is pay-as-you-go at cost: your share of
                the servers, plus your own storage and email, plus 20% for payment fees and a small reserve.
              </p>
            </div>
          </details>
          <details>
            <summary>How does billing work?</summary>
            <div>
              <p>
                You prepay credit and it is charged daily. Top up by card from ${pricing.settings.minTopupUsd} to $
                {pricing.settings.maxTopupUsd}, or turn on automatic top-up. You can set a monthly spending cap. We email you when your balance
                drops to 25%. At $0 there are 7 days of grace, then the workspace becomes read-only until you top up. Data is never deleted.
              </p>
            </div>
          </details>
          <details>
            <summary>What if I top up a lot?</summary>
            <div>
              <p>Your daily charges stay the same. Credit never expires, and unused credit is refundable on request.</p>
            </div>
          </details>
          <details>
            <summary>Why will the price go down?</summary>
            <div>
              <p>
                Most of the cost is fixed: the servers cost about the same for 10 teams or 500. Each new team lowers everyone's share. The
                server share cap only ever goes down, and once the reserve holds {pricing.settings.reserveTargetMonths} months of costs it can
                be lowered and the change is shown on the <a href="/finances">finances page</a>.
              </p>
            </div>
          </details>
          <details>
            <summary>What if you shut down?</summary>
            <div>
              <p>You get 90 days' notice, a full export of your data, and your unused credit back automatically.</p>
            </div>
          </details>
          <details>
            <summary>Can I export my data?</summary>
            <div>
              <p>
                Yes, any time, even when a workspace is read-only. An admin can download a .tar.gz with a workspace.json file (teams, issues,
                comments, activity, cycles, labels, views, custom fields, time entries, templates and the audit log), CSV files for issues,
                comments and time, and every attachment. You can also import from Linear, Jira and Trello.
              </p>
            </div>
          </details>
          <details>
            <summary>Who's behind this?</summary>
            <div>
              <p>
                <span class="placeholder">[WHO_IS_BEHIND_THIS]</span> One person, using AI to do the work of a team, accountable for what
                ships. <a href="/about">More about Glasstrack</a>.
              </p>
            </div>
          </details>
        </div>
      </section>
      <DataScript id="pricing-data" data={calcData(pricing)} />
    </Layout>
  );
}

export function calcData(p: PublicPricing) {
  return {
    settings: p.settings,
    sharedFixedMonthMicro: p.sharedFixedMonthMicro,
    activeWorkspaces: p.activeWorkspaces,
    typicalStorageGb: TYPICAL.storageGb,
    competitors: COMPETITORS.map((c) => ({ vendor: c.vendor, perUserMonthUsd: c.perUserMonthUsd })),
  };
}
