import { describe, expect, test } from "bun:test";
import { emptyTokenBook } from "./orderBook";
import {
  DEFAULT_SIGNED_VOLUME_COLOR_SCALE,
  signedVolumeAtPosition,
  signedVolumeColor,
  signedVolumePosition,
  signedVolumeSegments,
} from "./signedVolume";

describe("signedVolumeSegments", () => {
  test("is positive below bids, zero in the spread, and negative above asks", () => {
    const book = emptyTokenBook();
    book.usdToYes.setLevel("bid-1", { price: 0.4, take: 10 });
    book.usdToYes.setLevel("bid-2", { price: 0.3, take: 5 });
    book.yesToUsd.setLevel("ask", { price: 1 / 0.6, take: 6 });

    expect(signedVolumeSegments(book)).toEqual([
      { lo: 0, hi: 0.3, volume: 15 },
      { lo: 0.3, hi: 0.4, volume: 10 },
      { lo: 0.4, hi: 0.6, volume: 0 },
      { lo: 0.6, hi: 1, volume: -10 },
    ]);
  });
});

describe("signedVolumePosition", () => {
  test("uses softLimit as a symmetric half-saturation parameter", () => {
    expect(signedVolumePosition(0, 100)).toBe(0.5);
    expect(signedVolumePosition(100, 100)).toBe(0.75);
    expect(signedVolumePosition(-100, 100)).toBe(0.25);
    expect(signedVolumePosition(Infinity, 100)).toBe(1);
    expect(signedVolumePosition(-Infinity, 100)).toBe(0);
  });

  test("round-trips finite positions", () => {
    for (const volume of [-1000, -100, -1, 0, 1, 100, 1000]) {
      const position = signedVolumePosition(volume, 100);
      expect(signedVolumeAtPosition(position, 100)).toBeCloseTo(volume);
    }
  });
});

describe("signedVolumeColor", () => {
  test("uses equivalent-luminance opposing hues and zero ink at zero force", () => {
    const positive = signedVolumeColor(100);
    const negative = signedVolumeColor(-100);
    expect(positive).toContain(`oklch(${DEFAULT_SIGNED_VOLUME_COLOR_SCALE.luminance}`);
    expect(negative).toContain(`oklch(${DEFAULT_SIGNED_VOLUME_COLOR_SCALE.luminance}`);
    expect(positive).not.toBe(negative);
    expect(signedVolumeColor(0)).toBe("transparent");
  });
});
