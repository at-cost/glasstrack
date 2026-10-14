import { z } from "zod";

const bool = z
  .enum(["true", "false", "1", "0"])
  .transform((v) => v === "true" || v === "1");

const schema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().default(3000),
  APP_URL: z.url().default("http://localhost:3000"),
  /** Random string, 32+ chars. Signs local file URLs and OAuth state. */
  APP_SECRET: z.string().min(32),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info"),

  /** Owner connection: runs migrations and creates the runtime roles. */
  DATABASE_URL: z.string().min(1),
  DB_APP_PASSWORD: z.string().min(12),
  DB_SYSTEM_PASSWORD: z.string().min(12),
  DB_POOL_SIZE: z.coerce.number().int().min(1).default(10),
  MIGRATE_ON_BOOT: bool.default(true),
  WORKER_MODE: z.enum(["inline", "only", "off"]).default("inline"),
  /** Directory of the built SPA to serve. Empty disables static hosting (dev uses Vite). */
  WEB_DIST_DIR: z.string().default(""),

  SMTP_URL: z.string().default(""),
  EMAIL_FROM: z.string().default("Tracker <no-reply@localhost>"),

  STORAGE_DRIVER: z.enum(["local", "s3"]).default("local"),
  STORAGE_LOCAL_DIR: z.string().default("./data/files"),
  S3_ENDPOINT: z.string().default(""),
  S3_REGION: z.string().default("us-east-1"),
  S3_BUCKET: z.string().default(""),
  S3_ACCESS_KEY_ID: z.string().default(""),
  S3_SECRET_ACCESS_KEY: z.string().default(""),
  S3_FORCE_PATH_STYLE: bool.default(false),

  GOOGLE_CLIENT_ID: z.string().default(""),
  GOOGLE_CLIENT_SECRET: z.string().default(""),
  GITHUB_CLIENT_ID: z.string().default(""),
  GITHUB_CLIENT_SECRET: z.string().default(""),

  BILLING_ENABLED: bool.default(false),
  BACKUP_ENABLED: bool.default(false),
  BACKUP_CRON: z.string().default("15 3 * * *"),
  BACKUP_RETAIN_DAYS: z.coerce.number().int().default(14),
  /** Allow the test-only login endpoint. Never enable in production. */
  E2E_TEST_LOGIN: bool.default(false),
});

export type Config = z.infer<typeof schema> & {
  secureCookies: boolean;
  googleEnabled: boolean;
  githubEnabled: boolean;
};

export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  ${i.path.join(".")}: ${i.message}`).join("\n");
    throw new Error(`Invalid configuration:\n${issues}`);
  }
  const c = parsed.data;
  if (c.NODE_ENV === "production" && c.E2E_TEST_LOGIN) throw new Error("E2E_TEST_LOGIN must be off in production");
  if (c.STORAGE_DRIVER === "s3" && !c.S3_BUCKET) throw new Error("S3_BUCKET is required when STORAGE_DRIVER=s3");
  return {
    ...c,
    secureCookies: c.APP_URL.startsWith("https://"),
    googleEnabled: Boolean(c.GOOGLE_CLIENT_ID && c.GOOGLE_CLIENT_SECRET),
    githubEnabled: Boolean(c.GITHUB_CLIENT_ID && c.GITHUB_CLIENT_SECRET),
  };
}
