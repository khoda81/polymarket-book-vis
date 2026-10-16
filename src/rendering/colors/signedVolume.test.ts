import { describe, expect, test } from "bun:test";
import {
  DEFAULT_SIGNED_VOLUME_COLOR_SCALE,
  signedVolumeColor,
} from "./signedVolume";

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
