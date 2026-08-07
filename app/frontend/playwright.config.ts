import { defineConfig, devices } from "@playwright/test";

// E2E against the built app. The webServer command (see e2e-server.mjs) builds
// the SPA, copies it into app/backend/public, and boots the real backend on an
// ephemeral port against the sprout_test database. One smoke flow, run on a
// desktop project plus a 375px mobile project (doubles as the responsive check).

const BACKEND_PORT = 4310;
const BASE_URL = `http://127.0.0.1:${BACKEND_PORT}`;

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: true,
  retries: 0,
  reporter: "list",
  timeout: 60_000,
  expect: { timeout: 10_000 },
  use: {
    baseURL: BASE_URL,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [
    { name: "desktop", use: { ...devices["Desktop Chrome"], viewport: { width: 1280, height: 800 } } },
    { name: "mobile", use: { ...devices["Desktop Chrome"], viewport: { width: 375, height: 812 } } },
  ],
  webServer: {
    command: `node e2e-server.mjs ${BACKEND_PORT}`,
    url: `${BASE_URL}/health`,
    reuseExistingServer: false,
    timeout: 180_000,
  },
});
