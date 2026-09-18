import { describe, expect, test } from "bun:test";
import type { Event } from "@polymarket/client";
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

function rawThresholds(
  count: number,
  overrides: Partial<Record<number, unknown>> = {},
): unknown[] {
  return Array.from({ length: count }, (_, index) => ({
    id: String(100 + index),
    groupItemThreshold:
      index in overrides ? overrides[index] : String(index),
  }));
}

describe("nested threshold color geometry", () => {
  test("detects an increasing prefix family", () => {
    const palette = buildThresholdPalette(
      thresholdEvent([0.15, 0.4, 0.82]),
      rawThresholds(3),
    );
    expect(palette?.direction).toBe("prefix");
    expect(palette?.outcomes).toHaveLength(3);

    const [first, middle, last] = palette!.outcomes;
    expect(first.magnitude).toBeCloseTo(1, 12);
    expect(middle.magnitude).toBeCloseTo(Math.SQRT1_2, 12);
    expect(last.magnitude).toBeCloseTo(1 / 3, 12);

    for (const outcome of palette!.outcomes) {
      expect(outcome.scale.negativeChroma).toBe(0);
      expect(outcome.scale.negativeLuminance).toBe(0.88);
    }
  });

  test("detects a decreasing suffix family", () => {
    const palette = buildThresholdPalette(
      thresholdEvent([0.91, 0.7, 0.42]),
      rawThresholds(3),
    );
    expect(palette?.direction).toBe("suffix");

    const [first, middle, last] = palette!.outcomes;
    expect(first.magnitude).toBeCloseTo(1 / 3, 12);
    expect(middle.magnitude).toBeCloseTo(Math.SQRT1_2, 12);
    expect(last.magnitude).toBeCloseTo(1, 12);
  });

  test("maps token identity independently of event row order", () => {
    const event = thresholdEvent([0.1, 0.4, 0.9]);
    const shuffled = {
      ...event,
      markets: [event.markets[2], event.markets[0], event.markets[1]],
    } as Event;

    const a = buildThresholdPalette(event, rawThresholds(3))!;
    const b = buildThresholdPalette(shuffled, rawThresholds(3))!;

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
      buildThresholdPalette(
        thresholdEvent([0.5, 0.5, 0.5]),
        rawThresholds(3),
      ),
    ).toBeNull();

    expect(
      buildThresholdPalette(
        thresholdEvent([0.1, 0.5, 0.9]),
        rawThresholds(3, { 1: undefined }),
      ),
    ).toBeNull();

    expect(
      buildThresholdPalette(
        thresholdEvent([0.1, 0.5, 0.9]),
        rawThresholds(3, { 1: "7" }),
      ),
    ).toBeNull();

    const negRisk = thresholdEvent([0.1, 0.5, 0.9]);
    const marked = {
      ...negRisk,
      trading: { ...negRisk.trading, negRisk: true },
    } as Event;
    expect(buildThresholdPalette(marked, rawThresholds(3))).toBeNull();
  });

  test("semantic YES / neutral NO scale is explicit", () => {
    const scale = semanticYesNeutralNoScale(123, 0.5);
    expect(scale.positiveHue).toBe(123);
    expect(scale.positiveChroma).toBeCloseTo(0.08, 12);
    expect(scale.negativeChroma).toBe(0);
    expect(scale.negativeLuminance).toBe(0.88);
  });
});
