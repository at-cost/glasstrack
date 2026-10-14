import { sql } from "kysely";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { dailyCharge, GIB, usdToMicro } from "@glasstrack/shared";
import { balanceMicro, currentPriceMicro, runDailyBilling } from "../src/billing/service";
import { Client, createHarness, type Harness, setupWorkspace } from "./harness";

let h: Harness;
const PRICE_DAY = dailyCharge(usdToMicro(10));

beforeAll(async () => {
  h = await createHarness({ BILLING_ENABLED: "true", BILLING_STARTER_DOMAIN_LIMIT: "2" });
});
beforeEach(async () => {
  await h.reset();
  h.payments.setFailCharges(false);
});
afterAll(async () => {
  await h?.close();
});

const wsId = async (c: Client, slug: string) => (await c.ok("GET", `/api/v1/w/${slug}`)).id as string;
const billing = (c: Client, slug: string) => c.ok("GET", `/api/v1/w/${slug}/billing`);

async function webhook(event: object) {
  const { body, signature } = await h.payments.sign(event);
  return h.app.request("/api/v1/stripe/webhook", { method: "POST", headers: { "stripe-signature": signature, "content-type": "application/json" }, body });
}

/** Starts a top-up through the API and completes it with a signed webhook. */
async function topUp(c: Client, slug: string, usd: number, opts: { saveCard?: boolean; eventId?: string } = {}) {
  await c.ok("POST", `/api/v1/w/${slug}/billing/topup`, { amountUsd: usd, saveCard: opts.saveCard ?? false });
  const call = [...h.payments.calls].reverse().find((x) => x.method === "createTopupCheckout")!.args as { paymentId: string; workspaceId: string };
  const pi = `pi_${call.paymentId.slice(-8)}`;
  h.payments.fees.set(pi, Math.round(usd * 100 * 0.029 + 30));
  if (opts.saveCard) h.payments.cards.set(pi, { id: "pm_card_visa", label: "visa ending 4242" });
  const res = await webhook({
    id: opts.eventId ?? `evt_${call.paymentId}`, object: "event", type: "checkout.session.completed",
    data: { object: { id: `cs_${call.paymentId}`, object: "checkout.session", payment_status: "paid", payment_intent: pi, amount_total: usd * 100,
      metadata: { kind: "topup", workspace_id: call.workspaceId, payment_id: call.paymentId } } },
  });
  return { res, pi, paymentId: call.paymentId };
}

describe("starter credit", () => {
  it("gives a new workspace $10 once per verified email", async () => {
    const { c } = await setupWorkspace(h, "ann@acme.co", "acme");
    expect((await billing(c, "acme")).balanceMicro).toBe(usdToMicro(10));
    await c.ok("POST", "/api/v1/workspaces", { name: "Second", slug: "second" });
    expect((await billing(c, "second")).balanceMicro).toBe(0);
  });

  it("caps grants per company domain but not per public mail domain", async () => {
    await setupWorkspace(h, "a@corp.io", "corp-a");
    await setupWorkspace(h, "b@corp.io", "corp-b");
    const third = await setupWorkspace(h, "c@corp.io", "corp-c");
    expect((await billing(third.c, "corp-c")).balanceMicro).toBe(0);
    for (const [i, e] of ["x1@gmail.com", "x2@gmail.com", "x3@gmail.com"].entries()) {
      const w = await setupWorkspace(h, e, `gm-${i}`);
      expect((await billing(w.c, `gm-${i}`)).balanceMicro).toBe(usdToMicro(10));
    }
  });

  it("requires a verified email", async () => {
    const c = await new Client(h).login("unverified@x.co");
    await sql`UPDATE users SET email_verified_at = NULL`.execute(h.deps.dbs.owner);
    await c.ok("POST", "/api/v1/workspaces", { name: "U", slug: "unv" });
    expect((await billing(c, "unv")).balanceMicro).toBe(0);
  });

  it("is off entirely when billing is disabled (self-host default)", async () => {
    const off = await createHarness();
    try {
      await off.reset();
      const { c } = await setupWorkspace(off, "self@host.co", "selfhost");
      expect(await billing(c, "selfhost")).toEqual({ enabled: false });
      expect((await c.post("/api/v1/w/selfhost/billing/topup", { amountUsd: 10 })).status).toBe(400);
      expect(await runDailyBilling(off.deps)).toEqual({ workspaces: 0, charged: 0 });
    } finally {
      await off.close();
    }
  });
});

describe("daily charges", () => {
  it("charges the flat price pro-rata per day, catches up missed days, and is idempotent", async () => {
    const { c } = await setupWorkspace(h, "ann@acme.co", "acme");
    const id = await wsId(c, "acme");
    await sql`UPDATE workspaces SET created_at = now() - interval '2 days'`.execute(h.deps.dbs.owner);
    const r = await runDailyBilling(h.deps);
    expect(r.charged).toBe(3);
    expect(await balanceMicro(h.deps.dbs.system, id)).toBe(usdToMicro(10) - 3 * PRICE_DAY);
    expect((await runDailyBilling(h.deps)).charged).toBe(0);
    const tomorrow = new Date(Date.now() + 86_400_000);
    expect((await runDailyBilling(h.deps, tomorrow)).charged).toBe(1);
  });

  it("bills storage above 10 GB at cost", async () => {
    const { c, team } = await setupWorkspace(h, "ann@acme.co", "acme");
    const id = await wsId(c, "acme");
    const issue = await c.ok("POST", "/api/v1/w/acme/issues", { teamId: team.id, title: "big file" });
    await sql`INSERT INTO attachments (id, workspace_id, issue_id, storage_key, filename, content_type, size_bytes, uploaded_at)
      VALUES (gen_random_uuid(), ${id}, ${issue.id}, 'k', 'big.bin', 'application/octet-stream', ${30 * GIB}, now())`.execute(h.deps.dbs.owner);
    await runDailyBilling(h.deps);
    const b = await billing(c, "acme");
    const storageRows = b.ledger.filter((l: { kind: string }) => l.kind === "storage_charge");
    expect(storageRows).toHaveLength(1);
    expect(storageRows[0].amountMicro).toBe(-Math.round((20 * 23_000 * 12) / 365));
    expect(b.storage.overageDailyMicro).toBe(-storageRows[0].amountMicro);
  });
});

describe("running out", () => {
  it("grace for 7 days with warnings, then read-only; export keeps working; a top-up restores it", async () => {
    const { c, team } = await setupWorkspace(h, "ann@acme.co", "acme");
    await sql`UPDATE workspaces SET created_at = now() - interval '40 days'`.execute(h.deps.dbs.owner);
    await runDailyBilling(h.deps); // 31 days of charges > $10 starter
    let b = await billing(c, "acme");
    expect(b.balanceMicro).toBeLessThan(0);
    expect(b.status).toBe("grace");
    expect(h.mailer.last("ann@acme.co")?.subject).toBe("ACME: credit has run out");
    expect((await c.post("/api/v1/w/acme/issues", { teamId: team.id, title: "still works" })).status).toBe(201);

    const day = (n: number) => new Date(Date.now() + n * 86_400_000);
    h.mailer.outbox.length = 0;
    await runDailyBilling(h.deps, day(3));
    expect(h.mailer.outbox.map((m) => m.subject)).toEqual(["ACME: credit has run out"]);
    await runDailyBilling(h.deps, day(7));
    b = await billing(c, "acme");
    expect(b.status).toBe("read_only");
    expect(h.mailer.last("ann@acme.co")?.subject).toBe("ACME is now read-only");
    expect((await c.post("/api/v1/w/acme/issues", { teamId: team.id, title: "blocked" })).status).toBe(402);
    expect((await c.get("/api/v1/w/acme/issues")).status).toBe(200);
    expect((await c.post("/api/v1/w/acme/exports")).status).toBe(202);

    // Read-only workspaces are not charged further.
    const before = (await billing(c, "acme")).balanceMicro;
    await runDailyBilling(h.deps, day(9));
    expect((await billing(c, "acme")).balanceMicro).toBe(before);

    await topUp(c, "acme", 50);
    b = await billing(c, "acme");
    expect(b.status).toBe("active");
    expect(h.mailer.last("ann@acme.co")?.subject).toBe("ACME is active again");
    expect((await c.post("/api/v1/w/acme/issues", { teamId: team.id, title: "back" })).status).toBe(201);
  });
});

describe("top-ups via Stripe", () => {
  it("credits a paid Checkout session once, records the real fee, and ignores duplicates", async () => {
    const { c } = await setupWorkspace(h, "ann@acme.co", "acme");
    const { res, pi, paymentId } = await topUp(c, "acme", 25, { eventId: "evt_dup" });
    expect(res.status).toBe(200);
    // Same event again, and a different event for the same payment intent.
    const replay = await webhook({
      id: "evt_dup", object: "event", type: "checkout.session.completed",
      data: { object: { id: "cs_x", object: "checkout.session", payment_status: "paid", payment_intent: pi, amount_total: 2500,
        metadata: { kind: "topup", workspace_id: await wsId(c, "acme"), payment_id: paymentId } } },
    });
    expect(await replay.json()).toMatchObject({ duplicate: true });
    await webhook({
      id: "evt_other", object: "event", type: "checkout.session.completed",
      data: { object: { id: "cs_y", object: "checkout.session", payment_status: "paid", payment_intent: pi, amount_total: 2500,
        metadata: { kind: "topup", workspace_id: await wsId(c, "acme"), payment_id: paymentId } } },
    });
    const b = await billing(c, "acme");
    expect(b.balanceMicro).toBe(usdToMicro(35));
    expect(b.payments[0]).toMatchObject({ status: "succeeded", amountMicro: usdToMicro(25), feeMicro: (Math.round(2500 * 0.029) + 30) * 10_000 });
  });

  it("rejects bad signatures and unpaid sessions", async () => {
    const { c } = await setupWorkspace(h, "ann@acme.co", "acme");
    const bad = await h.app.request("/api/v1/stripe/webhook", { method: "POST", headers: { "stripe-signature": "t=1,v1=nope", "content-type": "application/json" }, body: "{}" });
    expect(bad.status).toBe(400);
    await c.ok("POST", "/api/v1/w/acme/billing/topup", { amountUsd: 10 });
    const call = h.payments.calls.find((x) => x.method === "createTopupCheckout")!.args as { paymentId: string; workspaceId: string };
    await webhook({
      id: "evt_unpaid", object: "event", type: "checkout.session.completed",
      data: { object: { id: "cs_u", object: "checkout.session", payment_status: "unpaid", payment_intent: "pi_u", amount_total: 1000,
        metadata: { kind: "topup", workspace_id: call.workspaceId, payment_id: call.paymentId } } },
    });
    expect((await billing(c, "acme")).balanceMicro).toBe(usdToMicro(10));
  });

  it("explains a payment provider failure instead of a generic error", async () => {
    const { c } = await setupWorkspace(h, "ann@acme.co", "acme");
    const original = h.payments.ensureCustomer;
    h.payments.ensureCustomer = async () => {
      throw new Error("Payments are not configured (set STRIPE_SECRET_KEY)");
    };
    try {
      const r = await c.post("/api/v1/w/acme/billing/topup", { amountUsd: 10 });
      expect(r.status).toBe(502);
      expect(r.body.error.message).toContain("Payments are not configured");
    } finally {
      h.payments.ensureCustomer = original;
    }
  });

  it("validates amounts and roles", async () => {
    const { c } = await setupWorkspace(h, "ann@acme.co", "acme");
    expect((await c.post("/api/v1/w/acme/billing/topup", { amountUsd: 1 })).status).toBe(400);
    expect((await c.post("/api/v1/w/acme/billing/topup", { amountUsd: 5000 })).status).toBe(400);
    const inv = await c.ok("POST", "/api/v1/w/acme/invites", { role: "member" });
    const m = await new Client(h).login("m@acme.co");
    await m.ok("POST", `/api/v1/invites/${inv.url.split("/").pop()}/accept`);
    expect((await m.post("/api/v1/w/acme/billing/topup", { amountUsd: 10 })).status).toBe(403);
    expect((await m.get("/api/v1/w/acme/billing")).status).toBe(200);
  });

  it("refunds reduce the balance", async () => {
    const { c } = await setupWorkspace(h, "ann@acme.co", "acme");
    const { pi } = await topUp(c, "acme", 20);
    await webhook({ id: "evt_ref", object: "event", type: "charge.refunded", data: { object: { id: "ch_1", object: "charge", payment_intent: pi, amount_refunded: 500, refunded: false } } });
    await webhook({ id: "evt_ref2", object: "event", type: "charge.refunded", data: { object: { id: "ch_1", object: "charge", payment_intent: pi, amount_refunded: 2000, refunded: true } } });
    expect((await billing(c, "acme")).balanceMicro).toBe(usdToMicro(10));
  });
});

describe("automatic top-up", () => {
  it("needs a saved card, charges it off-session below the threshold, credits on webhook", async () => {
    const { c } = await setupWorkspace(h, "ann@acme.co", "acme");
    expect((await c.put("/api/v1/w/acme/billing/auto-topup", { enabled: true, thresholdUsd: 5, amountUsd: 20 })).status).toBe(400);
    await topUp(c, "acme", 10, { saveCard: true });
    expect((await billing(c, "acme")).card).toBe("visa ending 4242");
    await c.ok("PUT", "/api/v1/w/acme/billing/auto-topup", { enabled: true, thresholdUsd: 25, amountUsd: 20 });
    await runDailyBilling(h.deps);
    const charge = h.payments.calls.find((x) => x.method === "chargeSavedCard")!.args as { paymentId: string; amountCents: number; workspaceId: string };
    expect(charge.amountCents).toBe(2000);
    const before = (await billing(c, "acme")).balanceMicro;
    await webhook({
      id: "evt_auto", object: "event", type: "payment_intent.succeeded",
      data: { object: { id: "pi_auto_x", object: "payment_intent", amount_received: 2000, metadata: { kind: "auto_topup", workspace_id: charge.workspaceId, payment_id: charge.paymentId } } },
    });
    expect((await billing(c, "acme")).balanceMicro).toBe(before + usdToMicro(20));
    // Only one automatic top-up per day.
    await runDailyBilling(h.deps);
    expect(h.payments.calls.filter((x) => x.method === "chargeSavedCard")).toHaveLength(1);
  });

  it("a declined card turns automatic top-up off and emails the admins", async () => {
    const { c } = await setupWorkspace(h, "ann@acme.co", "acme");
    await topUp(c, "acme", 10, { saveCard: true });
    await c.ok("PUT", "/api/v1/w/acme/billing/auto-topup", { enabled: true, thresholdUsd: 50, amountUsd: 20 });
    h.payments.setFailCharges(true);
    await runDailyBilling(h.deps);
    expect((await billing(c, "acme")).autoTopup.enabled).toBe(false);
    expect(h.mailer.last("ann@acme.co")?.subject).toBe("ACME: automatic top-up failed");
  });
});

describe("guarantees in the database", () => {
  it("the price can never go up, and price history can't be edited", async () => {
    await setupWorkspace(h, "ann@acme.co", "acme");
    const sys = h.deps.dbs.system;
    expect(await currentPriceMicro(h.deps)).toBe(usdToMicro(10)); // seeded on boot in production
    await expect(sys.insertInto("pricingConfig").values({ monthlyPriceMicro: usdToMicro(10.01), reason: "nope" }).execute()).rejects.toThrow(/only go down/);
    await sys.insertInto("pricingConfig").values({ monthlyPriceMicro: usdToMicro(9.5), reason: "cheaper" }).execute();
    await expect(sql`UPDATE pricing_config SET monthly_price_micro = 20000000`.execute(sys)).rejects.toThrow(/append-only/);
    await runDailyBilling(h.deps);
    const charge = await sys.selectFrom("creditLedger").select("amountMicro").where("kind", "=", "charge").executeTakeFirstOrThrow();
    expect(Number(charge.amountMicro)).toBe(-dailyCharge(usdToMicro(9.5)));
  });

  it("the ledger is append-only, even for the system role", async () => {
    await setupWorkspace(h, "ann@acme.co", "acme");
    const sys = h.deps.dbs.system;
    await expect(sql`UPDATE credit_ledger SET amount_micro = 999999999`.execute(sys)).rejects.toThrow(/append-only/);
    await expect(sql`DELETE FROM credit_ledger`.execute(sys)).rejects.toThrow(/append-only/);
  });

  it("financial records survive workspace deletion, without personal data", async () => {
    const { c } = await setupWorkspace(h, "ann@acme.co", "acme");
    const id = await wsId(c, "acme");
    await topUp(c, "acme", 10);
    await c.ok("DELETE", "/api/v1/w/acme", { confirm: "acme" });
    const kept = await sql<{ n: string }>`SELECT (SELECT count(*) FROM credit_ledger WHERE workspace_id = ${id}) + (SELECT count(*) FROM payments WHERE workspace_id = ${id}) AS n`.execute(h.deps.dbs.owner);
    expect(Number(kept.rows[0]!.n)).toBe(3); // starter grant, top-up, payment
    const acct = await sql<{ n: string }>`SELECT count(*) AS n FROM billing_accounts WHERE workspace_id = ${id}`.execute(h.deps.dbs.owner);
    expect(Number(acct.rows[0]!.n)).toBe(0); // Stripe customer link removed
  });
});
