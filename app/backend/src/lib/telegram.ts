import { logger } from "./logger";

// The ONLY module that talks to api.telegram.org. No database, no settings
// lookup, no policy — callers decide who/what/how.

const API_TIMEOUT_MS = 15_000;
// A cold-start DNS/TLS handshake can exceed a single 10s attempt (review
// defect 17: the first outbound call after a restart paid DNS + TLS and
// timed out, silently dropping the notification). Retry transport-level
// failures and 429s with backoff; permanent errors go straight back. The
// Test-connection button (getMe) is the most cold-start-exposed call of all,
// so it shares the same timeout and retry policy (review defect 18).
const MAX_ATTEMPTS = 3;
const RETRY_BACKOFF_MS = [1_000, 3_000];
// Telegram can return a huge retry_after on 429. Beyond this, give up rather
// than hold a pending timer (review defect 18).
const MAX_RETRY_AFTER_S = 60;

// Only these are worth another attempt. blocked / bad_token are permanent —
// retrying them would just waste the auto-disable signal (hard rule 11).
// unknown means the response didn't parse as JSON — the shape of a Telegram
// 502/503 HTML page — which is transient (review defect 18).
const RETRYABLE_ERRORS: ReadonlySet<TelegramError> = new Set([
  "network",
  "rate_limited",
  "unknown",
]);

/**
 * Overridable base URL. Production hits the real Telegram API; tests point it
 * at a dead port to prove that a dead Telegram endpoint never affects a run.
 * Read lazily so an integration test can flip it without reloading modules.
 */
function apiBase(): string {
  return process.env["TELEGRAM_API_BASE"] ?? "https://api.telegram.org";
}

export type TelegramError =
  | "blocked"
  | "rate_limited"
  | "network"
  | "bad_token"
  | "unknown";

export type TelegramSendResult =
  | { ok: true }
  | { ok: false; error: TelegramError };

export type TelegramBotInfo =
  | { ok: true; username: string; id: number }
  | { ok: false; error: TelegramError };

/** Retry tuning. The defaults are production values; tests shrink the backoff
 *  and inject a sleep spy so the retry loop runs in milliseconds. */
export type SendRetryConfig = {
  maxAttempts?: number;
  backoffMs?: number[];
  sleep?: (ms: number) => Promise<void>;
};

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

type ApiBody = {
  ok?: boolean;
  error_code?: number;
  description?: string;
  parameters?: { retry_after?: number };
};

type Attempt<T = void> =
  | { ok: true; value: T }
  | {
      ok: false;
      error: TelegramError;
      retryAfterSeconds?: number;
      errName?: string;
      errMessage?: string;
    };

/** Escape text destined for HTML parse_mode. Callers MUST use this for any
 *  value that came from a run (error strings, step messages). */
export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function isRetryable(error: TelegramError): boolean {
  return RETRYABLE_ERRORS.has(error);
}

/** A result that will never succeed by retrying, or has nothing left to give. */
function shouldGiveUp<T>(
  result: Attempt<T>,
  attemptIndex: number,
  maxAttempts: number,
): boolean {
  if (!result.ok && !isRetryable(result.error)) return true;
  if (attemptIndex >= maxAttempts) return true;
  // A 429 whose retry_after exceeds the cap would hold a pending timer for
  // minutes; surface the rate_limited error instead.
  if (
    !result.ok &&
    result.error === "rate_limited" &&
    result.retryAfterSeconds !== undefined &&
    result.retryAfterSeconds > MAX_RETRY_AFTER_S
  ) {
    return true;
  }
  return false;
}

/** Wait before the next attempt. A 429's `retry_after` (seconds) wins over the
 *  fixed backoff schedule; network failures use ~1s / ~3s. */
function retryDelayMs(
  error: TelegramError,
  retryAfterSeconds: number | undefined,
  backoffMs: number[],
  attemptIndex: number,
): number {
  if (error === "rate_limited" && retryAfterSeconds !== undefined) {
    return retryAfterSeconds * 1000;
  }
  return backoffMs[attemptIndex - 1] ?? 0;
}

/** The transient-carrying fields of a failure, for a compact log line. */
function attemptLogCtx<T>(
  result: Attempt<T>,
): {
  errName?: string;
  errMessage?: string;
  retryAfterSeconds?: number;
} {
  if (result.ok) return {};
  return {
    ...(result.errName !== undefined ? { errName: result.errName } : {}),
    ...(result.errMessage !== undefined
      ? { errMessage: result.errMessage }
      : {}),
    ...(result.retryAfterSeconds !== undefined
      ? { retryAfterSeconds: result.retryAfterSeconds }
      : {}),
  };
}

/** The shared retry loop. Never logs a raw error object — only `errName` /
 *  `errMessage` (a DOMException carries ~25 DOM constants that would bury
 *  real signal). Fire-and-forget callers absorb the waits. */
async function withRetry<T>(
  attemptFn: () => Promise<Attempt<T>>,
  retry: SendRetryConfig,
  what: string,
): Promise<Attempt<T>> {
  const { maxAttempts, backoffMs, sleep } = {
    maxAttempts: MAX_ATTEMPTS,
    backoffMs: RETRY_BACKOFF_MS,
    sleep: defaultSleep,
    ...retry,
  };

  let last: Attempt<T> = { ok: false, error: "network" };
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const result = await attemptFn();
    if (result.ok) return result;
    last = result;

    // blocked / bad_token are permanent, and an oversized retry_after gives up
    // rather than hold a timer — both reach the caller on this attempt.
    if (shouldGiveUp(result, attempt, maxAttempts)) break;

    const delayMs = retryDelayMs(
      result.error,
      result.retryAfterSeconds,
      backoffMs,
      attempt,
    );
    logger.debug(
      { attempt, maxAttempts, delayMs, ...attemptLogCtx(result) },
      `${what} attempt failed; retrying`,
    );
    await sleep(delayMs);
  }

  // Only a retryable error that exhausted its attempts (or an oversized
  // retry_after) is worth a warn here; permanent errors were already handed
  // back to the caller.
  if (!last.ok && isRetryable(last.error)) {
    logger.warn(
      { error: last.error, ...attemptLogCtx(last) },
      `${what} failed after exhausting retries`,
    );
  }
  return last;
}

async function attemptSend(
  botToken: string,
  chatId: string,
  html: string,
): Promise<Attempt<void>> {
  try {
    const res = await fetch(`${apiBase()}/bot${botToken}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text: html,
        parse_mode: "HTML",
        disable_web_page_preview: true,
      }),
      signal: AbortSignal.timeout(API_TIMEOUT_MS),
    });
    // Telegram returns non-JSON on some 5xx — never let that throw upward.
    let body: ApiBody;
    try {
      body = (await res.json()) as ApiBody;
    } catch {
      return { ok: false, error: "unknown" };
    }
    if (body.ok) return { ok: true, value: undefined };
    return {
      ok: false,
      error: classify(body.error_code, body.description),
      ...(body.parameters?.retry_after !== undefined
        ? { retryAfterSeconds: body.parameters.retry_after }
        : {}),
    };
  } catch (err: unknown) {
    // AbortSignal.timeout and DNS/socket failures land here.
    const errName = err instanceof Error ? err.name : typeof err;
    const errMessage = err instanceof Error ? err.message : String(err);
    return { ok: false, error: "network", errName, errMessage };
  }
}

export async function sendTelegramMessage(
  botToken: string,
  chatId: string,
  html: string,
  retry: SendRetryConfig = {},
): Promise<TelegramSendResult> {
  const result = await withRetry(
    () => attemptSend(botToken, chatId, html),
    retry,
    "telegram send",
  );
  return result.ok ? { ok: true } : { ok: false, error: result.error };
}

async function attemptGetMe(botToken: string): Promise<Attempt<{ username: string; id: number }>> {
  try {
    const res = await fetch(`${apiBase()}/bot${botToken}/getMe`, {
      signal: AbortSignal.timeout(API_TIMEOUT_MS),
    });
    let body: ApiBody & {
      result?: { id: number; is_bot: boolean; username: string };
    };
    try {
      body = (await res.json()) as typeof body;
    } catch {
      return { ok: false, error: "unknown" };
    }
    if (body.ok && body.result?.is_bot) {
      return {
        ok: true,
        value: { username: body.result.username, id: body.result.id },
      };
    }
    return {
      ok: false,
      error: classify(body.error_code, body.description),
      ...(body.parameters?.retry_after !== undefined
        ? { retryAfterSeconds: body.parameters.retry_after }
        : {}),
    };
  } catch (err: unknown) {
    const errName = err instanceof Error ? err.name : typeof err;
    const errMessage = err instanceof Error ? err.message : String(err);
    return { ok: false, error: "network", errName, errMessage };
  }
}

export async function getBotInfo(
  botToken: string,
  retry: SendRetryConfig = {},
): Promise<TelegramBotInfo> {
  const result = await withRetry(
    () => attemptGetMe(botToken),
    retry,
    "telegram getMe",
  );
  if (result.ok) {
    return { ok: true, username: result.value.username, id: result.value.id };
  }
  return { ok: false, error: result.error };
}

function classify(
  code: number | undefined,
  description: string | undefined,
): TelegramError {
  const d = (description ?? "").toLowerCase();
  if (code === 401 || d.includes("unauthorized")) return "bad_token";
  if (code === 429) return "rate_limited";
  if (
    d.includes("chat not found") ||
    d.includes("blocked") ||
    d.includes("kicked")
  ) {
    return "blocked";
  }
  return "unknown";
}
