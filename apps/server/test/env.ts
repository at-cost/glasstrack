/** Test configuration. Override TEST_DATABASE_URL in CI. */
export const testEnv: Record<string, string> = {
  NODE_ENV: "test",
  APP_URL: "http://localhost:3999",
  APP_SECRET: "test-secret-test-secret-test-secret-0123456789",
  DATABASE_URL: process.env.TEST_DATABASE_URL ?? "postgres://localhost:5432/glasstrack_test",
  DB_APP_PASSWORD: "app-password-for-tests",
  DB_SYSTEM_PASSWORD: "system-password-for-tests",
  STORAGE_DRIVER: "local",
  STORAGE_LOCAL_DIR: "./.test-data/files",
  E2E_TEST_LOGIN: "true",
  STRIPE_WEBHOOK_SECRET: "whsec_test_secret_for_glasstrack",
  LOG_LEVEL: process.env.TEST_LOG_LEVEL ?? "silent",
};
