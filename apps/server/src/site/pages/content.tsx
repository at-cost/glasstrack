/** @jsxImportSource hono/jsx */
import type { PublicPricing } from "../../finances/public";
import { COMPETITORS } from "../competitors";
import { estimate, TYPICAL } from "../estimate";
import { usdWhole } from "../fmt";
import { GITHUB_URL, Layout, type PageMeta, type SiteCtx } from "../layout";

export const aboutMeta: PageMeta = {
  path: "/about",
  title: "About Glasstrack",
  description: "Why Glasstrack exists: software is getting cheaper to make, so it should cost less to use. Open source, and hosted at cost.",
  og: "about",
};

export function AboutPage(p: { pricing: PublicPricing; site: SiteCtx }) {
  const s = p.pricing.settings;
  const linear = COMPETITORS.find((c) => c.vendor === "Linear")!;
  const months = ["zero", "one", "two", "three", "four", "five", "six"][s.reserveTargetMonths] ?? String(s.reserveTargetMonths);
  // Live estimates from the same module as billing, to the nearest 10 cents.
  const about = (people: number) => `$${(Math.round(estimate(p.pricing, people, TYPICAL.storageGb).totalMicro / 100_000) / 10).toFixed(2)}`;
  const linearFor = (people: number) => `$${(linear.perUserMonthUsd * people).toLocaleString("en-US")}`;
  return (
    <Layout meta={aboutMeta} site={p.site}>
      <div class="wrap">
        <header class="page-head">
          <p class="eyebrow">About</p>
          <h1>If software costs less to make, it should cost less to use.</h1>
        </header>
        <div class="prose" style="padding-bottom:40px">
          <p>
            Writing software is getting cheaper every month, and people are building free, open-source versions of the tools we all pay for.
            This is my contribution.
          </p>
          <p>
            Glasstrack is an issue tracker for teams, in the spirit of Linear and Jira. It's open source under the MIT licence, and I've tried to
            build in the features and feedback I've seen and used in other tools. Every feature is free, and nothing is locked behind a paid
            plan: download it, run it, change it.
          </p>
          <p>
            If you'd rather not run it yourself, I'll host it for you. Instead of charging per seat, I charge what it costs to run: a share of
            the servers (at most {usdWhole(s.serverShareCapUsd * 1_000_000)} a month), plus your workspace's own storage and email, plus{" "}
            {Math.round(s.feeMarkup * 100)}% to cover payment fees and a small reserve. A {TYPICAL.people}-person team pays about{" "}
            {about(TYPICAL.people)} a month and a 200-person team about {about(200)}, where Linear would charge {linearFor(TYPICAL.people)} and{" "}
            {linearFor(200)}. Every new workspace starts with ${s.signupCreditUsd} of credit, and the <a href="/pricing">calculator</a> shows
            where every cent goes.
          </p>
          <p>
            I'm self-funding Glasstrack to start, and I publish every cost and all the <a href="/finances">finances</a>, including the
            $200-a-month AI subscription and how much of the bill I'm covering myself. Most of the cost is fixed: the servers cost much the same
            whether 10 teams use them or 500. So the server share falls as more teams join, and once there are {months} months of running costs
            in reserve, the {usdWhole(s.serverShareCapUsd * 1_000_000)} cap comes down too. The price only goes down.
          </p>
          <p>
            How can it be this cheap? AI now does much of the work that used to need a whole team. It already helps me build and fix Glasstrack,
            and I'm setting it up to check GitHub issues, prioritise them and propose fixes. Every change is tested, and anything risky comes to
            me. If the server has a problem, I'm alerted within minutes. Instead of turning those savings into profit, Glasstrack passes them on
            to you. I'm still here: I set the direction, I'm accountable for what ships, and you can always <a href="/contact">reach me</a>.
          </p>
          <p>
            My aim is to make software as close to free as possible. Issue tracking is the first tool. If this works, I'd like to do the same for
            others.
          </p>
        </div>
      </div>
    </Layout>
  );
}

export const howMeta: PageMeta = {
  path: "/how-its-run",
  title: "How Glasstrack is run",
  description:
    "Every 4 hours, AI triages GitHub issues and opens small fixes; a script merges them only if every test passes. Server alerts reach a person within minutes.",
  og: "how-its-run",
};

const VOTE_URL = `${GITHUB_URL}/issues?q=is%3Aissue+is%3Aopen+sort%3Areactions-%2B1-desc`;

const ThumbsUp = () => (
  <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round" style="vertical-align:-3px">
    <path d="M7 10v11H3V10zM7 10l4-8c1.7 0 3 1.3 3 3v4h5.5a2 2 0 0 1 2 2.3l-1.4 8A2 2 0 0 1 18.1 21H7" />
  </svg>
);

export function HowPage(p: { site: SiteCtx }) {
  return (
    <Layout meta={howMeta} site={p.site}>
      <div class="wrap">
        <header class="page-head">
          <p class="eyebrow">How it's run</p>
          <h1>AI does the routine work. A person is accountable.</h1>
          <p class="lede">
            The loop below runs every 4 hours. The instructions the AI follows are in{" "}
            <a href={`${GITHUB_URL}/blob/main/.github/ai-maintainer/PLAYBOOK.md`}>the playbook</a>. Every fix it proposes is a public pull
            request, and whether it gets merged is decided in public by{" "}
            <a href={`${GITHUB_URL}/blob/main/.github/ai-maintainer/gate.sh`}>a short script</a>, not by the AI. It started in October 2026,
            so it's new: expect rough edges.
          </p>
        </header>

        <section class="section" aria-labelledby="loop-h">
          <h2 id="loop-h">The loop</h2>
          <ol class="points prose">
            <li>
              <strong>Triage every new GitHub issue.</strong> Add labels, close duplicates with a link to the original, and ask for steps to
              reproduce when they're missing.
            </li>
            <li>
              <strong>Fix a small batch, in priority order.</strong>
              <ol>
                <li>Security problems, data loss and outages first.</li>
                <li>
                  Then confirmed bugs, ranked by thumbs-up <ThumbsUp /> reactions.
                </li>
                <li>Then feature requests that pass a vote threshold and are marked "accepted".</li>
              </ol>
            </li>
            <li>
              <strong>Merge small changes once every test passes.</strong> The AI opens a pull request; it can't merge it. A plain script merges
              it only if the full test suite passes, it's small, and it touches none of the areas below. Anything else waits for a person.
              Releasing to glasstrack.dev is still done by a person.
            </li>
          </ol>
        </section>

        <section class="section prose" aria-labelledby="outage-h">
          <h2 id="outage-h">When something breaks</h2>
          <ul>
            <li>glasstrack.dev is checked every 5 minutes, and the server's health, CPU and disk are watched.</li>
            <li>
              When an alert fires, a read-only check of the server runs straight away and the results go to me by message. The AI then takes a
              look at the likely cause on its next run and, if it's a bug, opens a fix. It can't restart, change or delete anything on the server; that
              stays with me.
            </li>
          </ul>
        </section>

        <section class="section grid-2" aria-label="Human review and voting">
          <div>
            <h2>What always needs a human</h2>
            <ul>
              <li>Billing</li>
              <li>Authentication and sign-in</li>
              <li>Data migrations</li>
              <li>Security changes</li>
            </ul>
            <p class="muted">Changes in these areas are reviewed and shipped by a person, never by the loop alone.</p>
          </div>
          <div>
            <h2>How to vote</h2>
            <p>
              Add a thumbs-up <ThumbsUp /> reaction to the issues you care about, and upvote ideas in GitHub Discussions. The most-wanted
              issues rise to the top of the queue.
            </p>
            <p>
              <a href={VOTE_URL}>Open issues, most thumbs-up first</a>
            </p>
          </div>
        </section>

        <section class="section prose" aria-labelledby="cost-h">
          <h2 id="cost-h">What it costs</h2>
          <p>
            The AI coding subscription, $200 a month, appears as its own line on the <a href="/finances">finances page</a>, next to the
            servers, so you can see what this way of working costs. It's all used for Glasstrack. A flat subscription is currently cheaper
            than paying per token, and I'll switch if per-token pricing becomes the cheaper option.
          </p>
        </section>
      </div>
    </Layout>
  );
}

