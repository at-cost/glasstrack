# Architecture

Working name: **Tracker** (placeholder until a product name is chosen).

An open-source, MIT-licensed ticket tracker that anyone can self-host with every feature, and that is also run as a hosted multi-tenant service priced at cost with public finances. Because price equals cost, efficiency is a feature: the whole system must run for hundreds of teams on one 2 vCPU / 4 GB server.

This document was approved before code was written and is kept in step with the code. Sections marked **Decision** need an answer from the maintainer. Where the build differs from the original plan, it says so.

---

## 1. Stack

| Concern | Choice | Why |
|---|---|---|
| Language | TypeScript (strict) everywhere | One language, shared types between API and SPA. |
| Runtime | Node.js 22 LTS | Boring, long support window, small Alpine image. |
| HTTP server | Hono on `@hono/node-server` | Tiny, fast, Web-standard Request/Response, built-in CSRF/secure-headers middleware. |
| Frontend | React 19 + Vite SPA, served as static files by the same Hono process | One container, no SSR server to run. |
| Client data | TanStack Query | Caching, optimistic updates and rollback in one proven library. |
| Routing (client) | TanStack Router | Type-safe routes and search params (filters live in the URL). |
| Drag and drop | `@dnd-kit/core` + `@dnd-kit/sortable` | Accessible (keyboard drag), maintained, no heavy deps. |
| Validation | Zod, schemas shared in `packages/shared` | Single source for request types on both sides. |
| Database | PostgreSQL 16 | The only stateful dependency. |
| DB access | Kysely + `pg` | Typed SQL builder, no runtime engine or codegen binary; migrations with `up`/`down`. |
| Jobs | pg-boss | Queue, retries, cron schedules, all inside Postgres. |
| Real-time | Postgres `LISTEN/NOTIFY` + Server-Sent Events | SSE is one-way (all we need), plain HTTP, auto-reconnect, no WebSocket server. |
| Auth | Own sessions in Postgres; `arctic` for Google/GitHub OAuth | Small audited OAuth helpers, no auth SaaS, no heavy framework. |
| Email | Nodemailer over SMTP | AWS SES exposes an SMTP endpoint, so one transport covers SMTP and SES with zero AWS SDK. |
| Object storage | `aws4fetch` (SigV4 signing over fetch) + local-disk driver | Works with S3, MinIO, R2 and Hetzner storage; ~10 KB vs the multi-MB AWS SDK. |
| Markdown | `marked` + DOMPurify (client); stored as source | Never store or serve unsanitised HTML. |
| Logging | pino (JSON) | Fast structured logs. |
| Payments (M2) | `stripe` official SDK | Webhook signature verification and typed API. |
| Tests | Vitest (unit + integration against real Postgres), Playwright (e2e) | Same runner front and back; RLS must be tested on real Postgres. |
| Styling | Plain CSS with custom properties, CSS modules | Zero runtime, easy dark/light themes, original look. |
| Icons | Lucide (ISC) | Generic open icon set, not borrowed from any tracker. |

Rejected as heavier: Next.js (needs an SSR server), Prisma (engine binary, weaker RLS ergonomics), Redis/BullMQ (extra stateful service), Socket.IO (unneeded bidirectional protocol), Tailwind (fine, but CSS variables are enough and keep the look deliberate).

### Process model

One Node process runs HTTP, SSE, and the pg-boss worker (`WORKER_MODE=inline`, default). For larger installs the same image can run as `WORKER_MODE=only` and `WORKER_MODE=off` in two containers with no code change.

Memory budget on the 4 GB target: Postgres ~1.5 GB (`shared_buffers=1GB`), Node ~250 MB, OS and page cache the rest.

---

## 2. Folder structure

```
.
├── apps/
│   ├── server/                 Hono API, SSE, jobs, static SPA hosting
│   │   ├── src/
│   │   │   ├── index.ts        boot: config, migrate (optional), http, worker
│   │   │   ├── config.ts       env parsing (zod), the only place env is read
│   │   │   ├── db/             pools, tenant transaction helper, Kysely types
│   │   │   ├── migrations/     numbered, up + down
│   │   │   ├── auth/           magic link, OAuth, sessions, CSRF
│   │   │   ├── modules/        one folder per domain: workspaces, teams, issues,
│   │   │   │                   comments, cycles, views, search, notifications,
│   │   │   │                   attachments, export, billing, metering, finances
│   │   │   ├── realtime/       LISTEN connection + SSE fan-out
│   │   │   ├── jobs/           pg-boss registration and handlers
│   │   │   ├── email/          transport + templates (plain text + simple HTML)
│   │   │   ├── storage/        s3 + local drivers behind one interface
│   │   │   └── system/         the ONLY code allowed to use the RLS-bypassing pool
│   │   └── test/               integration tests (RLS isolation, API)
│   └── web/                    React SPA
│       └── src/ (routes, components, features/*, styles/, lib/)
├── packages/
│   └── shared/                 zod schemas, enums, money + allocation maths
├── e2e/                        Playwright tests
├── scripts/                    seed, backup, restore-verify
├── docker/                     Dockerfile, postgres init (roles)
├── docker-compose.yml
├── .env.example
└── .github/workflows/ci.yml
```

pnpm workspaces. The cost-allocation, ledger and pricing maths live in `packages/shared/src/money/` as pure functions so they are unit-tested in isolation and reused by the public finances page.

---

## 3. Tenancy and row-level security

### Roles

| Role | Purpose | RLS |
|---|---|---|
| owner (the `DATABASE_URL` user) | Owns all tables, runs migrations, creates the two runtime roles on boot. Used at runtime only by pg-boss. | n/a |
| `tracker_app` | Every HTTP request. `NOBYPASSRLS`. | Enforced |
| `tracker_system` | Cross-workspace jobs (digests, deletion, cleanup, later metering) and pre-sign-in auth lookups. | Explicit allow-all policy (`system_all`), not `BYPASSRLS`, so it works on RDS |

### Request flow

1. Middleware authenticates the session cookie (API tokens arrive in M4), giving `user_id`.
2. Every request runs inside one transaction that starts with `SELECT set_config('app.user_id', $1, true)`.
3. For workspace routes (`/api/v1/w/:slug/...`) a `SECURITY DEFINER` function `app.enter_workspace(slug)` checks membership of `app.user_id` and only then sets `app.workspace_id` (transaction-local). If the user is not a member it raises, so there is no code path that sets the workspace without a membership check.
4. Transaction-local settings mean pooled connections never leak context, and it works behind PgBouncer in transaction mode.

### Policies

Every table with a `workspace_id` column gets:

```sql
ALTER TABLE t ENABLE ROW LEVEL SECURITY;
ALTER TABLE t FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant ON t
  USING      (workspace_id = current_setting('app.workspace_id', true)::uuid)
  WITH CHECK (workspace_id = current_setting('app.workspace_id', true)::uuid);
```

An unset setting yields `NULL`, which matches nothing: default deny.

Exceptions:
- `workspace_members`: also readable where `user_id = app.user_id` (so a user can list their own workspaces).
- `workspaces`: readable where the user is a member.

A test queries `pg_catalog` and fails if any table with a `workspace_id` column lacks `relrowsecurity`, `relforcerowsecurity` and a `tracker_app` policy. Role checks (admin/member/guest) and guest team scoping are enforced in the application layer; RLS is the tenant wall.

### Isolation tests

`apps/server/test/rls.test.ts` creates workspaces A and B with rows in every tenant table (it asserts that), then as a member of A tries every API route of B, B's issue ids and keys inside A, cross-workspace references (labels, parents, assignees, relations), search and listings, and, directly as `tracker_app`, selects, updates and inserts against B in every tenant table. It also checks the workspace setting never leaks between pooled connections.

---

## 4. Data model

All ids are `uuid` (v7, time-ordered, generated in app) unless noted. All timestamps are `timestamptz`. Money is `bigint` **micro-USD** (1 USD = 1,000,000) because daily pro-rata charges are fractions of a cent.

### Global tables (no `workspace_id`)

| Table | Key columns | Indexes / notes |
|---|---|---|
| `users` | id, email `citext`, name, avatar_url, email_verified_at, created_at, deleted_at | unique(email) |
| `auth_identities` | id, user_id, provider (`google`/`github`), provider_user_id, email | unique(provider, provider_user_id) |
| `magic_links` | id, email, token_hash, expires_at (15 min), used_at, ip | unique(token_hash) |
| `sessions` | id, user_id, token_hash, created_at, last_seen_at, expires_at, user_agent | unique(token_hash), (user_id) |
| `workspaces` | id, slug, name, status (`active`/`grace`/`read_only`/`deleting`), created_by, created_at | unique(slug); RLS: members only |
| `starter_credit_claims` | id, email_hash, domain, workspace_id, created_at | (email_hash), (domain); limits farming |
| `pricing_config` | id, effective_from, monthly_price_micro, created_by, reason | append-only; trigger rejects any price higher than the latest row |
| `stripe_events` | event_id (pk, text), type, received_at, processed_at | webhook idempotency |
| `cost_entries` | id, period_start, period_end, category, source (`aws`/`stripe`/`manual`), amount_micro, public_label, note | (period_start) |
| `finance_daily` | day (pk), revenue_micro, costs `jsonb` (by public line), total_cost_micro, paying_workspaces, cost_per_workspace_micro, reserve_micro, reserve_target_micro, price_micro, recommended_price_micro, margin_bp | public; never contains workspace ids |

### Tenant tables (all have `workspace_id uuid not null`, RLS as above)

| Table | Key columns | Indexes / notes |
|---|---|---|
| `workspace_members` | workspace_id, user_id, role (`admin`/`member`/`guest`), joined_at, last_active_at | pk(workspace_id, user_id); (user_id) |
| `invites` | id, workspace_id, email (null for link invites), token_hash, role, invited_by, expires_at, accepted_at, revoked_at | unique(token_hash); accepted via `SECURITY DEFINER app.accept_invite(token)` |
| `teams` | id, workspace_id, key (e.g. `ENG`), name, issue_counter, archived_at | unique(workspace_id, key) |
| `team_members` | workspace_id, team_id, user_id | pk(team_id, user_id); guests see only their teams |
| `workflow_states` | id, workspace_id, team_id, name, category (`backlog`/`unstarted`/`started`/`completed`/`canceled`), color, position | (team_id, position); defaults: Backlog, Todo, In Progress, In Review, Done, Cancelled |
| `labels` | id, workspace_id, team_id (null = workspace-wide), name, color | unique(workspace_id, coalesce(team_id), lower(name)) |
| `cycles` | id, workspace_id, team_id, number, name, starts_on, ends_on, completed_at | unique(team_id, number) |
| `issues` | id, workspace_id, team_id, number, title, description_md, status_id, priority (0 none, 1 urgent .. 4 low), assignee_id, creator_id, parent_id, cycle_id, due_date, estimate `numeric(6,2)`, sort_key `text`, created_at, updated_at, started_at, completed_at, canceled_at, archived_at, search `tsvector` (generated: title A, description B) | unique(team_id, number); (workspace_id, team_id, status_id, sort_key); (workspace_id, assignee_id); (workspace_id, cycle_id); (parent_id); GIN(search) |
| `issue_labels` | workspace_id, issue_id, label_id | pk(issue_id, label_id); (label_id) |
| `issue_relations` | id, workspace_id, issue_id, related_issue_id, type (`blocks`/`related`/`duplicate`) | unique(issue_id, related_issue_id, type); check not self |
| `issue_subscribers` | workspace_id, issue_id, user_id | pk(issue_id, user_id) |
| `comments` | id, workspace_id, issue_id, author_id, body_md, created_at, edited_at, deleted_at, search `tsvector` | (issue_id, created_at); GIN(search) |
| `activity` | id `bigserial`, workspace_id, issue_id, actor_id, kind, data `jsonb`, created_at | (issue_id, id); append-only (UPDATE/DELETE revoked) |
| `attachments` | id, workspace_id, issue_id, comment_id, uploader_id, storage_key, filename, content_type, size_bytes, created_at, deleted_at | (issue_id); storage metering sums `size_bytes` |
| `saved_views` | id, workspace_id, team_id, owner_id, name, shared, layout (`list`/`board`), filters `jsonb`, sort `jsonb` | (workspace_id, owner_id) |
| `notifications` | id, workspace_id, user_id, issue_id, kind, actor_id, data `jsonb`, created_at, read_at, emailed_at | (user_id, read_at, created_at desc) |
| `notification_settings` | workspace_id, user_id, digest (`off`/`hourly`/`daily`), events `jsonb` | pk(workspace_id, user_id) |
| `exports` | id, workspace_id, requested_by, status, storage_key, size_bytes, created_at, expires_at | |
| `api_tokens` (M4) | id, workspace_id, user_id, name, token_hash, last_used_at, expires_at, revoked_at | unique(token_hash) |
| `webhooks` (M4) | id, workspace_id, url, secret, events, active | |
| `credit_ledger` (M2) | id `bigserial`, workspace_id, kind (`starter_grant`/`topup`/`charge`/`storage_charge`/`refund`/`adjustment`), amount_micro (signed), idempotency_key, ref_type, ref_id, memo, created_by, created_at | unique(idempotency_key); (workspace_id, id); append-only |
| `billing_accounts` (M2) | workspace_id (pk), stripe_customer_id, has_card, auto_topup, auto_topup_threshold_micro, auto_topup_amount_micro, grace_started_at, read_only_at | |
| `payments` (M2) | id, workspace_id, stripe_payment_intent, balance_txn_id, gross_micro, fee_micro, net_micro, created_at | unique(stripe_payment_intent) |
| `usage_daily` (M3) | workspace_id, day, active_members, storage_bytes, emails_sent, api_requests | pk(workspace_id, day) |
| `workspace_cost_daily` (M3) | workspace_id, day, shared_micro, storage_micro, email_micro, fees_micro, total_micro | pk(workspace_id, day); admin only, never public |

### Notable details

- **Human IDs**: `UPDATE teams SET issue_counter = issue_counter + 1 RETURNING issue_counter` inside the create transaction. Displayed as `KEY-number`. If a team key is renamed, old keys keep resolving through a `team_key_aliases` table.
- **Ordering**: `sort_key` is a fractional index string (lexicographic), so a drag updates one row with no renumbering.
- **Search**: `websearch_to_tsquery('simple', q)` over issues and comments, plus exact match on `KEY-123`. The `simple` config avoids English-only stemming for international teams.
- **Realtime**: after each mutation the transaction calls `pg_notify('ws', '{"w":<workspace>,"t":"issue","id":<id>,"v":<updated_at>}')`. Notifications fire on commit only. One `LISTEN` connection per process fans out to SSE clients of that workspace; clients refetch or patch their cache. Payloads stay well under the 8 KB limit because they carry ids, not rows.
- **Deletion (GDPR)**: workspace deletion sets `status = deleting`, then a job deletes tenant rows in batches and removes the storage prefix `w/<workspace_id>/`. Ledger and payment rows required for tax are anonymised and kept, which must be stated in the privacy policy. **Decision 1**.

---

## 5. API outline

JSON over REST at `/api/v1`. The SPA uses a session cookie; integrations (M4) use `Authorization: Bearer <token>`. Errors: `{ "error": { "code", "message" } }`.

```
GET  /health                      process up
GET  /ready                       DB reachable + migrations current

POST /api/v1/auth/magic-link      { email }
GET  /api/v1/auth/magic-link/verify?token=
GET  /api/v1/auth/oauth/:provider            start (google|github)
GET  /api/v1/auth/oauth/:provider/callback
POST /api/v1/auth/logout
GET  /api/v1/me

GET  /api/v1/workspaces           POST /api/v1/workspaces
POST /api/v1/invites/:token/accept

Under /api/v1/w/:slug
  GET|PATCH|DELETE   /                         workspace
  GET|PATCH|DELETE   /members[/:userId]
  GET|POST|DELETE    /invites[/:id]
  GET|POST|PATCH     /teams[/:teamId]
  GET|POST|PATCH|DELETE /teams/:teamId/states[/:id]
  GET|POST|PATCH|DELETE /labels[/:id]
  GET|POST|PATCH     /teams/:teamId/cycles[/:id]
  GET  /issues?team=&status=&assignee=&label=&priority=&cycle=&q=&cursor=
  POST /issues
  GET|PATCH|DELETE   /issues/:key              (key = ENG-123 or uuid)
  POST /issues/:key/move                       { statusId, after?, before? }
  POST|DELETE        /issues/:key/relations[/:id]
  GET|POST           /issues/:key/comments     PATCH|DELETE /comments/:id
  GET  /issues/:key/activity
  POST /issues/:key/attachments                returns presigned upload
  GET|POST|PATCH|DELETE /views[/:id]
  GET  /search?q=
  GET  /notifications   POST /notifications/read
  GET|PUT /notification-settings
  POST /exports   GET /exports/:id
  GET  /events                                  SSE stream

M2:  GET /w/:slug/billing, POST /w/:slug/billing/topup (Stripe Checkout),
     PUT /w/:slug/billing/auto-topup, POST /api/v1/stripe/webhook
M3:  GET /api/v1/public/finances(.csv), /api/v1/admin/costs, /admin/pricing
M4:  /w/:slug/tokens, /w/:slug/webhooks, /w/:slug/import/{linear|jira|trello},
     POST /api/v1/github/webhook
```

Issue lists use `limit`/`offset` (default 500, max 2000), simple and fast enough at per-team sizes; switch to keyset pagination if teams grow past tens of thousands of open issues. Writes return the updated entity so optimistic updates can reconcile. Magic-link tokens are consumed by a POST from the SPA, so email link scanners can't burn them.

### Security

- Cookies: `__Host-session`, `HttpOnly`, `Secure`, `SameSite=Lax`, opaque random token stored as SHA-256 hash.
- CSRF: `SameSite=Lax` plus an `Origin` header check on every non-GET request (Hono `csrf` middleware). Bearer-token requests are exempt because browsers don't attach them automatically.
- Rate limits: in-process token buckets keyed by IP and by email/token (auth: 5 magic links per email per 15 min; API: 600 req/min per token). This is correct for the single-process target; a Postgres-backed limiter is the upgrade path if we ever run several app containers.
- Secrets only from env (validated at boot). `pnpm audit` in CI. Content-Security-Policy with no inline scripts.

---

## 6. Credit ledger (Milestone 2)

- **Append-only**: `UPDATE` and `DELETE` revoked from all app roles and blocked by trigger. Corrections are new `adjustment` or `refund` rows.
- **Balance** = `SUM(amount_micro)` per workspace. With roughly one charge row per day this stays tiny; a covering index makes it a fast index-only scan. No cached balance column to drift.
- **Idempotency**: every row has a unique `idempotency_key`, e.g. `charge:<workspace>:<day>`, `topup:<stripe_payment_intent>`, `starter:<workspace>`. The daily job and webhooks can rerun safely.
- **Concurrency**: charges take `pg_advisory_xact_lock(hashtext(workspace_id))` so balance checks and inserts are serialised per workspace.
- **Daily charge**: `round(monthly_price_micro × 12 / 365)` per active workspace per day. 12/365 rather than days-in-month keeps every day the same price; the yearly total equals 12 × monthly.
- **Starter credit**: $10 granted only after email verification. One grant per verified email; at most N per email domain per 30 days (N configurable, public domains like gmail.com exempt from the domain cap but still per-email). Top-ups beyond the starter credit require a card on file.
- **Zero balance**: `grace` for 7 days (warning emails on days 0, 3, 6), then `read_only`. Writes are rejected by middleware with a clear message; reads and export always work. Data is never deleted for non-payment.
- **Fair use storage**: bytes over 10 GB charged daily at the at-cost per-GB rate as `storage_charge` rows.
- **Price never increases**: enforced by a DB trigger on `pricing_config` and checked again in code.

**Revenue recognition** matters for the public numbers: a top-up is prepaid credit (a liability), not revenue. Revenue is recognised when `charge` rows consume credit. The reserve is built from recognised revenue minus costs, not from cash received.

---

## 7. Cost metering and allocation (Milestone 3)

Daily job, per workspace, writes `usage_daily`:
- active members: distinct members with `last_active_at` in the last 30 days (`last_active_at` is updated at most once per hour per member to avoid write amplification);
- storage bytes: `SUM(size_bytes)` of live attachments and exports;
- emails sent: counted when each email is handed to the transport;
- API requests: in-memory counters flushed every minute with an upsert.

Allocation, in `packages/shared/src/money/allocate.ts` (pure, exhaustively unit-tested, property-tested so that allocations always sum to the input totals):

```
workspace_cost = shared_costs × (ws_active_members / total_active_members)
               + storage_GB × storage_rate
               + emails × email_rate
               + ws_payment_fees
```

Edge cases defined up front: zero total active members (shared costs split evenly across active workspaces); rounding in micro-USD with the remainder assigned by largest remainder so totals reconcile exactly.

Price recommendation:

```
recommended = (total_monthly_costs ÷ paying_workspaces) × (1 + margin)
margin = 10% while reserve < 6 × monthly_costs, else 2%
```

If `recommended < current price`, the admin screen shows a "lower price" action that appends to `pricing_config`. Nothing raises the price automatically.

Public `/finances` page: daily roll-up into `finance_daily`, history charts, CSV download. It shows aggregates only; no table on the page or in the CSV carries a workspace id, name or slug. While fewer than 5 paying workspaces exist, "cost per workspace" is still shown (it is an average) but no distribution or percentile is.

---

## 8. Operations

- `docker compose up`: services `app` and `postgres` (plus optional profiles `minio` and `mailpit` for local S3/email testing). Self-host default storage is the local disk volume, so MinIO is not required.
- Migrations run on container start (`MIGRATE_ON_BOOT=true`) using `tracker_owner`, before the HTTP server listens. Every migration has a `down`; CI runs up, down, up.
- Backups: a pg-boss cron job runs `pg_dump -Fc` and uploads to `s3://<bucket>/backups/` (or the local volume). `scripts/restore-verify.sh` restores the latest dump into a scratch database, runs migrations-are-current and row-count sanity checks, then drops it. Docs show cron and systemd timer examples.
- Portability: nothing AWS-specific is required. S3 endpoint, SMTP host and `DATABASE_URL` are env vars; moving to Hetzner is a config change.

---

## 9. Risks and open decisions

1. **GDPR deletion vs financial records** (Decision 1): payments and ledger rows probably need keeping for tax (UK: 6 years). Plan: anonymise and keep those, delete everything else.
2. **Starter credit accounting** (Decision 2): is spend paid by starter credit revenue (and so counted in "paying workspaces"), or a promotional cost? Recommendation: treat it as a marketing cost line shown publicly, and count only card-funded workspaces as paying.
3. **Price only goes down vs rising costs**: if AWS or Stripe raise prices, the reserve absorbs it. If the reserve runs out, the rule must break or the service runs at a loss. Recommend stating that policy publicly now.
4. **Flat price vs per-member cost**: large teams cost more but pay the same flat fee. Acceptable by design, but it shapes who the allocation formula favours; worth stating on the finances page.
5. ~~`BYPASSRLS` on RDS~~ Resolved: the system role uses an explicit `system_all` policy instead, so no superuser-only attribute is needed. The `DATABASE_URL` user needs `CREATEROLE` once to create the runtime roles.
6. **SSE connection limits**: browsers allow 6 HTTP/1.1 connections per origin; with many tabs SSE can starve requests. Mitigation: serve over HTTP/2 (Caddy in front) and share one stream across tabs via `BroadcastChannel`.
7. **Single server**: one EC2 box is a single point of failure. Backups plus restore-verify limit data loss; downtime risk is accepted at this scale and published.
8. **Full-text search quality**: Postgres FTS is good enough for titles and descriptions but lacks typo tolerance. `pg_trgm` can be added later without new infrastructure.
9. **Email deliverability**: magic-link login depends on it. SES with SPF/DKIM/DMARC set up is part of the deploy guide.
10. **Clean-room**: no code, icons or visual style copied from Linear, Plane or Jira. Plane is AGPL, so its code must not be read for implementation detail. Original colour palette and layout.
11. **Product name** (Decision 3): needed before public launch, domain purchase and README.

## 10. As built (Milestone 1)

- Exports are a streamed `.tar.gz` (workspace.json, issues.csv, comments.csv, attachments/), not a zip: streaming tar has no 4 GB limit and needs no dependency. CSV cells starting with `= + - @` are prefixed to stop formula injection.
- The server ships as one tsup bundle, so the runtime Docker image has no `node_modules` (node:22-alpine + pg client tools + ~3.5 MB of JS).
- Background jobs: pg-boss queues `export.workspace`, `workspace.delete`, `notifications.digest` (every 15 min, honours hourly/daily per user), `maintenance.cleanup` (hourly) and `backup.run` (cron, when `BACKUP_ENABLED`). Jobs are enqueued after the request transaction commits.
- Backups: `node dist/backup.js` or the scheduled job writes `backups/tracker-<timestamp>.dump`; `node dist/restore-verify.js` restores the newest into a scratch database, runs sanity checks and drops it (exit code 1 on failure, for cron alerts).
- Docker was not available on the build machine, so the image and `docker compose up` are verified in CI (the `docker` job boots the stack and checks `/ready`), not locally.
