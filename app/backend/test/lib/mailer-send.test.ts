import { afterEach, describe, expect, it, vi } from "vitest";

// 4B.1 — the provider path. This file resets the module registry so config.ts
// re-evaluates against a stubbed RESEND_API_KEY / MAIL_FROM, then asserts the
// exact payload sent to Resend's REST API (endpoint, bearer header, JSON
// body). Global fetch is stubbed so no network ever happens.

describe("sendMail with a provider configured", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.resetModules();
    vi.restoreAllMocks();
  });

  it("POSTs the message to Resend with the bearer key and never logs the body", async () => {
    vi.resetModules();
    vi.stubEnv("RESEND_API_KEY", "re_test_123");
    vi.stubEnv("MAIL_FROM", "Sprout Automator <no-reply@example.com>");
    const fetchMock = vi.fn<typeof fetch>(
      async () => new Response("{}", { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const { logger } = await import("../../src/lib/logger");
    const infoSpy = vi.spyOn(logger, "info").mockImplementation(() => logger);
    const warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => logger);

    const { sendMail } = await import("../../src/lib/mailer");
    const result = await sendMail({
      to: "someone@example.com",
      subject: "Reset your password",
      html: "<p>reset</p>",
    });

    expect(result).toEqual({ ok: true, mode: "send" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    // The provider path never logs — the body only ever leaves via the fetch.
    expect(infoSpy).not.toHaveBeenCalled();
    expect(warnSpy).not.toHaveBeenCalled();
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("https://api.resend.com/emails");
    expect(init?.method).toBe("POST");
    expect(init?.headers).toMatchObject({
      Authorization: "Bearer re_test_123",
      "Content-Type": "application/json",
    });
    expect(JSON.parse(init?.body as string)).toEqual({
      from: "Sprout Automator <no-reply@example.com>",
      to: "someone@example.com",
      subject: "Reset your password",
      html: "<p>reset</p>",
    });
  });

  it("throws (instead of logging the email) when the provider returns an error", async () => {
    vi.resetModules();
    vi.stubEnv("RESEND_API_KEY", "re_test_123");
    vi.stubEnv("MAIL_FROM", "no-reply@example.com");
    const fetchMock = vi.fn<typeof fetch>(
      async () => new Response('{"message":"rate limit"}', { status: 429 }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const { sendMail } = await import("../../src/lib/mailer");
    await expect(
      sendMail({ to: "a@example.com", subject: "Reset", html: "<p>x</p>" }),
    ).rejects.toThrow(/email send failed \(429\)/);
  });
});
