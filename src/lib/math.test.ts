import { expect, test } from "bun:test";
import { fmtRelativeTime } from "./math";

test("fmtRelativeTime formats clock-like durations", () => {
  expect(fmtRelativeTime(0)).toBe("0s");
  expect(fmtRelativeTime(100)).toBe("1m 40s");
  expect(fmtRelativeTime(1100)).toBe("18m 20s");
  expect(fmtRelativeTime(7200)).toBe("2h");
});
