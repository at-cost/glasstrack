import { Hono } from "hono";
import { z } from "zod";
import { creditLastsDays, topupAllowed, usdToMicro } from "@glasstrack/shared";
import { type AppEnv, requireRole, requireUser } from "../context";
import { ApiError, badRequest } from "../lib/errors";
import { uuid7 } from "../lib/ids";
import { loadSettings } from "./pricing";
import { balanceMicro, chargeFor, dayInputs, ensureBillingAccount, refundableMicro, topupsThisMonthMicro } from "./service";
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
    const sys = deps.dbs.system;
    const settings = await loadSettings(sys);
    const today = new Date().toISOString().slice(0, 10);
    const [balance, acct, ledger, payments, estimate, refundable, topupsThisMonth] = await Promise.all([
      balanceMicro(trx, ws.id),
      trx.selectFrom("billingAccounts").selectAll().where("workspaceId", "=", ws.id).executeTakeFirst(),
      trx.selectFrom("creditLedger").select(["id", "kind", "amountMicro", "memo", "refType", "refId", "createdAt"]).orderBy("createdAt", "desc").orderBy("id", "desc").limit(100).execute(),
      trx.selectFrom("payments").select(["id", "kind", "amountMicro", "feeMicro", "status", "createdAt"]).orderBy("createdAt", "desc").limit(20).execute(),
      dayInputs(deps, today).then((inputs) => chargeFor(deps, ws.id, inputs, settings)),
      refundableMicro(sys, ws.id),
      topupsThisMonthMicro(sys, ws.id),
    ]);
    const perDay = estimate.day.totalMicro;
    return c.json({
      enabled: true,
      status: ws.status,
      balanceMicro: balance,
      // What this workspace costs now, from the same module as the nightly charge.
      estimate: {
        monthly: estimate.month,
        daily: estimate.day,
        storageGb: estimate.usage.storageGb,
        emailsPerMonth: estimate.usage.emailsPerMonth,
        active: estimate.active,
      },
      dailyChargeMicro: perDay,
      daysRemaining: perDay > 0 ? Math.max(0, Math.floor(balance / perDay)) : null,
      creditLastsDays: creditLastsDays(Math.max(0, balance), estimate.month.totalMicro),
      refundableMicro: refundable,
      refundRequestedAt: acct?.refundRequestedAt?.toISOString() ?? null,
      card: acct?.cardLabel ?? null,
      graceStartedAt: acct?.graceStartedAt?.toISOString() ?? null,
      autoTopup: {
        enabled: acct?.autoTopupEnabled ?? false,
        thresholdMicro: n(acct?.autoTopupThresholdMicro),
        amountMicro: n(acct?.autoTopupAmountMicro),
      },
      monthlyCapMicro: acct?.monthlyCapMicro == null ? null : n(acct.monthlyCapMicro),
      topupsThisMonthMicro: topupsThisMonth,
      limits: { minTopupMicro: usdToMicro(settings.minTopupUsd), maxTopupMicro: usdToMicro(settings.maxTopupUsd) },
      pricing: settings,
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
    const settings = await loadSettings(deps.dbs.system);
    if (!topupAllowed(settings, body.amountUsd)) throw badRequest(`Top-ups must be between $${settings.minTopupUsd} and $${settings.maxTopupUsd}`);
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
    const body = z.object({
      enabled: z.boolean(), thresholdUsd: z.number().min(0).max(1000), amountUsd: z.number(),
      /** Most that may be topped up (manually or automatically) in one calendar month; null = no cap. */
      monthlyCapUsd: z.number().positive().max(100_000).nullable().optional(),
    }).parse(await c.req.json());
    const settings = await loadSettings(deps.dbs.system);
    if (!topupAllowed(settings, body.amountUsd)) throw badRequest(`Top-ups must be between $${settings.minTopupUsd} and $${settings.maxTopupUsd}`);
    if (body.monthlyCapUsd != null && body.monthlyCapUsd < body.amountUsd) throw badRequest("The monthly cap must be at least one automatic top-up");
    await ensureBillingAccount(deps.dbs.system, ws.id);
    const trx = c.get("trx");
    const acct = await trx.selectFrom("billingAccounts").select("defaultPaymentMethod").where("workspaceId", "=", ws.id).executeTakeFirstOrThrow();
    if (body.enabled && !acct.defaultPaymentMethod) throw badRequest("Save a card with a top-up first, then turn on automatic top-up");
    await trx.updateTable("billingAccounts")
      .set({
        autoTopupEnabled: body.enabled, autoTopupThresholdMicro: usdToMicro(body.thresholdUsd), autoTopupAmountMicro: usdToMicro(body.amountUsd),
        ...(body.monthlyCapUsd !== undefined ? { monthlyCapMicro: body.monthlyCapUsd === null ? null : usdToMicro(body.monthlyCapUsd) } : {}),
        updatedAt: new Date(),
      })
      .where("workspaceId", "=", ws.id).execute();
    await audit(c, "billing.auto_topup_changed", "billing", ws.id, body);
    return c.json({ ok: true });
  })
  .post("/billing/refund-request", async (c) => {
    const deps = c.get("deps");
    if (!deps.config.BILLING_ENABLED) throw badRequest("Billing is not enabled on this server");
    requireRole(c, "admin");
    const user = requireUser(c);
    const ws = c.get("ws");
    const sys = deps.dbs.system;
    const amount = await refundableMicro(sys, ws.id);
    if (amount <= 0) throw badRequest("There is no unused paid credit to refund. The signup credit isn't refundable as cash.");
    await sys.updateTable("billingAccounts").set({ refundRequestedAt: new Date(), updatedAt: new Date() }).where("workspaceId", "=", ws.id).execute();
    await audit(c, "billing.refund_requested", "billing", ws.id, { refundableMicro: amount });
    const subject = `Refund requested: ${ws.name}`;
    const text = `${user.email} asked for a refund of unused credit for workspace ${ws.slug} (${ws.id}). Refundable now: $${(amount / 1e6).toFixed(2)}. Process it in the operator admin.`;
    for (const to of deps.config.operatorEmails) await deps.mailer.send({ to, subject, text });
    return c.json({ ok: true, refundableMicro: amount });
  });
