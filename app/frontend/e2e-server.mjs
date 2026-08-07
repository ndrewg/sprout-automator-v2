// Playwright webServer command: build the SPA, place it where the backend
// serves static assets (app/backend/public), migrate sprout_test, then boot the
// REAL backend on the given port. The e2e then talks to the built app exactly
// as production does (SPA + API from one Express server).
//
// Playwright spawns this via the shell, polls the `url` from playwright.config,
// and kills the process tree when done. This process must stay alive for the
// duration of the test run.

import { spawn, spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const port = process.argv[2] ?? "4310";
const here = path.dirname(fileURLToPath(import.meta.url));
const frontendDist = path.join(here, "dist");
const backendDir = path.resolve(here, "..", "backend");
const backendPublic = path.join(backendDir, "public");

// The frontend must be built before the backend can serve it. Always build so
// the e2e tests the CURRENT source, not a stale dist.
console.log("[e2e-server] building frontend…");
const build = spawnSync("pnpm", ["build"], { cwd: here, stdio: "inherit", shell: true });
if (build.status !== 0) {
  console.error("[e2e-server] frontend build failed");
  process.exit(1);
}

// Copy the built SPA into app/backend/public (gitignored).
rmSync(backendPublic, { recursive: true, force: true });
mkdirSync(backendPublic, { recursive: true });
copyDir(frontendDist, backendPublic);
console.log(`[e2e-server] copied SPA → ${backendPublic}`);

// Isolate e2e from the dev DB: use sprout_test and a dead SPROUT_URL so no run
// could ever reach real HRHub. NODE_ENV=test keeps cookies non-Secure over http.
const backendEnv = {
  ...process.env,
  NODE_ENV: "test",
  PORT: port,
  DATABASE_URL: "postgres://sprout:sprout_dev_pw@localhost:5432/sprout_test",
  APP_ENCRYPTION_KEY: "0".repeat(64),
  SESSION_SECRET: "e2e-session-secret-not-for-production-123456789",
  SPROUT_URL: "http://127.0.0.1:9/",
};

// Migrate the test database (the backend does not auto-migrate).
console.log("[e2e-server] migrating sprout_test…");
const migrate = spawnSync("pnpm", ["exec", "tsx", "src/db/migrate.ts"], {
  cwd: backendDir,
  env: backendEnv,
  stdio: "inherit",
  shell: true,
});
if (migrate.status !== 0) {
  console.error("[e2e-server] migration failed");
  process.exit(1);
}

// Start the backend. This is the long-lived child; forward exit so Playwright's
// process-tree teardown reaches it.
console.log(`[e2e-server] starting backend on :${port}`);
const child = spawn("pnpm", ["exec", "tsx", "src/index.ts"], {
  cwd: backendDir,
  env: backendEnv,
  stdio: "inherit",
  shell: true,
});
child.on("error", (err) => {
  console.error("[e2e-server] backend spawn error", err);
  process.exit(1);
});
child.on("exit", (code) => {
  process.exit(code ?? 0);
});

function copyDir(from, to) {
  for (const entry of readdirSync(from)) {
    const src = path.join(from, entry);
    const dest = path.join(to, entry);
    if (statSync(src).isDirectory()) {
      mkdirSync(dest, { recursive: true });
      copyDir(src, dest);
    } else {
      copyFileSync(src, dest);
    }
  }
}
