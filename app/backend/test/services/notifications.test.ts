import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { encrypt } from "../../src/lib/encryption";
import { escapeHtml, type TelegramSendResult } from "../../src/lib/telegram";
import {
  dispatch,
  expectedFireTime,
  isWeekend,
  notifyRunFinished,
  renderMissedMessage,
  renderRunFinishedMessage,
  sweepMissedRuns,
  type SweepDeps,
} from "../../src/services/notifications";
import type { Run } from "../../src/db/schema";

// Dispatch needs no network (fake transport) and no real database (mocked
// db/client + audit). The sweep is fully dependency-injected. Nothing here
// reaches api.telegram.org or Postgres.

const { selectMock, updateMock, recordAuditMock } = vi.hoisted(() => ({
  selectMock: vi.fn(),
  updateMock: vi.fn(),
  recordAuditMock: vi.fn(),
}));

vi.mock("../../src/db/client", () => ({
  db: { select: selectMock, update: updateMock },
}));

vi.mock("../../src/lib/audit", () => ({
  recordAudit: recordAuditMock,
}));

type Row = {
  id: string;
  userId: string;
  telegramBotTokenEnc: string | null;
  telegramChatId: string | null;
  enabled: boolean;
  notifyOnSuccess: boolean;
  notifyOnFailure: boolean;
  notifyOnSkipped: boolean;
  notifyOnMissed: boolean;
  blockedCount: number;
  updatedAt: Date;
};

function makeRow(overrides: Partial<Row> = {}): Row {
  return {
    id: "n1",
    userId: "user-1",
    telegramBotTokenEnc: encrypt("fake-token-12345"),
    telegramChatId: "123456789",
    enabled: true,
    notifyOnSuccess: true,
    notifyOnFailure: true,
    notifyOnSkipped: true,
    notifyOnMissed: true,
    blockedCount: 0,
    updatedAt: new Date(),
    ...overrides,
  };
}

let currentRow: Row;
let setPatches: Record<string, unknown>[];

function stubDb(initial: Row): void {
  currentRow = { ...initial };
  setPatches = [];
  selectMock.mockImplementation(() => ({
    from: () => ({ where: () => ({ limit: async () => [currentRow] }) }),
  }));
  updateMock.mockImplementation(() => ({
    set: (patch: Record<string, unknown>) => {
      setPatches.push(patch);
      return {
        where: async () => {
          Object.assign(currentRow, patch);
        },
      };
    },
  }));
}

function makeRun(overrides: Partial<Run> = {}): Run {
  return {
    id: "r1",
    userId: "user-1",
    action: "in",
    status: "success",
    loginMethod: null,
    error: null,
    steps: [],
    startedAt: new Date("2026-08-10T05:31:00+08:00"),
    finishedAt: new Date("2026-08-10T05:31:05+08:00"),
    ...overrides,
  };
}

const sendMock = vi.fn<
  (botToken: string, chatId: string, html: string) => Promise<TelegramSendResult>
>();

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("renderRunFinishedMessage — the four shapes", () => {
  const date = new Date("2026-08-10T05:31:00+08:00");

  it("success renders ✅ and the action label", () => {
    expect(
      renderRunFinishedMessage({
        action: "in",
        status: "success",
        error: null,
        skipReason: null,
        date,
      }),
    ).toBe("✅ <b>Clocked in</b>\n05:31 · Mon 10 Aug");
    expect(
      renderRunFinishedMessage({
        action: "out",
        status: "success",
        error: null,
        skipReason: null,
        date,
      }),
    ).toBe("✅ <b>Clocked out</b>\n05:31 · Mon 10 Aug");
  });

  it("failure renders ⚠️ and the escaped reason", () => {
    const html = renderRunFinishedMessage({
      action: "out",
      status: "failure",
      error: "Login failed — <b>could not</b> reach dashboard.",
      skipReason: null,
      date,
    });
    expect(html).toBe(
      "⚠️ <b>Clock-out failed</b>\n05:31 · Mon 10 Aug\n" +
        "Login failed — &lt;b&gt;could not&lt;/b&gt; reach dashboard.",
    );
    expect(html).not.toContain("<b>could not</b>");
  });

  it("benign skip renders ℹ️ with the matched-row reason", () => {
    expect(
      renderRunFinishedMessage({
        action: "in",
        status: "skipped",
        error: null,
        skipReason:
          'Already clocked IN today (matched row "08/10/26  IN  05:02") — skipping.',
        date,
      }),
    ).toBe(
      "ℹ️ <b>Clock-in skipped</b>\n05:31 · Mon 10 Aug\n" +
        'Already clocked IN today (matched row "08/10/26  IN  05:02") — skipping.',
    );
  });

  it("unsafe skip renders ⚠️ with the could-not-verify line", () => {
    expect(
      renderRunFinishedMessage({
        action: "in",
        status: "skipped",
        error: null,
        skipReason:
          "Could not locate Attendance card. Skipping IN as a safety measure.",
        date,
      }),
    ).toBe(
      "⚠️ <b>Clock-in skipped — could not verify</b>\n05:31 · Mon 10 Aug\n" +
        "Could not locate Attendance card. Skipping IN as a safety measure.\n" +
        "You may NOT be clocked in. Check HRHub.",
    );
  });

  it("the two skip variants are distinguished", () => {
    const benign = renderRunFinishedMessage({
      action: "in",
      status: "skipped",
      error: null,
      skipReason: "Already clocked IN today (matched row \"x\") — skipping.",
      date,
    });
    const unsafe = renderRunFinishedMessage({
      action: "in",
      status: "skipped",
      error: null,
      skipReason: "Could not verify clock state (boom). Skipping IN as a safety measure.",
      date,
    });
    expect(benign.startsWith("ℹ️")).toBe(true);
    expect(benign).not.toContain("could not verify");
    expect(unsafe.startsWith("⚠️")).toBe(true);
    expect(unsafe).toContain("could not verify");
    expect(unsafe).toContain("You may NOT be clocked in.");
  });

  it("neither skip variant renders a trailing lifecycle step", () => {
    // Regression guard for the old last-step approach: runAutomation's finally
    // logs "Closing browser context." last, which would otherwise be the reason.
    const benign = renderRunFinishedMessage({
      action: "in",
      status: "skipped",
      error: null,
      skipReason: 'Already clocked IN today (matched row "x") — skipping.',
      date,
    });
    const unsafe = renderRunFinishedMessage({
      action: "in",
      status: "skipped",
      error: null,
      skipReason: "Could not verify clock state (boom). Skipping IN as a safety measure.",
      date,
    });
    expect(benign).not.toContain("Closing browser context.");
    expect(unsafe).not.toContain("Closing browser context.");
  });

  it("strips ANSI escapes from a failure reason", () => {
    const html = renderRunFinishedMessage({
      action: "out",
      status: "failure",
      error: "Login failed — \x1b[2mcould not\x1b[22m reach dashboard.",
      skipReason: null,
      date,
    });
    expect(html).not.toContain("\x1b[");
    expect(html).toContain("could not reach dashboard.");
    expect(html).toContain("Clock-out failed");
  });

  it("strips ANSI from a skip reason before the unsafe marker test", () => {
    const html = renderRunFinishedMessage({
      action: "in",
      status: "skipped",
      error: null,
      skipReason:
        "\x1b[2mCould not\x1b[22m verify clock state. Skipping IN as a safety measure.",
      date,
    });
    expect(html.startsWith("⚠️")).toBe(true);
    expect(html).not.toContain("\x1b[");
    expect(html).toContain("You may NOT be clocked in.");
  });

  it("truncates long reasons in the notification only", () => {
    const long = "boom ".repeat(100); // 500 chars — a multi-line Playwright call log stand-in
    const html = renderRunFinishedMessage({
      action: "out",
      status: "failure",
      error: long,
      skipReason: null,
      date,
    });
    // The full 500-char error is NOT in the message — only the ~300-char clip.
    expect(html.length).toBeLessThan(400);
    expect(html).not.toContain("boom ".repeat(100));
    expect(html.endsWith("…")).toBe(true);
  });
});

describe("renderMissedMessage", () => {
  it("renders the expected-time header and manual-action hint", () => {
    expect(renderMissedMessage("in", "05:30:00", "2026-08-10")).toBe(
      "🔴 <b>Clock-in did not run</b>\nExpected 05:30 · Mon 10 Aug\n\n" +
        "No run was recorded today. The scheduler may have been asleep or the " +
        "server down. Clock in manually if you haven't already.",
    );
  });

  it("derives the action verb — a clock-out miss says Clock out", () => {
    expect(renderMissedMessage("out", "18:05:00", "2026-08-10")).toBe(
      "🔴 <b>Clock-out did not run</b>\nExpected 18:05 · Mon 10 Aug\n\n" +
        "No run was recorded today. The scheduler may have been asleep or the " +
        "server down. Clock out manually if you haven't already.",
    );
    expect(renderMissedMessage("out", "18:05:00", "2026-08-10")).not.toContain(
      "Clock in manually",
    );
  });
});

describe("escapeHtml", () => {
  it("neutralises markup in run-derived strings", () => {
    expect(escapeHtml("<b>bold</b> & <i>italic</i>")).toBe(
      "&lt;b&gt;bold&lt;/b&gt; &amp; &lt;i&gt;italic&lt;/i&gt;",
    );
  });
});

describe("dispatch — the send path and blocked-count state machine", () => {
  it("returns skipped when no settings row exists", async () => {
    stubDb(makeRow());
    selectMock.mockImplementation(() => ({
      from: () => ({ where: () => ({ limit: async () => [] }) }),
    }));
    const out = await dispatch("user-1", "<b>hi</b>", "success", sendMock);
    expect(out).toBe("skipped");
    expect(sendMock).not.toHaveBeenCalled();
    expect(updateMock).not.toHaveBeenCalled();
  });

  it("returns skipped when disabled and does NOT reset blockedCount", async () => {
    stubDb(makeRow({ enabled: false, blockedCount: 5 }));
    const out = await dispatch("user-1", "<b>hi</b>", "success", sendMock);
    expect(out).toBe("skipped");
    expect(sendMock).not.toHaveBeenCalled();
    expect(updateMock).not.toHaveBeenCalled();
    expect(currentRow.blockedCount).toBe(5);
  });

  it("returns skipped when the per-kind toggle is off", async () => {
    stubDb(makeRow({ notifyOnSuccess: false, blockedCount: 2 }));
    const out = await dispatch("user-1", "<b>hi</b>", "success", sendMock);
    expect(out).toBe("skipped");
    expect(sendMock).not.toHaveBeenCalled();
    expect(currentRow.blockedCount).toBe(2);
  });

  it("returns skipped when token or chat id is missing/malformed", async () => {
    stubDb(makeRow({ telegramBotTokenEnc: null }));
    expect(await dispatch("user-1", "x", "success", sendMock)).toBe("skipped");
    stubDb(makeRow({ telegramChatId: "not-a-number" }));
    expect(await dispatch("user-1", "x", "success", sendMock)).toBe("skipped");
    expect(sendMock).not.toHaveBeenCalled();
  });

  it("on success resets a non-zero blockedCount to 0", async () => {
    stubDb(makeRow({ blockedCount: 2 }));
    sendMock.mockResolvedValue({ ok: true });
    const out = await dispatch("user-1", "<b>hi</b>", "success", sendMock);
    expect(out).toBe("sent");
    expect(sendMock).toHaveBeenCalledWith(
      "fake-token-12345",
      "123456789",
      "<b>hi</b>",
    );
    expect(setPatches).toEqual([{ blockedCount: 0 }]);
    expect(currentRow.blockedCount).toBe(0);
  });

  it("background dispatch passes NO retry cap — the transport default of 3 applies", async () => {
    // The interactive test route caps its own calls at {maxAttempts: 2}; a
    // background dispatch (nobody waiting, a lost notification is the failure
    // we are preventing) must stay at the transport default. Exactly three
    // arguments means no retry config was passed (review defect 19).
    stubDb(makeRow());
    sendMock.mockResolvedValue({ ok: true });
    await dispatch("user-1", "<b>hi</b>", "success", sendMock);
    expect(sendMock).toHaveBeenCalledWith(
      "fake-token-12345",
      "123456789",
      "<b>hi</b>",
    );
    expect(sendMock.mock.calls[0]).toHaveLength(3);
  });

  it("on success leaves blockedCount alone when it is already 0", async () => {
    stubDb(makeRow({ blockedCount: 0 }));
    sendMock.mockResolvedValue({ ok: true });
    expect(await dispatch("user-1", "x", "success", sendMock)).toBe("sent");
    expect(updateMock).not.toHaveBeenCalled();
  });

  it("three consecutive blocked results flip enabled to false and write exactly one audit row", async () => {
    stubDb(makeRow({ blockedCount: 0 }));
    sendMock.mockResolvedValue({ ok: false, error: "blocked" });

    expect(await dispatch("user-1", "x", "success", sendMock)).toBe("failed");
    expect(currentRow.blockedCount).toBe(1);
    expect(currentRow.enabled).toBe(true);
    expect(await dispatch("user-1", "x", "success", sendMock)).toBe("failed");
    expect(currentRow.blockedCount).toBe(2);
    expect(await dispatch("user-1", "x", "success", sendMock)).toBe("failed");

    expect(currentRow.enabled).toBe(false);
    expect(currentRow.blockedCount).toBe(3);
    expect(recordAuditMock).toHaveBeenCalledTimes(1);
    expect(recordAuditMock).toHaveBeenCalledWith("notification_auto_disabled", {
      userId: "user-1",
      metadata: { blockedCount: 3, reason: "consecutive_blocked" },
    });
  });

  it("a network error leaves blockedCount untouched", async () => {
    stubDb(makeRow({ blockedCount: 2 }));
    sendMock.mockResolvedValue({ ok: false, error: "network" });
    const out = await dispatch("user-1", "x", "success", sendMock);
    expect(out).toBe("failed");
    expect(updateMock).not.toHaveBeenCalled();
    expect(currentRow.blockedCount).toBe(2);
    expect(currentRow.enabled).toBe(true);
  });
});

describe("notifyRunFinished", () => {
  it("does nothing for a non-terminal status", async () => {
    stubDb(makeRow());
    const out = await notifyRunFinished({
      run: makeRun({ status: "pending" }),
      skipReason: null,
    });
    expect(out).toBe("skipped");
    expect(updateMock).not.toHaveBeenCalled();
  });
});

describe("expectedFireTime / isWeekend", () => {
  it("converts Manila wall-clock date+time to an instant", () => {
    expect(expectedFireTime("2026-08-10", "05:30:00").getTime()).toBe(
      new Date("2026-08-10T05:30:00+08:00").getTime(),
    );
    expect(expectedFireTime("2026-08-10", "18:05:00").getTime()).toBe(
      new Date("2026-08-10T18:05:00+08:00").getTime(),
    );
  });

  it("detects weekends from the Manila date string", () => {
    expect(isWeekend("2026-08-08")).toBe(true); // Saturday
    expect(isWeekend("2026-08-09")).toBe(true); // Sunday
    expect(isWeekend("2026-08-10")).toBe(false); // Monday
  });
});

// --- sweep control flow (all dependencies faked — no DB, no network) --------

type SweepCalls = {
  dispatched: string[];
  inserted: string[];
  loaded: number;
};

function makeSweepDeps(overrides: Partial<SweepDeps> = {}): {
  deps: SweepDeps;
  calls: SweepCalls;
} {
  const calls: SweepCalls = { dispatched: [], inserted: [], loaded: 0 };
  const deps: SweepDeps = {
    now: () => new Date("2026-08-10T05:55:00+08:00"), // Monday, 25min past 05:30
    isWorkday: () => true,
    loadEnabledSchedules: async () => {
      calls.loaded += 1;
      return [
        {
          id: "s1",
          userId: "u1",
          clockInTime: "05:30:00",
          clockOutTime: "18:05:00",
          enabled: true,
          pausedFrom: null,
          pausedUntil: null,
          updatedAt: new Date(),
        },
      ];
    },
    hasRunToday: async () => false,
    tryInsertMissedNotice: async (userId, action, dateStr) => {
      calls.inserted.push(`${userId}:${action}:${dateStr}`);
      return true;
    },
    dispatchMissed: async (_userId, html) => {
      calls.dispatched.push(html);
      return "sent";
    },
    ...overrides,
  };
  return { deps, calls };
}

describe("sweepMissedRuns", () => {
  it("misses the in-run past grace → one notice + one dispatch; second sweep is idempotent", async () => {
    let claim = true;
    const { deps, calls } = makeSweepDeps({
      tryInsertMissedNotice: async (userId, action, dateStr) => {
        calls.inserted.push(`${userId}:${action}:${dateStr}`);
        const result = claim;
        claim = false; // the unique index now rejects a duplicate insert
        return result;
      },
    });

    await sweepMissedRuns(deps);
    // in is past 05:50 grace → missed; out is still in the future → skipped.
    expect(calls.inserted).toEqual(["u1:in:2026-08-10"]);
    expect(calls.dispatched).toHaveLength(1);
    expect(calls.dispatched[0]).toContain("Clock-in did not run");

    await sweepMissedRuns(deps);
    expect(calls.inserted).toEqual([
      "u1:in:2026-08-10",
      "u1:in:2026-08-10", // attempted again…
    ]);
    expect(calls.dispatched).toHaveLength(1); // …but no second dispatch
  });

  it("a run exists today (any status) → no notice and no dispatch", async () => {
    const { deps, calls } = makeSweepDeps({ hasRunToday: async () => true });
    await sweepMissedRuns(deps);
    expect(calls.inserted).toEqual([]);
    expect(calls.dispatched).toEqual([]);
  });

  it("weekend or holiday short-circuits before any lookup", async () => {
    const { deps, calls } = makeSweepDeps({ isWorkday: () => false });
    await sweepMissedRuns(deps);
    expect(calls.loaded).toBe(0);
    expect(calls.inserted).toEqual([]);
    expect(calls.dispatched).toEqual([]);
  });

  it("now inside the grace window → nothing", async () => {
    const { deps, calls } = makeSweepDeps({
      now: () => new Date("2026-08-10T05:45:00+08:00"), // 05:30 + 15min < 20min grace
    });
    await sweepMissedRuns(deps);
    expect(calls.inserted).toEqual([]);
    expect(calls.dispatched).toEqual([]);
  });
});
