import { defineConfig, devices } from "@playwright/test";

const PORT = 3300;
export const E2E = {
  url: `http://localhost:${PORT}`,
  mailFile: "test-results/e2e-mail.jsonl",
  databaseUrl: process.env.E2E_DATABASE_URL ?? "postgres://localhost:5432/tracker_e2e",
};

/** Runs the production build (apps/server/dist + apps/web/dist). Run `pnpm build` first. */
export default defineConfig({
  testDir: "e2e",
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : "list",
  globalSetup: "./e2e/global-setup.ts",
  use: { baseURL: E2E.url, trace: "retain-on-failure", screenshot: "only-on-failure" },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    command: "node --enable-source-maps apps/server/dist/index.js",
    url: `${E2E.url}/ready`,
    reuseExistingServer: false,
    timeout: 60_000,
    env: {
      NODE_ENV: "test",
      PORT: String(PORT),
      APP_URL: E2E.url,
      APP_SECRET: "e2e-secret-e2e-secret-e2e-secret-0123456789",
      DATABASE_URL: E2E.databaseUrl,
      DB_APP_PASSWORD: "e2e-app-password",
      DB_SYSTEM_PASSWORD: "e2e-system-password",
      WEB_DIST_DIR: "apps/web/dist",
      STORAGE_LOCAL_DIR: "test-results/e2e-files",
      SMTP_URL: `file://${process.cwd()}/test-results/e2e-mail.jsonl`,
      LOG_LEVEL: "warn",
    },
  },
});
