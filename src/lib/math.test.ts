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

test("fmtRelativeTime uses compact significant digits", () => {
  expect(fmtRelativeTime(0)).toBe("0ms");
  expect(fmtRelativeTime(0.053)).toBe("53ms");
  expect(fmtRelativeTime(0.53)).toBe("0.53s");
  expect(fmtRelativeTime(3.4)).toBe("3.4s");
  expect(fmtRelativeTime(52)).toBe("52s");
  expect(fmtRelativeTime(263)).toBe("4.3m");
  expect(fmtRelativeTime(18.01 * 60)).toBe("18m");
  expect(fmtRelativeTime(7_200)).toBe("2h");
  expect(fmtRelativeTime(104 * 86_400)).toBe("3.4mo");
});


test("relativeTimeDisplay exposes semantic redraw deadlines", () => {
  const milliseconds = relativeTimeDisplay(0.023, "elapsed");
  expect(milliseconds.text).toBe("23ms");
  expect(milliseconds.nextChangeMs).toBeCloseTo(1, 3);

  const seconds = relativeTimeDisplay(13.5, "elapsed");
  expect(seconds.text).toBe("13s");
  expect(seconds.nextChangeMs).toBeCloseTo(500, 6);

  const minutes = relativeTimeDisplay(60 + 47, "elapsed");
  expect(minutes.text).toBe("1.7m");
  expect(minutes.nextChangeMs).toBeCloseTo(5_000, 6);

  const remaining = relativeTimeDisplay(60 + 47.2, "remaining");
  expect(remaining.text).toBe("1.8m");
  expect(remaining.nextChangeMs).toBeCloseTo(800, 6);

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
