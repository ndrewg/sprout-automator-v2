import { db } from "../src/db/client";
import { runs } from "../src/db/schema";

// E2E seeding helper for the frontend e2e/runs-history.spec.ts: insert `count`
// terminal runs for a user directly into the test database. Runs created
// through POST /runs would enqueue the real executor (and trip the
// single-active-run guard); these rows never execute — they exist purely so the
// RunsPanel "Show more" pagination can be exercised against real rows.
//
// Usage: tsx test/e2e-seed-runs.ts <userId> <count>

async function main(): Promise<void> {
  const userId = process.argv[2];
  const count = Number(process.argv[3]);
  if (!userId || !Number.isInteger(count) || count < 1) {
    throw new Error(
      "usage: tsx test/e2e-seed-runs.ts <userId> <count> (count must be a positive integer)",
    );
  }

  // Guard: this helper fabricates "success" rows straight into whatever
  // DATABASE_URL points at — rows the real scheduler never produced. Against a
  // dev or production database that would forge run history (and mislead the
  // missed-run sweep), so refuse unless the connected database is clearly a
  // test database. Only the call site (e2e/runs-history.spec.ts) pins
  // sprout_test; never trust the ambient env.
  const { rows } = await db.$client.query<{ dbname: string }>(
    "select current_database() as dbname",
  );
  const dbname = rows[0]?.dbname ?? "";
  if (!dbname.includes("test")) {
    throw new Error(
      `refusing to seed: connected database "${dbname}" is not a test database (name must contain "test")`,
    );
  }

  // Newest first: run i is `i` minutes older than run 0, so the history table
  // shows a clear ordering and the date column spans days.
  await db.insert(runs).values(
    Array.from({ length: count }, (_, i) => ({
      userId,
      action: i % 2 === 0 ? ("in" as const) : ("out" as const),
      status: "success" as const,
      startedAt: new Date(Date.now() - i * 60_000),
      finishedAt: new Date(Date.now() - i * 60_000 + 30_000),
    })),
  );

  await db.$client.end();
}

// Top-level entrypoint (sanctioned idiom #3).
// oxlint-disable-next-line promise/prefer-await-to-then -- sanctioned top-level idiom (#3): the process exit is the only handler.
main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
