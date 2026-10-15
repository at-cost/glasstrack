import { Hono } from "hono";
import { sql } from "kysely";
import { type AppEnv } from "../context";
import { badRequest, notFound } from "../lib/errors";
import { assertTeamAccess, visibleTeamIds } from "./teams";

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const NONE = "00000000-0000-0000-0000-000000000000";
const n = (v: unknown) => (v === null || v === undefined ? null : Number(v));

/**
 * Delivery reports, all computed in Postgres from issue timestamps:
 * cycle time = completed_at - started_at (first time it entered a "started" status),
 * lead time = completed_at - created_at.
 */
export const reportRoutes = new Hono<AppEnv>()
  .get("/reports/overview", async (c) => {
    const from = c.req.query("from");
    const to = c.req.query("to");
    if (!from || !to || !DAY.test(from) || !DAY.test(to) || from > to) throw badRequest("from and to (YYYY-MM-DD) are required");
    const team = c.req.query("team") || null;
    if (team) await assertTeamAccess(c, team);
    const visible = await visibleTeamIds(c);
    const teams = team ? [team] : visible;
    const trx = c.get("trx");
    // Shared scope: non-archived issues of the chosen/visible teams.
    const scope = teams ? sql`AND i.team_id = ANY(${teams.length ? teams : [NONE]}::uuid[])` : sql``;
    const range = sql`i.completed_at >= ${from}::date AND i.completed_at < ${to}::date + 1`;

    const times = await sql<{ completed: string; cycle_p50: string; cycle_p75: string; cycle_p90: string; lead_p50: string; lead_p75: string; lead_p90: string }>`
      SELECT count(*) AS completed,
        percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM i.completed_at - i.started_at) / 3600) FILTER (WHERE i.started_at IS NOT NULL) AS cycle_p50,
        percentile_cont(0.75) WITHIN GROUP (ORDER BY extract(epoch FROM i.completed_at - i.started_at) / 3600) FILTER (WHERE i.started_at IS NOT NULL) AS cycle_p75,
        percentile_cont(0.9) WITHIN GROUP (ORDER BY extract(epoch FROM i.completed_at - i.started_at) / 3600) FILTER (WHERE i.started_at IS NOT NULL) AS cycle_p90,
        percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM i.completed_at - i.created_at) / 3600) AS lead_p50,
        percentile_cont(0.75) WITHIN GROUP (ORDER BY extract(epoch FROM i.completed_at - i.created_at) / 3600) AS lead_p75,
        percentile_cont(0.9) WITHIN GROUP (ORDER BY extract(epoch FROM i.completed_at - i.created_at) / 3600) AS lead_p90
      FROM issues i WHERE ${range} AND i.archived_at IS NULL ${scope}`.execute(trx);

    const histogram = await sql<{ bucket: string; n: string }>`
      SELECT CASE
          WHEN h < 24 THEN 'under 1 day' WHEN h < 72 THEN '1 to 3 days' WHEN h < 168 THEN '3 to 7 days'
          WHEN h < 336 THEN '1 to 2 weeks' WHEN h < 672 THEN '2 to 4 weeks' ELSE 'over 4 weeks' END AS bucket,
        count(*) AS n
      FROM (SELECT extract(epoch FROM i.completed_at - i.started_at) / 3600 AS h FROM issues i
            WHERE ${range} AND i.started_at IS NOT NULL AND i.archived_at IS NULL ${scope}) x
      GROUP BY 1`.execute(trx);

    // Weekly throughput and the open-work trend (week ends), Monday-based weeks.
    const weekly = await sql<{ week: string; created: string; completed: string; open: string }>`
      WITH weeks AS (
        SELECT generate_series(date_trunc('week', ${from}::date), date_trunc('week', ${to}::date), interval '1 week')::date AS week
      )
      SELECT to_char(w.week, 'YYYY-MM-DD') AS week,
        (SELECT count(*) FROM issues i WHERE i.created_at >= w.week AND i.created_at < w.week + 7 AND i.archived_at IS NULL ${scope}) AS created,
        (SELECT count(*) FROM issues i WHERE i.completed_at >= w.week AND i.completed_at < w.week + 7 AND i.archived_at IS NULL ${scope}) AS completed,
        (SELECT count(*) FROM issues i WHERE i.created_at < w.week + 7 AND i.archived_at IS NULL
           AND (coalesce(i.completed_at, i.canceled_at) IS NULL OR coalesce(i.completed_at, i.canceled_at) >= w.week + 7) ${scope}) AS open
      FROM weeks w ORDER BY w.week`.execute(trx);

    const byAssignee = await sql<{ user_id: string | null; n: string }>`
      SELECT a.user_id, count(DISTINCT i.id) AS n FROM issues i LEFT JOIN issue_assignees a ON a.issue_id = i.id
      WHERE ${range} AND i.archived_at IS NULL ${scope} GROUP BY a.user_id ORDER BY n DESC LIMIT 50`.execute(trx);
    const byLabel = await sql<{ label_id: string; n: string }>`
      SELECT l.label_id, count(*) AS n FROM issues i JOIN issue_labels l ON l.issue_id = i.id
      WHERE ${range} AND i.archived_at IS NULL ${scope} GROUP BY l.label_id ORDER BY n DESC LIMIT 50`.execute(trx);

    const t = times.rows[0] as unknown as Record<string, unknown>;
    const order = ["under 1 day", "1 to 3 days", "3 to 7 days", "1 to 2 weeks", "2 to 4 weeks", "over 4 weeks"];
    const hist = new Map(histogram.rows.map((r) => [r.bucket, Number(r.n)]));
    return c.json({
      from, to, teamId: team,
      completed: Number(t.completed ?? 0),
      cycleTimeHours: { p50: n(t.cycleP50), p75: n(t.cycleP75), p90: n(t.cycleP90) },
      leadTimeHours: { p50: n(t.leadP50), p75: n(t.leadP75), p90: n(t.leadP90) },
      cycleTimeHistogram: order.map((bucket) => ({ bucket, count: hist.get(bucket) ?? 0 })),
      weekly: weekly.rows.map((r) => ({ week: r.week, created: Number(r.created), completed: Number(r.completed), open: Number(r.open) })),
      byAssignee: byAssignee.rows.map((r) => ({ userId: (r as unknown as { userId: string | null }).userId, completed: Number(r.n) })),
      byLabel: byLabel.rows.map((r) => ({ labelId: (r as unknown as { labelId: string }).labelId, completed: Number(r.n) })),
    });
  })

  /** Burndown for a cycle: scope and remaining per day, by estimate points when the cycle uses them, else by count. */
  .get("/reports/cycles/:id", async (c) => {
    const trx = c.get("trx");
    const cy = await trx.selectFrom("cycles").select(["id", "teamId", "number", "name", "startsOn", "endsOn", "completedAt"])
      .where("id", "=", c.req.param("id")).executeTakeFirst();
    if (!cy) throw notFound("Cycle not found");
    await assertTeamAccess(c, cy.teamId);
    const pts = await sql<{ any_estimates: boolean }>`SELECT bool_or(estimate IS NOT NULL) AS any_estimates FROM issues WHERE cycle_id = ${cy.id} AND archived_at IS NULL`.execute(trx);
    const usePoints = Boolean((pts.rows[0] as unknown as { anyEstimates: boolean | null })?.anyEstimates);
    const weight = usePoints ? sql`coalesce(i.estimate, 0)` : sql`1`;
    const rows = await sql<{ day: string; scope: string; done: string }>`
      WITH days AS (
        SELECT generate_series(${cy.startsOn}::date, least(${cy.endsOn}::date, current_date), interval '1 day')::date AS day
      )
      SELECT to_char(d.day, 'YYYY-MM-DD') AS day,
        coalesce((SELECT sum(${weight}) FROM issues i WHERE i.cycle_id = ${cy.id} AND i.archived_at IS NULL AND i.created_at < d.day + 1), 0) AS scope,
        coalesce((SELECT sum(${weight}) FROM issues i WHERE i.cycle_id = ${cy.id} AND i.archived_at IS NULL AND i.created_at < d.day + 1
          AND coalesce(i.completed_at, i.canceled_at) < d.day + 1), 0) AS done
      FROM days d ORDER BY d.day`.execute(trx);
    const totalDays = Math.round((Date.parse(cy.endsOn) - Date.parse(cy.startsOn)) / 86_400_000) + 1;
    const startScope = rows.rows.length ? Number(rows.rows[0]!.scope) : 0;
    return c.json({
      cycle: { ...cy, completedAt: cy.completedAt?.toISOString() ?? null },
      unit: usePoints ? "points" : "issues",
      totalDays,
      days: rows.rows.map((r, i) => ({
        day: r.day,
        scope: Number(r.scope),
        completed: Number(r.done),
        remaining: Number(r.scope) - Number(r.done),
        ideal: Math.max(0, Math.round((startScope * (1 - i / Math.max(1, totalDays - 1))) * 100) / 100),
      })),
    });
  });
