import { generateCodeVerifier, generateState, GitHub, Google } from "arctic";
import { Hono } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { z } from "zod";
import { emailSchema } from "@glasstrack/shared";
import type { AppEnv, Ctx, Deps } from "../context";
import type { Db } from "../db";
import { layout } from "../email";
import { ApiError, badRequest, notFound } from "../lib/errors";
import { newToken, sha256, uuid7 } from "../lib/ids";
import { logger } from "../lib/logger";
import { createSession, destroySession } from "./session";

const MAGIC_LINK_MINUTES = 15;

/** Only same-site relative paths, to avoid open redirects. */
export function safeRedirect(r: string | null | undefined): string {
  if (!r || !r.startsWith("/") || r.startsWith("//") || r.startsWith("/\\")) return "/";
  return r;
}

export async function findOrCreateUser(
  system: Db,
  p: { email: string; name?: string | null; avatarUrl?: string | null },
): Promise<string> {
  const email = p.email.toLowerCase();
  const existing = await system.selectFrom("users").select(["id", "emailVerifiedAt"]).where("email", "=", email).executeTakeFirst();
  if (existing) {
    if (!existing.emailVerifiedAt) {
      await system.updateTable("users").set({ emailVerifiedAt: new Date() }).where("id", "=", existing.id).execute();
    }
    return existing.id;
  }
  const id = uuid7();
  await system
    .insertInto("users")
    .values({
      id,
      email,
      name: p.name?.trim() || email.split("@")[0]!,
      avatarUrl: p.avatarUrl ?? null,
      emailVerifiedAt: new Date(),
    })
    .onConflict((oc) => oc.column("email").doNothing())
    .execute();
  const row = await system.selectFrom("users").select("id").where("email", "=", email).executeTakeFirstOrThrow();
  return row.id;
}

function clientIp(c: Ctx): string {
  // Behind one trusted reverse proxy (Caddy/nginx) the last X-Forwarded-For hop is the client.
  const xff = c.req.header("x-forwarded-for");
  return xff?.split(",").pop()?.trim() || c.req.header("x-real-ip") || "local";
}

function rateLimit(c: Ctx, key: string) {
  const wait = c.get("deps").limits.auth.take(key);
  if (wait > 0) {
    c.header("Retry-After", String(wait));
    throw new ApiError(429, "rate_limited", "Too many attempts. Please wait a few minutes.");
  }
}

function providers(deps: Deps) {
  const base = deps.config.APP_URL.replace(/\/$/, "");
  return {
    google: deps.config.googleEnabled
      ? new Google(deps.config.GOOGLE_CLIENT_ID, deps.config.GOOGLE_CLIENT_SECRET, `${base}/api/v1/auth/oauth/google/callback`)
      : null,
    github: deps.config.githubEnabled
      ? new GitHub(deps.config.GITHUB_CLIENT_ID, deps.config.GITHUB_CLIENT_SECRET, `${base}/api/v1/auth/oauth/github/callback`)
      : null,
  };
}

async function fetchJson<T>(url: string, token: string): Promise<T> {
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${token}`, Accept: "application/json", "User-Agent": "glasstrack" },
  });
  if (!res.ok) throw new Error(`OAuth profile fetch failed: ${res.status}`);
  return (await res.json()) as T;
}

interface Profile {
  providerUserId: string;
  email: string;
  name: string | null;
  avatarUrl: string | null;
}

async function googleProfile(token: string): Promise<Profile> {
  const p = await fetchJson<{ sub: string; email: string; email_verified: boolean; name?: string; picture?: string }>(
    "https://openidconnect.googleapis.com/v1/userinfo",
    token,
  );
  if (!p.email_verified) throw badRequest("Your Google email is not verified");
  return { providerUserId: p.sub, email: p.email, name: p.name ?? null, avatarUrl: p.picture ?? null };
}

async function githubProfile(token: string): Promise<Profile> {
  const u = await fetchJson<{ id: number; login: string; name: string | null; avatar_url: string }>(
    "https://api.github.com/user",
    token,
  );
  const emails = await fetchJson<{ email: string; primary: boolean; verified: boolean }[]>(
    "https://api.github.com/user/emails",
    token,
  );
  const primary = emails.find((e) => e.primary && e.verified) ?? emails.find((e) => e.verified);
  if (!primary) throw badRequest("Your GitHub account has no verified email");
  return { providerUserId: String(u.id), email: primary.email, name: u.name ?? u.login, avatarUrl: u.avatar_url };
}

export const authRoutes = new Hono<AppEnv>()
  .get("/providers", (c) => {
    const p = providers(c.get("deps"));
    return c.json({ google: Boolean(p.google), github: Boolean(p.github), magicLink: true });
  })

  .post("/magic-link", async (c) => {
    const deps = c.get("deps");
    const body = z
      .object({ email: emailSchema, redirectTo: z.string().max(500).optional() })
      .parse(await c.req.json());
    rateLimit(c, `ml-ip:${clientIp(c)}`);
    rateLimit(c, `ml-email:${body.email}`);
    const token = newToken();
    await deps.dbs.system
      .insertInto("magicLinks")
      .values({
        id: uuid7(),
        email: body.email,
        tokenHash: sha256(token),
        redirectTo: safeRedirect(body.redirectTo),
        expiresAt: new Date(Date.now() + MAGIC_LINK_MINUTES * 60_000),
        ip: clientIp(c),
      })
      .execute();
    const url = `${deps.config.APP_URL.replace(/\/$/, "")}/auth/verify?token=${token}`;
    const { text, html } = layout(
      "Your sign-in link",
      [`Use the button below to sign in. The link works once and expires in ${MAGIC_LINK_MINUTES} minutes.`,
       "If you didn't ask for this, you can ignore this email."],
      { label: "Sign in", url },
    );
    await deps.mailer.send({ to: body.email, subject: "Your sign-in link", text, html });
    return c.json({ ok: true });
  })

  // Consumed with POST from the SPA, so link-scanning email clients can't burn the token.
  .post("/magic-link/verify", async (c) => {
    const deps = c.get("deps");
    const { token } = z.object({ token: z.string().min(10).max(200) }).parse(await c.req.json());
    rateLimit(c, `mlv-ip:${clientIp(c)}`);
    const link = await deps.dbs.system
      .updateTable("magicLinks")
      .set({ usedAt: new Date() })
      .where("tokenHash", "=", sha256(token))
      .where("usedAt", "is", null)
      .where("expiresAt", ">", new Date())
      .returning(["email", "redirectTo"])
      .executeTakeFirst();
    if (!link) throw new ApiError(400, "invalid_link", "This sign-in link is invalid or has expired.");
    const userId = await findOrCreateUser(deps.dbs.system, { email: link.email });
    await createSession(c, userId, { authMethod: "magic_link" });
    return c.json({ redirectTo: safeRedirect(link.redirectTo) });
  })

  .get("/oauth/:provider", async (c) => {
    const deps = c.get("deps");
    const name = c.req.param("provider");
    const p = providers(deps);
    const state = generateState();
    const cookieOpts = { httpOnly: true, secure: deps.config.secureCookies, sameSite: "Lax" as const, path: "/", maxAge: 600 };
    setCookie(c, "oauth_state", state, cookieOpts);
    setCookie(c, "oauth_redirect", safeRedirect(c.req.query("redirectTo")), cookieOpts);
    if (name === "google" && p.google) {
      const verifier = generateCodeVerifier();
      setCookie(c, "oauth_verifier", verifier, cookieOpts);
      return c.redirect(p.google.createAuthorizationURL(state, verifier, ["openid", "email", "profile"]).toString());
    }
    if (name === "github" && p.github) {
      return c.redirect(p.github.createAuthorizationURL(state, ["read:user", "user:email"]).toString());
    }
    throw notFound("Sign-in provider not configured");
  })

  .get("/oauth/:provider/callback", async (c) => {
    const deps = c.get("deps");
    const name = c.req.param("provider") as "google" | "github";
    const p = providers(deps);
    const state = getCookie(c, "oauth_state");
    const verifier = getCookie(c, "oauth_verifier");
    const redirectTo = safeRedirect(getCookie(c, "oauth_redirect"));
    for (const k of ["oauth_state", "oauth_verifier", "oauth_redirect"]) deleteCookie(c, k, { path: "/" });
    const code = c.req.query("code");
    if (!code || !state || state !== c.req.query("state")) return c.redirect("/login?error=oauth_state");
    let profile: Profile;
    try {
      if (name === "google" && p.google && verifier) {
        profile = await googleProfile((await p.google.validateAuthorizationCode(code, verifier)).accessToken());
      } else if (name === "github" && p.github) {
        profile = await githubProfile((await p.github.validateAuthorizationCode(code)).accessToken());
      } else {
        return c.redirect("/login?error=oauth_provider");
      }
    } catch (err) {
      logger.warn({ err, provider: name }, "oauth callback failed");
      return c.redirect("/login?error=oauth_failed");
    }
    const sys = deps.dbs.system;
    const identity = await sys
      .selectFrom("authIdentities")
      .select("userId")
      .where("provider", "=", name)
      .where("providerUserId", "=", profile.providerUserId)
      .executeTakeFirst();
    let userId = identity?.userId;
    if (!userId) {
      // Providers above only return verified emails, so linking by email is safe.
      userId = await findOrCreateUser(sys, profile);
      await sys
        .insertInto("authIdentities")
        .values({ id: uuid7(), userId, provider: name, providerUserId: profile.providerUserId, email: profile.email })
        .onConflict((oc) => oc.columns(["provider", "providerUserId"]).doNothing())
        .execute();
    }
    await createSession(c, userId, { authMethod: name });
    return c.redirect(redirectTo);
  })

  .post("/logout", async (c) => {
    await destroySession(c);
    return c.json({ ok: true });
  })

  // Test-only shortcut used by Playwright; refused unless E2E_TEST_LOGIN=true.
  .post("/test-login", async (c) => {
    const deps = c.get("deps");
    if (!deps.config.E2E_TEST_LOGIN || deps.config.NODE_ENV === "production") throw notFound();
    const body = z.object({ email: emailSchema, name: z.string().optional() }).parse(await c.req.json());
    const userId = await findOrCreateUser(deps.dbs.system, body);
    await createSession(c, userId, { authMethod: "test" });
    return c.json({ ok: true });
  });
