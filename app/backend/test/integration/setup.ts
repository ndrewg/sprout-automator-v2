import { afterEach } from "vitest";
import { stopWallClockTick } from "../../src/lib/wall-clock-tick";

// The integration project's SHARED teardown (phase 15E). Every integration test
// starts from a clean scheduler: no registered schedules, no "already fired
// today" slots, no 5-minute sweep bucket, and no wall-clock tick handlers.
//
// Why this is not a per-file habit: through phases 10–14 the suite was flaky —
// e2e 11/16 and integration 149/150, green only on a re-run — because a test
// that queued a retry (or registered a schedule) and never tore it down left
// module-global state behind for its neighbours in the same single-fork worker.
// A reset that only some files remember to call is not a reset.
//
// `services/scheduler` is imported DYNAMICALLY, inside the hook, on purpose:
// this file runs before the test file's `vi.mock` factories are applied, and a
// static import here would instantiate the whole service graph (scheduler →
// run-lifecycle → retry → notifications) for real. A test that then mocks one of
// those modules would find it already loaded and its mock silently bypassed —
// the failure mode that made the retry and OTP tests report "the message never
// arrived" while the code was in fact working. By the time `afterEach` runs, the
// test file's mocks are registered, so the dynamic import resolves through them.
//
// The retry state itself needs no reset here: since phase 15B it lives in
// `runs.retry_at`, and the harness's `resetDatabase()` truncates `runs` before
// every test. `stopWallClockTick()` drops EVERY handler — including the
// scheduler's — which is why no test may rely on a registration surviving a test
// boundary, and why `offTick(name)` exists for a per-consumer reset.
afterEach(async () => {
  const { resetSchedulerState } = await import("../../src/services/scheduler");
  resetSchedulerState();
  stopWallClockTick();
});
