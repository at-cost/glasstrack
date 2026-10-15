import { type Kysely, sql } from "kysely";

/**
 * Pay-as-you-go at cost (replaces the flat monthly price), public finances
 * independent of billing, and a cookie-less page view counter for the website.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
-- Versioned, append-only pricing settings (see packages/shared/src/money/pricing.ts).
CREATE TABLE pricing_settings (
  id serial PRIMARY KEY,
  effective_from timestamptz NOT NULL DEFAULT now(),
  signup_credit_usd numeric(12, 4) NOT NULL CHECK (signup_credit_usd >= 0),
  server_share_cap_usd numeric(12, 4) NOT NULL CHECK (server_share_cap_usd >= 0),
  fee_markup numeric(8, 4) NOT NULL CHECK (fee_markup >= 0 AND fee_markup <= 1),
  min_topup_usd numeric(12, 2) NOT NULL CHECK (min_topup_usd >= 1),
  max_topup_usd numeric(12, 2) NOT NULL CHECK (max_topup_usd >= min_topup_usd),
  storage_usd_per_gb_month numeric(12, 6) NOT NULL CHECK (storage_usd_per_gb_month >= 0),
  email_usd_per_thousand numeric(12, 6) NOT NULL CHECK (email_usd_per_thousand >= 0),
  stripe_fee_percent numeric(8, 6) NOT NULL CHECK (stripe_fee_percent >= 0),
  stripe_fee_fixed_usd numeric(12, 4) NOT NULL CHECK (stripe_fee_fixed_usd >= 0),
  reserve_target_months numeric(6, 2) NOT NULL CHECK (reserve_target_months >= 0),
  reason text NOT NULL,
  created_by text NOT NULL DEFAULT 'system'
);
-- The server share cap can only ever go down, and history can't be rewritten.
CREATE FUNCTION app.cap_never_increases() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE cur numeric;
BEGIN
  SELECT server_share_cap_usd INTO cur FROM pricing_settings ORDER BY id DESC LIMIT 1;
  IF cur IS NOT NULL AND NEW.server_share_cap_usd > cur THEN
    RAISE EXCEPTION 'server share cap can only go down (current %, new %)', cur, NEW.server_share_cap_usd;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER cap_never_increases BEFORE INSERT ON pricing_settings FOR EACH ROW EXECUTE FUNCTION app.cap_never_increases();
CREATE TRIGGER pricing_settings_append_only BEFORE UPDATE OR DELETE ON pricing_settings FOR EACH ROW EXECUTE FUNCTION app.reject_change();
INSERT INTO pricing_settings (signup_credit_usd, server_share_cap_usd, fee_markup, min_topup_usd, max_topup_usd, storage_usd_per_gb_month,
  email_usd_per_thousand, stripe_fee_percent, stripe_fee_fixed_usd, reserve_target_months, reason)
VALUES (10, 5, 0.2, 10, 500, 0.023, 0.10, 0.0315, 0.27, 3, 'Pay-as-you-go launch settings');

ALTER TABLE billing_accounts
  ADD COLUMN monthly_cap_micro bigint CHECK (monthly_cap_micro IS NULL OR monthly_cap_micro > 0),
  ADD COLUMN last_credit_micro bigint NOT NULL DEFAULT 0,
  ADD COLUMN low_balance_notified boolean NOT NULL DEFAULT false,
  ADD COLUMN refund_requested_at timestamptz;

GRANT UPDATE (monthly_cap_micro) ON billing_accounts TO glasstrack_app;

ALTER TABLE cost_entries ADD COLUMN paid_by_credits boolean NOT NULL DEFAULT false;

-- What each workspace was charged for a day (one row per charged day).
ALTER TABLE workspace_cost_daily ADD COLUMN active boolean NOT NULL DEFAULT true;

-- Public log of changes that made running Glasstrack cheaper.
CREATE TABLE cost_savings (
  id uuid PRIMARY KEY,
  day date NOT NULL,
  change text NOT NULL,
  saving_month_micro bigint NOT NULL CHECK (saving_month_micro >= 0),
  created_by text NOT NULL DEFAULT 'system',
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE finance_daily
  ADD COLUMN shared_fixed_micro bigint NOT NULL DEFAULT 0,
  ADD COLUMN credit_held_micro bigint NOT NULL DEFAULT 0,
  ADD COLUMN founder_gap_micro bigint NOT NULL DEFAULT 0,
  ADD COLUMN server_share_cap_micro bigint NOT NULL DEFAULT 0,
  ADD COLUMN recommended_cap_micro bigint,
  ADD COLUMN costs_paid_by_credits jsonb NOT NULL DEFAULT '[]';
ALTER TABLE finance_daily ALTER COLUMN price_micro SET DEFAULT 0, ALTER COLUMN margin_bp SET DEFAULT 0;

-- Website analytics: page, day and referring site only. No IPs, no cookies, no user ids.
CREATE TABLE page_views (
  day date NOT NULL,
  path text NOT NULL,
  referrer_host text NOT NULL DEFAULT '',
  views integer NOT NULL DEFAULT 0,
  PRIMARY KEY (day, path, referrer_host)
);

GRANT ALL ON pricing_settings, cost_savings, page_views TO glasstrack_system;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO glasstrack_system;
`.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`
DROP TABLE IF EXISTS page_views, cost_savings;
DROP TRIGGER IF EXISTS cap_never_increases ON pricing_settings;
DROP TRIGGER IF EXISTS pricing_settings_append_only ON pricing_settings;
DROP TABLE IF EXISTS pricing_settings;
DROP FUNCTION IF EXISTS app.cap_never_increases();
ALTER TABLE billing_accounts DROP COLUMN IF EXISTS monthly_cap_micro, DROP COLUMN IF EXISTS last_credit_micro,
  DROP COLUMN IF EXISTS low_balance_notified, DROP COLUMN IF EXISTS refund_requested_at;
ALTER TABLE cost_entries DROP COLUMN IF EXISTS paid_by_credits;
ALTER TABLE workspace_cost_daily DROP COLUMN IF EXISTS active;
ALTER TABLE finance_daily DROP COLUMN IF EXISTS shared_fixed_micro, DROP COLUMN IF EXISTS credit_held_micro, DROP COLUMN IF EXISTS founder_gap_micro,
  DROP COLUMN IF EXISTS server_share_cap_micro, DROP COLUMN IF EXISTS recommended_cap_micro, DROP COLUMN IF EXISTS costs_paid_by_credits;
`.execute(db);
}
