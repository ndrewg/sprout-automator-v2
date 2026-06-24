// Per-run OTP bridge: multiple users can clock in concurrently, so the
// "I am waiting for an OTP" state must be keyed by runId, not module-global.

type Resolver = (code: string) => void;
type Rejecter = (err: Error) => void;

type PendingOtp = {
  resolve: Resolver;
  reject: Rejecter;
  timeout: NodeJS.Timeout;
};

const pending = new Map<string, PendingOtp>();

const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;

export function isWaitingForOtp(runId: string): boolean {
  return pending.has(runId);
}

export function submitOtp(runId: string, code: string): boolean {
  const entry = pending.get(runId);
  if (!entry) return false;
  clearTimeout(entry.timeout);
  pending.delete(runId);
  entry.resolve(code);
  return true;
}

export function waitForOtp(
  runId: string,
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
): Promise<string> {
  if (pending.has(runId)) {
    throw new Error(`Already waiting for OTP on run ${runId}`);
  }
  return new Promise<string>((resolve, reject) => {
    const timeout = setTimeout(() => {
      pending.delete(runId);
      reject(new Error("OTP timeout: no OTP submitted within time limit"));
    }, timeoutMs);
    pending.set(runId, { resolve, reject, timeout });
  });
}

export function cancelWait(runId: string): void {
  const entry = pending.get(runId);
  if (!entry) return;
  clearTimeout(entry.timeout);
  pending.delete(runId);
  entry.reject(new Error("OTP wait cancelled"));
}
