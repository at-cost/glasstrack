import Stripe from "stripe";
import { describe, expect, it } from "vitest";
import { stripeGateway } from "../src/billing/gateway";
import { loadConfig } from "../src/config";
import { testEnv } from "./env";

/**
 * Talks to a real Stripe sandbox. Skipped unless STRIPE_SANDBOX_KEY (an
 * sk_test_ key) is set, so CI and contributors never need Stripe access.
 */
const key = process.env.STRIPE_SANDBOX_KEY ?? "";
describe.skipIf(!key.startsWith("sk_test_"))("Stripe sandbox", () => {
  it("creates a customer and a USD Checkout session for a top-up", async () => {
    const config = loadConfig({ ...testEnv, STRIPE_SECRET_KEY: key, BILLING_ENABLED: "true" });
    const gw = stripeGateway(config);
    const run = `sandbox-test-${Date.now()}`;
    const customerId = await gw.ensureCustomer({ existingId: null, workspaceId: run, email: "sandbox-test@glasstrack.dev", name: "Sandbox test" });
    expect(customerId).toMatch(/^cus_/);
    const s = await gw.createTopupCheckout({
      customerId, amountCents: 2500, workspaceId: run, paymentId: run, saveCard: true,
      successUrl: "https://glasstrack.dev/ok", cancelUrl: "https://glasstrack.dev/cancel",
    });
    expect(s.url).toMatch(/^https:\/\/checkout\.stripe\.com\//);
    const stripe = new Stripe(key);
    const session = await stripe.checkout.sessions.retrieve(s.id);
    expect(session).toMatchObject({ amount_total: 2500, currency: "usd", mode: "payment", livemode: false });
    expect(session.metadata).toMatchObject({ kind: "topup", workspace_id: run, payment_id: run });
    await stripe.checkout.sessions.expire(s.id);
    await stripe.customers.del(customerId);
  });
});
