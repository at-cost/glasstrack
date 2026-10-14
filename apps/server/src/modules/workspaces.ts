import { Hono } from "hono";
import { sql } from "kysely";
import { z } from "zod";
import {
  createWorkspaceSchema,
  DEFAULT_STATES,
  type Invite,
  inviteSchema,
  type Me,
  type Member,
  mentionHandle,
  updateMemberSchema,
  updateWorkspaceSchema,
} from "@glasstrack/shared";
import { type AppEnv, requireRole, requireUser } from "../context";
import type { Db } from "../db";
import { asUser, notify, type Tx } from "../db/tenant";
import { layout } from "../email";
import { ApiError, badRequest, conflict, forbidden, notFound } from "../lib/errors";
import { newToken, sha256, uuid7 } from "../lib/ids";
import { workspaceTx } from "./workspaceTx";

const INVITE_DAYS = 7;

export async function listMyWorkspaces(app: Db, userId: string): Promise<Me["workspaces"]> {
  return asUser(app, userId, (trx) =>
    trx
      .selectFrom("workspaceMembers as m")
      .innerJoin("workspaces as w", "w.id", "m.workspaceId")
      .select(["w.id", "w.slug", "w.name", "m.role"])
      .where("m.userId", "=", userId)
      .where("w.status", "!=", "deleting")
      .orderBy("w.name")
      .execute(),
  );
}

/** Derives a team key like "ACME" from a name. */
export function deriveKey(name: string): string {
  const letters = name.toUpperCase().replace(/[^A-Z0-9]/g, "");
  const key = letters.replace(/^[0-9]+/, "").slice(0, 4);
  return key.length >= 2 ? key : "TEAM";
}

/** Creates a team with the default workflow. Used by workspace creation and the teams API. */
export async function insertTeam(trx: Tx | Db, workspaceId: string, name: string, key: string): Promise<string> {
  const teamId = uuid7();
  await trx.insertInto("teams").values({ id: teamId, workspaceId, name, key }).execute();
  await trx
    .insertInto("workflowStates")
    .values(DEFAULT_STATES.map((s, i) => ({ id: uuid7(), workspaceId, teamId, ...s, position: i + 1 })))
    .execute();
  return teamId;
}

export async function membersOf(trx: Tx): Promise<Member[]> {
  const rows = await trx
    .selectFrom("workspaceMembers as m")
    .innerJoin("users as u", "u.id", "m.userId")
    .select(["u.id as userId", "u.name", "u.email", "u.avatarUrl", "m.role"])
    .where("m.workspaceId", "=", sql<string>`app.ws()`)
    .orderBy("u.name")
    .execute();
  return rows.map((r) => ({ ...r, handle: mentionHandle(r.email) }));
}

async function adminCount(trx: Tx): Promise<number> {
  const r = await trx
    .selectFrom("workspaceMembers")
    .select((eb) => eb.fn.countAll<string>().as("n"))
    .where("role", "=", "admin")
    .executeTakeFirstOrThrow();
  return Number(r.n);
}

/** Routes outside a workspace: create, list, accept invite. */
export const workspaceRootRoutes = new Hono<AppEnv>()
  .get("/me", async (c) => {
    const user = requireUser(c);
    const workspaces = await listMyWorkspaces(c.get("deps").dbs.app, user.id);
    const me: Me = { id: user.id, email: user.email, name: user.name, avatarUrl: user.avatarUrl, workspaces };
    return c.json(me);
  })
  .patch("/me", async (c) => {
    const user = requireUser(c);
    const body = z.object({ name: z.string().trim().min(1).max(80) }).parse(await c.req.json());
    await asUser(c.get("deps").dbs.app, user.id, async (trx) => {
      await trx.updateTable("users").set({ name: body.name }).where("id", "=", user.id).execute();
      const memberships = await trx.selectFrom("workspaceMembers").select("workspaceId").where("userId", "=", user.id).execute();
      for (const m of memberships) await notify(trx, m.workspaceId, { t: "member", id: user.id });
    });
    return c.json({ ok: true });
  })
  .post("/workspaces", async (c) => {
    const user = requireUser(c);
    const body = createWorkspaceSchema.parse(await c.req.json());
    const sys = c.get("deps").dbs.system;
    const id = uuid7();
    try {
      await sys.transaction().execute(async (trx) => {
        await trx.insertInto("workspaces").values({ id, slug: body.slug, name: body.name, createdBy: user.id }).execute();
        await trx.insertInto("workspaceMembers").values({ workspaceId: id, userId: user.id, role: "admin" }).execute();
        await insertTeam(trx as unknown as Db, id, body.name, deriveKey(body.name));
      });
    } catch (e) {
      if ((e as { code?: string }).code === "23505") throw conflict("That workspace URL is taken");
      throw e;
    }
    return c.json({ id, slug: body.slug, name: body.name }, 201);
  })
  .get("/invites/:token", async (c) => {
    const inv = await c
      .get("deps")
      .dbs.system.selectFrom("invites as i")
      .innerJoin("workspaces as w", "w.id", "i.workspaceId")
      .select(["w.name as workspaceName", "w.slug", "i.role", "i.email"])
      .where("i.tokenHash", "=", sha256(c.req.param("token")))
      .where("i.revokedAt", "is", null)
      .where("i.acceptedAt", "is", null)
      .where("i.expiresAt", ">", new Date())
      .executeTakeFirst();
    if (!inv) throw notFound("This invite is invalid or has expired");
    return c.json({ workspaceName: inv.workspaceName, slug: inv.slug, role: inv.role });
  })
  .post("/invites/:token/accept", async (c) => {
    const user = requireUser(c);
    const sys = c.get("deps").dbs.system;
    const result = await sys.transaction().execute(async (trx) => {
      const inv = await trx
        .selectFrom("invites as i")
        .innerJoin("workspaces as w", "w.id", "i.workspaceId")
        .select(["i.id", "i.workspaceId", "i.email", "i.role", "w.slug"])
        .where("i.tokenHash", "=", sha256(c.req.param("token")))
        .where("i.revokedAt", "is", null)
        .where("i.acceptedAt", "is", null)
        .where("i.expiresAt", ">", new Date())
        .forUpdate()
        .executeTakeFirst();
      if (!inv) throw notFound("This invite is invalid or has expired");
      if (inv.email && inv.email.toLowerCase() !== user.email.toLowerCase()) {
        throw forbidden(`This invite was sent to ${inv.email}. Sign in with that address to accept it.`);
      }
      await trx
        .insertInto("workspaceMembers")
        .values({ workspaceId: inv.workspaceId, userId: user.id, role: inv.role })
        .onConflict((oc) => oc.columns(["workspaceId", "userId"]).doNothing())
        .execute();
      // Email invites are single-use; link invites stay valid until they expire or are revoked.
      if (inv.email) await trx.updateTable("invites").set({ acceptedAt: new Date() }).where("id", "=", inv.id).execute();
      return { slug: inv.slug };
    });
    return c.json(result);
  });

/** Routes inside /w/:slug */
export const workspaceRoutes = new Hono<AppEnv>()
  .use(workspaceTx)
  .get("/", (c) => c.json(c.get("ws")))
  .patch("/", async (c) => {
    requireRole(c, "admin");
    const body = updateWorkspaceSchema.parse(await c.req.json());
    const trx = c.get("trx");
    await trx.updateTable("workspaces").set({ name: body.name }).where("id", "=", c.get("ws").id).execute();
    return c.json({ ...c.get("ws"), name: body.name });
  })
  .delete("/", async (c) => {
    requireRole(c, "admin");
    const ws = c.get("ws");
    const { confirm } = z.object({ confirm: z.string() }).parse(await c.req.json());
    if (confirm !== ws.slug) throw badRequest("Type the workspace URL name to confirm deletion");
    // Status changes are owned by the system role; the deletion job removes all data.
    await c.get("deps").dbs.system.updateTable("workspaces").set({ status: "deleting" }).where("id", "=", ws.id).execute();
    c.get("afterCommit").push(() => c.get("deps").jobs.send("workspace.delete", { workspaceId: ws.id }));
    return c.json({ ok: true });
  })

  .get("/members", async (c) => c.json(await membersOf(c.get("trx"))))
  .patch("/members/:userId", async (c) => {
    requireRole(c, "admin");
    const { role } = updateMemberSchema.parse(await c.req.json());
    const trx = c.get("trx");
    const userId = c.req.param("userId");
    const cur = await trx.selectFrom("workspaceMembers").select("role").where("userId", "=", userId)
      .where("workspaceId", "=", c.get("ws").id).executeTakeFirst();
    if (!cur) throw notFound("Member not found");
    if (cur.role === "admin" && role !== "admin" && (await adminCount(trx)) <= 1) {
      throw badRequest("A workspace needs at least one admin");
    }
    await trx.updateTable("workspaceMembers").set({ role }).where("userId", "=", userId)
      .where("workspaceId", "=", c.get("ws").id).execute();
    await notify(trx, c.get("ws").id, { t: "member", id: userId });
    return c.json({ ok: true });
  })
  .delete("/members/:userId", async (c) => {
    const user = requireUser(c);
    const userId = c.req.param("userId");
    if (userId !== user.id) requireRole(c, "admin");
    const trx = c.get("trx");
    const ws = c.get("ws");
    const cur = await trx.selectFrom("workspaceMembers").select("role").where("userId", "=", userId)
      .where("workspaceId", "=", ws.id).executeTakeFirst();
    if (!cur) throw notFound("Member not found");
    if (cur.role === "admin" && (await adminCount(trx)) <= 1) throw badRequest("A workspace needs at least one admin");
    await trx.deleteFrom("teamMembers").where("userId", "=", userId).execute();
    await trx.deleteFrom("issueSubscribers").where("userId", "=", userId).execute();
    await trx.updateTable("issues").set({ assigneeId: null }).where("assigneeId", "=", userId).execute();
    await trx.deleteFrom("workspaceMembers").where("userId", "=", userId).where("workspaceId", "=", ws.id).execute();
    await notify(trx, ws.id, { t: "member", id: userId });
    c.get("deps").hub.kick(ws.id, userId);
    return c.json({ ok: true });
  })

  .get("/invites", async (c) => {
    requireRole(c, "admin");
    const rows = await c
      .get("trx")
      .selectFrom("invites")
      .select(["id", "email", "role", "createdAt", "expiresAt"])
      .where("acceptedAt", "is", null)
      .where("revokedAt", "is", null)
      .where("expiresAt", ">", new Date())
      .orderBy("createdAt", "desc")
      .execute();
    return c.json(
      rows.map(
        (r): Invite => ({ ...r, createdAt: r.createdAt.toISOString(), expiresAt: r.expiresAt.toISOString() }),
      ),
    );
  })
  .post("/invites", async (c) => {
    requireRole(c, "admin");
    const user = requireUser(c);
    const deps = c.get("deps");
    const body = inviteSchema.parse(await c.req.json());
    const ws = c.get("ws");
    const wait = deps.limits.auth.take(`invite:${ws.id}`);
    if (wait > 0) throw new ApiError(429, "rate_limited", "Too many invites at once. Try again shortly.");
    const token = newToken();
    const id = uuid7();
    const expiresAt = new Date(Date.now() + INVITE_DAYS * 86400_000);
    await c
      .get("trx")
      .insertInto("invites")
      .values({ id, workspaceId: ws.id, email: body.email ?? null, tokenHash: sha256(token), role: body.role, invitedBy: user.id, expiresAt })
      .execute();
    const url = `${deps.config.APP_URL.replace(/\/$/, "")}/invite/${token}`;
    if (body.email) {
      const { text, html } = layout(
        `Join ${ws.name}`,
        [`${user.name} invited you to the ${ws.name} workspace.`, `The invite expires in ${INVITE_DAYS} days.`],
        { label: "Accept invite", url },
      );
      await deps.mailer.send({ to: body.email, subject: `${user.name} invited you to ${ws.name}`, text, html });
    }
    const invite: Invite = {
      id,
      email: body.email ?? null,
      role: body.role,
      createdAt: new Date().toISOString(),
      expiresAt: expiresAt.toISOString(),
      url,
    };
    return c.json(invite, 201);
  })
  .delete("/invites/:id", async (c) => {
    requireRole(c, "admin");
    await c.get("trx").updateTable("invites").set({ revokedAt: new Date() }).where("id", "=", c.req.param("id")).execute();
    return c.json({ ok: true });
  });
