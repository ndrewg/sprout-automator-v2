import { describe, it, expect } from "vitest";
import { timeToCronExpression } from "./scheduler";

describe("timeToCronExpression", () => {
  it("converts HH:MM / HH:MM:SS to a Mon–Fri cron expression", () => {
    expect(timeToCronExpression("05:30")).toBe("30 5 * * 1-5");
    expect(timeToCronExpression("18:05:00")).toBe("5 18 * * 1-5");
    expect(timeToCronExpression("00:00")).toBe("0 0 * * 1-5");
    expect(timeToCronExpression("23:59")).toBe("59 23 * * 1-5");
  });

  it("rejects out-of-range / malformed times", () => {
    expect(() => timeToCronExpression("24:00")).toThrow();
    expect(() => timeToCronExpression("5:99")).toThrow();
    expect(() => timeToCronExpression("notatime")).toThrow();
  });
});
