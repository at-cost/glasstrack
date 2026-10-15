import Stripe from "stripe";
import type { PaymentGateway } from "../src/billing/gateway";

export const WEBHOOK_SECRET = "whsec_test_secret_for_glasstrack";
const stripe = new Stripe("sk_test_dummy");

/** Fake for outgoing calls; webhooks are signed and verified with the real SDK. */
export function fakeStripe() {
  let n = 0;
  const calls: { method: string; args: unknown }[] = [];
  const fees = new Map<string, number>();
  const cards = new Map<string, { id: string; label: string }>();
  let failCharges = false;
  const gw: PaymentGateway & {
    calls: typeof calls;
    fees: typeof fees;
    cards: typeof cards;
    setFailCharges(v: boolean): void;
    sign(event: object): Promise<{ body: string; signature: string }>;
  } = {
    calls,
    fees,
    cards,
    setFailCharges(v) {
      failCharges = v;
    },
    async ensureCustomer(p) {
      calls.push({ method: "ensureCustomer", args: p });
      return p.existingId ?? `cus_${++n}`;
    },
    async createTopupCheckout(p) {
      calls.push({ method: "createTopupCheckout", args: p });
      const id = `cs_test_${++n}`;
      return { id, url: `https://checkout.stripe.com/c/pay/${id}` };
    },
    async chargeSavedCard(p) {
      calls.push({ method: "chargeSavedCard", args: p });
      if (failCharges) throw new Error("Your card was declined.");
      return { paymentIntentId: `pi_auto_${++n}`, status: "succeeded" };
    },
    async refund(p) {
      calls.push({ method: "refund", args: p });
      return { id: `re_${++n}` };
    },
    async fetchFee(pi) {
      const fee = fees.get(pi);
      return fee === undefined ? null : { feeCents: fee, netCents: 0 };
    },
    async savedCard(pi) {
      return cards.get(pi) ?? null;
    },
    async verifyWebhook(raw, signature) {
      return stripe.webhooks.constructEventAsync(raw, signature, WEBHOOK_SECRET);
    },
    async sign(event) {
      const body = JSON.stringify(event);
      const signature = await stripe.webhooks.generateTestHeaderStringAsync({ payload: body, secret: WEBHOOK_SECRET });
      return { body, signature };
    },
  };
  return gw;
}
