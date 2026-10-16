# Contributing

Thanks for helping. A few ground rules keep this project cheap to run and easy to self-host.

## Principles

- **Postgres is the only stateful dependency.** Queues, real-time and search all run in Postgres. Please don't add Redis, a message broker or a search engine; if a feature seems to need one, open an issue first.
- **Every feature works when self-hosted.** No paid-only code paths. Hosted-only concerns (billing, metering) sit behind `BILLING_ENABLED`.
- **Lean dependencies.** Prefer the platform and small, well-maintained libraries. Explain any new dependency in the PR.
- **Clean-room.** Take ideas from other trackers, never their code, icons or visual style. Do not read AGPL code (for example Plane) to implement something here.
- **Tenant isolation is not optional.** Every table with tenant data has a `workspace_id` column and row-level security. The test suite fails if a new table is missing either.

## Setup

Requirements: Node 22+, pnpm 10, PostgreSQL 15+ running locally.

```sh
pnpm install
createdb glasstrack_dev && createdb glasstrack_test
cp .env.example .env && sh scripts/init-env.sh   # or edit .env by hand
# For local dev set in .env:
#   DATABASE_URL=postgres://<you>@localhost:5432/glasstrack_dev
#   APP_URL=http://localhost:5180  PORT=3100  E2E_TEST_LOGIN=true
pnpm migrate
pnpm seed            # demo workspace, sign in as demo@example.com
pnpm dev             # API on :3100, web on :5180
```

Without `SMTP_URL`, sign-in links are printed in the server log.

## Checks

```sh
pnpm lint
pnpm typecheck
pnpm test            # uses TEST_DATABASE_URL or postgres://localhost:5432/glasstrack_test
pnpm test:e2e        # Playwright; builds nothing, run `pnpm build` first
```

The public website (/, /pricing, /finances and the other public pages) is rendered by the server with Hono JSX in `apps/server/src/site`. Its browser scripts build with `pnpm --filter @glasstrack/server build:site` (part of `pnpm build`). To refresh the product screenshots and Open Graph images after UI changes, run `pnpm build && pnpm site:screenshots` and commit the files it writes to `apps/server/src/site/public`.

The integration tests drop and recreate the test database schema, run every migration up, down and up again, and check tenant isolation for every tenant table.

## Database changes

- Add a numbered file in `apps/server/src/migrations/` with `up` and `down`, and register it in `migrations/index.ts`.
- New tenant table: add `workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE`, enable and force RLS, add the `tenant` (glasstrack_app) and `system_all` (glasstrack_system) policies, and grant privileges. Copy the pattern in `0001_init.ts`.
- Request handlers use `c.get("trx")`, which is already scoped to the workspace. Use `deps.dbs.system` only for cross-workspace jobs and pre-sign-in auth.

## Commits and PRs

Small commits with a clear subject line. Describe what changed and why in the PR, and how you tested it.
