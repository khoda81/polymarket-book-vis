import { describe, expect, test } from "bun:test";
import type { Event } from "@polymarket/client";
import { buildNegRiskPalette, stableHue } from "./negRiskColors";
import { DEFAULT_SIGNED_VOLUME_COLOR_SCALE } from "./signedVolume";

function negRiskEvent(
  marketIds: readonly string[],
  options: { augmented?: boolean } = {},
): Event {
  return {
    id: "event-42",
    trading: {
      negRisk: true,
      negRiskMarketId: "group-7",
      negRiskAugmented: options.augmented ?? false,
    },
    markets: marketIds.map((id, index) => ({
      id,
      state: { negRisk: true },
      outcomes: {
        yes: { tokenId: `yes-${id}` },
        no: { tokenId: `no-${id}` },
      },
      question: `Outcome ${index}`,
    })),
  } as unknown as Event;
}

function hueDistance(a: number, b: number): number {
  return (((b - a) % 360) + 360) % 360;
}

describe("negative-risk color geometry", () => {
  test("places binary outcomes opposite one another with full-chroma complements", () => {
    const palette = buildNegRiskPalette(negRiskEvent(["10", "20"]));
    expect(palette).not.toBeNull();

    const [a, b] = palette!.outcomes;
    expect(hueDistance(a.hue, b.hue)).toBeCloseTo(180, 12);
    expect(a.scale.negativeHue).toBeCloseTo(b.hue, 12);
    expect(b.scale.negativeHue).toBeCloseTo(a.hue, 12);

    expect(a.scale.positiveChroma).toBe(
      DEFAULT_SIGNED_VOLUME_COLOR_SCALE.chroma,
    );
    expect(a.scale.negativeChroma).toBe(
      DEFAULT_SIGNED_VOLUME_COLOR_SCALE.chroma,
    );
    expect(a.scale.negativeLuminance).toBe(0.72);
  });

  test("uses the equal-complement barycenter magnitude 1/(N-1)", () => {
    const palette = buildNegRiskPalette(negRiskEvent(["1", "2", "3", "4"]));
    expect(palette).not.toBeNull();

    const expectedNoChroma = DEFAULT_SIGNED_VOLUME_COLOR_SCALE.chroma / 3;
    for (const outcome of palette!.outcomes) {
      expect(outcome.scale.positiveChroma).toBe(
        DEFAULT_SIGNED_VOLUME_COLOR_SCALE.chroma,
      );
      expect(outcome.scale.negativeChroma).toBeCloseTo(expectedNoChroma, 12);
      expect(hueDistance(outcome.hue, outcome.scale.negativeHue)).toBeCloseTo(
        180,
        12,
      );
    }

    const hues = palette!.outcomes.map((outcome) => outcome.hue);
    for (let i = 1; i < hues.length; i++)
      expect(hueDistance(hues[i - 1], hues[i])).toBeCloseTo(90, 12);
  });

  test("slot colors are stable under event market reordering", () => {
    const forward = buildNegRiskPalette(negRiskEvent(["100", "2", "30"]))!;
    const shuffled = buildNegRiskPalette(negRiskEvent(["30", "100", "2"]))!;

    for (const tokenId of forward.outcomes.map(
      (outcome) => outcome.yesTokenId,
    )) {
      expect(forward.byYesTokenId.get(tokenId)?.hue).toBe(
        shuffled.byYesTokenId.get(tokenId)?.hue,
      );
    }
  });

  test("does not invent a palette for non-neg-risk or augmented events", () => {
    const ordinary = negRiskEvent(["1", "2"]);
    const nonNegRisk = {
      ...ordinary,
      trading: { ...ordinary.trading, negRisk: false },
    } as Event;

    expect(buildNegRiskPalette(nonNegRisk)).toBeNull();
    expect(
      buildNegRiskPalette(negRiskEvent(["1", "2"], { augmented: true })),
    ).toBeNull();
  });

  test("phase hashing is deterministic and bounded", () => {
    expect(stableHue("group-7")).toBe(stableHue("group-7"));
    expect(stableHue("group-7")).toBeGreaterThanOrEqual(0);
    expect(stableHue("group-7")).toBeLessThan(360);
  });
});
