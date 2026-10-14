import { defineConfig } from "vitest/config";

// Tests import modules that load `config.ts`, which Zod-validates the env at
// import time. Supply a self-contained test env so unit tests need no real
// .env / database. These values are dummies — never real secrets.
export default defineConfig({
  test: {
    env: {
      NODE_ENV: "test",
      APP_ENCRYPTION_KEY: "0".repeat(64),
      SESSION_SECRET: "x".repeat(48),
      DATABASE_URL: "postgres://test:test@localhost:5432/test",
      // Signup allowlist for the test environment (§4A.2): the harness signs
      // every test user up through the REAL /auth/signup route with an
      // @example.com address, so the allowlist must admit example.com.
      // Deliberately capital-E: it doubles as the case-insensitivity proof for
      // the allowlist side, since the harness emails are lowercase.
      SIGNUP_ALLOWED: "Example.com, maz.getutua@gmail.com",
    },
    // Two projects: unit (pure, no database) and integration (real Postgres).
    // The root config provides the shared dummy env (APP_ENCRYPTION_KEY,
    // SESSION_SECRET, …); each project narrows its file selection and, for
    // integration, overrides DATABASE_URL to a SEPARATE database (sprout_test) —
    // never the dev one. `pnpm test` stays database-free: it runs only the unit
    // project.
    projects: [
      {
        test: {
          name: "unit",
          include: [
            "test/lib/**/*.test.ts",
            "test/services/**/*.test.ts",
            // Phase 17: the orchestration above the HRHub portal seam is pure
            // code with a scripted fake adapter, so its safety rules (read the
            // card first, an OUT needs an IN, unconfirmed means unknown) are
            // unit-testable. test/automation/fake-portal.ts is the fake; only
            // `*.test.ts` files are collected.
            "test/automation/**/*.test.ts",
          ],
        },
      },
      {
        test: {
          name: "integration",
          include: ["test/integration/**/*.test.ts"],
          // ONE shared afterEach for every integration file (phase 15E): the
          // scheduler's module-global state (registered schedules, the
          // fired-slot set, the sweep bucket) and the wall-clock tick's
          // handlers are reset between tests. As a per-file habit it leaked — a
          // file that scheduled a retry and never tore it down failed its
          // neighbours, and that is part of what made the suite flaky.
          setupFiles: ["./test/integration/setup.ts"],
          // One test database, shared across all integration files: file parallelism
          // would make concurrent migrate() calls race to create the drizzle schema,
          // AND parallel resetDatabase() truncates would clobber each other. Run
          // integration files serially (maxWorkers: 1 — vitest 4 replaced the old
          // poolOptions.forks.singleFork with this top-level option).
          maxWorkers: 1,
          // Point at a dead local port so any enqueued run fails fast at navigation
          // instead of ever touching real HRHub. The 1×202 / N−1×409 race split is
          // decided in startRun regardless of what the automation then does.
          env: {
            DATABASE_URL:
              "postgres://sprout:sprout_dev_pw@localhost:5432/sprout_test",
            SPROUT_URL: "http://127.0.0.1:9/",
            // Same allowlist as the root test env (merged, not replaced): the
            // harness signs test users up through the real signup route.
            SIGNUP_ALLOWED: "Example.com, maz.getutua@gmail.com",
            // The test process stands in for the SCHEDULING host (15D), so
            // /health's "enabled schedules in the DB but none registered" check
            // still has teeth here. Nothing in the suite calls startScheduler.
            SCHEDULER_ENABLED: "true",
          },
        },
      },
    ],
  },
});