import { sql } from "kysely";
import { DEFAULT_PRICING, dailyShare, daysInMonth, GIB, type PricingSettings } from "@glasstrack/shared";
import type { Db } from "../db";

const n = (v: unknown) => Number(v ?? 0);
const isoDay = (d: Date) => d.toISOString().slice(0, 10);

/** Cost categories charged per workspace through usage, so not part of the shared fixed costs. */
export const USAGE_CATEGORIES = ["storage", "email"] as const;

export async function loadSettings(db: Db): Promise<PricingSettings & { id: number | null; effectiveFrom: string | null }> {
  const r = await db.selectFrom("pricingSettings").selectAll().orderBy("id", "desc").limit(1).executeTakeFirst();
  if (!r) return { ...DEFAULT_PRICING, id: null, effectiveFrom: null };
  return {
    id: r.id,
    effectiveFrom: r.effectiveFrom.toISOString(),
    signupCreditUsd: n(r.signupCreditUsd),
    serverShareCapUsd: n(r.serverShareCapUsd),
    feeMarkup: n(r.feeMarkup),
    minTopupUsd: n(r.minTopupUsd),
    maxTopupUsd: n(r.maxTopupUsd),
    storageUsdPerGbMonth: n(r.storageUsdPerGbMonth),
    emailUsdPer1000: n(r.emailUsdPerThousand),
    stripeFeePercent: n(r.stripeFeePercent),
    stripeFeeFixedUsd: n(r.stripeFeeFixedUsd),
    reserveTargetMonths: n(r.reserveTargetMonths),
  };
}

const monthStart = (day: string) => `${day.slice(0, 7)}-01`;
const monthEnd = (day: string) => `${day.slice(0, 7)}-${String(daysInMonth(day)).padStart(2, "0")}`;

/**
 * Shared fixed costs for the calendar month containing `day`: every cost entry
 * except storage and email (those are charged per workspace), spread evenly
 * over its period, summed over the month's days.
 */
export async function sharedFixedMonthMicro(db: Db, day: string): Promise<number> {
  const from = monthStart(day);
  const to = monthEnd(day);
  const entries = await db.selectFrom("costEntries").select(["amountMicro", "periodStart", "periodEnd"])
    .where("category", "not in", [...USAGE_CATEGORIES]).where("periodStart", "<=", to).where("periodEnd", ">=", from).execute();
  let total = 0;
  for (const e of entries) {
    for (let d = from; d <= to; d = isoDay(new Date(Date.parse(`${d}T00:00:00Z`) + 86_400_000))) {
      total += dailyShare(n(e.amountMicro), e.periodStart, e.periodEnd, d);
    }
  }
  return total;
}

/**
 * Workspaces with any member activity in the 30 days up to `day` (viewers count
 * too: they use the servers). Only the latest activity time is stored, so a
 * workspace active since then also counts (this matters only for catch-up days).
 */
export async function activeWorkspaceIds(db: Db, day: string): Promise<Set<string>> {
  const r = await sql<{ id: string }>`
    SELECT w.id FROM workspaces w
    WHERE w.status <> 'deleting' AND EXISTS (
      SELECT 1 FROM workspace_members m WHERE m.workspace_id = w.id
        AND m.last_active_at > ${day}::date + 1 - interval '30 days')`.execute(db);
  return new Set(r.rows.map((x) => x.id));
}

/** Current stored bytes (attachments and finished exports) and emails sent in the 30 days up to `day`. */
export async function workspaceUsage(db: Db, workspaceId: string, day: string): Promise<{ storageGb: number; emailsPerMonth: number }> {
  const r = await sql<{ bytes: string; emails: string }>`
    SELECT
      coalesce((SELECT sum(size_bytes) FROM attachments WHERE workspace_id = ${workspaceId} AND deleted_at IS NULL), 0)
        + coalesce((SELECT sum(size_bytes) FROM exports WHERE workspace_id = ${workspaceId} AND status = 'done'), 0) AS bytes,
      coalesce((SELECT sum(emails_sent) FROM usage_daily WHERE workspace_id = ${workspaceId}
        AND day > ${day}::date - 30 AND day <= ${day}::date), 0) AS emails`.execute(db);
  return { storageGb: n(r.rows[0]?.bytes) / GIB, emailsPerMonth: n(r.rows[0]?.emails) };
}
