import { type Kysely, sql } from "kysely";

/** Milestone 4: API tokens, outgoing webhooks, linked pull requests and GitHub settings. */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
CREATE TABLE api_tokens (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name text NOT NULL,
  token_hash text NOT NULL UNIQUE,
  token_prefix text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz,
  expires_at timestamptz,
  revoked_at timestamptz
);
CREATE INDEX ON api_tokens (workspace_id, user_id);

CREATE TABLE webhooks (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  url text NOT NULL,
  secret text NOT NULL,
  events text[] NOT NULL,
  active boolean NOT NULL DEFAULT true,
  consecutive_failures integer NOT NULL DEFAULT 0,
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON webhooks (workspace_id);

CREATE TABLE webhook_deliveries (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  webhook_id uuid NOT NULL REFERENCES webhooks(id) ON DELETE CASCADE,
  event text NOT NULL,
  payload jsonb NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'succeeded', 'failed')),
  attempts integer NOT NULL DEFAULT 0,
  response_status integer,
  error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  delivered_at timestamptz
);
CREATE INDEX ON webhook_deliveries (webhook_id, created_at DESC);

CREATE TABLE issue_links (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  issue_id uuid NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
  provider text NOT NULL CHECK (provider IN ('github')),
  url text NOT NULL,
  title text NOT NULL,
  state text NOT NULL CHECK (state IN ('open', 'closed', 'merged')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (issue_id, url)
);

CREATE TABLE github_integrations (
  workspace_id uuid PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
  secret text NOT NULL,
  move_on_merge boolean NOT NULL DEFAULT true,
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
`.execute(db);
  for (const t of ["api_tokens", "webhooks", "webhook_deliveries", "issue_links", "github_integrations"]) {
    await sql
      .raw(`
ALTER TABLE ${t} ENABLE ROW LEVEL SECURITY;
ALTER TABLE ${t} FORCE ROW LEVEL SECURITY;
CREATE POLICY system_all ON ${t} TO glasstrack_system USING (true) WITH CHECK (true);
CREATE POLICY tenant ON ${t} TO glasstrack_app USING (workspace_id = app.ws()) WITH CHECK (workspace_id = app.ws());
GRANT SELECT, INSERT, UPDATE, DELETE ON ${t} TO glasstrack_app;
GRANT ALL ON ${t} TO glasstrack_system;
`)
      .execute(db);
  }
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP TABLE IF EXISTS github_integrations, issue_links, webhook_deliveries, webhooks, api_tokens CASCADE;`.execute(db);
}
