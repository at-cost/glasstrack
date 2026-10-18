/** @jsxImportSource hono/jsx */
import { GITHUB_URL, Layout, type PageMeta, type SiteCtx } from "../layout";

export const selfHostMeta: PageMeta = {
  path: "/self-host",
  title: "Self-host Glasstrack with Docker",
  description:
    "Run Glasstrack on your own server in three steps with Docker Compose. MIT licensed, every feature included, no paid tiers. Postgres is the only other dependency.",
  og: "self-host",
};

function Code(p: { code: string; label: string }) {
  return (
    <div class="code">
      <pre>
        <code>{p.code}</code>
      </pre>
      <button type="button" class="btn btn-sm copy" data-copy={p.code} hidden aria-label={`Copy: ${p.label}`}>
        Copy
      </button>
    </div>
  );
}

const ENV: [string, string, string][] = [
  ["APP_URL", "Required", "The public address people use, e.g. https://tracker.example.com. With https, cookies are marked Secure."],
  ["APP_SECRET", "Required", "32 or more random characters. Signs file links and sign-in state. init-env.sh fills it in."],
  ["POSTGRES_PASSWORD", "Required", "Password for the bundled Postgres container. Filled in by init-env.sh."],
  ["DB_APP_PASSWORD, DB_SYSTEM_PASSWORD", "Required", "Passwords for the two database roles the app creates on boot. Filled in by init-env.sh."],
  ["DATABASE_URL", "Optional", "Use your own Postgres 15 or newer (RDS, Neon, Hetzner...) instead of the bundled container."],
  ["SMTP_URL, EMAIL_FROM", "Recommended", "Any SMTP server for sign-in links and notifications. Unset, emails are written to the log."],
  ["STORAGE_DRIVER, S3_*", "Optional", "local (default, the app volume) or s3 for AWS S3, MinIO, R2 or any S3-compatible store."],
  ["GOOGLE_CLIENT_ID/SECRET, GITHUB_CLIENT_ID/SECRET", "Optional", "Sign in with Google or GitHub. Email links always work."],
  ["BACKUP_ENABLED, BACKUP_CRON", "Optional", "Daily pg_dump to your storage under backups/."],
  ["DOMAIN", "Optional", "With --profile tls, Caddy gets an HTTPS certificate for this domain automatically."],
  ["HOST_PORT", "Optional", "Port on the host (default 3000)."],
  ["MIGRATE_ON_BOOT, WORKER_MODE", "Optional", "Migrations run on start by default; background jobs run in the same process unless you split them."],
  ["INBOUND_EMAIL_DOMAIN, INBOUND_EMAIL_SECRET", "Optional", "Email to issue (see docs/EMAIL-TO-ISSUE.md)."],
  ["STATUS_PAGE_URL", "Optional", "Link the /status page to an external status page."],
  ["BILLING_ENABLED", "Leave off", "Hosted-mode billing. Self-hosted servers don't need it; every feature works without it."],
];

export function SelfHostPage(p: { site: SiteCtx }) {
  return (
    <Layout meta={selfHostMeta} site={p.site}>
      <div class="wrap">
        <header class="page-head">
          <p class="eyebrow">Self-host</p>
          <h1>Run it yourself, free</h1>
          <p class="lede">
            Every feature is included, under the MIT licence. No paid tiers and no licence keys. Single sign-on, time tracking,
            automations and the rest all work on your server.
          </p>
        </header>

        <section class="section grid-2" aria-labelledby="req-h">
          <div>
            <h2 id="req-h">What you need</h2>
            <ul>
              <li>A Linux server or any machine with Docker and the Compose plugin.</li>
              <li>A small server is enough: 2 vCPUs and 4 GB of RAM.</li>
              <li>Postgres is the only stateful dependency. It runs in the bundled container, or point it at your own Postgres 15+.</li>
              <li>Optional: an SMTP server for email, and S3-compatible storage for files and backups.</li>
            </ul>
          </div>
          <div>
            <h2>Quick start</h2>
            <ol class="steps">
              <li>
                <strong>1. Get the code</strong>
                <Code label="clone the repository" code={`git clone ${GITHUB_URL}.git && cd glasstrack`} />
              </li>
              <li>
                <strong>2. Create .env with random secrets</strong>, then set <code>APP_URL</code> and <code>SMTP_URL</code> in it.
                <Code label="create the env file" code="sh scripts/init-env.sh" />
              </li>
              <li>
                <strong>3. Start it.</strong> The app is on http://localhost:3000.
                <Code label="start the containers" code="docker compose up -d" />
              </li>
            </ol>
            <p class="small muted">
              For HTTPS, set <code>DOMAIN</code> and <code>APP_URL=https://your-domain</code> in .env, then run{" "}
              <code>docker compose --profile tls up -d</code>.
            </p>
          </div>
        </section>

        <section class="section" aria-labelledby="env-h">
          <h2 id="env-h">Settings</h2>
          <p class="muted">
            Everything is set with environment variables in .env. Every option is documented in{" "}
            <a href={`${GITHUB_URL}/blob/main/.env.example`}>.env.example</a>.
          </p>
          <div class="table-scroll">
            <table class="ledger">
              <thead>
                <tr>
                  <th scope="col">Variable</th>
                  <th scope="col">Needed</th>
                  <th scope="col">What it does</th>
                </tr>
              </thead>
              <tbody>
                {ENV.map(([k, need, what]) => (
                  <tr>
                    <th scope="row">
                      <code>{k}</code>
                    </th>
                    <td>{need}</td>
                    <td>{what}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>

        <section class="section grid-2" aria-label="Backups and upgrades">
          <div>
            <h2>Backups</h2>
            <p>
              Set <code>BACKUP_ENABLED=true</code> to dump the database daily to <code>backups/</code> in your storage. To prove the newest backup
              restores, run this daily from cron. It restores into a scratch database, checks it, and exits non-zero on failure:
            </p>
            <Code label="verify the newest backup" code="docker compose exec app node dist/restore-verify.js" />
            <p style="margin-top:12px">One-off backup:</p>
            <Code label="take a backup now" code="docker compose exec app node dist/backup.js" />
          </div>
          <div>
            <h2>Upgrades</h2>
            <p>Pull the new code and rebuild. Database migrations run automatically when the container starts.</p>
            <Code label="upgrade" code={"git pull\ndocker compose up -d --build"} />
            <p style="margin-top:12px">
              Health checks: <code>GET /health</code> (process up) and <code>GET /ready</code> (database reachable, migrations current). Logs are
              JSON lines on stdout.
            </p>
          </div>
        </section>

        <section class="section prose" aria-labelledby="move-h">
          <h2 id="move-h">Moving from glasstrack.dev to your own server</h2>
          <p>
            Export your workspace (Settings, then Export) and import it into a new workspace on your server. Issue numbers like ENG-12,
            comments, history, attachments, custom fields, time entries and templates all come across, and people are matched by email. A
            test exports and re-imports a workspace on every change, so leaving stays easy.
          </p>
          <Code
            label="import a workspace export"
            code={"docker compose cp ./acme-export.tar.gz app:/tmp/acme-export.tar.gz\ndocker compose exec app node dist/import-workspace.js /tmp/acme-export.tar.gz --slug acme --owner you@example.com"}
          />
          <p class="small muted" style="margin-top:12px">
            Add <code>--dry-run</code> first to see what would be imported. Recurring issues and automations arrive switched off. Billing,
            API tokens, webhooks, integrations and single sign-on stay behind; set those up again on your server.
          </p>
        </section>

        <section class="section prose" aria-labelledby="docs-h">
          <h2 id="docs-h">Full documentation</h2>
          <p>
            The <a href={`${GITHUB_URL}#readme`}>README</a> covers managed Postgres, S3 storage, email and operations.{" "}
            <a href={`${GITHUB_URL}/blob/main/docs/DEPLOY.md`}>docs/DEPLOY.md</a> describes how glasstrack.dev itself runs and how to move it
            between hosts, and <a href={`${GITHUB_URL}/blob/main/docs/API.md`}>docs/API.md</a> documents the REST API and webhooks.
          </p>
        </section>
      </div>
    </Layout>
  );
}
