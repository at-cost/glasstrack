/** @jsxImportSource hono/jsx */
import type { Child } from "hono/jsx";
import { Layout, type PageMeta, Placeholder, type SiteCtx } from "../layout";

export const termsMeta: PageMeta = { path: "/terms", title: "Terms of service | Glasstrack", description: "The terms for using hosted Glasstrack.", og: "legal" };
export const privacyMeta: PageMeta = {
  path: "/privacy",
  title: "Privacy | Glasstrack",
  description: "How hosted Glasstrack handles personal data, what the website counts (no cookies, no IP addresses) and what it stores.",
  og: "legal",
};
export const dpaMeta: PageMeta = {
  path: "/dpa",
  title: "Data processing agreement | Glasstrack",
  description: "The data processing agreement for organisations using hosted Glasstrack.",
  og: "legal",
};
export const contactMeta: PageMeta = { path: "/contact", title: "Contact | Glasstrack", description: "How to reach the person who runs Glasstrack.", og: "contact" };

function LegalShell(p: { meta: PageMeta; site: SiteCtx; title: string; children: Child }) {
  return (
    <Layout meta={p.meta} site={p.site}>
      <div class="wrap">
        <header class="page-head">
          <h1>{p.title}</h1>
        </header>
        <div class="prose" style="padding-bottom:40px">
          {p.children}
        </div>
      </div>
    </Layout>
  );
}

export const TermsPage = (p: { site: SiteCtx }) => (
  <LegalShell meta={termsMeta} site={p.site} title="Terms of service">
    <p>
      <Placeholder name="TERMS_TEXT" />
    </p>
    <p class="muted small">
      Last updated <Placeholder name="TERMS_LAST_UPDATED" />. Operator: <Placeholder name="OPERATOR_NAME_AND_ADDRESS" />
    </p>
  </LegalShell>
);

export const DpaPage = (p: { site: SiteCtx }) => (
  <LegalShell meta={dpaMeta} site={p.site} title="Data processing agreement">
    <p>
      <Placeholder name="DPA_TEXT" />
    </p>
    <p class="muted small">
      Last updated <Placeholder name="DPA_LAST_UPDATED" />. Operator: <Placeholder name="OPERATOR_NAME_AND_ADDRESS" />
    </p>
  </LegalShell>
);

export const PrivacyPage = (p: { site: SiteCtx }) => (
  <LegalShell meta={privacyMeta} site={p.site} title="Privacy">
    <h2>Privacy policy</h2>
    <p>
      <Placeholder name="PRIVACY_POLICY_TEXT" />
    </p>
    <p class="muted small">
      Last updated <Placeholder name="PRIVACY_LAST_UPDATED" />. Operator: <Placeholder name="OPERATOR_NAME_AND_ADDRESS" />
    </p>

    <h2 style="margin-top:40px">Technical summary</h2>
    <p class="muted">
      A plain description of what this website and the app store. It is not the privacy policy above, which is the legal text.
    </p>
    <h3>Website visit counts</h3>
    <ul>
      <li>
        For each public page (such as /, /pricing and /finances) the server counts views per day. It stores the page path, the date (UTC), the
        number of views, and, when you arrive from another website, only that website's host name (for example news.ycombinator.com).
      </li>
      <li>
        It does not store IP addresses, cookies, user agents, full referring addresses, or anything that could identify a visitor. Obvious
        bots are not counted.
      </li>
      <li>Counts are kept in memory and written to the database once a minute.</li>
    </ul>
    <h3>Cookies</h3>
    <ul>
      <li>The public website sets no cookies.</li>
      <li>
        When you sign in, the app sets one session cookie (HttpOnly, SameSite=Lax) so you stay signed in. It lasts up to 30 days and is removed
        when you sign out. Sign-in with Google, GitHub or single sign-on uses short-lived cookies (10 minutes) to complete the sign-in safely.
      </li>
    </ul>
    <h3>Stored in your browser</h3>
    <ul>
      <li>
        Your theme choice (light or dark) is saved in your browser's localStorage. It never leaves your device. The app also remembers the last
        workspace you opened in the same way.
      </li>
    </ul>
  </LegalShell>
);

export const ContactPage = (p: { site: SiteCtx }) => (
  <LegalShell meta={contactMeta} site={p.site} title="Contact">
    <p>
      Email <Placeholder name="SUPPORT_EMAIL" /> for help with your workspace, billing, refunds or anything else.
    </p>
    <p>
      <Placeholder name="RESPONSE_TIME" />
    </p>
    <p>
      Bugs and feature requests are best filed as{" "}
      <a href="https://github.com/transparent-ai-businesses/glasstrack/issues">GitHub issues</a>, where others can vote on them.
    </p>
    <p class="muted small">
      Operator: <Placeholder name="OPERATOR_NAME_AND_ADDRESS" />
    </p>
  </LegalShell>
);
