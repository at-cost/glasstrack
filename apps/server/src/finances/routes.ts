import { Hono } from "hono";
import { z } from "zod";
import { assertPriceNotIncreased, formatUsd, MARGIN_BUILDING_RESERVE, MARGIN_RESERVE_FULL, RESERVE_TARGET_MONTHS, usdToMicro } from "@glasstrack/shared";
import { currentPriceMicro } from "../billing/service";
import { type AppEnv, type Ctx, requireUser } from "../context";
import { toCsv } from "../lib/csv";
import { badRequest, forbidden, notFound } from "../lib/errors";
import { uuid7 } from "../lib/ids";
import { addDays, CATEGORY_LABELS, isoDay, recompute } from "./service";

const n = (v: unknown) => Number(v ?? 0);

const FORMULA = {
  allocation: "workspace_cost = shared_costs × (workspace active members ÷ all active members) + storage_GB × storage_rate + emails × email_rate + its payment fees",
  price: `recommended_price = (monthly costs ÷ paying workspaces) × (1 + margin). Margin is ${MARGIN_BUILDING_RESERVE * 100}% until the reserve covers ${RESERVE_TARGET_MONTHS} months of costs, then ${MARGIN_RESERVE_FULL * 100}%. The price is never raised.`,
};

async function history(c: Ctx, days: number) {
  const rows = await c.get("deps").dbs.system.selectFrom("financeDaily").selectAll()
    .where("day", ">", addDays(isoDay(new Date()), -days)).orderBy("day").execute();
  return rows.map((r) => ({
    day: r.day,
    revenueMicro: n(r.revenueMicro),
    starterCreditUsedMicro: n(r.starterUsedMicro),
    costs: r.costs as Record<string, number>,
    paymentFeesMicro: n(r.paymentFeesMicro),
    totalCostMicro: n(r.totalCostMicro),
    activeWorkspaces: r.activeWorkspaces,
    payingWorkspaces: r.payingWorkspaces,
    costPerWorkspaceMicro: n(r.costPerWorkspaceMicro),
    reserveMicro: n(r.reserveMicro),
    reserveTargetMicro: n(r.reserveTargetMicro),
    priceMicro: n(r.priceMicro),
    recommendedPriceMicro: r.recommendedPriceMicro === null ? null : n(r.recommendedPriceMicro),
    marginBp: r.marginBp,
  }));
}

/**
 * Public, no sign-in. Aggregates only: nothing here is per workspace, and no
 * workspace id, name or slug ever appears.
 */
export const publicFinanceRoutes = new Hono<AppEnv>()
  .get("/finances", async (c) => {
    const deps = c.get("deps");
    if (!deps.config.BILLING_ENABLED) throw notFound("This server does not publish finances");
    const days = Math.min(Math.max(Number(c.req.query("days") ?? 365) || 365, 7), 3650);
    const rows = await history(c, days);
    const pricing = await deps.dbs.system.selectFrom("pricingConfig").select(["effectiveFrom", "monthlyPriceMicro", "reason"]).orderBy("id").execute();
    c.header("Cache-Control", "public, max-age=600");
    return c.json({
      currency: "USD",
      currentPriceMicro: await currentPriceMicro(deps),
      latest: rows.at(-1) ?? null,
      formula: FORMULA,
      priceHistory: pricing.map((p) => ({ from: p.effectiveFrom.toISOString(), monthlyPriceMicro: n(p.monthlyPriceMicro), reason: p.reason })),
      history: rows,
    });
  })
  .get("/finances.csv", async (c) => {
    const deps = c.get("deps");
    if (!deps.config.BILLING_ENABLED) throw notFound("This server does not publish finances");
    const rows = await history(c, 3650);
    const labels = [...new Set(rows.flatMap((r) => Object.keys(r.costs)))].sort();
    const usd = (m: number | null) => (m === null ? "" : (m / 1_000_000).toFixed(6));
    const csv = toCsv(
      rows.map((r) => ({
        day: r.day,
        revenue_usd: usd(r.revenueMicro),
        starter_credit_used_usd: usd(r.starterCreditUsedMicro),
        ...Object.fromEntries(labels.map((l) => [`cost:${l}`, usd(r.costs[l] ?? 0)])),
        payment_fees_usd: usd(r.paymentFeesMicro),
        total_cost_usd: usd(r.totalCostMicro),
        active_workspaces: r.activeWorkspaces,
        paying_workspaces: r.payingWorkspaces,
        cost_per_workspace_usd: usd(r.costPerWorkspaceMicro),
        reserve_usd: usd(r.reserveMicro),
        reserve_target_usd: usd(r.reserveTargetMicro),
        price_usd: usd(r.priceMicro),
        recommended_price_usd: usd(r.recommendedPriceMicro),
        margin_percent: (r.marginBp / 100).toFixed(2),
      })),
      ["day", "revenue_usd", "starter_credit_used_usd", ...labels.map((l) => `cost:${l}`), "payment_fees_usd", "total_cost_usd", "active_workspaces",
        "paying_workspaces", "cost_per_workspace_usd", "reserve_usd", "reserve_target_usd", "price_usd", "recommended_price_usd", "margin_percent"],
    );
    c.header("Content-Type", "text/csv; charset=utf-8");
    c.header("Content-Disposition", 'attachment; filename="glasstrack-finances.csv"');
    return c.body(csv);
  });

function requireOperator(c: Ctx) {
  const user = requireUser(c);
  const deps = c.get("deps");
  if (!deps.config.BILLING_ENABLED) throw notFound();
  if (!deps.config.operatorEmails.includes(user.email.toLowerCase())) throw forbidden("Operators only");
  return user;
}

const costSchema = z.object({
  periodStart: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  periodEnd: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  category: z.enum(["infrastructure", "email", "storage", "domain", "tools", "ai", "other"]),
  amountUsd: z.number().min(0).max(1_000_000),
  publicLabel: z.string().trim().min(1).max(60).optional(),
  note: z.string().max(500).optional(),
}).refine((x) => x.periodStart <= x.periodEnd, "periodEnd must be on or after periodStart");

/** Operator admin: cost inputs, pricing. */
export const adminRoutes = new Hono<AppEnv>()
  .get("/overview", async (c) => {
    requireOperator(c);
    const deps = c.get("deps");
    const sys = deps.dbs.system;
    const rows = await history(c, 90);
    const costs = await sys.selectFrom("costEntries").selectAll().orderBy("periodStart", "desc").limit(500).execute();
    const pricing = await sys.selectFrom("pricingConfig").selectAll().orderBy("id", "desc").execute();
    const latest = rows.at(-1) ?? null;
    return c.json({
      currentPriceMicro: await currentPriceMicro(deps),
      latest,
      canLower: latest?.recommendedPriceMicro != null && latest.recommendedPriceMicro < (await currentPriceMicro(deps)),
      awsConfigured: deps.config.AWS_COST_EXPLORER_ENABLED,
      categories: CATEGORY_LABELS,
      costs: costs.map((e) => ({ ...e, amountMicro: n(e.amountMicro), createdAt: e.createdAt.toISOString() })),
      pricing: pricing.map((p) => ({ id: p.id, effectiveFrom: p.effectiveFrom.toISOString(), monthlyPriceMicro: n(p.monthlyPriceMicro), reason: p.reason, createdBy: p.createdBy })),
      history: rows,
    });
  })
  .post("/costs", async (c) => {
    const user = requireOperator(c);
    const body = costSchema.parse(await c.req.json());
    const id = uuid7();
    await c.get("deps").dbs.system.insertInto("costEntries").values({
      id, periodStart: body.periodStart, periodEnd: body.periodEnd, category: body.category, source: "manual",
      amountMicro: usdToMicro(body.amountUsd), publicLabel: body.publicLabel ?? CATEGORY_LABELS[body.category]!, note: body.note ?? null, createdBy: user.email,
    }).execute();
    return c.json({ id }, 201);
  })
  .patch("/costs/:id", async (c) => {
    requireOperator(c);
    const body = costSchema.parse(await c.req.json());
    const r = await c.get("deps").dbs.system.updateTable("costEntries").set({
      periodStart: body.periodStart, periodEnd: body.periodEnd, category: body.category, amountMicro: usdToMicro(body.amountUsd),
      publicLabel: body.publicLabel ?? CATEGORY_LABELS[body.category]!, note: body.note ?? null,
    }).where("id", "=", c.req.param("id")).where("source", "=", "manual").executeTakeFirst();
    if (!r.numUpdatedRows) throw notFound("Manual cost entry not found");
    return c.json({ ok: true });
  })
  .delete("/costs/:id", async (c) => {
    requireOperator(c);
    const r = await c.get("deps").dbs.system.deleteFrom("costEntries").where("id", "=", c.req.param("id")).where("source", "=", "manual").executeTakeFirst();
    if (!r.numDeletedRows) throw notFound("Manual cost entry not found");
    return c.json({ ok: true });
  })
  .post("/pricing/lower", async (c) => {
    const user = requireOperator(c);
    const deps = c.get("deps");
    const body = z.object({ monthlyUsd: z.number().min(0), reason: z.string().trim().min(3).max(300) }).parse(await c.req.json());
    const current = await currentPriceMicro(deps);
    const next = usdToMicro(body.monthlyUsd);
    if (next >= current) throw badRequest(`The new price must be lower than ${formatUsd(current)}`);
    assertPriceNotIncreased(current, next);
    await deps.dbs.system.insertInto("pricingConfig").values({ monthlyPriceMicro: next, reason: body.reason, createdBy: user.email }).execute();
    return c.json({ monthlyPriceMicro: next });
  })
  .post("/finances/recompute", async (c) => {
    requireOperator(c);
    const body = z.object({ from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional() }).parse(await c.req.json());
    const days = await recompute(c.get("deps"), body.from, body.to ?? addDays(isoDay(new Date()), -1));
    return c.json({ days });
  })
  .get("/me", (c) => {
    const user = c.get("user");
    const deps = c.get("deps");
    return c.json({ operator: Boolean(user && deps.config.BILLING_ENABLED && deps.config.operatorEmails.includes(user.email.toLowerCase())) });
  });
