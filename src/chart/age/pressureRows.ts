import { clamp01 } from "@/shared/math";
import { PRICE_SCALE, priceFromTicks, type Price } from "@/domain/books/price";

/**
 * How a bar lays its track's price axis across the row: `ascending` draws
 * track price p at x = p, `descending` at x = 1 - p.
 */
export type PriceAxis = "ascending" | "descending";

/** The half of a row a bar grows into, away from the centerline. */
export type BarSide = "above" | "below";

/**
 * One drawing of a half-book pressure track.
 *
 * The renderer knows nothing about where a track's book comes from. Callers
 * decide which track each bar draws, where, in which color, and how hovering
 * it is described.
 */
export interface PressureBar {
  /** Key of the pressure history this bar draws. */
  readonly track: string;
  /** Name of the track's book, e.g. in recorder-age titles. */
  readonly trackLabel: string;
  readonly color: string;
  readonly side: BarSide;
  readonly priceAxis: PriceAxis;
  /** What hovering this bar quotes: a name and a price for a track price. */
  readonly quote: {
    readonly label: string;
    readonly price: (trackPrice: number) => number;
  };
}

export interface PressureRow {
  readonly key: string;
  readonly label: string;
  /** Bars in drawing order; later bars draw over earlier ones. */
  readonly bars: readonly PressureBar[];
}

/** CSS-space direction from the row centerline into the bar's half. */
export function barYDirection(bar: Pick<PressureBar, "side">): -1 | 1 {
  return bar.side === "above" ? -1 : 1;
}

/** The half of a row a screen y falls into; the centerline belongs below. */
export function sideAtY(yCss: number, centerCss: number): BarSide {
  return yCss >= centerCss ? "below" : "above";
}

/** Track price under normalized screen x. */
export function trackPriceAtDisplayX(
  displayX: number,
  priceAxis: PriceAxis,
): number {
  const x = clamp01(displayX);
  return priceAxis === "descending" ? 1 - x : x;
}

/** Exact field lookup coordinate for a continuous track price. */
export function trackPriceTicks(trackPrice: number): Price {
  return priceFromTicks(
    Math.max(0, Math.min(PRICE_SCALE, Math.floor(trackPrice * PRICE_SCALE))),
  );
}

/** Normalized x of the edge where a bar's track price reaches 1. */
export function barFarEdgeX(bar: Pick<PressureBar, "priceAxis">): 0 | 1 {
  return bar.priceAxis === "descending" ? 0 : 1;
}
