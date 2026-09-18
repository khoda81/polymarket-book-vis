import { describe, expect, test } from "bun:test";
import { emptyTokenBook } from "./orderBook";
import {
  DEFAULT_SIGNED_VOLUME_COLOR_SCALE,
  signedVolumeColor,
  signedVolumeSegments,
} from "./signedVolume";

describe("signedVolumeSegments", () => {
  test("tracks signed shares and the capital needed to sweep each side", () => {
    const book = emptyTokenBook();
    book.usdToYes.setLevel("bid-1", { price: 0.4, take: 10 });
    book.usdToYes.setLevel("bid-2", { price: 0.3, take: 5 });
    book.yesToUsd.setLevel("ask", { price: 1 / 0.6, take: 6 });

    expect(signedVolumeSegments(book)).toEqual([
      // Wiping bids is equivalent to buying NO: 10×0.6 + 5×0.7 = 9.5.
      { lo: 0, hi: 0.3, volume: 15, sweepCost: 9.5 },
      { lo: 0.3, hi: 0.4, volume: 10, sweepCost: 6 },
      { lo: 0.4, hi: 0.6, volume: 0, sweepCost: 0 },
      // The inverse book level represents 10 YES at a 0.6 ask.
      { lo: 0.6, hi: 1, volume: -10, sweepCost: 6 },
    ]);
  });
})  test("keeps a many-level empty spread exactly zero", () => {
    const book = emptyTokenBook();
    for (let i = 0; i < 40; i++) {
      const price = 0.4 - i * 0.001;
      const take = 0.1 + i * 0.037;
      book.usdToYes.setLevel(`bid-${i}`, { price, take });
    }
    book.yesToUsd.setLevel("ask", { price: 1 / 0.6, take: 6 });

    const spread = signedVolumeSegments(book).find(
      (segment) => segment.lo === 0.4 && segment.hi === 0.6,
    );
    expect(spread).toEqual({
      lo: 0.4,
      hi: 0.6,
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
