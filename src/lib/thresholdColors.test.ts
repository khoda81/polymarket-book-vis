import { describe, expect, test } from "bun:test";
import type { Event, MarketId } from "@polymarket/client";
import {
  buildThresholdPalette,
  semanticYesNeutralNoScale,
} from "./thresholdColors";

function thresholdEvent(prices: readonly number[]): Event {
  return {
    id: "event-threshold-42",
    trading: { negRisk: false },
    markets: prices.map((price, index) => ({
      id: String(100 + index),
      state: { negRisk: false },
      outcomes: {
        yes: {
          tokenId: `yes-${index}`,
          price: String(price),
        },
        no: {
          tokenId: `no-${index}`,
          price: String(1 - price),
        },
      },
      question: `Threshold ${index}`,
    })),
  } as unknown as Event;
}

function thresholdMap(
  event: Event,
  count: number,
  overrides: Partial<Record<number, number | undefined>> = {},
): ReadonlyMap<MarketId, number> {
  const result = new Map<MarketId, number>();
  for (let index = 0; index < count; index++) {
    const market = event.markets.find(
      (candidate) => candidate.id === String(100 + index),
    );
    if (!market) continue;

    const value = index in overrides ? overrides[index] : index;
    if (typeof value === "number") result.set(market.id, value);
  }
  return result;
}

describe("nested threshold color geometry", () => {
  test("detects an increasing prefix family", () => {
    const event = thresholdEvent([0.15, 0.4, 0.82]);
    const palette = buildThresholdPalette(event, thresholdMap(event, 3));
    expect(palette?.direction).toBe("prefix");
    expect(palette?.outcomes).toHaveLength(3);

    const [first, middle, last] = palette!.outcomes;
    expect(first.magnitude).toBeCloseTo(1, 12);
    expect(middle.magnitude).toBeCloseTo(Math.SQRT1_2, 12);
    expect(last.magnitude).toBeCloseTo(1 / 3, 12);

    expect(first.noMagnitude).toBeCloseTo(1 / 3, 12);
    expect(middle.noMagnitude).toBeCloseTo(Math.SQRT1_2, 12);
    expect(last.noMagnitude).toBeCloseTo(1, 12);

    for (const outcome of palette!.outcomes) {
      expect(outcome.scale.negativeChroma).toBeCloseTo(
        0.16 * outcome.noMagnitude,
        12,
      );
      expect(outcome.scale.negativeLuminance).toBe(0.72);
    }
  });

  test("detects a decreasing suffix family", () => {
    const event = thresholdEvent([0.91, 0.7, 0.42]);
    const palette = buildThresholdPalette(event, thresholdMap(event, 3));
    expect(palette?.direction).toBe("suffix");

    const [first, middle, last] = palette!.outcomes;
    expect(first.magnitude).toBeCloseTo(1 / 3, 12);
    expect(middle.magnitude).toBeCloseTo(Math.SQRT1_2, 12);
    expect(last.magnitude).toBeCloseTo(1, 12);
    expect(first.noMagnitude).toBeCloseTo(1, 12);
    expect(middle.noMagnitude).toBeCloseTo(Math.SQRT1_2, 12);
    expect(last.noMagnitude).toBeCloseTo(1 / 3, 12);
  });

  test("uses the requested shrinking partition geometry for four thresholds", () => {
    const event = thresholdEvent([0.94, 0.83, 0.75, 0.56]);
    const palette = buildThresholdPalette(event, thresholdMap(event, 4))!;
    expect(palette.direction).toBe("suffix");

    const expectedYes = [[0, 1, 2, 3], [0, 1, 2], [0, 1], [0]];
    const expectedNo = [[4], [3, 4], [2, 3, 4], [1, 2, 3, 4]];

    for (const [index, outcome] of palette.outcomes.entries()) {
      expect(outcome.yesAtomIndices).toEqual(expectedYes[index]);
      expect(outcome.noAtomIndices).toEqual(expectedNo[index]);
      expect(outcome.scale.negativeChroma).toBeGreaterThan(0);
      expect((((outcome.noHue - outcome.hue) % 360) + 360) % 360).toBeCloseTo(
        180,
        10,
      );
    }
  });

  test("maps token identity independently of event row order", () => {
    const event = thresholdEvent([0.1, 0.4, 0.9]);
    const shuffled = {
      ...event,
      markets: [event.markets[2], event.markets[0], event.markets[1]],
    } as Event;

    const thresholds = thresholdMap(event, 3);
    const a = buildThresholdPalette(event, thresholds)!;
    const b = buildThresholdPalette(shuffled, thresholds)!;

    for (const tokenId of ["yes-0", "yes-1", "yes-2"]) {
      expect(a.byYesTokenId.get(tokenId)?.hue).toBe(
        b.byYesTokenId.get(tokenId)?.hue,
      );
      expect(a.byYesTokenId.get(tokenId)?.magnitude).toBe(
        b.byYesTokenId.get(tokenId)?.magnitude,
      );
    }
  });

  test("refuses ambiguous or incomplete threshold families", () => {
    expect(
      (() => {
        const event = thresholdEvent([0.5, 0.5, 0.5]);
        return buildThresholdPalette(event, thresholdMap(event, 3));
      })(),
    ).toBeNull();

    expect(
      (() => {
        const event = thresholdEvent([0.1, 0.5, 0.9]);
        return buildThresholdPalette(
          event,
          thresholdMap(event, 3, { 1: undefined }),
        );
      })(),
    ).toBeNull();

    expect(
      (() => {
        const event = thresholdEvent([0.1, 0.5, 0.9]);
        return buildThresholdPalette(event, thresholdMap(event, 3, { 1: 7 }));
      })(),
    ).toBeNull();

    const augmented = thresholdEvent([0.1, 0.5, 0.9]);
    const marked = {
      ...augmented,
      trading: {
        ...augmented.trading,
        negRisk: true,
        negRiskAugmented: true,
      },
    } as Event;
    expect(buildThresholdPalette(marked, thresholdMap(marked, 3))).toBeNull();
  });

  test("accepts threshold metadata inside ordinary negative-risk events", () => {
    const event = thresholdEvent([0.91, 0.7, 0.42]);
    const marked = {
      ...event,
      trading: { ...event.trading, negRisk: true },
      markets: event.markets.map((market) => ({
        ...market,
        state: { ...market.state, negRisk: true },
      })),
    } as Event;

    const palette = buildThresholdPalette(marked, thresholdMap(marked, 3));
    expect(palette?.direction).toBe("suffix");
    expect(palette?.outcomes.map((outcome) => outcome.yesAtomIndices)).toEqual([
      [0, 1, 2],
      [0, 1],
      [0],
    ]);
  });

  test("generic binary scale keeps YES semantic and NO neutral", () => {
    const scale = semanticYesNeutralNoScale(123);
    expect(scale.positiveHue).toBe(123);
    expect(scale.positiveChroma).toBe(0.16);
    expect(scale.negativeChroma).toBe(0);
    expect(scale.negativeLuminance).toBe(0.72);
  });
});
