import type { MiddlewareHandler } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import type { AppEnv, Ctx, Deps } from "../context";
import { newToken, sha256, uuid7 } from "../lib/ids";

const SESSION_DAYS = 30;
export const cookieName = (deps: Deps) => (deps.config.secureCookies ? "__Host-glasstrack_session" : "glasstrack_session");

export async function createSession(c: Ctx, userId: string, opts: { authMethod?: string; ssoWorkspaceId?: string | null } = {}): Promise<void> {
  const deps = c.get("deps");
  const token = newToken();
  await deps.dbs.system
    .insertInto("sessions")
    .values({
      id: uuid7(),
      userId,
      tokenHash: sha256(token),
      userAgent: c.req.header("user-agent")?.slice(0, 300) ?? null,
      expiresAt: new Date(Date.now() + SESSION_DAYS * 86400_000),
      authMethod: opts.authMethod ?? "unknown",
      ssoWorkspaceId: opts.ssoWorkspaceId ?? null,
    })
    .execute();
  setCookie(c, cookieName(deps), token, {
    httpOnly: true,
    secure: deps.config.secureCookies,
    sameSite: "Lax",
    path: "/",
    maxAge: SESSION_DAYS * 86400,
  });
}

export async function destroySession(c: Ctx): Promise<void> {
  const deps = c.get("deps");
  const user = c.get("user");
  if (user) await deps.dbs.system.deleteFrom("sessions").where("id", "=", user.sessionId).execute();
  deleteCookie(c, cookieName(deps), { path: "/", secure: deps.config.secureCookies });
}

/** Loads the session user if a valid cookie is present; never rejects. */
export const sessionMiddleware: MiddlewareHandler<AppEnv> = async (c, next) => {
  const deps = c.get("deps");
  const token = getCookie(c, cookieName(deps));
  c.set("user", null);
  if (token) {
    const row = await deps.dbs.system
      .selectFrom("sessions as s")
      .innerJoin("users as u", "u.id", "s.userId")
      .select(["s.id as sessionId", "s.lastSeenAt", "s.authMethod", "s.ssoWorkspaceId", "u.id", "u.email", "u.name", "u.avatarUrl"])
      .where("s.tokenHash", "=", sha256(token))
      .where("s.expiresAt", ">", new Date())
      .where("u.deletedAt", "is", null)
      .executeTakeFirst();
    if (row) {
      c.set("user", { id: row.id, email: row.email, name: row.name, avatarUrl: row.avatarUrl, sessionId: row.sessionId, authMethod: row.authMethod, ssoWorkspaceId: row.ssoWorkspaceId });
      // Sliding expiry, written at most once an hour.
      if (Date.now() - row.lastSeenAt.getTime() > 3600_000) {
        await deps.dbs.system
          .updateTable("sessions")
          .set({ lastSeenAt: new Date(), expiresAt: new Date(Date.now() + SESSION_DAYS * 86400_000) })
          .where("id", "=", row.sessionId)
          .execute();
      }
    }
  }
  await next();
};
