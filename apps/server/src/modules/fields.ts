import { Hono } from "hono";
import { sql } from "kysely";
import { type CustomField, customFieldSchema, updateCustomFieldSchema } from "@glasstrack/shared";
import { type AppEnv, requireRole } from "../context";
import { notify, type Tx } from "../db/tenant";
import { badRequest, conflict, notFound } from "../lib/errors";
import { uuid7 } from "../lib/ids";
import { audit } from "./audit";
import { assertTeamAccess } from "./teams";

type FieldRow = { id: string; teamId: string | null; name: string; type: CustomField["type"]; options: CustomField["options"]; position: number };
const toField = (r: FieldRow): CustomField => ({ ...r, options: r.options ?? [] });

/**
 * Checks and normalises custom field values for an issue in `teamId`.
 * Returns the values to write; `null` means "clear this field".
 */
export async function validateFieldValues(trx: Tx, teamId: string, input: Record<string, unknown>): Promise<Map<string, unknown | null>> {
  const ids = Object.keys(input);
  const out = new Map<string, unknown | null>();
  if (ids.length === 0) return out;
  const fields = await trx.selectFrom("customFields").select(["id", "teamId", "name", "type", "options"])
    .where("id", "in", ids).where("archivedAt", "is", null).execute();
  const byId = new Map(fields.map((f) => [f.id, f]));
  for (const id of ids) {
    const f = byId.get(id);
    if (!f || (f.teamId && f.teamId !== teamId)) throw badRequest("Unknown custom field for this team");
    const v = input[id];
    if (v === null || v === undefined || v === "" || (Array.isArray(v) && v.length === 0)) {
      out.set(id, null);
      continue;
    }
    const bad = (why: string) => badRequest(`${f.name}: ${why}`);
    const optionIds = new Set((f.options ?? []).map((o) => o.id));
    switch (f.type) {
      case "text":
        if (typeof v !== "string" || v.length > 2000) throw bad("must be text up to 2,000 characters");
        out.set(id, v);
        break;
      case "number":
        if (typeof v !== "number" || !Number.isFinite(v) || Math.abs(v) > 1e12) throw bad("must be a number");
        out.set(id, v);
        break;
      case "select":
        if (typeof v !== "string" || !optionIds.has(v)) throw bad("pick one of the options");
        out.set(id, v);
        break;
      case "multi_select":
        if (!Array.isArray(v) || v.length > 50 || !v.every((x) => typeof x === "string" && optionIds.has(x))) throw bad("pick from the options");
        out.set(id, [...new Set(v)]);
        break;
      case "date":
        if (typeof v !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(v) || Number.isNaN(Date.parse(v))) throw bad("must be a date");
        out.set(id, v);
        break;
      case "checkbox":
        if (typeof v !== "boolean") throw bad("must be true or false");
        out.set(id, v);
        break;
      case "url":
        if (typeof v !== "string" || v.length > 2000 || !/^https?:\/\//i.test(v)) throw bad("must be an http(s) link");
        try {
          new URL(v);
        } catch {
          throw bad("must be a valid link");
        }
        out.set(id, v);
        break;
      case "user": {
        if (typeof v !== "string") throw bad("must be a member");
        const m = await trx.selectFrom("workspaceMembers").select("userId").where("userId", "=", v)
          .where("workspaceId", "=", sql<string>`app.ws()`).executeTakeFirst();
        if (!m) throw bad("must be a workspace member");
        out.set(id, v);
        break;
      }
    }
  }
  return out;
}

/** Writes validated values; returns which fields actually changed. */
export async function writeFieldValues(
  trx: Tx,
  workspaceId: string,
  issueId: string,
  values: Map<string, unknown | null>,
  current: Record<string, unknown> = {},
): Promise<string[]> {
  const changed: string[] = [];
  for (const [fieldId, v] of values) {
    if (JSON.stringify(current[fieldId] ?? null) === JSON.stringify(v)) continue;
    changed.push(fieldId);
    if (v === null) await trx.deleteFrom("issueFieldValues").where("issueId", "=", issueId).where("fieldId", "=", fieldId).execute();
    else {
      await trx.insertInto("issueFieldValues").values({ workspaceId, issueId, fieldId, value: JSON.stringify(v) })
        .onConflict((oc) => oc.columns(["issueId", "fieldId"]).doUpdateSet({ value: JSON.stringify(v) })).execute();
    }
  }
  return changed;
}

const COLS = ["id", "teamId", "name", "type", "options", "position"] as const;

export const fieldRoutes = new Hono<AppEnv>()
  .get("/fields", async (c) => {
    const rows = await c.get("trx").selectFrom("customFields").select(COLS).where("archivedAt", "is", null)
      .orderBy("position").orderBy("createdAt").execute();
    return c.json(rows.map(toField));
  })
  .post("/fields", async (c) => {
    requireRole(c, "admin");
    const body = customFieldSchema.parse(await c.req.json());
    if (body.teamId) await assertTeamAccess(c, body.teamId);
    if ((body.type === "select" || body.type === "multi_select") && body.options.length === 0) throw badRequest("Add at least one option");
    if (new Set(body.options.map((o) => o.id)).size !== body.options.length) throw badRequest("Option ids must be unique");
    const trx = c.get("trx");
    const max = await trx.selectFrom("customFields").select((eb) => eb.fn.max("position").as("p")).executeTakeFirst();
    const id = uuid7();
    try {
      await trx.insertInto("customFields").values({
        id, workspaceId: c.get("ws").id, teamId: body.teamId ?? null, name: body.name, type: body.type,
        options: JSON.stringify(body.options), position: Number(max?.p ?? 0) + 1,
      }).execute();
    } catch (e) {
      if ((e as { code?: string }).code === "23505") throw conflict(`A field called ${body.name} already exists`);
      throw e;
    }
    await audit(c, "field.created", "field", id, { name: body.name, type: body.type });
    await notify(trx, c.get("ws").id, { t: "team", id });
    const row = await trx.selectFrom("customFields").select(COLS).where("id", "=", id).executeTakeFirstOrThrow();
    return c.json(toField(row), 201);
  })
  .patch("/fields/:id", async (c) => {
    requireRole(c, "admin");
    const body = updateCustomFieldSchema.parse(await c.req.json());
    const trx = c.get("trx");
    const cur = await trx.selectFrom("customFields").select(["type", "options"]).where("id", "=", c.req.param("id"))
      .where("archivedAt", "is", null).executeTakeFirst();
    if (!cur) throw notFound("Field not found");
    if (body.options) {
      if (new Set(body.options.map((o) => o.id)).size !== body.options.length) throw badRequest("Option ids must be unique");
      // Removing an option clears it from issues.
      const kept = new Set(body.options.map((o) => o.id));
      const removed = (cur.options ?? []).map((o) => o.id).filter((o) => !kept.has(o));
      if (removed.length && cur.type === "select") {
        await sql`DELETE FROM issue_field_values WHERE field_id = ${c.req.param("id")} AND value #>> '{}' = ANY(${removed})`.execute(trx);
      }
      if (removed.length && cur.type === "multi_select") {
        await sql`UPDATE issue_field_values SET value = coalesce((SELECT jsonb_agg(x) FROM jsonb_array_elements(value) x WHERE NOT (x #>> '{}' = ANY(${removed}))), '[]')
          WHERE field_id = ${c.req.param("id")}`.execute(trx);
        await sql`DELETE FROM issue_field_values WHERE field_id = ${c.req.param("id")} AND value = '[]'::jsonb`.execute(trx);
      }
    }
    try {
      await trx.updateTable("customFields").set({
        ...(body.name ? { name: body.name } : {}),
        ...(body.options ? { options: JSON.stringify(body.options) } : {}),
        ...(body.position !== undefined ? { position: body.position } : {}),
      }).where("id", "=", c.req.param("id")).execute();
    } catch (e) {
      if ((e as { code?: string }).code === "23505") throw conflict("A field with that name already exists");
      throw e;
    }
    await audit(c, "field.updated", "field", c.req.param("id"), body.name ? { name: body.name } : {});
    await notify(trx, c.get("ws").id, { t: "team", id: c.req.param("id") });
    const row = await trx.selectFrom("customFields").select(COLS).where("id", "=", c.req.param("id")).executeTakeFirstOrThrow();
    return c.json(toField(row));
  })
  .delete("/fields/:id", async (c) => {
    requireRole(c, "admin");
    const trx = c.get("trx");
    const r = await trx.updateTable("customFields").set({ archivedAt: new Date() }).where("id", "=", c.req.param("id"))
      .where("archivedAt", "is", null).returning("name").executeTakeFirst();
    if (!r) throw notFound("Field not found");
    await trx.deleteFrom("issueFieldValues").where("fieldId", "=", c.req.param("id")).execute();
    await audit(c, "field.deleted", "field", c.req.param("id"), { name: r.name });
    await notify(trx, c.get("ws").id, { t: "team", id: c.req.param("id") });
    return c.json({ ok: true });
  });
