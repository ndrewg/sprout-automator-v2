import { defineWorkspace } from "vitest/config";

// Two projects: unit (pure, no database) and integration (real Postgres).
// The root vitest.config.ts provides the shared dummy env (APP_ENCRYPTION_KEY,
// SESSION_SECRET, …); each project narrows its file selection and, for
// integration, overrides DATABASE_URL to a SEPARATE database (sprout_test) —
// never the dev one. `pnpm test` stays database-free: it runs only the unit
// project.
export default defineWorkspace([
  {
    test: {
      name: "unit",
      include: ["test/lib/**/*.test.ts", "test/services/**/*.test.ts"],
    },
  },
  {
    test: {
      name: "integration",
      include: ["test/integration/**/*.test.ts"],
      // One test database, shared across all integration files: file parallelism
      // would make concurrent migrate() calls race to create the drizzle schema,
      // AND parallel resetDatabase() truncates would clobber each other. Run
      // integration files in a single fork, serially.
      poolOptions: {
        forks: { singleFork: true },
      },
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
      },
    },
  },
]);
