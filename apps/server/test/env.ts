/** Test configuration. Override TEST_DATABASE_URL in CI. */
export const testEnv: Record<string, string> = {
  NODE_ENV: "test",
  APP_URL: "http://localhost:3999",
  APP_SECRET: "test-secret-test-secret-test-secret-0123456789",
  DATABASE_URL: process.env.TEST_DATABASE_URL ?? "postgres://localhost:5432/tracker_test",
  DB_APP_PASSWORD: "app-password-for-tests",
  DB_SYSTEM_PASSWORD: "system-password-for-tests",
  STORAGE_DRIVER: "local",
  STORAGE_LOCAL_DIR: "./.test-data/files",
  E2E_TEST_LOGIN: "true",
  LOG_LEVEL: process.env.TEST_LOG_LEVEL ?? "silent",
};
