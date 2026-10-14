import { sql } from "kysely";
import {
  dailyCharge,
  formatUsd,
  GIB,
  nextBillingState,
  storageOverageDaily,
  usdToMicro,
} from "@glasstrack/shared";
import type { Deps } from "../context";
import type { Db } from "../db";
import { layout } from "../email";
import { sha256, uuid7 } from "../lib/ids";
import { logger } from "../lib/logger";

/** Public mail providers: capped per address, not per domain. */
const PUBLIC_DOMAINS = new Set([
  "gmail.com", "googlemail.com", "outlook.com", "hotmail.com", "live.com", "msn.com", "yahoo.com", "icloud.com",
  "me.com", "mac.com", "proton.me", "protonmail.com", "pm.me", "aol.com", "gmx.com", "gmx.de", "mail.com",
  "yandex.com", "zoho.com", "fastmail.com", "hey.com", "tutanota.com", "duck.com",
]);

const toNum = (v: string | number | bigint | null | undefined) => (v === null || v === undefined ? 0 : Number(v));
const isoDay = (d: Date) => d.toISOString().slice(0, 10);
const addDays = (day: string, n: number) => isoDay(new Date(Date.parse(`${day}T00:00:00Z`) + n * 86_400_000));

/** Current monthly price; seeds the config table from env on first use. */
export async function currentPriceMicro(deps: Pick<Deps, "dbs" | "config">): Promise<number> {
  const sys = deps.dbs.system;
  const row = await sys.selectFrom("pricingConfig").select("monthlyPriceMicro").orderBy("id", "desc").limit(1).executeTakeFirst();
  if (row) return toNum(row.monthlyPriceMicro);
  const initial = usdToMicro(deps.config.BILLING_INITIAL_PRICE_USD);
  await sys.insertInto("pricingConfig").values({ monthlyPriceMicro: initial, reason: "Initial price" }).execute();
  return initial;
}

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
  const amount = usdToMicro(deps.config.BILLING_STARTER_CREDIT_USD);
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
export async function runDailyBilling(deps: Deps, now = new Date()): Promise<{ workspaces: number; charged: number }> {
  if (!deps.config.BILLING_ENABLED) return { workspaces: 0, charged: 0 };
  const sys = deps.dbs.system;
  const price = await currentPriceMicro(deps);
  const perDay = dailyCharge(price);
  const today = isoDay(now);
  const workspaces = await sys
    .selectFrom("workspaces as w")
    .leftJoin("billingAccounts as b", "b.workspaceId", "w.id")
    .select(["w.id", "w.name", "w.slug", "w.status", "w.createdAt", "b.lastChargedOn", "b.graceStartedAt", "b.warningsSent", "b.autoTopupEnabled", "b.autoTopupThresholdMicro"])
    .where("w.status", "!=", "deleting")
    .execute();
  let charged = 0;
  const base = deps.config.APP_URL.replace(/\/$/, "");
  for (const ws of workspaces) {
    try {
      await ensureBillingAccount(sys, ws.id);
      if (ws.status !== "read_only") {
        let day = ws.lastChargedOn ? addDays(ws.lastChargedOn, 1) : isoDay(ws.createdAt);
        if (day < addDays(today, -MAX_CATCH_UP_DAYS + 1)) day = addDays(today, -MAX_CATCH_UP_DAYS + 1);
        const bytes = await storageBytes(sys, ws.id);
        const overage = storageOverageDaily(bytes, deps.config.BILLING_FREE_STORAGE_GB, usdToMicro(deps.config.BILLING_STORAGE_USD_PER_GB_MONTH));
        for (; day <= today; day = addDays(day, 1)) {
          if (await addLedger(sys, { workspaceId: ws.id, kind: "charge", amountMicro: -perDay, key: `charge:${ws.id}:${day}`, refType: "day", refId: day, memo: `Daily charge (${formatUsd(price)}/month)` })) charged++;
          if (overage > 0) {
            await addLedger(sys, {
              workspaceId: ws.id, kind: "storage_charge", amountMicro: -overage, key: `storage:${ws.id}:${day}`, refType: "day", refId: day,
              memo: `Storage over ${deps.config.BILLING_FREE_STORAGE_GB} GB (${(bytes / GIB).toFixed(2)} GB stored)`,
            });
          }
        }
        await sys.updateTable("billingAccounts").set({ lastChargedOn: today, updatedAt: new Date() }).where("workspaceId", "=", ws.id).execute();
      }
      const balance = await balanceMicro(sys, ws.id);
      if (ws.autoTopupEnabled && balance < toNum(ws.autoTopupThresholdMicro) && ws.status !== "deleting") {
        await deps.jobs.send("billing.autotopup", { workspaceId: ws.id });
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
