import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { csrf } from "hono/csrf";
import { secureHeaders } from "hono/secure-headers";
import { sql } from "kysely";
import { ZodError } from "zod";
import { authRoutes } from "./auth/routes";
import { importRoutes } from "./importers/run";
import { githubSettingsRoutes, githubWebhookRoutes } from "./modules/github";
import { adminRoutes, publicFinanceRoutes } from "./finances/routes";
import { billingRoutes } from "./billing/routes";
import { stripeWebhookRoutes } from "./billing/webhook";
import { sessionMiddleware } from "./auth/session";
import { ssoAuthRoutes, ssoSettingsRoutes } from "./auth/sso";
import { auditRoutes } from "./modules/audit";
import { automationRoutes } from "./modules/automations";
import { gitForgeSettingsRoutes, gitForgeWebhookRoutes } from "./modules/gitForges";
import { inboundEmailRoutes, intakeSettingsRoutes, publicFormRoutes } from "./modules/intake";
import { reportRoutes } from "./modules/reports";
import { fieldRoutes } from "./modules/fields";
import { templateRoutes } from "./modules/templates";
import { timeRoutes } from "./modules/time";
import { bearerMiddleware } from "./auth/tokens";
import { tokenRoutes } from "./modules/tokens";
import { webhookRoutes } from "./modules/webhooks";
import type { AppEnv, Deps } from "./context";
import { ApiError } from "./lib/errors";
import { logger } from "./lib/logger";
import { migrations } from "./migrations";
import { attachmentRoutes } from "./modules/attachments";
import { commentRoutes } from "./modules/comments";
import { exportRoutes } from "./modules/exports";
import { issueRoutes } from "./modules/issues";
import { notificationRoutes } from "./modules/notifications";
import { teamRoutes } from "./modules/teams";
import { viewRoutes } from "./modules/views";
import { workspaceRootRoutes, workspaceRoutes } from "./modules/workspaces";
import { workspaceTx } from "./modules/workspaceTx";
import { realtimeRoutes } from "./realtime/routes";
import { fileRoutes } from "./storage/routes";

export function createApp(deps: Deps) {
  const app = new Hono<AppEnv>();
  const origin = new URL(deps.config.APP_URL).origin;

  app.use(async (c, next) => {
    c.set("deps", deps);
    const start = performance.now();
    await next();
    const ms = Math.round(performance.now() - start);
    if (c.req.path.startsWith("/api/") && !c.req.path.endsWith("/events")) {
      logger.info({ method: c.req.method, path: c.req.path, status: c.res.status, ms }, "request");
    }
  });

  app.get("/health", (c) => c.json({ ok: true }));
  app.get("/ready", async (c) => {
    try {
      const r = await sql<{ n: string }>`SELECT count(*) AS n FROM kysely_migration`.execute(deps.dbs.system);
      const applied = Number(r.rows[0]?.n ?? 0);
      const expected = Object.keys(migrations).length;
      if (applied < expected) return c.json({ ok: false, reason: "migrations pending" }, 503);
      return c.json({ ok: true });
    } catch (err) {
      logger.warn({ err }, "readiness check failed");
      return c.json({ ok: false, reason: "database unavailable" }, 503);
    }
  });

  const headers = secureHeaders({
      contentSecurityPolicy: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", "data:", "blob:", "https:"],
        connectSrc: ["'self'", "https:"],
        frameAncestors: ["'none'"],
        formAction: ["'self'"],
        baseUri: ["'self'"],
      },
      crossOriginEmbedderPolicy: false,
  });
  // File downloads set their own stricter sandbox policy.
  app.use("*", (c, next) => (c.req.path.startsWith("/api/v1/files/") ? next() : headers(c, next)));

  const api = new Hono<AppEnv>();
  // Origin check on every state-changing request (CSRF). Cookies are SameSite=Lax too.
  api.use(csrf({ origin }));
  api.use(async (c, next) => {
    // A bearer token replaces the cookie session entirely.
    if (c.req.header("authorization")?.startsWith("Bearer ")) return bearerMiddleware(c, next);
    c.set("tokenWorkspaceId", null);
    return sessionMiddleware(c, next);
  });
  api.use(async (c, next) => {
    const user = c.get("user");
    const key = user ? `u:${user.id}` : `ip:${c.req.header("x-forwarded-for")?.split(",").pop()?.trim() ?? "local"}`;
    const wait = deps.limits.api.take(key);
    if (wait > 0) {
      c.header("Retry-After", String(wait));
      throw new ApiError(429, "rate_limited", "Too many requests. Slow down a little.");
    }
    await next();
  });
  api.use("*", async (c, next) => {
    // Files are streamed with their own limit; JSON bodies stay small.
    if (c.req.path.startsWith("/api/v1/files/")) return next();
    const maxSize = c.req.path.endsWith("/import") ? 26 * 1024 * 1024 : c.req.path === "/api/v1/inbound/email" ? 16 * 1024 * 1024 : 1024 * 1024;
    return bodyLimit({ maxSize })(c, next);
  });

  api.route("/auth/sso", ssoAuthRoutes);
  api.route("/auth", authRoutes);
  api.route("/stripe", stripeWebhookRoutes);
  api.route("/public", publicFinanceRoutes);
  api.route("/admin", adminRoutes);
  api.route("/github", githubWebhookRoutes);
  api.route("/git", gitForgeWebhookRoutes);
  api.route("/forms", publicFormRoutes);
  api.route("/inbound", inboundEmailRoutes);
  api.route("/files", fileRoutes);
  api.route("/", workspaceRootRoutes);
  api.route("/w/:slug", realtimeRoutes);
  const ws = new Hono<AppEnv>();
  ws.use(workspaceTx);
  ws.route("/", workspaceRoutes);
  ws.route("/", teamRoutes);
  ws.route("/", issueRoutes);
  ws.route("/", commentRoutes);
  ws.route("/", attachmentRoutes);
  ws.route("/", viewRoutes);
  ws.route("/", notificationRoutes);
  ws.route("/", exportRoutes);
  ws.route("/", billingRoutes);
  ws.route("/", tokenRoutes);
  ws.route("/", webhookRoutes);
  ws.route("/", importRoutes);
  ws.route("/", githubSettingsRoutes);
  ws.route("/", fieldRoutes);
  ws.route("/", timeRoutes);
  ws.route("/", templateRoutes);
  ws.route("/", auditRoutes);
  ws.route("/", ssoSettingsRoutes);
  ws.route("/", automationRoutes);
  ws.route("/", reportRoutes);
  ws.route("/", gitForgeSettingsRoutes);
  ws.route("/", intakeSettingsRoutes);
  api.route("/w/:slug", ws);
  api.all("*", (c) => c.json({ error: { code: "not_found", message: "Not found" } }, 404));
  app.route("/api/v1", api);

  if (deps.config.WEB_DIST_DIR) {
    const root = deps.config.WEB_DIST_DIR;
    app.use("/assets/*", async (c, next) => {
      await next();
      if (c.res.ok) c.header("Cache-Control", "public, max-age=31536000, immutable");
    });
    app.use("*", serveStatic({ root }));
    // SPA fallback: client-side routes get index.html.
    app.get("*", serveStatic({ root, path: "index.html" }));
  }

  app.onError((err, c) => {
    if (err instanceof ZodError) {
      const first = err.issues[0];
      const message = first ? `${first.path.join(".") || "input"}: ${first.message}` : "Invalid input";
      return c.json({ error: { code: "invalid", message, issues: err.issues } }, 400);
    }
    if (err instanceof ApiError) return c.json({ error: { code: err.code, message: err.message } }, err.status);
    if (err instanceof SyntaxError && c.req.header("content-type")?.includes("json")) {
      return c.json({ error: { code: "invalid_json", message: "Malformed JSON" } }, 400);
    }
    if ("getResponse" in err && typeof err.getResponse === "function") {
      const res = err.getResponse() as Response;
      return c.json({ error: { code: res.status === 403 ? "forbidden" : "error", message: err.message } }, res.status as 400);
    }
    logger.error({ err, path: c.req.path }, "unhandled error");
    const detail = deps.config.NODE_ENV === "production" ? undefined : String(err);
    return c.json({ error: { code: "internal", message: "Something went wrong", detail } }, 500);
  });

  return app;
}
