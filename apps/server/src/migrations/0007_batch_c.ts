import { type Kysely, sql } from "kysely";

/**
 * Private teams, free read-only viewers, GitLab and Gitea/Forgejo webhooks,
 * public request forms and email-to-issue inboxes.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
ALTER TABLE workspace_members DROP CONSTRAINT workspace_members_role_check;
ALTER TABLE workspace_members ADD CONSTRAINT workspace_members_role_check CHECK (role IN ('admin', 'member', 'guest', 'viewer'));
ALTER TABLE invites DROP CONSTRAINT invites_role_check;
ALTER TABLE invites ADD CONSTRAINT invites_role_check CHECK (role IN ('admin', 'member', 'guest', 'viewer'));

ALTER TABLE teams ADD COLUMN private boolean NOT NULL DEFAULT false;

ALTER TABLE issue_links DROP CONSTRAINT issue_links_provider_check;
ALTER TABLE issue_links ADD CONSTRAINT issue_links_provider_check CHECK (provider IN ('github', 'gitlab', 'gitea'));

CREATE TABLE git_integrations (
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  provider text NOT NULL CHECK (provider IN ('gitlab', 'gitea')),
  secret text NOT NULL,
  move_on_merge boolean NOT NULL DEFAULT true,
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, provider)
);

-- Public request forms (/forms/:token) and email inboxes (<token>@inbound domain).
CREATE TABLE intake_channels (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  team_id uuid NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('form', 'email')),
  token text NOT NULL UNIQUE,
  name text NOT NULL,
  intro text NOT NULL DEFAULT '',
  enabled boolean NOT NULL DEFAULT true,
  status_id uuid REFERENCES workflow_states(id) ON DELETE SET NULL,
  label_ids uuid[] NOT NULL DEFAULT '{}',
  -- form: 'optional' | 'required' email; email inbox: 'anyone' | 'members' may send.
  require_email boolean NOT NULL DEFAULT false,
  members_only boolean NOT NULL DEFAULT false,
  notify_submitter boolean NOT NULL DEFAULT true,
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON intake_channels (workspace_id, team_id);

-- Who asked, so they can be told when the issue is resolved.
CREATE TABLE intake_submissions (
  issue_id uuid PRIMARY KEY REFERENCES issues(id) ON DELETE CASCADE,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  channel_id uuid REFERENCES intake_channels(id) ON DELETE SET NULL,
  submitter_email text,
  submitter_name text,
  message_id text,
  resolved_notified_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX intake_submissions_pending ON intake_submissions (workspace_id) WHERE submitter_email IS NOT NULL AND resolved_notified_at IS NULL;
`.execute(db);
  for (const t of ["git_integrations", "intake_channels", "intake_submissions"]) {
    await sql
      .raw(`
ALTER TABLE ${t} ENABLE ROW LEVEL SECURITY;
ALTER TABLE ${t} FORCE ROW LEVEL SECURITY;
CREATE POLICY system_all ON ${t} TO glasstrack_system USING (true) WITH CHECK (true);
CREATE POLICY tenant ON ${t} TO glasstrack_app USING (workspace_id = app.ws()) WITH CHECK (workspace_id = app.ws());
GRANT ALL ON ${t} TO glasstrack_system;
GRANT SELECT, INSERT, UPDATE, DELETE ON ${t} TO glasstrack_app;
`)
      .execute(db);
  }
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`
DROP TABLE IF EXISTS intake_submissions, intake_channels, git_integrations CASCADE;
DELETE FROM issue_links WHERE provider <> 'github';
ALTER TABLE issue_links DROP CONSTRAINT issue_links_provider_check;
ALTER TABLE issue_links ADD CONSTRAINT issue_links_provider_check CHECK (provider IN ('github'));
ALTER TABLE teams DROP COLUMN IF EXISTS private;
UPDATE workspace_members SET role = 'guest' WHERE role = 'viewer';
DELETE FROM invites WHERE role = 'viewer';
ALTER TABLE workspace_members DROP CONSTRAINT workspace_members_role_check;
ALTER TABLE workspace_members ADD CONSTRAINT workspace_members_role_check CHECK (role IN ('admin', 'member', 'guest'));
ALTER TABLE invites DROP CONSTRAINT invites_role_check;
ALTER TABLE invites ADD CONSTRAINT invites_role_check CHECK (role IN ('admin', 'member', 'guest'));
`.execute(db);
}
