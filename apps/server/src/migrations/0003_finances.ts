import { type Kysely, sql } from "kysely";

/** Milestone 3: usage metering, cost inputs and the public daily finances roll-up. */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
CREATE TABLE usage_daily (
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  day date NOT NULL,
  active_members integer NOT NULL DEFAULT 0,
  storage_bytes bigint NOT NULL DEFAULT 0,
  emails_sent integer NOT NULL DEFAULT 0,
  api_requests integer NOT NULL DEFAULT 0,
  PRIMARY KEY (workspace_id, day)
);
CREATE INDEX usage_daily_day ON usage_daily (day);

CREATE TABLE workspace_cost_daily (
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  day date NOT NULL,
  shared_micro bigint NOT NULL,
  storage_micro bigint NOT NULL,
  email_micro bigint NOT NULL,
  fees_micro bigint NOT NULL,
  total_micro bigint NOT NULL,
  PRIMARY KEY (workspace_id, day)
);

-- Operating costs. Payment fees are not entered here; they come from payments.fee_micro.
CREATE TABLE cost_entries (
  id uuid PRIMARY KEY,
  period_start date NOT NULL,
  period_end date NOT NULL,
  category text NOT NULL CHECK (category IN ('infrastructure', 'email', 'storage', 'domain', 'tools', 'ai', 'other')),
  source text NOT NULL CHECK (source IN ('aws', 'manual')),
  amount_micro bigint NOT NULL CHECK (amount_micro >= 0),
  public_label text NOT NULL,
  note text,
  external_key text UNIQUE,
  created_by text NOT NULL DEFAULT 'system',
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (period_start <= period_end)
);
CREATE INDEX cost_entries_period ON cost_entries (period_start, period_end);

-- Public: aggregates only, never a workspace id, name or slug.
CREATE TABLE finance_daily (
  day date PRIMARY KEY,
  revenue_micro bigint NOT NULL,
  starter_used_micro bigint NOT NULL,
  costs jsonb NOT NULL,
  payment_fees_micro bigint NOT NULL,
  total_cost_micro bigint NOT NULL,
  active_workspaces integer NOT NULL,
  paying_workspaces integer NOT NULL,
  cost_per_workspace_micro bigint NOT NULL,
  reserve_micro bigint NOT NULL,
  reserve_target_micro bigint NOT NULL,
  price_micro bigint NOT NULL,
  recommended_price_micro bigint,
  margin_bp integer NOT NULL,
  computed_at timestamptz NOT NULL DEFAULT now()
);
`.execute(db);
  for (const t of ["usage_daily", "workspace_cost_daily"]) {
    await sql
      .raw(`
ALTER TABLE ${t} ENABLE ROW LEVEL SECURITY;
ALTER TABLE ${t} FORCE ROW LEVEL SECURITY;
CREATE POLICY system_all ON ${t} TO glasstrack_system USING (true) WITH CHECK (true);
CREATE POLICY tenant ON ${t} TO glasstrack_app USING (workspace_id = app.ws()) WITH CHECK (workspace_id = app.ws());
GRANT SELECT ON ${t} TO glasstrack_app;
`)
      .execute(db);
  }
  await sql`
GRANT ALL ON usage_daily, workspace_cost_daily, cost_entries, finance_daily TO glasstrack_system;
`.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`DROP TABLE IF EXISTS finance_daily, cost_entries, workspace_cost_daily, usage_daily CASCADE;`.execute(db);
}
