import { describe, expect, test } from "bun:test";
import { fmtRelativeTime, logAgeTicks } from "./math";

describe("logAgeTicks", () => {
  test("places ticks at real logarithmic durations including zero", () => {
    const ticks = logAgeTicks(
      { min: 0, max: Math.log1p(20 * 60) },
      420,
    );
    const seconds = ticks.map((tick) => Math.expm1(tick));

    expect(seconds[0]).toBe(0);
    expect(seconds).toEqual([...seconds].sort((a, b) => a - b));
    for (const value of seconds.filter((seconds) => seconds >= 60))
      expect(Math.round(value) % 60).toBe(0);
  });

  test("formats duration ticks as relative clock units", () => {
    expect(fmtRelativeTime(0)).toBe("0s");
    expect(fmtRelativeTime(100)).toBe("1m 40s");
    expect(fmtRelativeTime(1100)).toBe("18m 20s");
    expect(fmtRelativeTime(7200)).toBe("2h");
  });
});
