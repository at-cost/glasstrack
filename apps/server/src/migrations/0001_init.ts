import { type Kysely, sql } from "kysely";

/**
 * Core schema for Milestone 1.
 *
 * Tenant tables carry workspace_id and are protected by row-level security:
 * - tracker_app (HTTP requests) sees only rows of app.workspace_id, a
 *   transaction-local setting written by app.enter_workspace() after a
 *   membership check.
 * - tracker_system (jobs, auth) has an explicit allow-all policy instead of
 *   BYPASSRLS, so the same setup works on managed Postgres such as RDS.
 */

const TENANT_TABLES = [
  "workspace_members",
  "invites",
  "teams",
  "team_key_aliases",
  "team_members",
  "workflow_states",
  "labels",
  "cycles",
  "issues",
  "issue_labels",
  "issue_relations",
  "issue_subscribers",
  "comments",
  "activity",
  "attachments",
  "saved_views",
  "notifications",
  "notification_settings",
  "exports",
] as const;

export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
CREATE EXTENSION IF NOT EXISTS citext;
CREATE SCHEMA IF NOT EXISTS app;

CREATE FUNCTION app.uid() RETURNS uuid LANGUAGE sql STABLE AS
  $$ SELECT nullif(current_setting('app.user_id', true), '')::uuid $$;
CREATE FUNCTION app.ws() RETURNS uuid LANGUAGE sql STABLE AS
  $$ SELECT nullif(current_setting('app.workspace_id', true), '')::uuid $$;

-- ───────────── global tables ─────────────
CREATE TABLE users (
  id uuid PRIMARY KEY,
  email citext NOT NULL UNIQUE,
  name text NOT NULL,
  avatar_url text,
  email_verified_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);

CREATE TABLE auth_identities (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider text NOT NULL CHECK (provider IN ('google', 'github')),
  provider_user_id text NOT NULL,
  email citext,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (provider, provider_user_id)
);
CREATE INDEX ON auth_identities (user_id);

CREATE TABLE magic_links (
  id uuid PRIMARY KEY,
  email citext NOT NULL,
  token_hash text NOT NULL UNIQUE,
  redirect_to text,
  expires_at timestamptz NOT NULL,
  used_at timestamptz,
  ip text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON magic_links (email, created_at);

CREATE TABLE sessions (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash text NOT NULL UNIQUE,
  user_agent text,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL
);
CREATE INDEX ON sessions (user_id);

CREATE TABLE workspaces (
  id uuid PRIMARY KEY,
  slug citext NOT NULL UNIQUE,
  name text NOT NULL,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'grace', 'read_only', 'deleting')),
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- ───────────── tenant tables ─────────────
CREATE TABLE workspace_members (
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role text NOT NULL CHECK (role IN ('admin', 'member', 'guest')),
  joined_at timestamptz NOT NULL DEFAULT now(),
  last_active_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, user_id)
);
CREATE INDEX ON workspace_members (user_id);

CREATE TABLE invites (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  email citext,
  token_hash text NOT NULL UNIQUE,
  role text NOT NULL CHECK (role IN ('admin', 'member', 'guest')),
  invited_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  accepted_at timestamptz,
  revoked_at timestamptz
);
CREATE INDEX ON invites (workspace_id);

CREATE TABLE teams (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  key text NOT NULL,
  name text NOT NULL,
  issue_counter integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  archived_at timestamptz,
  UNIQUE (workspace_id, key)
);

CREATE TABLE team_key_aliases (
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  key text NOT NULL,
  team_id uuid NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  PRIMARY KEY (workspace_id, key)
);

CREATE TABLE team_members (
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  team_id uuid NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  PRIMARY KEY (team_id, user_id)
);
CREATE INDEX ON team_members (workspace_id, user_id);

CREATE TABLE workflow_states (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  team_id uuid NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  name text NOT NULL,
  category text NOT NULL CHECK (category IN ('backlog', 'unstarted', 'started', 'completed', 'canceled')),
  color text NOT NULL,
  position double precision NOT NULL,
  UNIQUE (team_id, name)
);
CREATE INDEX ON workflow_states (team_id, position);

CREATE TABLE labels (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  team_id uuid REFERENCES teams(id) ON DELETE CASCADE,
  name text NOT NULL,
  color text NOT NULL
);
CREATE UNIQUE INDEX labels_unique_name ON labels
  (workspace_id, coalesce(team_id, '00000000-0000-0000-0000-000000000000'::uuid), lower(name));

CREATE TABLE cycles (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  team_id uuid NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  number integer NOT NULL,
  name text,
  starts_on date NOT NULL,
  ends_on date NOT NULL,
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (team_id, number),
  CHECK (starts_on <= ends_on)
);

CREATE TABLE issues (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  team_id uuid NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  number integer NOT NULL,
  title text NOT NULL,
  description_md text NOT NULL DEFAULT '',
  status_id uuid NOT NULL REFERENCES workflow_states(id),
  priority smallint NOT NULL DEFAULT 0 CHECK (priority BETWEEN 0 AND 4),
  assignee_id uuid REFERENCES users(id) ON DELETE SET NULL,
  creator_id uuid REFERENCES users(id) ON DELETE SET NULL,
  parent_id uuid REFERENCES issues(id) ON DELETE SET NULL,
  cycle_id uuid REFERENCES cycles(id) ON DELETE SET NULL,
  due_date date,
  estimate numeric(6, 2),
  sort_key text NOT NULL COLLATE "C",
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  completed_at timestamptz,
  canceled_at timestamptz,
  archived_at timestamptz,
  search tsvector GENERATED ALWAYS AS (
    setweight(to_tsvector('simple', coalesce(title, '')), 'A') ||
    setweight(to_tsvector('simple', coalesce(description_md, '')), 'B')
  ) STORED,
  UNIQUE (team_id, number),
  CHECK (parent_id IS NULL OR parent_id <> id)
);
CREATE INDEX ON issues (workspace_id, team_id, status_id, sort_key);
CREATE INDEX ON issues (workspace_id, assignee_id);
CREATE INDEX ON issues (workspace_id, cycle_id);
CREATE INDEX ON issues (parent_id);
CREATE INDEX ON issues USING gin (search);

CREATE TABLE issue_labels (
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  issue_id uuid NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
  label_id uuid NOT NULL REFERENCES labels(id) ON DELETE CASCADE,
  PRIMARY KEY (issue_id, label_id)
);
CREATE INDEX ON issue_labels (label_id);

CREATE TABLE issue_relations (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  issue_id uuid NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
  related_issue_id uuid NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
  type text NOT NULL CHECK (type IN ('blocks', 'related', 'duplicate')),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (issue_id, related_issue_id, type),
  CHECK (issue_id <> related_issue_id)
);
CREATE INDEX ON issue_relations (related_issue_id);

CREATE TABLE issue_subscribers (
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  issue_id uuid NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  PRIMARY KEY (issue_id, user_id)
);

CREATE TABLE comments (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  issue_id uuid NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
  author_id uuid REFERENCES users(id) ON DELETE SET NULL,
  body_md text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  edited_at timestamptz,
  deleted_at timestamptz,
  search tsvector GENERATED ALWAYS AS (to_tsvector('simple', coalesce(body_md, ''))) STORED
);
CREATE INDEX ON comments (issue_id, created_at);
CREATE INDEX ON comments USING gin (search);

CREATE TABLE activity (
  id bigserial PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  issue_id uuid NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
  actor_id uuid REFERENCES users(id) ON DELETE SET NULL,
  kind text NOT NULL,
  data jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON activity (issue_id, id);

CREATE TABLE attachments (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  issue_id uuid NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
  uploader_id uuid REFERENCES users(id) ON DELETE SET NULL,
  storage_key text NOT NULL,
  filename text NOT NULL,
  content_type text NOT NULL,
  size_bytes bigint NOT NULL,
  uploaded_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);
CREATE INDEX ON attachments (issue_id);
CREATE INDEX ON attachments (workspace_id) WHERE deleted_at IS NULL;

CREATE TABLE saved_views (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  team_id uuid REFERENCES teams(id) ON DELETE CASCADE,
  owner_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name text NOT NULL,
  shared boolean NOT NULL DEFAULT false,
  layout text NOT NULL DEFAULT 'list' CHECK (layout IN ('list', 'board')),
  filters jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON saved_views (workspace_id, owner_id);

CREATE TABLE notifications (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  issue_id uuid NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
  kind text NOT NULL,
  actor_id uuid REFERENCES users(id) ON DELETE SET NULL,
  data jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(),
  read_at timestamptz,
  emailed_at timestamptz
);
CREATE INDEX ON notifications (workspace_id, user_id, created_at DESC);
CREATE INDEX notifications_unemailed ON notifications (created_at) WHERE emailed_at IS NULL AND read_at IS NULL;

CREATE TABLE notification_settings (
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  digest text NOT NULL DEFAULT 'daily' CHECK (digest IN ('off', 'hourly', 'daily')),
  events jsonb NOT NULL DEFAULT '{}',
  last_digest_at timestamptz,
  PRIMARY KEY (workspace_id, user_id)
);

CREATE TABLE exports (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  requested_by uuid REFERENCES users(id) ON DELETE SET NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'running', 'done', 'failed')),
  storage_key text,
  size_bytes bigint,
  error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz
);
CREATE INDEX ON exports (workspace_id, created_at DESC);
`.execute(db);

  // Row-level security on every tenant table.
  for (const t of TENANT_TABLES) {
    await sql
      .raw(`
ALTER TABLE ${t} ENABLE ROW LEVEL SECURITY;
ALTER TABLE ${t} FORCE ROW LEVEL SECURITY;
CREATE POLICY system_all ON ${t} TO tracker_system USING (true) WITH CHECK (true);
`)
      .execute(db);
  }
  for (const t of TENANT_TABLES.filter((t) => t !== "workspace_members")) {
    await sql
      .raw(`
CREATE POLICY tenant ON ${t} TO tracker_app
  USING (workspace_id = app.ws()) WITH CHECK (workspace_id = app.ws());
`)
      .execute(db);
  }

  await sql`
-- A user may list their own memberships across workspaces; everything else is per workspace.
CREATE POLICY tenant_read ON workspace_members FOR SELECT TO tracker_app
  USING (workspace_id = app.ws() OR user_id = app.uid());
CREATE POLICY tenant_insert ON workspace_members FOR INSERT TO tracker_app WITH CHECK (workspace_id = app.ws());
CREATE POLICY tenant_update ON workspace_members FOR UPDATE TO tracker_app
  USING (workspace_id = app.ws()) WITH CHECK (workspace_id = app.ws());
CREATE POLICY tenant_delete ON workspace_members FOR DELETE TO tracker_app USING (workspace_id = app.ws());

ALTER TABLE workspaces ENABLE ROW LEVEL SECURITY;
ALTER TABLE workspaces FORCE ROW LEVEL SECURITY;
CREATE POLICY system_all ON workspaces TO tracker_system USING (true) WITH CHECK (true);
CREATE POLICY member_read ON workspaces FOR SELECT TO tracker_app
  USING (id IN (SELECT workspace_id FROM workspace_members WHERE user_id = app.uid()));
CREATE POLICY current_update ON workspaces FOR UPDATE TO tracker_app
  USING (id = app.ws()) WITH CHECK (id = app.ws());

-- Users are visible to themselves and to members of the current workspace.
ALTER TABLE users ENABLE ROW LEVEL SECURITY;
ALTER TABLE users FORCE ROW LEVEL SECURITY;
CREATE POLICY system_all ON users TO tracker_system USING (true) WITH CHECK (true);
CREATE POLICY visible ON users FOR SELECT TO tracker_app USING (
  id = app.uid()
  OR id IN (SELECT user_id FROM workspace_members WHERE workspace_id = app.ws())
);
CREATE POLICY self_update ON users FOR UPDATE TO tracker_app USING (id = app.uid()) WITH CHECK (id = app.uid());

-- Grants
GRANT USAGE ON SCHEMA app TO tracker_app, tracker_system;
GRANT CREATE ON SCHEMA app TO tracker_system;
GRANT ALL ON ALL TABLES IN SCHEMA public TO tracker_system;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO tracker_app, tracker_system;
GRANT SELECT, INSERT, UPDATE, DELETE ON
  workspace_members, invites, teams, team_key_aliases, team_members, workflow_states, labels, cycles,
  issues, issue_labels, issue_relations, issue_subscribers, comments, attachments, saved_views,
  notifications, notification_settings, exports
  TO tracker_app;
GRANT SELECT, INSERT ON activity TO tracker_app;
GRANT SELECT ON workspaces, users TO tracker_app;
GRANT UPDATE (name) ON workspaces TO tracker_app;
GRANT UPDATE (name, avatar_url) ON users TO tracker_app;

-- Membership-checked entry into a workspace. Runs as tracker_system so it can
-- resolve the slug before app.workspace_id is set.
CREATE FUNCTION app.enter_workspace(p_slug text)
RETURNS TABLE (id uuid, slug text, name text, status text, role text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, app AS $$
DECLARE
  v_ws workspaces%ROWTYPE;
  v_role text;
BEGIN
  SELECT * INTO v_ws FROM workspaces w WHERE w.slug = p_slug;
  IF NOT FOUND THEN RAISE EXCEPTION 'workspace not found' USING ERRCODE = 'P0002'; END IF;
  SELECT m.role INTO v_role FROM workspace_members m
    WHERE m.workspace_id = v_ws.id AND m.user_id = app.uid();
  IF v_role IS NULL THEN RAISE EXCEPTION 'workspace not found' USING ERRCODE = 'P0002'; END IF;
  PERFORM set_config('app.workspace_id', v_ws.id::text, true);
  RETURN QUERY SELECT v_ws.id, v_ws.slug::text, v_ws.name, v_ws.status, v_role;
END $$;
ALTER FUNCTION app.enter_workspace(text) OWNER TO tracker_system;
REVOKE ALL ON FUNCTION app.enter_workspace(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.enter_workspace(text) TO tracker_app;

-- Activity is append-only for everyone but whole-workspace deletion.
CREATE FUNCTION app.reject_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION '% is append-only', TG_TABLE_NAME; END $$;
CREATE TRIGGER activity_no_update BEFORE UPDATE ON activity
  FOR EACH ROW EXECUTE FUNCTION app.reject_change();
`.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`
DROP TABLE IF EXISTS exports, notification_settings, notifications, saved_views, attachments, activity,
  comments, issue_subscribers, issue_relations, issue_labels, issues, cycles, labels, workflow_states,
  team_members, team_key_aliases, teams, invites, workspace_members, workspaces, sessions, magic_links,
  auth_identities, users CASCADE;
DROP SCHEMA IF EXISTS app CASCADE;
`.execute(db);
}
