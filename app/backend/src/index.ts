import { config } from "./config";
import { logger } from "./lib/logger";
import { parseSignupAllowlist } from "./lib/signup-allowlist";
import { trustedCloudflarePeerCount } from "./middleware/security";
import { app } from "./app";
import { recoverOrphanedRuns, runQueue } from "./services/run-queue";
import { executeQueuedRun } from "./services/runs";
import { loadAllSchedules, startMissedRunSweep } from "./services/scheduler";

// Backstop for anything the run executor's .catch or the app's error handler
// miss: log and keep serving. A scheduler that dies on an unrelated rejection
// is worse than one that logs it — since Node 15 an unhandled rejection would
// otherwise terminate the process, and the whole point of this app is that it
// is still alive at 05:30 (backlog #2).
process.on("unhandledRejection", (reason: unknown) => {
  logger.error({ err: reason }, "unhandled promise rejection");
});
process.on("uncaughtException", (err: Error) => {
  logger.error({ err }, "uncaught exception");
});

async function start(): Promise<void> {
  // 4A.2: in development an unset SIGNUP_ALLOWED means signup is open. Warn
  // once so a future public deploy doesn't happen by accident. (Production
  // refuses to boot entirely — see config.ts.)
  if (
    config.NODE_ENV === "development" &&
    parseSignupAllowlist(config.SIGNUP_ALLOWED).length === 0
  ) {
    logger.warn(
      "SIGNUP_ALLOWED is not set — signup is open to anyone who can reach this server. Set it before deploying anywhere public.",
    );
  }

  // F3: the trusted-peer set is the gate for honouring CF-Connecting-IP. Log
  // its SIZE at boot (never the addresses) so an operator can see the gate
  // armed — a 1 here is the confirmation their TRUSTED_CLOUDFLARE_PEERS change
  // took effect; a 0 is the normal, safe state. This also makes a wiring break
  // visible in the boot log.
  logger.info(
    { trustedCloudflarePeers: trustedCloudflarePeerCount() },
    "CF-Connecting-IP trusted-peer gate armed",
  );

  // Register the run executor with the queue. This lives in the startup path,
  // NOT in app.ts: importing the app for a route test must not register an
  // executor that could launch Chromium.
  runQueue.setExecutor(executeQueuedRun);

  // Any run left pending/running by a previous shutdown is orphaned — flip it
  // to failure so the user (and the single-active-run guard) aren't stuck.
  const recovered = await recoverOrphanedRuns();
  if (recovered > 0) {
    logger.info({ recovered }, "recovered orphaned runs from previous shutdown");
  }

  // Rehydrate enabled schedules from the DB into the in-process cron scheduler.
  const scheduleCount = await loadAllSchedules();
  logger.info({ scheduleCount }, "loaded schedules from database");

  // One global sweep for ALL users — a missed run is invisible unless the
  // process that survived to report it reconciles it.
  startMissedRunSweep();

  app.listen(config.PORT, "0.0.0.0", () => {
    logger.info(
      { port: config.PORT, env: config.NODE_ENV },
      "sprout-automator-backend listening",
    );
  });
}

// oxlint-disable-next-line promise/prefer-await-to-then -- sanctioned top-level idiom (#3): the process exit is the only handler.
start().catch((err: unknown) => {
  logger.error({ err }, "failed to start server");
  process.exit(1);
});
