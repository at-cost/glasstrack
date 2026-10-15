import { Hono } from "hono";
import { z } from "zod";
import { dailyCharge, GIB, storageOverageDaily, usdToMicro } from "@glasstrack/shared";
import { type AppEnv, requireRole, requireUser } from "../context";
import { ApiError, badRequest } from "../lib/errors";
import { uuid7 } from "../lib/ids";
import { balanceMicro, currentPriceMicro, ensureBillingAccount, storageBytes } from "./service";
import { audit } from "../modules/audit";

const n = (v: unknown) => Number(v ?? 0);

/** /w/:slug/billing. Reads go through the tenant transaction (RLS); writes use the system role. */
export const billingRoutes = new Hono<AppEnv>()
  .get("/billing", async (c) => {
    const deps = c.get("deps");
    if (!deps.config.BILLING_ENABLED) return c.json({ enabled: false });
    const trx = c.get("trx");
    const ws = c.get("ws");
    await ensureBillingAccount(deps.dbs.system, ws.id);
    const price = await currentPriceMicro(deps);
    const [balance, bytes, acct, ledger, payments] = await Promise.all([
      balanceMicro(trx, ws.id),
      storageBytes(trx, ws.id),
      trx.selectFrom("billingAccounts").selectAll().where("workspaceId", "=", ws.id).executeTakeFirst(),
      trx.selectFrom("creditLedger").select(["id", "kind", "amountMicro", "memo", "refType", "refId", "createdAt"]).orderBy("createdAt", "desc").orderBy("id", "desc").limit(100).execute(),
      trx.selectFrom("payments").select(["id", "kind", "amountMicro", "feeMicro", "status", "createdAt"]).orderBy("createdAt", "desc").limit(20).execute(),
    ]);
    const overage = storageOverageDaily(bytes, deps.config.BILLING_FREE_STORAGE_GB, usdToMicro(deps.config.BILLING_STORAGE_USD_PER_GB_MONTH));
    const perDay = dailyCharge(price) + overage;
    return c.json({
      enabled: true,
      status: ws.status,
      balanceMicro: balance,
      monthlyPriceMicro: price,
      dailyChargeMicro: perDay,
      daysRemaining: perDay > 0 ? Math.max(0, Math.floor(balance / perDay)) : null,
      storage: { bytes, freeBytes: deps.config.BILLING_FREE_STORAGE_GB * GIB, overageDailyMicro: overage, ratePerGbMonthMicro: usdToMicro(deps.config.BILLING_STORAGE_USD_PER_GB_MONTH) },
      card: acct?.cardLabel ?? null,
      graceStartedAt: acct?.graceStartedAt?.toISOString() ?? null,
      autoTopup: {
        enabled: acct?.autoTopupEnabled ?? false,
        thresholdMicro: n(acct?.autoTopupThresholdMicro),
        amountMicro: n(acct?.autoTopupAmountMicro),
      },
      limits: { minTopupMicro: usdToMicro(deps.config.BILLING_MIN_TOPUP_USD), maxTopupMicro: usdToMicro(deps.config.BILLING_MAX_TOPUP_USD) },
      // Charges are shown on the day they cover, which differs from createdAt after a catch-up run.
      ledger: ledger.map((l) => ({ id: l.id, kind: l.kind, amountMicro: n(l.amountMicro), memo: l.memo, day: l.refType === "day" ? l.refId : null, createdAt: l.createdAt.toISOString() })),
      payments: payments.map((p) => ({ id: p.id, kind: p.kind, amountMicro: n(p.amountMicro), feeMicro: p.feeMicro === null ? null : n(p.feeMicro), status: p.status, createdAt: p.createdAt.toISOString() })),
    });
  })
  .post("/billing/topup", async (c) => {
    const deps = c.get("deps");
    if (!deps.config.BILLING_ENABLED) throw badRequest("Billing is not enabled on this server");
    requireRole(c, "admin");
    const user = requireUser(c);
    const ws = c.get("ws");
    const body = z.object({ amountUsd: z.number(), saveCard: z.boolean().default(false) }).parse(await c.req.json());
    const cfg = deps.config;
    if (body.amountUsd < cfg.BILLING_MIN_TOPUP_USD || body.amountUsd > cfg.BILLING_MAX_TOPUP_USD) {
      throw badRequest(`Top-ups must be between $${cfg.BILLING_MIN_TOPUP_USD} and $${cfg.BILLING_MAX_TOPUP_USD}`);
    }
    const amountCents = Math.round(body.amountUsd * 100);
    const sys = deps.dbs.system;
    await ensureBillingAccount(sys, ws.id);
    const acct = await sys.selectFrom("billingAccounts").select("stripeCustomerId").where("workspaceId", "=", ws.id).executeTakeFirstOrThrow();
    let customerId: string;
    try {
      customerId = await deps.payments.ensureCustomer({ existingId: acct.stripeCustomerId, workspaceId: ws.id, email: user.email, name: ws.name });
    } catch (err) {
      throw new ApiError(502, "payment_provider", `Could not start checkout: ${String((err as Error).message ?? err)}`);
    }
    if (!acct.stripeCustomerId) {
      await sys.updateTable("billingAccounts").set({ stripeCustomerId: customerId, updatedAt: new Date() }).where("workspaceId", "=", ws.id).execute();
    }
    const paymentId = uuid7();
    await sys.insertInto("payments").values({ id: paymentId, workspaceId: ws.id, kind: "topup", amountMicro: amountCents * 10_000, status: "pending" }).execute();
    const back = `${cfg.APP_URL.replace(/\/$/, "")}/${ws.slug}/settings/billing`;
    try {
      const session = await deps.payments.createTopupCheckout({
        customerId, amountCents, workspaceId: ws.id, paymentId, saveCard: body.saveCard,
        successUrl: `${back}?topup=success`, cancelUrl: `${back}?topup=cancelled`,
      });
      await sys.updateTable("payments").set({ stripeCheckoutSessionId: session.id }).where("id", "=", paymentId).execute();
      await audit(c, "billing.topup_started", "payment", paymentId, { amountUsd: body.amountUsd, saveCard: body.saveCard });
      return c.json({ url: session.url });
    } catch (err) {
      await sys.updateTable("payments").set({ status: "failed" }).where("id", "=", paymentId).execute();
      throw new ApiError(502, "payment_provider", `Could not start checkout: ${String((err as Error).message ?? err)}`);
    }
  })
  .put("/billing/auto-topup", async (c) => {
    const deps = c.get("deps");
    if (!deps.config.BILLING_ENABLED) throw badRequest("Billing is not enabled on this server");
    requireRole(c, "admin");
    const ws = c.get("ws");
    const body = z.object({ enabled: z.boolean(), thresholdUsd: z.number().min(0).max(1000), amountUsd: z.number() }).parse(await c.req.json());
    const cfg = deps.config;
    if (body.amountUsd < cfg.BILLING_MIN_TOPUP_USD || body.amountUsd > cfg.BILLING_MAX_TOPUP_USD) {
      throw badRequest(`Top-ups must be between $${cfg.BILLING_MIN_TOPUP_USD} and $${cfg.BILLING_MAX_TOPUP_USD}`);
    }
    await ensureBillingAccount(deps.dbs.system, ws.id);
    const trx = c.get("trx");
    const acct = await trx.selectFrom("billingAccounts").select("defaultPaymentMethod").where("workspaceId", "=", ws.id).executeTakeFirstOrThrow();
    if (body.enabled && !acct.defaultPaymentMethod) throw badRequest("Save a card with a top-up first, then turn on automatic top-up");
    await trx.updateTable("billingAccounts")
      .set({ autoTopupEnabled: body.enabled, autoTopupThresholdMicro: usdToMicro(body.thresholdUsd), autoTopupAmountMicro: usdToMicro(body.amountUsd), updatedAt: new Date() })
      .where("workspaceId", "=", ws.id).execute();
    await audit(c, "billing.auto_topup_changed", "billing", ws.id, body);
    return c.json({ ok: true });
  });
