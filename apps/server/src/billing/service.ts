import { sql } from "kysely";
import {
  dailyCharge,
  daysInMonth,
  formatUsd,
  monthlyCost,
  nextBillingState,
  usdToMicro,
} from "@glasstrack/shared";
import type { Deps } from "../context";
import type { Db } from "../db";
import { layout } from "../email";
import { sha256, uuid7 } from "../lib/ids";
import { logger } from "../lib/logger";
import { activeWorkspaceIds, loadSettings, sharedFixedMonthMicro, workspaceUsage } from "./pricing";

/** Public mail providers: capped per address, not per domain. */
const PUBLIC_DOMAINS = new Set([
  "gmail.com", "googlemail.com", "outlook.com", "hotmail.com", "live.com", "msn.com", "yahoo.com", "icloud.com",
  "me.com", "mac.com", "proton.me", "protonmail.com", "pm.me", "aol.com", "gmx.com", "gmx.de", "mail.com",
  "yandex.com", "zoho.com", "fastmail.com", "hey.com", "tutanota.com", "duck.com",
]);

const toNum = (v: string | number | bigint | null | undefined) => (v === null || v === undefined ? 0 : Number(v));
const isoDay = (d: Date) => d.toISOString().slice(0, 10);
const addDays = (day: string, n: number) => isoDay(new Date(Date.parse(`${day}T00:00:00Z`) + n * 86_400_000));

export async function balanceMicro(db: Db, workspaceId: string): Promise<number> {
  const r = await db
    .selectFrom("creditLedger")
    .select(sql<string>`coalesce(sum(amount_micro), 0)`.as("b"))
    .where("workspaceId", "=", workspaceId)
    .executeTakeFirstOrThrow();
  return toNum(r.b);
}

export async function storageBytes(db: Db, workspaceId: string): Promise<number> {
  const r = await sql<{ n: string }>`
    SELECT coalesce((SELECT sum(size_bytes) FROM attachments WHERE workspace_id = ${workspaceId} AND deleted_at IS NULL), 0)
         + coalesce((SELECT sum(size_bytes) FROM exports WHERE workspace_id = ${workspaceId} AND status = 'done'), 0) AS n`.execute(db);
  return toNum(r.rows[0]?.n);
}

/** Adds a ledger row once per idempotency key. Returns false if it already existed. */
export async function addLedger(
  db: Db,
  row: { workspaceId: string; kind: "starter_grant" | "topup" | "charge" | "storage_charge" | "refund" | "adjustment"; amountMicro: number; key: string; refType?: string; refId?: string; memo?: string; createdBy?: string },
): Promise<boolean> {
  const r = await db
    .insertInto("creditLedger")
    .values({
      workspaceId: row.workspaceId,
      kind: row.kind,
      amountMicro: row.amountMicro,
      idempotencyKey: row.key,
      refType: row.refType ?? null,
      refId: row.refId ?? null,
      memo: row.memo ?? null,
      createdBy: row.createdBy ?? "system",
    })
    .onConflict((oc) => oc.column("idempotencyKey").doNothing())
    .returning("id")
    .executeTakeFirst();
  return Boolean(r);
}

export async function ensureBillingAccount(db: Db, workspaceId: string): Promise<void> {
  await db.insertInto("billingAccounts").values({ workspaceId }).onConflict((oc) => oc.column("workspaceId").doNothing()).execute();
}

/**
 * Grants the starter credit to a new workspace if the creator's email is
 * verified and neither the address nor (for company domains) the domain has
 * used up its allowance. Returns the reason when no credit is granted.
 */
export async function grantStarterCredit(
  deps: Pick<Deps, "dbs" | "config">,
  p: { workspaceId: string; userId: string },
): Promise<{ granted: boolean; reason?: string }> {
  const sys = deps.dbs.system;
  await ensureBillingAccount(sys, p.workspaceId);
  const amount = usdToMicro((await loadSettings(sys)).signupCreditUsd);
  if (amount <= 0) return { granted: false, reason: "no_starter_credit" };
  const user = await sys.selectFrom("users").select(["email", "emailVerifiedAt"]).where("id", "=", p.userId).executeTakeFirst();
  if (!user?.emailVerifiedAt) return { granted: false, reason: "email_not_verified" };
  const email = user.email.toLowerCase();
  const domain = email.split("@")[1] ?? "";
  return sys.transaction().execute(async (trx) => {
    // Serialise claims per domain so two signups can't both take the last slot.
    await sql`SELECT pg_advisory_xact_lock(hashtext(${`starter:${domain}`}))`.execute(trx);
    const already = await trx.selectFrom("starterCreditClaims").select("id").where("emailHash", "=", sha256(email)).executeTakeFirst();
    if (already) return { granted: false, reason: "email_already_claimed" };
    if (!PUBLIC_DOMAINS.has(domain)) {
      const recent = await trx
        .selectFrom("starterCreditClaims")
        .select((eb) => eb.fn.countAll<string>().as("n"))
        .where("domain", "=", domain)
        .where("createdAt", ">", new Date(Date.now() - 30 * 86_400_000))
        .executeTakeFirstOrThrow();
      if (Number(recent.n) >= deps.config.BILLING_STARTER_DOMAIN_LIMIT) return { granted: false, reason: "domain_limit" };
    }
    await trx.insertInto("starterCreditClaims").values({ id: uuid7(), emailHash: sha256(email), domain, workspaceId: p.workspaceId }).execute();
    await addLedger(trx, { workspaceId: p.workspaceId, kind: "starter_grant", amountMicro: amount, key: `starter:${p.workspaceId}`, memo: "Starter credit" });
    await trx.updateTable("billingAccounts").set({ lastCreditMicro: amount, lowBalanceNotified: false, updatedAt: new Date() }).where("workspaceId", "=", p.workspaceId).execute();
    return { granted: true };
  });
}

async function adminEmails(db: Db, workspaceId: string): Promise<string[]> {
  const rows = await db
    .selectFrom("workspaceMembers as m")
    .innerJoin("users as u", "u.id", "m.userId")
    .select("u.email")
    .where("m.workspaceId", "=", workspaceId)
    .where("m.role", "=", "admin")
    .execute();
  return rows.map((r) => r.email);
}

const MAX_CATCH_UP_DAYS = 31;

/**
 * Daily run per workspace: charge each day since the last charge (catching up
 * after downtime), add storage overage, then move between active, grace and
 * read-only. Read-only workspaces are not charged, so debt never piles up.
 * Idempotent: every charge has a per-day key, so reruns change nothing.
 */
/** Inputs that are the same for every workspace on a given day. */
export async function dayInputs(deps: Deps, day: string) {
  const sys = deps.dbs.system;
  return { day, sharedFixed: await sharedFixedMonthMicro(sys, day), active: await activeWorkspaceIds(sys, day), days: daysInMonth(day) };
}

/** One workspace's charge for one day, from the shared pricing module. */
export async function chargeFor(deps: Deps, workspaceId: string, inputs: Awaited<ReturnType<typeof dayInputs>>, settings: Awaited<ReturnType<typeof loadSettings>>) {
  const usage = await workspaceUsage(deps.dbs.system, workspaceId, inputs.day);
  const active = inputs.active.has(workspaceId);
  const month = monthlyCost({
    settings, sharedFixedMonthMicro: inputs.sharedFixed, activeWorkspaces: inputs.active.size, storageGb: usage.storageGb, emailsPerMonth: usage.emailsPerMonth, active,
  });
  return { month, day: dailyCharge(month, inputs.days), usage, active };
}

const usd = (micro: number) => formatUsd(micro, { precise: true });

/**
 * Nightly, per workspace: charge each day since the last charge (catching up
 * after downtime, at most 31 days), then move between active, grace and
 * read-only and send low-balance emails. Read-only workspaces are not charged.
 * Idempotent: every charge has a per-day key, so reruns change nothing.
 */
export async function runDailyBilling(deps: Deps, now = new Date()): Promise<{ workspaces: number; charged: number }> {
  if (!deps.config.BILLING_ENABLED) return { workspaces: 0, charged: 0 };
  const sys = deps.dbs.system;
  const settings = await loadSettings(sys);
  const today = isoDay(now);
  const workspaces = await sys
    .selectFrom("workspaces as w")
    .leftJoin("billingAccounts as b", "b.workspaceId", "w.id")
    .select(["w.id", "w.name", "w.slug", "w.status", "w.createdAt", "b.lastChargedOn", "b.graceStartedAt", "b.warningsSent", "b.autoTopupEnabled",
      "b.autoTopupThresholdMicro", "b.lastCreditMicro", "b.lowBalanceNotified"])
    .where("w.status", "!=", "deleting")
    .execute();
  const inputsByDay = new Map<string, Awaited<ReturnType<typeof dayInputs>>>();
  const inputsFor = async (day: string) => {
    let v = inputsByDay.get(day);
    if (!v) inputsByDay.set(day, (v = await dayInputs(deps, day)));
    return v;
  };
  let charged = 0;
  const base = deps.config.APP_URL.replace(/\/$/, "");
  for (const ws of workspaces) {
    try {
      await ensureBillingAccount(sys, ws.id);
      if (ws.status !== "read_only") {
        let day = ws.lastChargedOn ? addDays(ws.lastChargedOn, 1) : isoDay(ws.createdAt);
        if (day < addDays(today, -MAX_CATCH_UP_DAYS + 1)) day = addDays(today, -MAX_CATCH_UP_DAYS + 1);
        for (; day <= today; day = addDays(day, 1)) {
          const c = await chargeFor(deps, ws.id, await inputsFor(day), settings);
          const d = c.day;
          const memo = `Server ${usd(d.serverShareMicro)}, storage ${usd(d.storageMicro)} (${c.usage.storageGb.toFixed(2)} GB), email ${usd(d.emailMicro)}, fees and reserve ${usd(d.feesAndReserveMicro)}`;
          if (d.totalMicro > 0 && (await addLedger(sys, { workspaceId: ws.id, kind: "charge", amountMicro: -d.totalMicro, key: `charge:${ws.id}:${day}`, refType: "day", refId: day, memo }))) charged++;
          await sys.insertInto("workspaceCostDaily").values({
            workspaceId: ws.id, day, sharedMicro: d.serverShareMicro, storageMicro: d.storageMicro, emailMicro: d.emailMicro, feesMicro: d.feesAndReserveMicro,
            totalMicro: d.totalMicro, active: c.active,
          }).onConflict((oc) => oc.columns(["workspaceId", "day"]).doNothing()).execute();
        }
        await sys.updateTable("billingAccounts").set({ lastChargedOn: today, updatedAt: new Date() }).where("workspaceId", "=", ws.id).execute();
      }
      const balance = await balanceMicro(sys, ws.id);
      if (ws.autoTopupEnabled && balance < toNum(ws.autoTopupThresholdMicro) && ws.status !== "deleting") {
        await deps.jobs.send("billing.autotopup", { workspaceId: ws.id });
      }
      // Low balance: one email when it drops below 25% of the last credit added (the $0 emails come from grace below).
      const lastCredit = toNum(ws.lastCreditMicro);
      if (balance > 0 && lastCredit > 0 && balance < lastCredit * LOW_BALANCE_FRACTION && !ws.lowBalanceNotified && !ws.autoTopupEnabled) {
        await sendLowBalanceEmail(deps, ws, balance, `${base}/${ws.slug}/settings/billing`);
        await sys.updateTable("billingAccounts").set({ lowBalanceNotified: true, updatedAt: new Date() }).where("workspaceId", "=", ws.id).execute();
      }
      const status = ws.status === "grace" || ws.status === "read_only" ? ws.status : "active";
      const next = nextBillingState(
        { status, balanceMicro: balance, graceStartedAt: ws.graceStartedAt, warningsSent: ws.warningsSent ?? 0 },
        now,
      );
      await sys.updateTable("workspaces").set({ status: next.status }).where("id", "=", ws.id).where("status", "!=", "deleting").execute();
      await sys.updateTable("billingAccounts")
        .set({ graceStartedAt: next.graceStartedAt, warningsSent: next.warningsSent, updatedAt: new Date() })
        .where("workspaceId", "=", ws.id).execute();
      if (next.email) await sendBillingEmail(deps, ws, next.email, balance, `${base}/${ws.slug}/settings/billing`);
    } catch (err) {
      logger.error({ err, workspaceId: ws.id }, "daily billing failed for workspace");
    }
  }
  return { workspaces: workspaces.length, charged };
}

export const LOW_BALANCE_FRACTION = 0.25;

async function sendLowBalanceEmail(deps: Deps, ws: { id: string; name: string }, balance: number, url: string) {
  const subject = `${ws.name}: credit is running low`;
  const { text, html } = layout(subject, [
    `The ${ws.name} workspace has ${formatUsd(balance)} of credit left.`,
    "Top up, or turn on automatic top-up, to keep everything running. If it reaches $0, everything keeps working for 7 more days before the workspace becomes read-only. Nothing is ever deleted.",
  ], { label: "Open billing", url });
  for (const to of await adminEmails(deps.dbs.system, ws.id)) await deps.mailer.send({ to, subject, text, html, workspaceId: ws.id });
}

async function sendBillingEmail(
  deps: Deps,
  ws: { id: string; name: string },
  email: NonNullable<ReturnType<typeof nextBillingState>["email"]>,
  balance: number,
  url: string,
) {
  const to = await adminEmails(deps.dbs.system, ws.id);
  let subject: string;
  let lines: string[];
  if (email.kind === "grace_warning") {
    subject = `${ws.name}: credit has run out`;
    lines = [
      `The ${ws.name} workspace has used up its credit (balance ${formatUsd(balance)}).`,
      `Everything keeps working for ${email.daysLeft} more day${email.daysLeft === 1 ? "" : "s"}. After that the workspace becomes read-only until it is topped up. Nothing is ever deleted, and export always works.`,
    ];
  } else if (email.kind === "read_only") {
    subject = `${ws.name} is now read-only`;
    lines = [
      `The ${ws.name} workspace is read-only because its credit ran out 7 days ago.`,
      "Your data is safe and export still works. Top up to make it editable again.",
    ];
  } else {
    subject = `${ws.name} is active again`;
    lines = [`Thanks for topping up. The ${ws.name} workspace is fully active again.`];
  }
  const { text, html } = layout(subject, lines, { label: "Open billing", url });
  for (const addr of to) await deps.mailer.send({ to: addr, subject, text, html, workspaceId: ws.id });
}

/** Credits a successful payment exactly once and records it. */
export async function creditPayment(
  deps: Deps,
  p: { paymentId: string; workspaceId: string; paymentIntentId: string; amountCents: number; kind: "topup" | "auto_topup"; checkoutSessionId?: string },
): Promise<void> {
  const sys = deps.dbs.system;
  const amountMicro = p.amountCents * 10_000;
  await sys.transaction().execute(async (trx) => {
    await trx
      .insertInto("payments")
      .values({
        id: p.paymentId, workspaceId: p.workspaceId, kind: p.kind, stripePaymentIntentId: p.paymentIntentId,
        stripeCheckoutSessionId: p.checkoutSessionId ?? null, amountMicro, status: "succeeded", succeededAt: new Date(),
      })
      .onConflict((oc) =>
        oc.column("id").doUpdateSet({ stripePaymentIntentId: p.paymentIntentId, status: "succeeded", succeededAt: new Date(), amountMicro }),
      )
      .execute();
    await addLedger(trx, {
      workspaceId: p.workspaceId, kind: "topup", amountMicro, key: `topup:${p.paymentIntentId}`, refType: "payment",
      refId: p.paymentId, memo: p.kind === "auto_topup" ? "Automatic top-up" : "Top-up", createdBy: "stripe",
    });
    await trx.updateTable("billingAccounts").set({ lastCreditMicro: amountMicro, lowBalanceNotified: false, updatedAt: new Date() })
      .where("workspaceId", "=", p.workspaceId).execute();
  });
  await recordFee(deps, p.paymentId, p.paymentIntentId);
  // A top-up may end grace or read-only right away rather than at the next daily run.
  await refreshStatus(deps, p.workspaceId);
}

export async function recordFee(deps: Deps, paymentId: string, paymentIntentId: string): Promise<boolean> {
  try {
    const fee = await deps.payments.fetchFee(paymentIntentId);
    if (!fee) return false;
    await deps.dbs.system.updateTable("payments").set({ feeMicro: fee.feeCents * 10_000, netMicro: fee.netCents * 10_000 })
      .where("id", "=", paymentId).execute();
    return true;
  } catch (err) {
    logger.warn({ err, paymentId }, "could not fetch Stripe fee yet");
    return false;
  }
}

export async function refreshStatus(deps: Deps, workspaceId: string, now = new Date()): Promise<void> {
  const sys = deps.dbs.system;
  const ws = await sys.selectFrom("workspaces as w").leftJoin("billingAccounts as b", "b.workspaceId", "w.id")
    .select(["w.id", "w.name", "w.slug", "w.status", "b.graceStartedAt", "b.warningsSent"])
    .where("w.id", "=", workspaceId).executeTakeFirst();
  if (!ws || ws.status === "deleting") return;
  const balance = await balanceMicro(sys, workspaceId);
  const status = ws.status === "grace" || ws.status === "read_only" ? ws.status : "active";
  const next = nextBillingState({ status, balanceMicro: balance, graceStartedAt: ws.graceStartedAt, warningsSent: ws.warningsSent ?? 0 }, now);
  if (next.status === status && next.status !== "active") return; // only the daily run escalates
  await sys.updateTable("workspaces").set({ status: next.status }).where("id", "=", workspaceId).execute();
  await sys.updateTable("billingAccounts").set({ graceStartedAt: next.graceStartedAt, warningsSent: next.warningsSent, updatedAt: new Date() })
    .where("workspaceId", "=", workspaceId).execute();
  if (next.email?.kind === "restored") {
    await sendBillingEmail(deps, ws, next.email, balance, `${deps.config.APP_URL.replace(/\/$/, "")}/${ws.slug}/settings/billing`);
  }
}

/** Off-session charge of the saved card when the balance falls below the threshold. */
export async function runAutoTopup(deps: Deps, workspaceId: string): Promise<void> {
  const sys = deps.dbs.system;
  const acct = await sys.selectFrom("billingAccounts").selectAll().where("workspaceId", "=", workspaceId).executeTakeFirst();
  if (!acct?.autoTopupEnabled || !acct.stripeCustomerId || !acct.defaultPaymentMethod) return;
  const balance = await balanceMicro(sys, workspaceId);
  if (balance >= toNum(acct.autoTopupThresholdMicro)) return;
  // At most one automatic top-up per workspace per day.
  const today = isoDay(new Date());
  const recent = await sys.selectFrom("payments").select("id").where("workspaceId", "=", workspaceId).where("kind", "=", "auto_topup")
    .where("createdAt", ">=", new Date(`${today}T00:00:00Z`)).executeTakeFirst();
  if (recent) return;
  const paymentId = uuid7();
  const amountMicro = toNum(acct.autoTopupAmountMicro);
  // Monthly spending cap: automatic top-ups stop once this month's top-ups would pass it.
  if (acct.monthlyCapMicro !== null) {
    const spent = await topupsThisMonthMicro(sys, workspaceId);
    if (spent + amountMicro > toNum(acct.monthlyCapMicro)) {
      logger.info({ workspaceId }, "automatic top-up skipped: monthly spending cap reached");
      return;
    }
  }
  await sys.insertInto("payments").values({ id: paymentId, workspaceId, kind: "auto_topup", amountMicro, status: "pending" }).execute();
  try {
    const r = await deps.payments.chargeSavedCard({
      customerId: acct.stripeCustomerId, paymentMethodId: acct.defaultPaymentMethod, amountCents: Math.round(amountMicro / 10_000), workspaceId, paymentId,
    });
    await sys.updateTable("payments").set({ stripePaymentIntentId: r.paymentIntentId }).where("id", "=", paymentId).execute();
    // Credit arrives with the payment_intent.succeeded webhook.
  } catch (err) {
    logger.warn({ err, workspaceId }, "automatic top-up failed");
    await sys.updateTable("payments").set({ status: "failed" }).where("id", "=", paymentId).execute();
    await sys.updateTable("billingAccounts").set({ autoTopupEnabled: false, updatedAt: new Date() }).where("workspaceId", "=", workspaceId).execute();
    const ws = await sys.selectFrom("workspaces").select(["name", "slug"]).where("id", "=", workspaceId).executeTakeFirstOrThrow();
    const subject = `${ws.name}: automatic top-up failed`;
    const { text, html } = layout(subject, [
      "We tried to top up your credit with the saved card, but the payment didn't go through. Automatic top-up is now off.",
      "Please top up manually or update your card.",
    ], { label: "Open billing", url: `${deps.config.APP_URL.replace(/\/$/, "")}/${ws.slug}/settings/billing` });
    for (const to of await adminEmails(sys, workspaceId)) await deps.mailer.send({ to, subject, text, html, workspaceId });
  }
}

/** Retries fee lookups for payments whose balance transaction wasn't ready. */
export async function backfillFees(deps: Deps): Promise<number> {
  const rows = await deps.dbs.system.selectFrom("payments").select(["id", "stripePaymentIntentId"])
    .where("status", "=", "succeeded").where("feeMicro", "is", null).where("stripePaymentIntentId", "is not", null).limit(100).execute();
  let n = 0;
  for (const r of rows) if (await recordFee(deps, r.id, r.stripePaymentIntentId!)) n++;
  return n;
}

/** Top-ups (manual and automatic) that succeeded or are pending this calendar month (UTC). */
export async function topupsThisMonthMicro(db: Db, workspaceId: string, now = new Date()): Promise<number> {
  const from = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const r = await db.selectFrom("payments").select(sql<string>`coalesce(sum(amount_micro), 0)`.as("s"))
    .where("workspaceId", "=", workspaceId).where("status", "in", ["succeeded", "pending"]).where("createdAt", ">=", from).executeTakeFirstOrThrow();
  return toNum(r.s);
}

/**
 * Unused credit that came from payments (the signup credit is spent first and
 * isn't refundable as cash): balance − unspent signup credit, never below 0.
 */
export async function refundableMicro(db: Db, workspaceId: string): Promise<number> {
  const r = await db.selectFrom("creditLedger").select([
    sql<string>`coalesce(sum(amount_micro), 0)`.as("balance"),
    sql<string>`coalesce(sum(amount_micro) FILTER (WHERE kind = 'starter_grant'), 0)`.as("starter"),
    sql<string>`coalesce(-sum(amount_micro) FILTER (WHERE kind IN ('charge', 'storage_charge')), 0)`.as("charged"),
  ]).where("workspaceId", "=", workspaceId).executeTakeFirstOrThrow();
  const unspentStarter = Math.max(0, toNum(r.starter) - toNum(r.charged));
  return Math.max(0, toNum(r.balance) - unspentStarter);
}

/**
 * Refunds unused paid credit through the payment provider, newest payment
 * first, and records each refund in the ledger. Returns the amount refunded.
 */
export async function refundUnusedCredit(deps: Deps, workspaceId: string, by: string): Promise<number> {
  const sys = deps.dbs.system;
  let remaining = await refundableMicro(sys, workspaceId);
  if (remaining <= 0) return 0;
  const payments = await sys.selectFrom("payments").select(["id", "amountMicro", "stripePaymentIntentId"])
    .where("workspaceId", "=", workspaceId).where("status", "in", ["succeeded", "refunded"]).where("stripePaymentIntentId", "is not", null)
    .orderBy("succeededAt", "desc").execute();
  let refunded = 0;
  for (const p of payments) {
    if (remaining <= 0) break;
    const already = await sys.selectFrom("creditLedger").select(sql<string>`coalesce(-sum(amount_micro), 0)`.as("r"))
      .where("kind", "=", "refund").where("refType", "=", "payment").where("refId", "=", p.id).executeTakeFirstOrThrow();
    const left = toNum(p.amountMicro) - toNum(already.r);
    // Stripe refunds whole cents.
    const amountMicro = Math.floor(Math.min(left, remaining) / 10_000) * 10_000;
    if (amountMicro <= 0) continue;
    const r = await deps.payments.refund({ paymentIntentId: p.stripePaymentIntentId!, amountCents: amountMicro / 10_000, paymentId: p.id });
    await addLedger(sys, {
      workspaceId, kind: "refund", amountMicro: -amountMicro, key: `refund:${r.id}`, refType: "payment", refId: p.id, memo: "Refund of unused credit", createdBy: by,
    });
    await sys.updateTable("payments").set({ status: "refunded" }).where("id", "=", p.id).where(sql<boolean>`${amountMicro + toNum(already.r)} >= amount_micro`).execute();
    remaining -= amountMicro;
    refunded += amountMicro;
  }
  await sys.updateTable("billingAccounts").set({ refundRequestedAt: null, autoTopupEnabled: false, updatedAt: new Date() }).where("workspaceId", "=", workspaceId).execute();
  return refunded;
}

/** If the service closes: refund every workspace's unused paid credit. */
export async function refundAll(deps: Deps, by: string): Promise<{ workspaces: number; refundedMicro: number; failed: string[] }> {
  const ids = await deps.dbs.system.selectFrom("creditLedger").select("workspaceId").where("kind", "=", "topup").groupBy("workspaceId").execute();
  let total = 0;
  let n = 0;
  const failed: string[] = [];
  for (const { workspaceId } of ids) {
    try {
      const r = await refundUnusedCredit(deps, workspaceId, by);
      if (r > 0) n++;
      total += r;
    } catch (err) {
      logger.error({ err, workspaceId }, "refund failed");
      failed.push(workspaceId);
    }
  }
  return { workspaces: n, refundedMicro: total, failed };
}
