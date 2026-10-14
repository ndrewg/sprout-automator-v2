import { config } from "../config";

// Dead-man's-switch heartbeat (phase 12D). On every scheduler fire the app
// pings an OPTIONAL external URL so a service outside this process can alert
// when the pings stop — the failure mode that otherwise dies with the process
// it watches (a down Docker Desktop after a reboot silences the missed-run
// sweep that lives inside the same scheduler).
//
// Contract (hard rules 2 & 11):
//  - Fire-and-forget. A dead or hanging endpoint must never fail, delay, or
//    otherwise alter a run, a scheduler fire, or any HTTP response. The
//    sanctioned `.catch(() => {})` cleanup idiom absorbs the rejection.
//  - Short timeout so a hanging endpoint cannot delay a clock-in (that is the
//    failure mode that would turn a monitoring feature into an outage).
//  - NO identifying data in the ping — a bare GET with no query string, no
//    body, no email/user/run id. A third party seeing your clock-in times is a
//    privacy leak for other people, not just you.

const HEARTBEAT_TIMEOUT_MS = 5000;

/**
 * The URL to ping. `config` is the production source of truth; the env override
 * exists so tests can point the heartbeat anywhere without re-loading config.
 * Empty/unset means the feature is off — no requests, no warnings.
 */
function heartbeatUrl(): string | undefined {
  const override = process.env["HEARTBEAT_URL"];
  if (override !== undefined && override !== "") return override;
  return config.HEARTBEAT_URL ?? undefined;
}

/**
 * Whether a heartbeat URL is configured (phase 18D) — reported by `/health` as
 * `heartbeat.configured`.
 *
 * A BOOLEAN, never the URL. `/health` is unauthenticated and unthrottled (an
 * uptime monitor must reach it with no session), so the URL must not appear in
 * its body: anyone holding a dead-man's-switch ping URL can keep the alarm quiet
 * by pinging it, and a healthchecks.io URL can carry its own management token.
 * This is the same rule that keeps `GET /credentials` to `*Set` booleans and
 * `GET /notifications` to `telegramTokenSet` (AGENTS.md rule 4).
 *
 * Reads the same lazy env-override-then-config value as the ping itself, so the
 * reported state can never disagree with whether a ping would actually be sent.
 */
export function heartbeatConfigured(): boolean {
  return heartbeatUrl() !== undefined;
}

/**
 * Ping the heartbeat. Returns immediately; the request is fire-and-forget. No
 * identifying data. Never throws.
 */
export function pingHeartbeat(): void {
  const url = heartbeatUrl();
  if (!url) return; // feature off
  void fetch(url, {
    method: "GET",
    // A short timeout bounds the worst case: a hanging endpoint delays nothing.
    signal: AbortSignal.timeout(HEARTBEAT_TIMEOUT_MS),
  }).catch(() => {}); // oxlint-disable-line promise/prefer-await-to-then -- sanctioned fire-and-forget idiom (#2), §03: a dead heartbeat must not affect anything.
}
