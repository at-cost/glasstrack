import Stripe from "stripe";
import type { Config } from "../config";

/** The slice of Stripe that billing uses, so tests can swap in a fake. */
export interface PaymentGateway {
  ensureCustomer(p: { existingId: string | null; workspaceId: string; email: string; name: string }): Promise<string>;
  createTopupCheckout(p: {
    customerId: string;
    amountCents: number;
    workspaceId: string;
    paymentId: string;
    saveCard: boolean;
    successUrl: string;
    cancelUrl: string;
  }): Promise<{ id: string; url: string }>;
  /** Off-session charge of the saved card (auto top-up). */
  chargeSavedCard(p: {
    customerId: string;
    paymentMethodId: string;
    amountCents: number;
    workspaceId: string;
    paymentId: string;
  }): Promise<{ paymentIntentId: string; status: string }>;
  /** Actual Stripe fee in USD cents, from the balance transaction. null while not yet available. */
  fetchFee(paymentIntentId: string): Promise<{ feeCents: number; netCents: number } | null>;
  /** Card saved during a Checkout payment, if the customer agreed to save it. */
  savedCard(paymentIntentId: string): Promise<{ id: string; label: string } | null>;
  verifyWebhook(rawBody: string, signature: string): Promise<Stripe.Event>;
}

export function stripeGateway(config: Config): PaymentGateway {
  const stripe = new Stripe(config.STRIPE_SECRET_KEY, { appInfo: { name: "Glasstrack" }, maxNetworkRetries: 2 });
  return {
    async ensureCustomer({ existingId, workspaceId, email, name }) {
      if (existingId) return existingId;
      const c = await stripe.customers.create(
        { email, name, metadata: { workspace_id: workspaceId } },
        { idempotencyKey: `customer:${workspaceId}` },
      );
      return c.id;
    },
    async createTopupCheckout(p) {
      const s = await stripe.checkout.sessions.create(
        {
          mode: "payment",
          customer: p.customerId,
          client_reference_id: p.workspaceId,
          line_items: [
            {
              quantity: 1,
              price_data: {
                currency: "usd",
                unit_amount: p.amountCents,
                product_data: { name: "Glasstrack credit", description: "Prepaid credit for your workspace. Charged daily at cost." },
              },
            },
          ],
          payment_intent_data: {
            metadata: { workspace_id: p.workspaceId, payment_id: p.paymentId, kind: "topup" },
            ...(p.saveCard ? { setup_future_usage: "off_session" as const } : {}),
          },
          metadata: { workspace_id: p.workspaceId, payment_id: p.paymentId, kind: "topup" },
          success_url: p.successUrl,
          cancel_url: p.cancelUrl,
        },
        { idempotencyKey: `checkout:${p.paymentId}` },
      );
      if (!s.url) throw new Error("Stripe did not return a Checkout URL");
      return { id: s.id, url: s.url };
    },
    async chargeSavedCard(p) {
      const pi = await stripe.paymentIntents.create(
        {
          amount: p.amountCents,
          currency: "usd",
          customer: p.customerId,
          payment_method: p.paymentMethodId,
          off_session: true,
          confirm: true,
          description: "Glasstrack credit (automatic top-up)",
          metadata: { workspace_id: p.workspaceId, payment_id: p.paymentId, kind: "auto_topup" },
        },
        { idempotencyKey: `autotopup:${p.paymentId}` },
      );
      return { paymentIntentId: pi.id, status: pi.status };
    },
    async fetchFee(paymentIntentId) {
      const pi = await stripe.paymentIntents.retrieve(paymentIntentId, { expand: ["latest_charge.balance_transaction"] });
      const charge = pi.latest_charge as Stripe.Charge | null;
      const bt = charge?.balance_transaction as Stripe.BalanceTransaction | null | undefined;
      if (!bt || typeof bt === "string") return null;
      // Fees are reported in the settlement currency; convert back to USD when it differs.
      // exchange_rate: amount_in_charge_currency × rate = amount_in_settlement_currency.
      const toUsd = (n: number) => (bt.currency === "usd" || !bt.exchange_rate ? n : Math.round(n / bt.exchange_rate));
      const feeCents = toUsd(bt.fee);
      return { feeCents, netCents: pi.amount_received - feeCents };
    },
    async savedCard(paymentIntentId) {
      const pi = await stripe.paymentIntents.retrieve(paymentIntentId, { expand: ["payment_method"] });
      if (!pi.setup_future_usage) return null;
      const pm = pi.payment_method as Stripe.PaymentMethod | null;
      if (!pm || typeof pm === "string") return null;
      const label = pm.card ? `${pm.card.brand} ending ${pm.card.last4}` : pm.type;
      return { id: pm.id, label };
    },
    async verifyWebhook(rawBody, signature) {
      return stripe.webhooks.constructEventAsync(rawBody, signature, config.STRIPE_WEBHOOK_SECRET);
    },
  };
}

/** Billing off, or Stripe not configured: every call explains why. */
export function disabledGateway(): PaymentGateway {
  const no = async (): Promise<never> => {
    throw new Error("Payments are not configured (set STRIPE_SECRET_KEY)");
  };
  return { ensureCustomer: no, createTopupCheckout: no, chargeSavedCard: no, fetchFee: no, savedCard: no, verifyWebhook: no };
}

