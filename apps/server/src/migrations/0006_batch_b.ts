import { type Kysely, sql } from "kysely";

/** Timeline start dates, and automation rules with their run log. */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
ALTER TABLE issues ADD COLUMN start_date date;
ALTER TABLE issues ADD CONSTRAINT issues_start_before_due CHECK (start_date IS NULL OR due_date IS NULL OR start_date <= due_date);
CREATE INDEX issues_timeline ON issues (workspace_id, team_id, start_date, due_date) WHERE start_date IS NOT NULL OR due_date IS NOT NULL;

CREATE TABLE automation_rules (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  team_id uuid REFERENCES teams(id) ON DELETE CASCADE,
  name text NOT NULL,
  enabled boolean NOT NULL DEFAULT true,
  trigger text NOT NULL CHECK (trigger IN ('issue_created', 'status_changed', 'label_added', 'priority_changed', 'assignees_changed', 'comment_added', 'due_date_passed', 'no_activity')),
  trigger_config jsonb NOT NULL DEFAULT '{}',
  conditions jsonb NOT NULL DEFAULT '{}',
  actions jsonb NOT NULL,
  run_count integer NOT NULL DEFAULT 0,
  last_run_at timestamptz,
  last_error text,
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX automation_rules_trigger ON automation_rules (workspace_id, trigger) WHERE enabled;

CREATE TABLE automation_runs (
  id bigserial PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  rule_id uuid NOT NULL REFERENCES automation_rules(id) ON DELETE CASCADE,
  issue_id uuid REFERENCES issues(id) ON DELETE SET NULL,
  status text NOT NULL CHECK (status IN ('ok', 'error')),
  detail jsonb NOT NULL DEFAULT '{}',
  -- Scheduled triggers fire once per issue per occasion (e.g. "due:2026-10-15").
  run_key text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON automation_runs (rule_id, id DESC);
CREATE UNIQUE INDEX automation_runs_once ON automation_runs (rule_id, issue_id, run_key) WHERE run_key IS NOT NULL;
`.execute(db);
  for (const t of ["automation_rules", "automation_runs"]) {
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
  await sql`GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO glasstrack_app, glasstrack_system;`.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`
DROP TABLE IF EXISTS automation_runs, automation_rules CASCADE;
DROP INDEX IF EXISTS issues_timeline;
ALTER TABLE issues DROP CONSTRAINT IF EXISTS issues_start_before_due;
ALTER TABLE issues DROP COLUMN IF EXISTS start_date;
`.execute(db);
}
