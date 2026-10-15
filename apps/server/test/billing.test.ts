import { sql } from "kysely";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_PRICING, dailyCharge, daysInMonth, GIB, monthlyCost, usdToMicro } from "@glasstrack/shared";
import { balanceMicro, runDailyBilling } from "../src/billing/service";
import { Client, createHarness, type Harness, setupWorkspace } from "./harness";

let h: Harness;
const isoDay = (d: Date) => d.toISOString().slice(0, 10);
const daysAgo = (k: number) => isoDay(new Date(Date.now() - k * 86_400_000));

/** Shared server costs: $60/month for the months around now, as the operator would enter them. */
async function seedServerCosts(perMonthUsd = 60) {
  const from = new Date();
  for (let m = -2; m <= 1; m++) {
    const start = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth() + m, 1));
    const end = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth() + m + 1, 0));
    await sql`INSERT INTO cost_entries (id, period_start, period_end, category, source, amount_micro, public_label)
      VALUES (gen_random_uuid(), ${isoDay(start)}, ${isoDay(end)}, 'infrastructure', 'manual', ${usdToMicro(perMonthUsd)}, 'Servers')`.execute(h.deps.dbs.owner);
  }
}

/** What the module says one active workspace pays on `day` with this usage. */
const expectedDay = (day: string, p: { active: number; storageGb?: number; emails?: number; isActive?: boolean; fixedUsd?: number }) =>
  dailyCharge(monthlyCost({
    settings: DEFAULT_PRICING, sharedFixedMonthMicro: usdToMicro(p.fixedUsd ?? 60), activeWorkspaces: p.active,
    storageGb: p.storageGb ?? 0, emailsPerMonth: p.emails ?? 0, active: p.isActive ?? true,
  }), daysInMonth(day)).totalMicro;

beforeAll(async () => {
  h = await createHarness({ BILLING_ENABLED: "true", BILLING_STARTER_DOMAIN_LIMIT: "2", OPERATOR_EMAILS: "op@glasstrack.dev" });
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

describe("daily charges (pay-as-you-go)", () => {
  it("charges server share + usage + 20% per day from the shared module, catches up missed days, and is idempotent", async () => {
    await seedServerCosts(60);
    const { c } = await setupWorkspace(h, "ann@acme.co", "acme");
    const id = await wsId(c, "acme");
    await sql`UPDATE workspaces SET created_at = now() - interval '2 days'`.execute(h.deps.dbs.owner);
    const r = await runDailyBilling(h.deps);
    expect(r.charged).toBe(3);
    // 1 active workspace, $60 of servers: the share is capped at $5; $6/month with the 20%.
    const expected = [2, 1, 0].reduce((a, k) => a + expectedDay(daysAgo(k), { active: 1 }), 0);
    expect(await balanceMicro(h.deps.dbs.system, id)).toBe(usdToMicro(10) - expected);
    expect((await runDailyBilling(h.deps)).charged).toBe(0);
    const tomorrow = new Date(Date.now() + 86_400_000);
    expect((await runDailyBilling(h.deps, tomorrow)).charged).toBe(1);
    const b = await billing(c, "acme");
    expect(b.ledger.find((l: { kind: string }) => l.kind === "charge").memo).toMatch(/^Server \$0\.\d+, storage \$0\.00 \(0\.00 GB\), email \$0\.00, fees and reserve \$0\.\d+$/);
    expect(b.estimate.monthly.totalMicro).toBe(usdToMicro(6));
  });

  it("bills storage and email at cost plus 20%, from the same formula as the calculator", async () => {
    await seedServerCosts(60);
    const { c, team } = await setupWorkspace(h, "ann@acme.co", "acme");
    const id = await wsId(c, "acme");
    const issue = await c.ok("POST", "/api/v1/w/acme/issues", { teamId: team.id, title: "big file" });
    await sql`INSERT INTO attachments (id, workspace_id, issue_id, storage_key, filename, content_type, size_bytes, uploaded_at)
      VALUES (gen_random_uuid(), ${id}, ${issue.id}, 'k', 'big.bin', 'application/octet-stream', ${200 * GIB}, now())`.execute(h.deps.dbs.owner);
    await sql`INSERT INTO usage_daily (workspace_id, day, emails_sent) VALUES (${id}, ${daysAgo(1)}, 2000)`.execute(h.deps.dbs.owner);
    await runDailyBilling(h.deps);
    const b = await billing(c, "acme");
    // The test case from the spec: 200 GB and 2,000 emails, capped server share: about $11.76/month.
    expect(b.estimate.monthly.totalMicro / 1e6).toBeCloseTo(11.76, 2);
    const charge = b.ledger.find((l: { kind: string }) => l.kind === "charge");
    expect(charge.amountMicro).toBe(-expectedDay(daysAgo(0), { active: 1, storageGb: 200, emails: 2000 }));
    const parts = b.estimate.daily;
    expect(parts.serverShareMicro + parts.storageMicro + parts.emailMicro + parts.feesAndReserveMicro).toBe(parts.totalMicro);
  });

  it("splits the servers across active workspaces, and inactive workspaces pay only their storage and email", async () => {
    await seedServerCosts(60);
    const a = await setupWorkspace(h, "ann@acme.co", "acme");
    const others = [];
    for (let i = 0; i < 19; i++) others.push(await setupWorkspace(h, `u${i}@gmail.com`, `ws-${i}`));
    // ws-0 hasn't been used for 40 days.
    await sql`UPDATE workspace_members SET last_active_at = now() - interval '40 days' WHERE workspace_id = (SELECT id FROM workspaces WHERE slug = 'ws-0')`.execute(h.deps.dbs.owner);
    await runDailyBilling(h.deps);
    const today = daysAgo(0);
    // 19 active workspaces share $60: $3.16 each, under the $5 cap.
    expect(-(await billing(a.c, "acme")).ledger.find((l: { kind: string }) => l.kind === "charge").amountMicro).toBe(expectedDay(today, { active: 19 }));
    expect((await billing(others[0]!.c, "ws-0")).ledger.filter((l: { kind: string }) => l.kind === "charge")).toEqual([]); // no storage, no email: $0
  });

  it("emails once when the balance drops below 25% of the last credit, and resets after a top-up", async () => {
    await seedServerCosts(60);
    const { c } = await setupWorkspace(h, "ann@acme.co", "acme");
    const id = await wsId(c, "acme");
    await sql`UPDATE workspaces SET created_at = now() - interval '36 days'`.execute(h.deps.dbs.owner);
    // 31 catch-up days at about $0.20 a day: $10 to about $3.80, still above 25% ($2.50).
    await runDailyBilling(h.deps);
    expect(h.mailer.outbox.filter((m) => m.subject === "ACME: credit is running low")).toHaveLength(0);
    const day = (k: number) => new Date(Date.now() + k * 86_400_000);
    for (let k = 1; k <= 10; k++) await runDailyBilling(h.deps, day(k));
    expect(await balanceMicro(h.deps.dbs.system, id)).toBeLessThan(usdToMicro(2.5));
    expect(h.mailer.outbox.filter((m) => m.subject === "ACME: credit is running low")).toHaveLength(1);
  });
});

describe("running out", () => {
  it("grace for 7 days with warnings, then read-only; export keeps working; a top-up restores it", async () => {
    await seedServerCosts(60);
    const { c, team } = await setupWorkspace(h, "ann@acme.co", "acme");
    const id = await wsId(c, "acme");
    const issue = await c.ok("POST", "/api/v1/w/acme/issues", { teamId: team.id, title: "big file" });
    await sql`INSERT INTO attachments (id, workspace_id, issue_id, storage_key, filename, content_type, size_bytes, uploaded_at)
      VALUES (gen_random_uuid(), ${id}, ${issue.id}, 'k', 'big.bin', 'application/octet-stream', ${1000 * GIB}, now())`.execute(h.deps.dbs.owner);
    await sql`UPDATE workspaces SET created_at = now() - interval '40 days'`.execute(h.deps.dbs.owner);
    await runDailyBilling(h.deps); // 1 TB stored: about $33.60/month, so 31 days > $10 starter
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
    expect((await c.post("/api/v1/w/acme/billing/topup", { amountUsd: 9.99 })).status).toBe(400);
    expect((await c.post("/api/v1/w/acme/billing/topup", { amountUsd: 500.01 })).status).toBe(400);
    expect((await c.post("/api/v1/w/acme/billing/topup", { amountUsd: 500 })).status).toBe(200);
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

describe("monthly spending cap and refunds", () => {
  it("stops automatic top-ups once this month's top-ups would pass the cap", async () => {
    const { c } = await setupWorkspace(h, "ann@acme.co", "acme");
    await topUp(c, "acme", 10, { saveCard: true });
    expect((await c.put("/api/v1/w/acme/billing/auto-topup", { enabled: true, thresholdUsd: 50, amountUsd: 20, monthlyCapUsd: 10 })).status).toBe(400);
    await c.ok("PUT", "/api/v1/w/acme/billing/auto-topup", { enabled: true, thresholdUsd: 50, amountUsd: 20, monthlyCapUsd: 25 });
    expect((await billing(c, "acme")).monthlyCapMicro).toBe(usdToMicro(25));
    await runDailyBilling(h.deps);
    // $10 already topped up this month + $20 would be $30 > $25.
    expect(h.payments.calls.filter((x) => x.method === "chargeSavedCard")).toHaveLength(0);
    await c.ok("PUT", "/api/v1/w/acme/billing/auto-topup", { enabled: true, thresholdUsd: 50, amountUsd: 20, monthlyCapUsd: null });
    await runDailyBilling(h.deps);
    expect(h.payments.calls.filter((x) => x.method === "chargeSavedCard")).toHaveLength(1);
  });

  it("refunds unused paid credit on request, never the signup credit", async () => {
    const { c } = await setupWorkspace(h, "ann@acme.co", "acme");
    const id = await wsId(c, "acme");
    expect((await c.post("/api/v1/w/acme/billing/refund-request", {})).status).toBe(400); // only signup credit
    await topUp(c, "acme", 30);
    const req = await c.ok("POST", "/api/v1/w/acme/billing/refund-request", {});
    expect(req.refundableMicro).toBe(usdToMicro(30));
    expect(h.mailer.last("op@glasstrack.dev")?.subject).toBe("Refund requested: ACME");
    const op = await new Client(h).login("op@glasstrack.dev");
    const overview = await op.ok("GET", "/api/v1/admin/overview");
    expect(overview.refundRequests).toEqual([expect.objectContaining({ workspaceId: id, refundableMicro: usdToMicro(30) })]);
    expect((await c.post(`/api/v1/admin/refunds/${id}`, {})).status).toBe(403);
    const r = await op.ok("POST", `/api/v1/admin/refunds/${id}`, {});
    expect(r.refundedMicro).toBe(usdToMicro(30));
    expect(h.payments.calls.find((x) => x.method === "refund")!.args).toMatchObject({ amountCents: 3000 });
    const b = await billing(c, "acme");
    expect(b.balanceMicro).toBe(usdToMicro(10)); // the signup credit stays
    expect(b.refundRequestedAt).toBeNull();
    // Nothing more to refund; a second run is a no-op.
    expect((await op.ok("POST", `/api/v1/admin/refunds/${id}`, {})).refundedMicro).toBe(0);
  });

  it("refunds every workspace if the service closes", async () => {
    const a = await setupWorkspace(h, "ann@acme.co", "acme");
    const b = await setupWorkspace(h, "bob@gmail.com", "bravo");
    await topUp(a.c, "acme", 20);
    await topUp(b.c, "bravo", 50);
    const op = await new Client(h).login("op@glasstrack.dev");
    expect((await op.post("/api/v1/admin/refunds-all", { confirm: "yes" })).status).toBe(400);
    const r = await op.ok("POST", "/api/v1/admin/refunds-all", { confirm: "refund every workspace" });
    expect(r).toMatchObject({ workspaces: 2, refundedMicro: usdToMicro(70), failed: [] });
  });
});

describe("guarantees in the database", () => {
  it("the server share cap can never go up, and settings history can't be edited", async () => {
    await seedServerCosts(60);
    await setupWorkspace(h, "ann@acme.co", "acme");
    const sys = h.deps.dbs.system;
    const row = (cap: number) => ({
      signupCreditUsd: 10, serverShareCapUsd: cap, feeMarkup: 0.2, minTopupUsd: 10, maxTopupUsd: 500, storageUsdPerGbMonth: 0.023,
      emailUsdPerThousand: 0.1, stripeFeePercent: 0.0315, stripeFeeFixedUsd: 0.27, reserveTargetMonths: 3, reason: "test",
    });
    await expect(sys.insertInto("pricingSettings").values(row(5.01)).execute()).rejects.toThrow(/only go down/);
    await sys.insertInto("pricingSettings").values(row(2)).execute();
    await expect(sql`UPDATE pricing_settings SET server_share_cap_usd = 20`.execute(sys)).rejects.toThrow(/append-only/);
    await runDailyBilling(h.deps);
    const charge = await sys.selectFrom("creditLedger").select("amountMicro").where("kind", "=", "charge").executeTakeFirstOrThrow();
    // $60 / 1 workspace is capped at the new $2: $2.40/month with the 20%.
    expect(Number(charge.amountMicro)).toBe(-dailyCharge(monthlyCost({ settings: { ...DEFAULT_PRICING, serverShareCapUsd: 2 }, sharedFixedMonthMicro: 60e6, activeWorkspaces: 1, storageGb: 0, emailsPerMonth: 0 }), daysInMonth(daysAgo(0))).totalMicro);
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
