import { rm } from "node:fs/promises";
import { sql } from "kysely";
import { createApp } from "../src/app";
import { loadConfig } from "../src/config";
import type { Deps } from "../src/context";
import { createDatabases } from "../src/db";
import { createTestMailer, meteredMailer } from "../src/email";
import { createInlineJobs } from "../src/jobs";
import { UsageMeter } from "../src/lib/meter";
import { RateLimiter } from "../src/lib/rateLimit";
import { RealtimeHub } from "../src/realtime/hub";
import { createStorage } from "../src/storage";
import { testEnv } from "./env";
import { fakeStripe } from "./fakeStripe";

export type Harness = Awaited<ReturnType<typeof createHarness>>;

export async function createHarness(overrides: Record<string, string> = {}) {
  const config = loadConfig({ ...testEnv, ...overrides });
  const dbs = createDatabases(config);
  const mailer = createTestMailer();
  let deps!: Deps;
  const jobs = createInlineJobs(() => deps);
  const hub = new RealtimeHub(dbs.systemPool);
  const payments = fakeStripe();
  const meter = new UsageMeter(config.BILLING_ENABLED);
  deps = {
    config,
    dbs,
    mailer: meteredMailer(mailer, (ws) => meter.countEmail(ws)),
    meter,
    storage: createStorage(config),
    hub,
    jobs,
    payments,
    limits: { auth: new RateLimiter(1000, 60_000), api: new RateLimiter(100_000, 60_000) },
  };
  const app = createApp(deps);
  return {
    deps,
    app,
    payments,
    mailer,
    jobs,
    /** Truncates every table between tests (RLS is irrelevant to the owner). */
    async reset() {
      await sql.raw(`TRUNCATE users, workspaces, sessions, magic_links, auth_identities, payments, starter_credit_claims, stripe_events, cost_entries, finance_daily CASCADE`).execute(dbs.owner);
      // The ledger is append-only by trigger; tests bypass it as the owner.
      await sql.raw(`ALTER TABLE credit_ledger DISABLE TRIGGER ledger_append_only; TRUNCATE credit_ledger; ALTER TABLE credit_ledger ENABLE TRIGGER ledger_append_only;
        ALTER TABLE pricing_config DISABLE TRIGGER USER; TRUNCATE pricing_config RESTART IDENTITY; ALTER TABLE pricing_config ENABLE TRIGGER USER;`).execute(dbs.owner);
      payments.calls.length = 0;
      mailer.outbox.length = 0;
      jobs.ran.length = 0;
    },
    async close() {
      await hub.stop();
      deps.limits.auth.stop();
      deps.limits.api.stop();
      await dbs.close();
      await rm(config.STORAGE_LOCAL_DIR, { recursive: true, force: true });
    },
  };
}

/** Cookie-keeping client for app.request(). */
export class Client {
  jar = new Map<string, string>();
  constructor(
    private h: Harness,
    private origin = "http://localhost:3999",
  ) {}

  get cookie(): string {
    return [...this.jar].map(([k, v]) => `${k}=${v}`).join("; ");
  }
  set cookie(v: string) {
    this.jar.clear();
    for (const part of v.split(";").map((p) => p.trim()).filter(Boolean)) {
      const i = part.indexOf("=");
      if (i > 0) this.jar.set(part.slice(0, i), part.slice(i + 1));
    }
  }

  absorb(res: Response) {
    for (const sc of res.headers.getSetCookie()) {
      const pair = sc.split(";")[0]!;
      const i = pair.indexOf("=");
      const name = pair.slice(0, i);
      const value = pair.slice(i + 1);
      if (!value || /max-age=0/i.test(sc) || /expires=thu, 01 jan 1970/i.test(sc)) this.jar.delete(name);
      else this.jar.set(name, value);
    }
  }

  async req(method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
    const res = await this.h.app.request(path, {
      method,
      headers: {
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
        origin: this.origin,
        cookie: this.cookie,
        ...headers,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    this.absorb(res);
    const text = await res.text();
    let json: any = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = text;
    }
    return { status: res.status, body: json, headers: res.headers };
  }
  get = (p: string) => this.req("GET", p);
  post = (p: string, b: unknown = {}) => this.req("POST", p, b);
  patch = (p: string, b: unknown) => this.req("PATCH", p, b);
  put = (p: string, b: unknown) => this.req("PUT", p, b);
  del = (p: string, b?: unknown) => this.req("DELETE", p, b);

  async login(email: string, name?: string) {
    const r = await this.post("/api/v1/auth/test-login", { email, name });
    if (r.status !== 200) throw new Error(`login failed: ${JSON.stringify(r.body)}`);
    return this;
  }

  async ok(method: string, path: string, body?: unknown) {
    const r = await this.req(method, path, body);
    if (r.status >= 300) throw new Error(`${method} ${path} -> ${r.status}: ${JSON.stringify(r.body)}`);
    return r.body;
  }
}

/** Creates a user + workspace and returns the client, slug and first team. */
export async function setupWorkspace(h: Harness, email: string, slug: string) {
  const c = await new Client(h).login(email, email.split("@")[0]);
  await c.ok("POST", "/api/v1/workspaces", { name: slug.toUpperCase(), slug });
  const teams = await c.ok("GET", `/api/v1/w/${slug}/teams`);
  const states = await c.ok("GET", `/api/v1/w/${slug}/states`);
  return { c, slug, team: teams[0] as { id: string; key: string }, states: states as { id: string; name: string; category: string }[] };
}
