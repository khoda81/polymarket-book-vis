import { expect, test } from "bun:test";
import {
  MARKET_COLOR_CHROMA,
  MARKET_COLOR_LUMINANCE,
  fmtRelativeTime,
  fmtSI,
  marketColor,
  marketHue,
  relativeTimeDisplay,
} from "./math";

test("fmtRelativeTime uses one best-fit unit", () => {
  expect(fmtRelativeTime(0)).toBe("0ms");
  expect(fmtRelativeTime(0.61)).toBe("610ms");
  expect(fmtRelativeTime(3.4)).toBe("3.4s");
  expect(fmtRelativeTime(52)).toBe("52s");
  expect(fmtRelativeTime(263)).toBe("4.38m");
  expect(fmtRelativeTime(7_200)).toBe("2h");
  expect(fmtRelativeTime(104 * 86_400)).toBe("3.47mo");
});


test("relativeTimeDisplay exposes semantic redraw deadlines", () => {
  const milliseconds = relativeTimeDisplay(0.023, "elapsed");
  expect(milliseconds.text).toBe("23ms");
  expect(milliseconds.nextChangeMs).toBeCloseTo(1, 3);

  const seconds = relativeTimeDisplay(13.5, "elapsed");
  expect(seconds.text).toBe("13.5s");
  expect(seconds.nextChangeMs).toBeCloseTo(10, 6);

  const minutes = relativeTimeDisplay(60 + 47, "elapsed");
  expect(minutes.text).toBe("1.78m");
  expect(minutes.nextChangeMs).toBeCloseTo(400, 6);

  const remaining = relativeTimeDisplay(60 + 47.2, "remaining");
  expect(remaining.text).toBe("1.79m");
  expect(remaining.nextChangeMs).toBeCloseTo(200, 6);

  expect(relativeTimeDisplay(0, "remaining")).toEqual({
    text: "due",
    nextChangeMs: null,
  });
});


test("fmtSI keeps useful decimals before switching to SI prefixes", () => {
  expect(fmtSI(0.1)).toBe("0.1");
  expect(fmtSI(0.01)).toBe("0.01");
  expect(fmtSI(0.001)).toBe("0.001");
  expect(fmtSI(0.0005)).toBe("500µ");
  expect(fmtSI(0.000001)).toBe("1µ");
  expect(fmtSI(1e-9)).toBe("1n");
  expect(fmtSI(1_000)).toBe("1k");
  expect(fmtSI(1_000_000)).toBe("1M");
  expect(fmtSI(-0)).toBe("0");
});

test("marketColor and marketHue share the same deterministic phase", () => {
  const hue = marketHue("12345", 0);
  expect(marketColor("12345", 0)).toBe(
    `oklch(${MARKET_COLOR_LUMINANCE} ${MARKET_COLOR_CHROMA} ${hue})`,
  );
  expect(marketHue("12345", 0)).toBe(hue);
  expect(hue).toBeGreaterThanOrEqual(0);
  expect(hue).toBeLessThan(360);
});
