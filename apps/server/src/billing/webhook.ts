import { Hono } from "hono";
import type Stripe from "stripe";
import type { AppEnv, Deps } from "../context";
import { logger } from "../lib/logger";
import { addLedger, creditPayment, refreshStatus } from "./service";

/**
 * POST /api/v1/stripe/webhook. Signature-verified, and idempotent twice over:
 * events are recorded by id, and every ledger write has its own unique key, so
 * a retried or duplicated event can never credit twice.
 */
export const stripeWebhookRoutes = new Hono<AppEnv>().post("/webhook", async (c) => {
  const deps = c.get("deps");
  if (!deps.config.BILLING_ENABLED) return c.json({ error: { code: "not_found", message: "Not found" } }, 404);
  const raw = await c.req.text();
  const signature = c.req.header("stripe-signature") ?? "";
  let event: Stripe.Event;
  try {
    event = await deps.payments.verifyWebhook(raw, signature);
  } catch (err) {
    logger.warn({ err: String(err) }, "stripe webhook signature rejected");
    return c.json({ error: { code: "bad_signature", message: "Invalid signature" } }, 400);
  }
  const sys = deps.dbs.system;
  await sys.insertInto("stripeEvents").values({ eventId: event.id, type: event.type }).onConflict((oc) => oc.column("eventId").doNothing()).execute();
  const seen = await sys.selectFrom("stripeEvents").select("processedAt").where("eventId", "=", event.id).executeTakeFirstOrThrow();
  if (seen.processedAt) return c.json({ ok: true, duplicate: true });
  await handleEvent(deps, event);
  await sys.updateTable("stripeEvents").set({ processedAt: new Date() }).where("eventId", "=", event.id).execute();
  return c.json({ ok: true });
});

async function workspaceExists(deps: Deps, id: string | undefined): Promise<boolean> {
  if (!id) return false;
  return Boolean(await deps.dbs.system.selectFrom("workspaces").select("id").where("id", "=", id).executeTakeFirst());
}

export async function handleEvent(deps: Deps, event: Stripe.Event): Promise<void> {
  const sys = deps.dbs.system;
  switch (event.type) {
    case "checkout.session.completed":
    case "checkout.session.async_payment_succeeded": {
      const s = event.data.object as Stripe.Checkout.Session;
      const meta = s.metadata ?? {};
      if (meta.kind !== "topup" || s.payment_status !== "paid") return;
      const ws = meta.workspace_id;
      const pi = typeof s.payment_intent === "string" ? s.payment_intent : s.payment_intent?.id;
      if (!ws || !(await workspaceExists(deps, ws)) || !pi || !meta.payment_id) return;
      await creditPayment(deps, { paymentId: meta.payment_id, workspaceId: ws, paymentIntentId: pi, amountCents: s.amount_total ?? 0, kind: "topup", checkoutSessionId: s.id });
      const card = await deps.payments.savedCard(pi).catch(() => null);
      if (card) {
        await sys.updateTable("billingAccounts").set({ defaultPaymentMethod: card.id, cardLabel: card.label, updatedAt: new Date() })
          .where("workspaceId", "=", ws).execute();
      }
      return;
    }
    case "checkout.session.expired": {
      const s = event.data.object as Stripe.Checkout.Session;
      if (s.metadata?.payment_id) {
        await sys.updateTable("payments").set({ status: "failed" }).where("id", "=", s.metadata.payment_id).where("status", "=", "pending").execute();
      }
      return;
    }
    case "payment_intent.succeeded": {
      const pi = event.data.object as Stripe.PaymentIntent;
      const meta = pi.metadata ?? {};
      if (meta.kind !== "auto_topup" || !meta.payment_id || !meta.workspace_id || !(await workspaceExists(deps, meta.workspace_id))) return;
      await creditPayment(deps, { paymentId: meta.payment_id, workspaceId: meta.workspace_id, paymentIntentId: pi.id, amountCents: pi.amount_received, kind: "auto_topup" });
      return;
    }
    case "payment_intent.payment_failed": {
      const pi = event.data.object as Stripe.PaymentIntent;
      if (pi.metadata?.kind === "auto_topup" && pi.metadata.payment_id) {
        await sys.updateTable("payments").set({ status: "failed" }).where("id", "=", pi.metadata.payment_id).execute();
      }
      return;
    }
    case "charge.refunded": {
      const ch = event.data.object as Stripe.Charge;
      const piId = typeof ch.payment_intent === "string" ? ch.payment_intent : ch.payment_intent?.id;
      if (!piId) return;
      const pay = await sys.selectFrom("payments").select(["id", "workspaceId"]).where("stripePaymentIntentId", "=", piId).executeTakeFirst();
      if (!pay) return;
      // Refunds are cumulative on the charge; record the total refunded so far once.
      const prior = await sys.selectFrom("creditLedger").select((eb) => eb.fn.coalesce(eb.fn.sum<string>("amountMicro"), eb.val("0")).as("s"))
        .where("refType", "=", "refund").where("refId", "=", ch.id).executeTakeFirstOrThrow();
      const delta = ch.amount_refunded * 10_000 + Number(prior.s);
      if (delta > 0) {
        await addLedger(sys, { workspaceId: pay.workspaceId, kind: "refund", amountMicro: -delta, key: `refund:${ch.id}:${ch.amount_refunded}`, refType: "refund", refId: ch.id, memo: "Refund", createdBy: "stripe" });
      }
      if (ch.refunded) await sys.updateTable("payments").set({ status: "refunded" }).where("id", "=", pay.id).execute();
      await refreshStatus(deps, pay.workspaceId);
      return;
    }
    default:
      return;
  }
}
