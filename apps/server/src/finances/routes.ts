import { Hono } from "hono";
import { z } from "zod";
import { assertCapNotIncreased, DEFAULT_PRICING, type PricingSettings, usdToMicro, validatePricingSettings } from "@glasstrack/shared";
import { loadSettings } from "../billing/pricing";
import { balanceMicro, refundableMicro, refundAll, refundUnusedCredit } from "../billing/service";
import { type AppEnv, type Ctx, requireUser } from "../context";
import { ApiError, badRequest, forbidden, notFound } from "../lib/errors";
import { uuid7 } from "../lib/ids";
import { clearPublicCache, financesCsv, getPublicFinances, getPublicPricing } from "./public";
import { addDays, CATEGORY_LABELS, financesEnabled, isoDay, recompute } from "./service";

const n = (v: unknown) => Number(v ?? 0);

/**
 * Public, no sign-in. Aggregates only: nothing here is per workspace, and no
 * workspace id, name or slug ever appears. Same data as the website pages.
 */
export const publicFinanceRoutes = new Hono<AppEnv>()
  .get("/finances", async (c) => {
    if (!financesEnabled(c.get("deps").config)) throw notFound("This server does not publish finances");
    c.header("Cache-Control", "public, max-age=600");
    return c.json(await getPublicFinances(c.get("deps")));
  })
  .get("/finances.csv", async (c) => {
    if (!financesEnabled(c.get("deps").config)) throw notFound("This server does not publish finances");
    c.header("Content-Type", "text/csv; charset=utf-8");
    c.header("Content-Disposition", 'attachment; filename="glasstrack-finances.csv"');
    return c.body(financesCsv(await getPublicFinances(c.get("deps"))));
  })
  .get("/pricing", async (c) => {
    c.header("Cache-Control", "public, max-age=600");
    return c.json(await getPublicPricing(c.get("deps")));
  });

function requireOperator(c: Ctx) {
  const user = requireUser(c);
  const deps = c.get("deps");
  if (!financesEnabled(deps.config)) throw notFound();
  if (!deps.config.operatorEmails.includes(user.email.toLowerCase())) throw forbidden("Operators only");
  return user;
}

const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const costSchema = z.object({
  periodStart: day,
  periodEnd: day,
  category: z.enum(["infrastructure", "email", "storage", "domain", "tools", "ai", "other"]),
  amountUsd: z.number().min(0).max(1_000_000),
  publicLabel: z.string().trim().min(1).max(60).optional(),
  note: z.string().max(500).optional(),
  /** Shown at list price but paid with provider credits (e.g. AWS credits). */
  paidByCredits: z.boolean().optional(),
}).refine((x) => x.periodStart <= x.periodEnd, "periodEnd must be on or after periodStart");

const settingsSchema = z.object({
  signupCreditUsd: z.number(),
  serverShareCapUsd: z.number(),
  feeMarkup: z.number(),
  minTopupUsd: z.number(),
  maxTopupUsd: z.number(),
  storageUsdPerGbMonth: z.number(),
  emailUsdPer1000: z.number(),
  stripeFeePercent: z.number(),
  stripeFeeFixedUsd: z.number(),
  reserveTargetMonths: z.number(),
}).partial();

const toSettingsRow = (s: PricingSettings) => ({
  signupCreditUsd: s.signupCreditUsd, serverShareCapUsd: s.serverShareCapUsd, feeMarkup: s.feeMarkup, minTopupUsd: s.minTopupUsd, maxTopupUsd: s.maxTopupUsd,
  storageUsdPerGbMonth: s.storageUsdPerGbMonth, emailUsdPerThousand: s.emailUsdPer1000, stripeFeePercent: s.stripeFeePercent,
  stripeFeeFixedUsd: s.stripeFeeFixedUsd, reserveTargetMonths: s.reserveTargetMonths,
});

/** Operator admin: costs, pricing settings, savings log, refunds. */
export const adminRoutes = new Hono<AppEnv>()
  .get("/overview", async (c) => {
    requireOperator(c);
    const deps = c.get("deps");
    const sys = deps.dbs.system;
    const [costs, settings, settingsHistory, savings, refundRequests, finances] = await Promise.all([
      sys.selectFrom("costEntries").selectAll().orderBy("periodStart", "desc").limit(500).execute(),
      loadSettings(sys),
      sys.selectFrom("pricingSettings").selectAll().orderBy("id", "desc").limit(50).execute(),
      sys.selectFrom("costSavings").selectAll().orderBy("day", "desc").execute(),
      sys.selectFrom("billingAccounts as b").innerJoin("workspaces as w", "w.id", "b.workspaceId")
        .select(["w.id", "w.name", "w.slug", "b.refundRequestedAt"]).where("b.refundRequestedAt", "is not", null).orderBy("b.refundRequestedAt").execute(),
      getPublicFinances(deps),
    ]);
    return c.json({
      billingEnabled: deps.config.BILLING_ENABLED,
      awsConfigured: deps.config.AWS_COST_EXPLORER_ENABLED,
      categories: CATEGORY_LABELS,
      settings,
      defaults: DEFAULT_PRICING,
      settingsHistory: settingsHistory.map((r) => ({
        id: r.id, effectiveFrom: r.effectiveFrom.toISOString(), reason: r.reason, createdBy: r.createdBy,
        serverShareCapUsd: n(r.serverShareCapUsd), signupCreditUsd: n(r.signupCreditUsd), feeMarkup: n(r.feeMarkup), minTopupUsd: n(r.minTopupUsd),
        maxTopupUsd: n(r.maxTopupUsd), storageUsdPerGbMonth: n(r.storageUsdPerGbMonth), emailUsdPer1000: n(r.emailUsdPerThousand),
        stripeFeePercent: n(r.stripeFeePercent), stripeFeeFixedUsd: n(r.stripeFeeFixedUsd), reserveTargetMonths: n(r.reserveTargetMonths),
      })),
      finances,
      costs: costs.map((e) => ({ ...e, amountMicro: n(e.amountMicro), createdAt: e.createdAt.toISOString() })),
      savings: savings.map((s) => ({ id: s.id, day: s.day, change: s.change, savingMonthMicro: n(s.savingMonthMicro), createdBy: s.createdBy })),
      refundRequests: await Promise.all(refundRequests.map(async (r) => ({
        workspaceId: r.id, name: r.name, slug: r.slug, requestedAt: r.refundRequestedAt!.toISOString(),
        balanceMicro: await balanceMicro(sys, r.id), refundableMicro: await refundableMicro(sys, r.id),
      }))),
    });
  })
  .post("/costs", async (c) => {
    const user = requireOperator(c);
    const body = costSchema.parse(await c.req.json());
    const id = uuid7();
    await c.get("deps").dbs.system.insertInto("costEntries").values({
      id, periodStart: body.periodStart, periodEnd: body.periodEnd, category: body.category, source: "manual",
      amountMicro: usdToMicro(body.amountUsd), publicLabel: body.publicLabel ?? CATEGORY_LABELS[body.category]!, note: body.note ?? null,
      paidByCredits: body.paidByCredits ?? false, createdBy: user.email,
    }).execute();
    clearPublicCache();
    return c.json({ id }, 201);
  })
  .patch("/costs/:id", async (c) => {
    requireOperator(c);
    const body = costSchema.parse(await c.req.json());
    const r = await c.get("deps").dbs.system.updateTable("costEntries").set({
      periodStart: body.periodStart, periodEnd: body.periodEnd, category: body.category, amountMicro: usdToMicro(body.amountUsd),
      publicLabel: body.publicLabel ?? CATEGORY_LABELS[body.category]!, note: body.note ?? null, paidByCredits: body.paidByCredits ?? false,
    }).where("id", "=", c.req.param("id")).where("source", "=", "manual").executeTakeFirst();
    if (!r.numUpdatedRows) throw notFound("Manual cost entry not found");
    clearPublicCache();
    return c.json({ ok: true });
  })
  .delete("/costs/:id", async (c) => {
    requireOperator(c);
    const r = await c.get("deps").dbs.system.deleteFrom("costEntries").where("id", "=", c.req.param("id")).where("source", "=", "manual").executeTakeFirst();
    if (!r.numDeletedRows) throw notFound("Manual cost entry not found");
    clearPublicCache();
    return c.json({ ok: true });
  })
  /** New pricing settings version. The server share cap can only go down (also enforced by the database). */
  .post("/pricing", async (c) => {
    const user = requireOperator(c);
    const deps = c.get("deps");
    const body = settingsSchema.extend({ reason: z.string().trim().min(3).max(300) }).parse(await c.req.json());
    const { id: curId, effectiveFrom: _from, ...cur } = await loadSettings(deps.dbs.system);
    const { reason, ...changes } = body;
    const next: PricingSettings = { ...cur, ...changes };
    const problem = validatePricingSettings(next);
    if (problem) throw badRequest(problem);
    try {
      assertCapNotIncreased(curId === null ? null : cur.serverShareCapUsd, next.serverShareCapUsd);
    } catch (e) {
      throw badRequest((e as Error).message);
    }
    await deps.dbs.system.insertInto("pricingSettings").values({ ...toSettingsRow(next), reason, createdBy: user.email }).execute();
    clearPublicCache();
    return c.json(await loadSettings(deps.dbs.system), 201);
  })
  .post("/savings", async (c) => {
    const user = requireOperator(c);
    const body = z.object({ day, change: z.string().trim().min(3).max(300), savingMonthUsd: z.number().min(0).max(1_000_000) }).parse(await c.req.json());
    const id = uuid7();
    await c.get("deps").dbs.system.insertInto("costSavings").values({ id, day: body.day, change: body.change, savingMonthMicro: usdToMicro(body.savingMonthUsd), createdBy: user.email }).execute();
    clearPublicCache();
    return c.json({ id }, 201);
  })
  .delete("/savings/:id", async (c) => {
    requireOperator(c);
    const r = await c.get("deps").dbs.system.deleteFrom("costSavings").where("id", "=", c.req.param("id")).executeTakeFirst();
    if (!r.numDeletedRows) throw notFound("Not found");
    clearPublicCache();
    return c.json({ ok: true });
  })
  /** Refund a workspace's unused paid credit through Stripe. */
  .post("/refunds/:workspaceId", async (c) => {
    const user = requireOperator(c);
    const deps = c.get("deps");
    if (!deps.config.BILLING_ENABLED) throw badRequest("Billing is not enabled");
    try {
      const refunded = await refundUnusedCredit(deps, c.req.param("workspaceId"), user.email);
      return c.json({ refundedMicro: refunded });
    } catch (err) {
      throw new ApiError(502, "payment_provider", `Refund failed: ${String((err as Error).message ?? err)}`);
    }
  })
  /** Service closing: refund every workspace. Needs the exact confirmation phrase. */
  .post("/refunds-all", async (c) => {
    const user = requireOperator(c);
    const deps = c.get("deps");
    if (!deps.config.BILLING_ENABLED) throw badRequest("Billing is not enabled");
    z.object({ confirm: z.literal("refund every workspace") }).parse(await c.req.json());
    return c.json(await refundAll(deps, user.email));
  })
  .post("/finances/recompute", async (c) => {
    requireOperator(c);
    const body = z.object({ from: day, to: day.optional() }).parse(await c.req.json());
    const days = await recompute(c.get("deps"), body.from, body.to ?? isoDay(new Date()));
    clearPublicCache();
    return c.json({ days, to: body.to ?? addDays(isoDay(new Date()), 0) });
  })
  .get("/me", (c) => {
    const user = c.get("user");
    const deps = c.get("deps");
    return c.json({ operator: Boolean(user && financesEnabled(deps.config) && deps.config.operatorEmails.includes(user.email.toLowerCase())) });
  });
