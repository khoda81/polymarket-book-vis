import { expect, test } from "bun:test";
import { fmtRelativeTime, relativeTimeDisplay } from "./math";

test("fmtRelativeTime formats clock-like durations", () => {
  expect(fmtRelativeTime(0)).toBe("0s");
  expect(fmtRelativeTime(100)).toBe("1m 40s");
  expect(fmtRelativeTime(1100)).toBe("18m 20s");
  expect(fmtRelativeTime(7200)).toBe("2h");
});


test("relativeTimeDisplay exposes semantic redraw deadlines", () => {
  const milliseconds = relativeTimeDisplay(0.023, "elapsed");
  expect(milliseconds.text).toBe("23ms");
  expect(milliseconds.nextChangeMs).toBeCloseTo(1, 3);

  const tenths = relativeTimeDisplay(13.5, "elapsed");
  expect(tenths.text).toBe("13.5s");
  expect(tenths.nextChangeMs).toBeCloseTo(100, 6);

  const seconds = relativeTimeDisplay(60 + 47, "elapsed");
  expect(seconds.text).toBe("1m 47s");
  expect(seconds.nextChangeMs).toBeCloseTo(1000, 6);

  const remaining = relativeTimeDisplay(60 + 47.2, "remaining");
  expect(remaining.text).toBe("1m 48s");
  expect(remaining.nextChangeMs).toBeCloseTo(200, 6);

  expect(relativeTimeDisplay(0, "remaining")).toEqual({
    text: "due",
    nextChangeMs: null,
  });
});
