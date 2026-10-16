import { type Kysely, sql } from "kysely";

/** Owner decision (16 Oct 2026): hold 6 months of running costs in reserve before the cap can come down. Cap unchanged. */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`
INSERT INTO pricing_settings (signup_credit_usd, server_share_cap_usd, fee_markup, min_topup_usd, max_topup_usd, storage_usd_per_gb_month,
  email_usd_per_thousand, stripe_fee_percent, stripe_fee_fixed_usd, reserve_target_months, reason, created_by)
SELECT signup_credit_usd, server_share_cap_usd, fee_markup, min_topup_usd, max_topup_usd, storage_usd_per_gb_month,
  email_usd_per_thousand, stripe_fee_percent, stripe_fee_fixed_usd, 6, 'Reserve target raised to 6 months of costs', 'system'
FROM pricing_settings ORDER BY id DESC LIMIT 1;
`.execute(db);
}

export async function down(): Promise<void> {
  // pricing_settings is append-only; a later version can change it back.
}
