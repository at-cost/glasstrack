import { createHash } from "node:crypto";
import { generateCodeVerifier, generateState } from "arctic";
import { Hono } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { createRemoteJWKSet, jwtVerify } from "jose";
import { z } from "zod";
import { type SsoConfig, ssoConfigSchema } from "@glasstrack/shared";
import type { Config } from "../config";
import { type AppEnv, type Deps, requireRole } from "../context";
import { badRequest, notFound } from "../lib/errors";
import { logger } from "../lib/logger";
import { open, seal } from "../lib/secretBox";
import { assertPublicUrl } from "../lib/ssrf";
import { audit, auditSystem, requestIp } from "../modules/audit";
import { APP_HOME, findOrCreateUser, safeRedirect } from "./routes";
import { createSession } from "./session";

const PURPOSE = "sso-client-secret";
const callbackUrl = (config: Config) => `${config.APP_URL.replace(/\/$/, "")}/api/v1/auth/sso/callback`;

interface Discovery {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  jwks_uri: string;
  token_endpoint_auth_methods_supported?: string[];
}

const discoveryCache = new Map<string, { doc: Discovery; at: number }>();
const jwksCache = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

/** Reads and checks the provider's /.well-known/openid-configuration (cached for an hour). */
export async function discover(config: Config, issuer: string, fresh = false): Promise<Discovery> {
  const hit = discoveryCache.get(issuer);
  if (hit && !fresh && Date.now() - hit.at < 3600_000) return hit.doc;
  const allow = config.SSO_ALLOW_PRIVATE;
  const url = new URL(`${issuer.replace(/\/$/, "")}/.well-known/openid-configuration`);
  await assertPublicUrl(url.toString(), allow);
  const res = await fetch(url, { signal: AbortSignal.timeout(8000), redirect: "error", headers: { accept: "application/json" } });
  if (!res.ok) throw new Error(`The provider answered ${res.status} for its OpenID configuration`);
  const doc = (await res.json()) as Discovery;
  if (!doc.authorization_endpoint || !doc.token_endpoint || !doc.jwks_uri || !doc.issuer) throw new Error("The provider's configuration is incomplete");
  if (doc.issuer.replace(/\/$/, "") !== issuer.replace(/\/$/, "")) throw new Error(`Issuer mismatch: the provider says ${doc.issuer}`);
  for (const u of [doc.authorization_endpoint, doc.token_endpoint, doc.jwks_uri]) {
    const parsed = await assertPublicUrl(u, allow);
    if (parsed.protocol !== "https:" && !allow) throw new Error("Provider endpoints must use https");
  }
  discoveryCache.set(issuer, { doc, at: Date.now() });
  return doc;
}

async function loadConfig(deps: Deps, workspaceId: string) {
  return deps.dbs.system.selectFrom("ssoConfigs").selectAll().where("workspaceId", "=", workspaceId).where("enabled", "=", true).executeTakeFirst();
}

const cookieOpts = (deps: Deps) => ({ httpOnly: true, secure: deps.config.secureCookies, sameSite: "Lax" as const, path: "/", maxAge: 600 });
const s256 = (v: string) => createHash("sha256").update(v).digest("base64url");

/** Public sign-in routes under /api/v1/auth/sso. */
export const ssoAuthRoutes = new Hono<AppEnv>()
  /** Which workspaces offer SSO for this email's domain. */
  .post("/discover", async (c) => {
    const { email } = z.object({ email: z.email().max(254) }).parse(await c.req.json());
    const domain = email.split("@")[1]!.toLowerCase();
    const rows = await c.get("deps").dbs.system.selectFrom("ssoConfigs as s").innerJoin("workspaces as w", "w.id", "s.workspaceId")
      .select(["w.slug", "w.name"]).where("s.enabled", "=", true).where("w.status", "!=", "deleting")
      .where((eb) => eb(eb.val(domain), "=", eb.fn.any("s.allowedDomains"))).limit(10).execute();
    return c.json({ workspaces: rows });
  })
  .get("/:slug/start", async (c) => {
    const deps = c.get("deps");
    const ws = await deps.dbs.system.selectFrom("workspaces").select(["id", "status"]).where("slug", "=", c.req.param("slug")).executeTakeFirst();
    const cfg = ws && ws.status !== "deleting" ? await loadConfig(deps, ws.id) : undefined;
    if (!ws || !cfg) return c.redirect("/login?error=sso_not_configured");
    let doc: Discovery;
    try {
      doc = await discover(deps.config, cfg.issuer);
    } catch (err) {
      logger.warn({ err: String(err), workspaceId: ws.id }, "sso discovery failed");
      return c.redirect("/login?error=sso_provider");
    }
    const state = generateState();
    const nonce = generateState();
    const verifier = generateCodeVerifier();
    const o = cookieOpts(deps);
    setCookie(c, "sso_state", state, o);
    setCookie(c, "sso_nonce", nonce, o);
    setCookie(c, "sso_verifier", verifier, o);
    setCookie(c, "sso_ws", ws.id, o);
    setCookie(c, "sso_redirect", safeRedirect(c.req.query("redirectTo") ?? `/${c.req.param("slug")}`), o);
    const url = new URL(doc.authorization_endpoint);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("client_id", cfg.clientId);
    url.searchParams.set("redirect_uri", callbackUrl(deps.config));
    url.searchParams.set("scope", "openid email profile");
    url.searchParams.set("state", state);
    url.searchParams.set("nonce", nonce);
    url.searchParams.set("code_challenge", s256(verifier));
    url.searchParams.set("code_challenge_method", "S256");
    return c.redirect(url.toString());
  })
  .get("/callback", async (c) => {
    const deps = c.get("deps");
    const state = getCookie(c, "sso_state");
    const nonce = getCookie(c, "sso_nonce");
    const verifier = getCookie(c, "sso_verifier");
    const wsId = getCookie(c, "sso_ws");
    const redirectTo = safeRedirect(getCookie(c, "sso_redirect"));
    for (const k of ["sso_state", "sso_nonce", "sso_verifier", "sso_ws", "sso_redirect"]) deleteCookie(c, k, { path: "/" });
    const fail = (code: string) => c.redirect(`/login?error=${code}`);
    if (c.req.query("error")) return fail("sso_denied");
    const code = c.req.query("code");
    if (!code || !state || !nonce || !verifier || !wsId || state !== c.req.query("state")) return fail("sso_state");
    const cfg = await loadConfig(deps, wsId);
    if (!cfg) return fail("sso_not_configured");
    const ws = await deps.dbs.system.selectFrom("workspaces").select(["id", "slug", "status"]).where("id", "=", wsId).executeTakeFirstOrThrow();
    try {
      const doc = await discover(deps.config, cfg.issuer);
      const secret = open(deps.config.APP_SECRET, PURPOSE, cfg.clientSecretEnc);
      const form = new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: callbackUrl(deps.config), code_verifier: verifier });
      const headers: Record<string, string> = { "content-type": "application/x-www-form-urlencoded", accept: "application/json" };
      const methods = doc.token_endpoint_auth_methods_supported ?? ["client_secret_basic"];
      if (methods.includes("client_secret_basic")) {
        headers.authorization = `Basic ${Buffer.from(`${encodeURIComponent(cfg.clientId)}:${encodeURIComponent(secret)}`).toString("base64")}`;
      } else {
        form.set("client_id", cfg.clientId);
        form.set("client_secret", secret);
      }
      const tokenRes = await fetch(doc.token_endpoint, { method: "POST", headers, body: form, signal: AbortSignal.timeout(10_000), redirect: "error" });
      if (!tokenRes.ok) throw new Error(`token endpoint ${tokenRes.status}`);
      const tokens = (await tokenRes.json()) as { id_token?: string };
      if (!tokens.id_token) throw new Error("no id_token");
      let jwks = jwksCache.get(doc.jwks_uri);
      if (!jwks) {
        jwks = createRemoteJWKSet(new URL(doc.jwks_uri), { timeoutDuration: 8000 });
        jwksCache.set(doc.jwks_uri, jwks);
      }
      const { payload } = await jwtVerify(tokens.id_token, jwks, { issuer: doc.issuer, audience: cfg.clientId, clockTolerance: 60 });
      if (payload.nonce !== nonce) throw new Error("nonce mismatch");
      const rawEmail = [payload.email, payload.preferred_username, payload.upn].find((v) => typeof v === "string" && v.includes("@")) as string | undefined;
      if (!rawEmail) return fail("sso_no_email");
      if (payload.email_verified === false) return fail("sso_email_unverified");
      const email = rawEmail.toLowerCase();
      const domain = email.split("@")[1]!;
      if (cfg.allowedDomains.length && !cfg.allowedDomains.includes(domain)) return fail("sso_domain");
      const name = typeof payload.name === "string" ? payload.name : null;
      const userId = await findOrCreateUser(deps.dbs.system, { email, name });
      const member = await deps.dbs.system.selectFrom("workspaceMembers").select("role").where("workspaceId", "=", wsId).where("userId", "=", userId).executeTakeFirst();
      if (!member) {
        const invite = await deps.dbs.system.selectFrom("invites").select(["id", "role"]).where("workspaceId", "=", wsId).where("email", "=", email)
          .where("acceptedAt", "is", null).where("revokedAt", "is", null).where("expiresAt", ">", new Date()).executeTakeFirst();
        const role = invite?.role ?? cfg.autoJoinRole;
        if (!role) return fail("sso_not_member");
        await deps.dbs.system.insertInto("workspaceMembers").values({ workspaceId: wsId, userId, role }).onConflict((oc) => oc.columns(["workspaceId", "userId"]).doNothing()).execute();
        if (invite) await deps.dbs.system.updateTable("invites").set({ acceptedAt: new Date() }).where("id", "=", invite.id).execute();
        await auditSystem(deps.dbs.system, { workspaceId: wsId, actorId: userId, actorLabel: email, action: "member.joined_via_sso", data: { role }, ip: requestIp(c) });
      }
      await createSession(c, userId, { authMethod: "sso", ssoWorkspaceId: wsId });
      await auditSystem(deps.dbs.system, { workspaceId: wsId, actorId: userId, actorLabel: email, action: "sso.login", ip: requestIp(c) });
      return c.redirect(redirectTo === "/" || redirectTo === APP_HOME ? `/${ws.slug}` : redirectTo);
    } catch (err) {
      logger.warn({ err: String(err), workspaceId: wsId }, "sso callback failed");
      return fail("sso_failed");
    }
  });

function toConfig(deps: Deps, r: { issuer: string; clientId: string; allowedDomains: string[]; autoJoinRole: "member" | "guest" | null; enforce: boolean; enabled: boolean } | undefined): SsoConfig | { enabled: false; callbackUrl: string } {
  if (!r) return { enabled: false, callbackUrl: callbackUrl(deps.config) };
  return { ...r, hasSecret: true, callbackUrl: callbackUrl(deps.config) };
}

/** Admin settings under /w/:slug/sso. */
export const ssoSettingsRoutes = new Hono<AppEnv>()
  .get("/sso", async (c) => {
    requireRole(c, "admin");
    const row = await c.get("trx").selectFrom("ssoConfigs").select(["issuer", "clientId", "allowedDomains", "autoJoinRole", "enforce", "enabled"])
      .where("workspaceId", "=", c.get("ws").id).executeTakeFirst();
    return c.json(toConfig(c.get("deps"), row));
  })
  .put("/sso", async (c) => {
    requireRole(c, "admin");
    const deps = c.get("deps");
    const ws = c.get("ws");
    const body = ssoConfigSchema.parse(await c.req.json());
    const issuer = body.issuer.replace(/\/$/, "");
    try {
      await discover(deps.config, issuer, true);
    } catch (err) {
      throw badRequest(`Couldn't read the provider's settings: ${String((err as Error).message ?? err)}`);
    }
    const existing = await deps.dbs.system.selectFrom("ssoConfigs").select("clientSecretEnc").where("workspaceId", "=", ws.id).executeTakeFirst();
    if (!body.clientSecret && !existing) throw badRequest("Client secret is required");
    if (body.enforce && body.allowedDomains.length === 0) throw badRequest("Add at least one email domain before requiring SSO");
    const sealed = body.clientSecret ? seal(deps.config.APP_SECRET, PURPOSE, body.clientSecret) : existing!.clientSecretEnc;
    const values = {
      issuer, clientId: body.clientId, clientSecretEnc: sealed, allowedDomains: body.allowedDomains, autoJoinRole: body.autoJoinRole,
      enforce: body.enforce, enabled: body.enabled, updatedAt: new Date(),
    };
    // Secrets are written by the system role; the app role can't read the sealed column.
    await deps.dbs.system.insertInto("ssoConfigs").values({ workspaceId: ws.id, ...values })
      .onConflict((oc) => oc.column("workspaceId").doUpdateSet(values)).execute();
    await audit(c, existing ? "sso.updated" : "sso.configured", "sso", ws.id, {
      issuer, enforce: body.enforce, enabled: body.enabled, domains: body.allowedDomains, autoJoinRole: body.autoJoinRole, secretChanged: Boolean(body.clientSecret),
    });
    const row = await c.get("trx").selectFrom("ssoConfigs").select(["issuer", "clientId", "allowedDomains", "autoJoinRole", "enforce", "enabled"])
      .where("workspaceId", "=", ws.id).executeTakeFirst();
    return c.json(toConfig(deps, row));
  })
  .delete("/sso", async (c) => {
    requireRole(c, "admin");
    const deps = c.get("deps");
    const r = await deps.dbs.system.deleteFrom("ssoConfigs").where("workspaceId", "=", c.get("ws").id).executeTakeFirst();
    if (!r.numDeletedRows) throw notFound("SSO is not set up");
    await audit(c, "sso.removed", "sso", c.get("ws").id);
    return c.json({ ok: true });
  });

