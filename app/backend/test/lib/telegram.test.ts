import { afterEach, describe, expect, it, vi } from "vitest";
import {
  getBotInfo,
  sendTelegramMessage,
  type SendRetryConfig,
} from "../../src/lib/telegram";

// No real network: global fetch is stubbed per test. The backoff is shrunk to
// zero and `sleep` replaced with a spy so the retry loop runs in milliseconds
// and a test can assert exactly how long was waited.

const TOKEN = "123456789:ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghij"; // gitleaks:allow
const CHAT_ID = "123456789";
const HTML = "<b>clocked in</b>";

type JsonBody = {
  ok?: boolean;
  error_code?: number;
  description?: string;
  parameters?: { retry_after?: number };
  result?: { id: number; is_bot: boolean; username: string };
};

function okResponse(): { json: () => Promise<JsonBody> } {
  return { json: async () => ({ ok: true }) };
}

function apiResponse(body: JsonBody): { json: () => Promise<JsonBody> } {
  return { json: async () => body };
}

/** The non-JSON body Telegram serves on a 502/503 HTML error page. */
function htmlPage(): { json: () => Promise<JsonBody> } {
  return {
    json: async () => {
      throw new Error("Unexpected token '<'...");
    },
  };
}

/** Zero backoff + a sleep spy: fast, deterministic, and observable. */
function fastRetry(sleeps: number[] = []): Required<SendRetryConfig> {
  return {
    maxAttempts: 3,
    backoffMs: [0, 0],
    sleep: async (ms) => {
      sleeps.push(ms);
    },
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("sendTelegramMessage retry", () => {
  it("a transient network failure then success delivers the message", async () => {
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new Error("socket hang up"))
      .mockResolvedValueOnce(okResponse());
    vi.stubGlobal("fetch", fetchMock);

    const result = await sendTelegramMessage(
      TOKEN,
      CHAT_ID,
      HTML,
      fastRetry(),
    );
    expect(result).toEqual({ ok: true });
    // Attempt 1 failed (transport), attempt 2 succeeded — exactly one message
    // was ultimately sent, via two HTTP calls.
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("an always-failing transport is capped at maxAttempts and surfaces network", async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error("socket hang up"));
    vi.stubGlobal("fetch", fetchMock);

    const result = await sendTelegramMessage(
      TOKEN,
      CHAT_ID,
      HTML,
      fastRetry(),
    );
    expect(result).toEqual({ ok: false, error: "network" });
    expect(fetchMock).toHaveBeenCalledTimes(3); // capped, not retried forever
  });

  it("an explicit maxAttempts: 2 caps at two attempts — the interactive cap", async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error("socket hang up"));
    vi.stubGlobal("fetch", fetchMock);

    const result = await sendTelegramMessage(TOKEN, CHAT_ID, HTML, {
      ...fastRetry(),
      maxAttempts: 2,
    });
    expect(result).toEqual({ ok: false, error: "network" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("blocked is NOT retried — it must reach the auto-disable path immediately", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      apiResponse({
        ok: false,
        error_code: 403,
        description: "Forbidden: bot was blocked by the user",
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await sendTelegramMessage(
      TOKEN,
      CHAT_ID,
      HTML,
      fastRetry(),
    );
    expect(result).toEqual({ ok: false, error: "blocked" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("bad_token is NOT retried either", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      apiResponse({ ok: false, error_code: 401, description: "Unauthorized" }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await sendTelegramMessage(
      TOKEN,
      CHAT_ID,
      HTML,
      fastRetry(),
    );
    expect(result).toEqual({ ok: false, error: "bad_token" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("unknown (non-JSON 502/503 page) is retried as transient", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(htmlPage())
      .mockResolvedValueOnce(okResponse());
    vi.stubGlobal("fetch", fetchMock);

    const result = await sendTelegramMessage(
      TOKEN,
      CHAT_ID,
      HTML,
      fastRetry(),
    );
    expect(result).toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("an always-unknown transport is capped and surfaces unknown", async () => {
    const fetchMock = vi.fn().mockResolvedValue(htmlPage());
    vi.stubGlobal("fetch", fetchMock);

    const result = await sendTelegramMessage(
      TOKEN,
      CHAT_ID,
      HTML,
      fastRetry(),
    );
    expect(result).toEqual({ ok: false, error: "unknown" });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("rate_limited is retried, honouring Telegram's retry_after", async () => {
    const sleeps: number[] = [];
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        apiResponse({
          ok: false,
          error_code: 429,
          description: "Too Many Requests",
          parameters: { retry_after: 2 },
        }),
      )
      .mockResolvedValueOnce(okResponse());
    vi.stubGlobal("fetch", fetchMock);

    const result = await sendTelegramMessage(TOKEN, CHAT_ID, HTML, {
      ...fastRetry(),
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    });
    expect(result).toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    // retry_after:2s won over the zero backoff — the wait was 2000ms, not 0.
    expect(sleeps).toEqual([2000]);
  });

  it("an unrelenting 429 is retried up to the cap and surfaces rate_limited", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      apiResponse({
        ok: false,
        error_code: 429,
        description: "Too Many Requests",
        parameters: { retry_after: 1 },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await sendTelegramMessage(
      TOKEN,
      CHAT_ID,
      HTML,
      fastRetry(),
    );
    expect(result).toEqual({ ok: false, error: "rate_limited" });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("a retry_after beyond the 60s cap gives up instead of holding a pending timer", async () => {
    const sleeps: number[] = [];
    const fetchMock = vi.fn().mockResolvedValue(
      apiResponse({
        ok: false,
        error_code: 429,
        description: "Too Many Requests",
        parameters: { retry_after: 120 },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await sendTelegramMessage(TOKEN, CHAT_ID, HTML, {
      ...fastRetry(),
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    });
    expect(result).toEqual({ ok: false, error: "rate_limited" });
    expect(fetchMock).toHaveBeenCalledTimes(1); // no retry, no 2-minute timer
    expect(sleeps).toEqual([]);
  });

  it("a retry_after at exactly the 60s cap is still honoured", async () => {
    const sleeps: number[] = [];
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        apiResponse({
          ok: false,
          error_code: 429,
          description: "Too Many Requests",
          parameters: { retry_after: 60 },
        }),
      )
      .mockResolvedValueOnce(okResponse());
    vi.stubGlobal("fetch", fetchMock);

    const result = await sendTelegramMessage(TOKEN, CHAT_ID, HTML, {
      ...fastRetry(),
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    });
    expect(result).toEqual({ ok: true });
    expect(sleeps).toEqual([60000]);
  });
});

describe("getBotInfo retry", () => {
  it("a transient transport failure then success verifies the bot", async () => {
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new Error("socket hang up"))
      .mockResolvedValueOnce(
        apiResponse({
          ok: true,
          result: { id: 1, is_bot: true, username: "sprout_bot" },
        }),
      );
    vi.stubGlobal("fetch", fetchMock);

    const result = await getBotInfo(TOKEN, fastRetry());
    expect(result).toEqual({ ok: true, username: "sprout_bot", id: 1 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("bad_token is NOT retried", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      apiResponse({ ok: false, error_code: 401, description: "Unauthorized" }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await getBotInfo(TOKEN, fastRetry());
    expect(result).toEqual({ ok: false, error: "bad_token" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("an unrelenting transport failure is capped", async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error("socket hang up"));
    vi.stubGlobal("fetch", fetchMock);

    const result = await getBotInfo(TOKEN, fastRetry());
    expect(result).toEqual({ ok: false, error: "network" });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
});
