import { afterEach, describe, expect, it, vi } from "vitest";
import { logger } from "../../src/lib/logger";

// 4B.1 — the dev fallback (no provider, NODE_ENV != "production"; the unit env
// is NODE_ENV=test). The FULL message, including the reset link, is logged at
// info: in development that link is the only way to complete a reset, so
// logging it is the entire point of the branch. (In production the body is
// never logged — see mailer-prod-no-provider.test.ts.)

describe("sendMail without a provider in development", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("logs the full message including the reset link and returns success", async () => {
    const infoSpy = vi.spyOn(logger, "info").mockImplementation(() => logger);
    const { sendMail } = await import("../../src/lib/mailer");

    const subject = "Reset your password";
    const html =
      '<a href="http://localhost:3000/reset?token=dev-reset-token-abc">reset</a>';
    const result = await sendMail({ to: "someone@example.com", subject, html });

    expect(result).toEqual({ ok: true, mode: "log" });
    expect(infoSpy).toHaveBeenCalledTimes(1);

    // The full message object — html included — is what reaches the logger.
    const firstArg = infoSpy.mock.calls[0]?.[0] as Record<string, unknown> | undefined;
    expect(firstArg).toMatchObject({
      to: "someone@example.com",
      subject,
      html,
    });
    // And the token value itself is in the dev log: that is the point of the
    // branch — without it a reset cannot be completed.
    const logged = JSON.stringify(infoSpy.mock.calls);
    expect(logged).toContain("dev-reset-token-abc");
  });
});
