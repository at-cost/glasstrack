import { type Kysely, sql } from "kysely";

/**
 * Multiple assignees, custom fields, time tracking, issue templates, recurring
 * issues, audit log and per-workspace OIDC single sign-on.
 */

const TENANT = [
  "issue_assignees",
  "custom_fields",
  "issue_field_values",
  "time_entries",
  "active_timers",
  "issue_templates",
  "recurring_issues",
  "audit_log",
  "sso_configs",
] as const;

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
-- Multiple assignees replace issues.assignee_id.
CREATE TABLE issue_assignees (
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  issue_id uuid NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (issue_id, user_id)
);
CREATE INDEX ON issue_assignees (workspace_id, user_id);
INSERT INTO issue_assignees (workspace_id, issue_id, user_id)
  SELECT workspace_id, id, assignee_id FROM issues WHERE assignee_id IS NOT NULL;
DROP INDEX IF EXISTS issues_workspace_id_assignee_id_idx;
ALTER TABLE issues DROP COLUMN assignee_id;

CREATE TABLE custom_fields (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  team_id uuid REFERENCES teams(id) ON DELETE CASCADE,
  name text NOT NULL,
  type text NOT NULL CHECK (type IN ('text', 'number', 'select', 'multi_select', 'date', 'checkbox', 'url', 'user')),
  options jsonb NOT NULL DEFAULT '[]',
  position double precision NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  archived_at timestamptz
);
CREATE UNIQUE INDEX custom_fields_unique_name ON custom_fields
  (workspace_id, coalesce(team_id, '00000000-0000-0000-0000-000000000000'::uuid), lower(name)) WHERE archived_at IS NULL;

CREATE TABLE issue_field_values (
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  issue_id uuid NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
  field_id uuid NOT NULL REFERENCES custom_fields(id) ON DELETE CASCADE,
  value jsonb NOT NULL,
  PRIMARY KEY (issue_id, field_id)
);
CREATE INDEX ON issue_field_values (field_id);

CREATE TABLE time_entries (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  issue_id uuid NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
  user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  spent_on date NOT NULL,
  minutes integer NOT NULL CHECK (minutes > 0 AND minutes <= 1440),
  note text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON time_entries (issue_id);
CREATE INDEX ON time_entries (workspace_id, spent_on);

-- One running timer per person per workspace.
CREATE TABLE active_timers (
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  issue_id uuid NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
  started_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, user_id)
);

CREATE TABLE issue_templates (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  team_id uuid NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  name text NOT NULL,
  title text NOT NULL,
  description_md text NOT NULL DEFAULT '',
  status_id uuid REFERENCES workflow_states(id) ON DELETE SET NULL,
  priority smallint NOT NULL DEFAULT 0 CHECK (priority BETWEEN 0 AND 4),
  label_ids uuid[] NOT NULL DEFAULT '{}',
  assignee_ids uuid[] NOT NULL DEFAULT '{}',
  estimate numeric(6, 2),
  field_values jsonb NOT NULL DEFAULT '{}',
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON issue_templates (workspace_id, team_id);

CREATE TABLE recurring_issues (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  template_id uuid NOT NULL REFERENCES issue_templates(id) ON DELETE CASCADE,
  frequency text NOT NULL CHECK (frequency IN ('daily', 'weekly', 'monthly', 'yearly')),
  interval integer NOT NULL DEFAULT 1 CHECK (interval BETWEEN 1 AND 365),
  weekdays smallint[] NOT NULL DEFAULT '{}',
  month_day smallint CHECK (month_day BETWEEN 1 AND 31),
  hour smallint NOT NULL DEFAULT 9 CHECK (hour BETWEEN 0 AND 23),
  timezone text NOT NULL DEFAULT 'UTC',
  starts_on date NOT NULL,
  next_run_at timestamptz NOT NULL,
  last_run_at timestamptz,
  last_issue_id uuid REFERENCES issues(id) ON DELETE SET NULL,
  active boolean NOT NULL DEFAULT true,
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX recurring_due ON recurring_issues (next_run_at) WHERE active;

CREATE TABLE audit_log (
  id bigserial PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  actor_id uuid REFERENCES users(id) ON DELETE SET NULL,
  actor_label text NOT NULL,
  action text NOT NULL,
  target_type text,
  target_id text,
  data jsonb NOT NULL DEFAULT '{}',
  ip text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON audit_log (workspace_id, id DESC);
CREATE TRIGGER audit_log_append_only BEFORE UPDATE ON audit_log
  FOR EACH ROW EXECUTE FUNCTION app.reject_change();

CREATE TABLE sso_configs (
  workspace_id uuid PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
  issuer text NOT NULL,
  client_id text NOT NULL,
  client_secret_enc text NOT NULL,
  allowed_domains text[] NOT NULL DEFAULT '{}',
  auto_join_role text CHECK (auto_join_role IN ('member', 'guest')),
  enforce boolean NOT NULL DEFAULT false,
  enabled boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- How a session signed in, so "SSO only" workspaces can tell.
ALTER TABLE sessions ADD COLUMN auth_method text NOT NULL DEFAULT 'unknown';
ALTER TABLE sessions ADD COLUMN sso_workspace_id uuid REFERENCES workspaces(id) ON DELETE SET NULL;
`.execute(db);

  for (const t of TENANT) {
    await sql
      .raw(`
ALTER TABLE ${t} ENABLE ROW LEVEL SECURITY;
ALTER TABLE ${t} FORCE ROW LEVEL SECURITY;
CREATE POLICY system_all ON ${t} TO glasstrack_system USING (true) WITH CHECK (true);
CREATE POLICY tenant ON ${t} TO glasstrack_app USING (workspace_id = app.ws()) WITH CHECK (workspace_id = app.ws());
GRANT ALL ON ${t} TO glasstrack_system;
`)
      .execute(db);
  }
  await sql`
GRANT SELECT, INSERT, UPDATE, DELETE ON issue_assignees, custom_fields, issue_field_values, time_entries, active_timers,
  issue_templates, recurring_issues TO glasstrack_app;
-- The audit log is append-only for the app; SSO secrets are only readable by the system role.
GRANT SELECT, INSERT ON audit_log TO glasstrack_app;
GRANT SELECT (workspace_id, issuer, client_id, allowed_domains, auto_join_role, enforce, enabled, created_at, updated_at) ON sso_configs TO glasstrack_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO glasstrack_app, glasstrack_system;
`.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`
ALTER TABLE sessions DROP COLUMN IF EXISTS sso_workspace_id, DROP COLUMN IF EXISTS auth_method;
ALTER TABLE issues ADD COLUMN assignee_id uuid REFERENCES users(id) ON DELETE SET NULL;
UPDATE issues i SET assignee_id = (SELECT a.user_id FROM issue_assignees a WHERE a.issue_id = i.id ORDER BY a.created_at LIMIT 1);
CREATE INDEX ON issues (workspace_id, assignee_id);
DROP TABLE IF EXISTS sso_configs, audit_log, recurring_issues, issue_templates, active_timers, time_entries,
  issue_field_values, custom_fields, issue_assignees CASCADE;
`.execute(db);
}
