/** @jsxImportSource hono/jsx */
import type { Child } from "hono/jsx";
import { Layout, type PageMeta, type SiteCtx } from "../layout";
import { OPERATOR } from "../operator";

export const termsMeta: PageMeta = { path: "/terms", title: "Terms of service | Glasstrack", description: "The terms for using hosted Glasstrack: prepaid credit, daily charges, refunds and your data.", og: "legal" };
export const privacyMeta: PageMeta = {
  path: "/privacy",
  title: "Privacy | Glasstrack",
  description: "How hosted Glasstrack handles personal data, who it is shared with, how long it is kept, and what the website counts (no cookies, no IP addresses).",
  og: "legal",
};
export const dpaMeta: PageMeta = {
  path: "/dpa",
  title: "Data processing agreement | Glasstrack",
  description: "The data processing terms for organisations using hosted Glasstrack.",
  og: "legal",
};
export const contactMeta: PageMeta = { path: "/contact", title: "Contact | Glasstrack", description: "How to reach the person who runs Glasstrack.", og: "contact" };

const Mail = () => <a href={`mailto:${OPERATOR.email}`}>{OPERATOR.email}</a>;

function LegalShell(p: { meta: PageMeta; site: SiteCtx; title: string; children: Child }) {
  return (
    <Layout meta={p.meta} site={p.site}>
      <div class="wrap">
        <header class="page-head">
          <h1>{p.title}</h1>
        </header>
        <div class="prose" style="padding-bottom:40px">
          {p.children}
          <p class="muted small" style="margin-top:32px">
            Last updated {OPERATOR.legalUpdated}. {OPERATOR.name}, {OPERATOR.place}. Contact: <Mail />.
          </p>
        </div>
      </div>
    </Layout>
  );
}

/** Sub-processors, shared by the privacy policy and the DPA. */
const SUBPROCESSORS: [string, string, string][] = [
  ["Amazon Web Services (AWS)", "Servers, database, file storage, backups and sending email", "London, United Kingdom (eu-west-2)"],
  ["Cloudflare", "Domain name, network protection and delivering pages (sees IP addresses in transit)", "Global network"],
  ["Stripe", "Card payments for top-ups (we never see or store card numbers)", "United Kingdom, Ireland and United States"],
  ["Google and GitHub", "Only if you choose to sign in with them", "United States"],
  ["Proton", "Email we send and receive for support", "Switzerland"],
];

function Subprocessors() {
  return (
    <table class="ledger">
      <thead>
        <tr>
          <th scope="col">Company</th>
          <th scope="col">What for</th>
          <th scope="col">Where</th>
        </tr>
      </thead>
      <tbody>
        {SUBPROCESSORS.map(([who, what, where]) => (
          <tr>
            <td>{who}</td>
            <td>{what}</td>
            <td>{where}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export const TermsPage = (p: { site: SiteCtx }) => (
  <LegalShell meta={termsMeta} site={p.site} title="Terms of service">
    <p>
      These terms cover hosted Glasstrack at glasstrack.dev, run by {OPERATOR.name}, {OPERATOR.place} ("we", "us"). By creating an account or a
      workspace you agree to them. The Glasstrack software itself is open source under the MIT licence; if you run it yourself, only that licence
      applies, not these terms.
    </p>

    <h2>1. Your account and workspace</h2>
    <ul>
      <li>You need a valid email address. Keep your sign-in secure; you're responsible for what happens in workspaces you administer.</li>
      <li>Workspace admins decide who can join and what role they have.</li>
      <li>You own everything you put into Glasstrack. We only use it to run the service for you.</li>
    </ul>

    <h2>2. Prices and prepaid credit</h2>
    <ul>
      <li>
        Hosted workspaces are pay-as-you-go at cost, paid from prepaid credit and charged daily. How the charge is worked out is shown on the{" "}
        <a href="/pricing">pricing page</a>, and every cost behind it on the <a href="/finances">finances page</a>.
      </li>
      <li>New workspaces get free signup credit (currently $10). It has no cash value, can't be refunded or transferred, and is used first.</li>
      <li>You can top up by card with the amounts allowed on the billing page (currently $10 to $500 per top-up), manually or automatically.</li>
      <li>Prices are in US dollars. Your bank may charge its own fees for currency conversion.</li>
      <li>The server share cap only ever goes down. We won't raise it.</li>
    </ul>

    <h2>3. When credit runs out</h2>
    <ul>
      <li>We email workspace admins when credit is low and when it reaches zero.</li>
      <li>
        After it reaches zero, everything keeps working for 7 days. After that the workspace becomes read-only until it's topped up. We never
        delete your data because of an unpaid balance, and export always works.
      </li>
    </ul>

    <h2>4. Refunds</h2>
    <ul>
      <li>Credit never expires.</li>
      <li>
        You can ask for a refund of unused credit you paid for at any time, from the billing page or by email. We refund it to the card you paid
        with, minus the payment processing fees we were charged for those payments (for example Stripe's fees and any currency conversion fees),
        which we can't get back.
      </li>
      <li>Signup credit and any credit we gave you for free aren't refundable.</li>
      <li>Refunds normally reach your card within 5 to 10 working days of us processing them.</li>
    </ul>

    <h2>5. Fair use</h2>
    <ul>
      <li>
        Don't use Glasstrack for anything illegal, to send spam, to store malware, to attack or overload the service, or to get around limits or
        abuse the signup credit (for example by creating many workspaces).
      </li>
      <li>We may suspend a workspace that breaks these rules or puts the service or other customers at risk, and will tell you why.</li>
    </ul>

    <h2>6. Ending</h2>
    <ul>
      <li>You can delete your workspace at any time from its settings. Unused paid credit can be refunded as in section 4.</li>
      <li>
        If we ever close hosted Glasstrack, we'll give at least 90 days' notice by email, keep export working until the end, and refund all unused
        paid credit as in section 4. You can always keep running Glasstrack yourself.
      </li>
    </ul>

    <h2>7. Availability and liability</h2>
    <ul>
      <li>
        We work hard to keep Glasstrack running and your data safe, with daily backups, but we can't promise it will always be available or free
        of bugs. The service is provided "as is".
      </li>
      <li>
        As far as the law allows, we aren't liable for indirect or consequential losses (such as lost profits or data), and our total liability
        is limited to the amount you paid us in the 12 months before the claim. Nothing in these terms limits liability that can't be limited by
        law.
      </li>
    </ul>

    <h2>8. Changes and law</h2>
    <ul>
      <li>We'll email workspace admins at least 30 days before any change to these terms that affects you, and show the date above.</li>
      <li>These terms are governed by the law of England and Wales, and the courts of England and Wales have jurisdiction.</li>
    </ul>
  </LegalShell>
);

export const PrivacyPage = (p: { site: SiteCtx }) => (
  <LegalShell meta={privacyMeta} site={p.site} title="Privacy">
    <p>
      This explains what personal data hosted Glasstrack (glasstrack.dev) collects, why, who it's shared with, and your rights. {OPERATOR.name},{" "}
      {OPERATOR.place}, is the controller for account and billing data. For the content of a workspace (issues, comments, files), the
      organisation using the workspace is the controller and we process it on its behalf (see the <a href="/dpa">DPA</a>).
    </p>

    <h2>What we collect</h2>
    <ul>
      <li>
        <strong>Account:</strong> your email address, your name, and your profile picture if you sign in with Google or GitHub.
      </li>
      <li>
        <strong>Workspace content:</strong> whatever you and your team put in: issues, comments, files, and the activity history.
      </li>
      <li>
        <strong>Billing:</strong> top-ups, charges and balances. Card details go straight to Stripe; we only keep the card brand and last four
        digits for automatic top-ups.
      </li>
      <li>
        <strong>Security:</strong> when you ask for a sign-in link we record your IP address with it to stop abuse; these records are deleted
        after one day. Server logs may contain IP addresses and are kept briefly (they're rotated, at most 50 MB per service).
      </li>
      <li>
        <strong>Usage counts:</strong> per workspace, the number of active members, stored bytes and emails sent, to work out charges.
      </li>
    </ul>

    <h2>Why (legal basis)</h2>
    <ul>
      <li>To provide the service you signed up for (contract).</li>
      <li>To take payments and keep financial records, which the law requires (legal obligation).</li>
      <li>To keep the service secure and prevent abuse of the signup credit (legitimate interests).</li>
    </ul>
    <p>We don't sell personal data, show ads, or use your workspace content to train AI models.</p>

    <h2>Who we share it with</h2>
    <p>Only these providers, only for the purposes listed:</p>
    <Subprocessors />
    <p>
      Where data leaves the UK, we rely on the UK's adequacy regulations or the providers' standard contractual clauses (the UK International Data
      Transfer Addendum).
    </p>

    <h2>How long we keep it</h2>
    <ul>
      <li>Account and workspace data: until you delete it or the workspace. A deleted workspace and its files are removed straight away, and from backups within 14 days.</li>
      <li>Backups: up to 14 days.</li>
      <li>
        Billing records (amounts and dates, without names or emails): as long as the law requires, usually 6 years. To stop the signup credit
        being claimed twice, we keep a one-way hash of the email address that claimed it.
      </li>
    </ul>

    <h2>Your rights</h2>
    <p>
      You can ask to see, correct, export or delete your personal data, or object to how we use it, by emailing <Mail />. Workspace admins can
      export everything from settings at any time. If you're unhappy with how we handle your data, you can complain to the Information
      Commissioner's Office (ico.org.uk).
    </p>

    <h2 style="margin-top:40px">Technical summary</h2>
    <h3>Website visit counts</h3>
    <ul>
      <li>
        For each public page (such as /, /pricing and /finances) the server counts views per day. It stores the page path, the date (UTC), the
        number of views, and, when you arrive from another website, only that website's host name (for example news.ycombinator.com).
      </li>
      <li>
        It does not store IP addresses, cookies, user agents, full referring addresses, or anything that could identify a visitor. Obvious bots
        are not counted.
      </li>
    </ul>
    <h3>Cookies</h3>
    <ul>
      <li>The public website sets no cookies.</li>
      <li>
        When you sign in, the app sets one session cookie (HttpOnly, SameSite=Lax) so you stay signed in. It lasts up to 30 days and is removed
        when you sign out. Sign-in with Google, GitHub or single sign-on uses short-lived cookies (10 minutes) to complete the sign-in safely.
        These are strictly necessary, so no consent banner is needed.
      </li>
    </ul>
    <h3>Stored in your browser</h3>
    <ul>
      <li>
        Your theme choice (light or dark) and the last workspace you opened are saved in your browser's localStorage. They never leave your
        device.
      </li>
    </ul>
  </LegalShell>
);

export const DpaPage = (p: { site: SiteCtx }) => (
  <LegalShell meta={dpaMeta} site={p.site} title="Data processing agreement">
    <p>
      This agreement applies when an organisation (the "customer") uses hosted Glasstrack to process personal data, and forms part of the{" "}
      <a href="/terms">terms of service</a>. The customer is the controller; {OPERATOR.name} is the processor. It is meant to meet Article 28 of
      the UK GDPR (and the EU GDPR where it applies).
    </p>
    <h2>1. What we process</h2>
    <ul>
      <li>
        <strong>Subject matter and purpose:</strong> hosting the customer's workspace so its team can track work.
      </li>
      <li>
        <strong>Duration:</strong> while the workspace exists, then deletion as in section 6.
      </li>
      <li>
        <strong>Data subjects:</strong> the customer's team members and anyone they mention or upload information about.
      </li>
      <li>
        <strong>Personal data:</strong> names, email addresses, profile pictures, and any personal data in issues, comments and files.
      </li>
    </ul>
    <h2>2. Our commitments</h2>
    <ul>
      <li>We process the data only on the customer's documented instructions, which are these terms and how the customer uses Glasstrack.</li>
      <li>Anyone with access to the data is bound by confidentiality.</li>
      <li>
        We keep it secure: encryption in transit (TLS), encrypted storage and backups, database-level separation between workspaces, least-access
        server administration, and daily tested backups.
      </li>
      <li>We help the customer respond to data subject requests (workspace export and deletion are built in) and with data protection impact assessments where reasonable.</li>
      <li>We tell the customer without undue delay, and within 48 hours of becoming aware, about any personal data breach affecting its data.</li>
    </ul>
    <h2>3. Sub-processors</h2>
    <p>The customer authorises these sub-processors. We'll give 30 days' notice by email of any new one, and the customer may object.</p>
    <Subprocessors />
    <h2>4. Transfers</h2>
    <p>Data is stored in London. Transfers outside the UK rely on adequacy regulations or the UK International Data Transfer Addendum.</p>
    <h2>5. Audits</h2>
    <p>We'll answer reasonable written questions about how we meet this agreement, and make available the information needed to show it.</p>
    <h2>6. End of service</h2>
    <p>When a workspace is deleted, its data and files are removed straight away, and from backups within 14 days.</p>
    <p>
      If your organisation needs a signed copy, email <Mail />.
    </p>
  </LegalShell>
);

export const ContactPage = (p: { site: SiteCtx }) => (
  <LegalShell meta={contactMeta} site={p.site} title="Contact">
    <p>
      Email <Mail /> for help with your workspace, billing, refunds or anything else. Glasstrack is run by one person, so I aim to reply within
      two working days, and sooner if something is broken.
    </p>
    <p>
      Bugs and feature requests are best filed as{" "}
      <a href="https://github.com/transparent-ai-businesses/glasstrack/issues">GitHub issues</a>, where others can vote on them.
    </p>
  </LegalShell>
);
