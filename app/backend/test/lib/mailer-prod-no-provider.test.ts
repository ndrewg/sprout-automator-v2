import { afterEach, describe, expect, it, vi } from "vitest";

// 4B.1 — the production fallback (no provider, NODE_ENV=production). Recipient
// + subject only, plus a loud warn that reset emails cannot be delivered. A
// reset link in a production log file is a live credential, so the body is
// never logged here. This file resets the module registry so config.ts
// re-evaluates against the stubbed NODE_ENV=production.

describe("sendMail without a provider in production", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
    vi.restoreAllMocks();
  });

  it("logs recipient + subject and warns, and never logs the body", async () => {
    vi.resetModules();
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("RESEND_API_KEY", "");
    vi.stubEnv("MAIL_FROM", "");

    const { logger } = await import("../../src/lib/logger");
    const { sendMail } = await import("../../src/lib/mailer");
    const infoSpy = vi.spyOn(logger, "info").mockImplementation(() => logger);
    const warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => logger);

    const subject = "Reset your password";
    const html =
      '<a href="https://sprout.example.com/reset?token=prod-reset-token-xyz">reset</a>';
    const result = await sendMail({ to: "someone@example.com", subject, html });

    expect(result).toEqual({ ok: true, mode: "log" });
    // A warn is the loud signal that mail is not actually delivered.
    expect(warnSpy).toHaveBeenCalledTimes(1);

    // The html key never reaches the logger at all in production.
    const firstInfoArg = infoSpy.mock.calls[0]?.[0] as Record<string, unknown> | undefined;
    const firstWarnArg = warnSpy.mock.calls[0]?.[0] as Record<string, unknown> | undefined;
    expect(firstInfoArg?.["html"]).toBeUndefined();
    expect(firstWarnArg?.["html"]).toBeUndefined();

    const logged = JSON.stringify([...infoSpy.mock.calls, ...warnSpy.mock.calls]);
    expect(logged).toContain("someone@example.com");
    expect(logged).toContain(subject);
    // The token never appears in a production log line.
    expect(logged).not.toContain("prod-reset-token-xyz");
  });
});
