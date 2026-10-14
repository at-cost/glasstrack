import { type Kysely, sql } from "kysely";

/**
 * Milestone 2: credits and billing (hosted mode). Ledger and payment rows have
 * no foreign key to workspaces on purpose: they are kept, without personal
 * data, after a workspace is deleted, because financial records must be.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
CREATE TABLE pricing_config (
  id serial PRIMARY KEY,
  effective_from timestamptz NOT NULL DEFAULT now(),
  monthly_price_micro bigint NOT NULL CHECK (monthly_price_micro >= 0),
  reason text NOT NULL,
  created_by text NOT NULL DEFAULT 'system'
);

-- The price can only ever go down, and history can't be rewritten.
CREATE FUNCTION app.pricing_never_increases() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE cur bigint;
BEGIN
  SELECT monthly_price_micro INTO cur FROM pricing_config ORDER BY id DESC LIMIT 1;
  IF cur IS NOT NULL AND NEW.monthly_price_micro > cur THEN
    RAISE EXCEPTION 'price can only go down (current %, new %)', cur, NEW.monthly_price_micro;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER pricing_never_increases BEFORE INSERT ON pricing_config
  FOR EACH ROW EXECUTE FUNCTION app.pricing_never_increases();
CREATE TRIGGER pricing_append_only BEFORE UPDATE OR DELETE ON pricing_config
  FOR EACH ROW EXECUTE FUNCTION app.reject_change();

CREATE TABLE credit_ledger (
  id bigserial PRIMARY KEY,
  workspace_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('starter_grant', 'topup', 'charge', 'storage_charge', 'refund', 'adjustment')),
  amount_micro bigint NOT NULL,
  idempotency_key text NOT NULL UNIQUE,
  ref_type text,
  ref_id text,
  memo text,
  created_by text NOT NULL DEFAULT 'system',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX credit_ledger_ws ON credit_ledger (workspace_id, id) INCLUDE (amount_micro, kind);
CREATE TRIGGER ledger_append_only BEFORE UPDATE OR DELETE ON credit_ledger
  FOR EACH ROW EXECUTE FUNCTION app.reject_change();

CREATE TABLE billing_accounts (
  workspace_id uuid PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
  stripe_customer_id text,
  default_payment_method text,
  card_label text,
  auto_topup_enabled boolean NOT NULL DEFAULT false,
  auto_topup_threshold_micro bigint NOT NULL DEFAULT 2000000,
  auto_topup_amount_micro bigint NOT NULL DEFAULT 20000000,
  grace_started_at timestamptz,
  warnings_sent integer NOT NULL DEFAULT 0,
  last_charged_on date,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE payments (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('topup', 'auto_topup')),
  stripe_checkout_session_id text UNIQUE,
  stripe_payment_intent_id text UNIQUE,
  amount_micro bigint NOT NULL,
  fee_micro bigint,
  net_micro bigint,
  currency text NOT NULL DEFAULT 'usd',
  status text NOT NULL CHECK (status IN ('pending', 'succeeded', 'failed', 'refunded')),
  created_at timestamptz NOT NULL DEFAULT now(),
  succeeded_at timestamptz
);
CREATE INDEX payments_ws ON payments (workspace_id, created_at DESC);
CREATE INDEX payments_missing_fee ON payments (succeeded_at) WHERE status = 'succeeded' AND fee_micro IS NULL;

-- Farming limits: one starter grant per verified email (stored hashed) and a cap per domain.
CREATE TABLE starter_credit_claims (
  id uuid PRIMARY KEY,
  email_hash text NOT NULL UNIQUE,
  domain text NOT NULL,
  workspace_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX starter_claims_domain ON starter_credit_claims (domain, created_at);

CREATE TABLE stripe_events (
  event_id text PRIMARY KEY,
  type text NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  processed_at timestamptz
);
`.execute(db);

  // starter_credit_claims is system-only (no grants to the app role) but still gets RLS,
  // so every table with a workspace_id column is covered.
  for (const t of ["credit_ledger", "billing_accounts", "payments", "starter_credit_claims"]) {
    await sql
      .raw(`
ALTER TABLE ${t} ENABLE ROW LEVEL SECURITY;
ALTER TABLE ${t} FORCE ROW LEVEL SECURITY;
CREATE POLICY system_all ON ${t} TO glasstrack_system USING (true) WITH CHECK (true);
CREATE POLICY tenant ON ${t} TO glasstrack_app USING (workspace_id = app.ws()) WITH CHECK (workspace_id = app.ws());
${t === "starter_credit_claims" ? "" : `GRANT SELECT ON ${t} TO glasstrack_app;`}
`)
      .execute(db);
  }
  await sql`
GRANT UPDATE (auto_topup_enabled, auto_topup_threshold_micro, auto_topup_amount_micro, updated_at) ON billing_accounts TO glasstrack_app;
GRANT SELECT ON pricing_config TO glasstrack_app;
GRANT ALL ON pricing_config, credit_ledger, billing_accounts, payments, starter_credit_claims, stripe_events TO glasstrack_system;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO glasstrack_system;
`.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`
DROP TABLE IF EXISTS stripe_events, starter_credit_claims, payments, billing_accounts, credit_ledger, pricing_config CASCADE;
DROP FUNCTION IF EXISTS app.pricing_never_increases();
`.execute(db);
}
