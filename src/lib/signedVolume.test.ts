import { describe, expect, test } from "bun:test";
import { emptyTokenBook } from "./orderBook";
import { priceFromLegacyNumber as p } from "./price";
import {
  DEFAULT_SIGNED_VOLUME_COLOR_SCALE,
  signedVolumeColor,
  signedVolumeSegments,
} from "./signedVolume";

describe("signedVolumeSegments", () => {
  test("tracks signed shares and the capital needed to sweep each side", () => {
    const book = emptyTokenBook();
    book.usdToYes.setLevel(p(0.4), 10);
    book.usdToYes.setLevel(p(0.3), 5);
    book.yesToUsd.setLevel(p(0.6), 10);

    expect(signedVolumeSegments(book)).toEqual([
      // Wiping bids is equivalent to buying NO: 10×0.6 + 5×0.7 = 9.5.
      { lo: p(0), hi: p(0.3), volume: 15, sweepCost: 9.5 },
      { lo: p(0.3), hi: p(0.4), volume: 10, sweepCost: 6 },
      { lo: p(0.4), hi: p(0.6), volume: 0, sweepCost: 0 },
      { lo: p(0.6), hi: p(1), volume: -10, sweepCost: 6 },
    ]);
  });

  test("keeps a many-level empty spread exactly zero", () => {
    const book = emptyTokenBook();
    for (let i = 0; i < 40; i++) {
      const price = 0.4 - i * 0.001;
      const take = 0.1 + i * 0.037;
      book.usdToYes.setLevel(p(price), take);
    }
    book.yesToUsd.setLevel(p(0.6), 10);

    const spread = signedVolumeSegments(book).find(
      (segment) => segment.lo === p(0.4) && segment.hi === p(0.6),
    );
    expect(spread).toEqual({
      lo: p(0.4),
      hi: p(0.6),
      volume: 0,
      sweepCost: 0,
    });
  });
});

describe("signedVolumeColor", () => {
  test("uses equivalent-luminance opposing hues independent of magnitude", () => {
    const positive = signedVolumeColor(1);
    const negative = signedVolumeColor(-1);

    expect(positive).toContain(
      `oklch(${DEFAULT_SIGNED_VOLUME_COLOR_SCALE.luminance}`,
    );
    expect(negative).toContain(
      `oklch(${DEFAULT_SIGNED_VOLUME_COLOR_SCALE.luminance}`,
    );
    expect(positive).not.toBe(negative);
    expect(signedVolumeColor(1_000_000)).toBe(positive);
    expect(signedVolumeColor(-1_000_000)).toBe(negative);
    expect(signedVolumeColor(0)).toBe("transparent");
  });
});

test("signedVolumeColor supports side-specific luminance and chroma", () => {
  const scale = {
    luminance: 0.7,
    chroma: 0.15,
    positiveHue: 30,
    negativeHue: 210,
    positiveLuminance: 0.72,
    negativeLuminance: 0.88,
    positiveChroma: 0.18,
    negativeChroma: 0.04,
  };
  expect(signedVolumeColor(1, scale)).toBe("oklch(0.72 0.18 30)");
  expect(signedVolumeColor(-1, scale)).toBe("oklch(0.88 0.04 210)");
});
