import type { AgeRowOrientation } from "../../chart/age/ageStripOrientation";

/**
 * Put the card-order edge selected by the row orientation first in the
 * horizontally scrolling hidden-market strip.
 */
export function hiddenMarketDisplayOrder<T>(
  markets: readonly T[],
  orientation: AgeRowOrientation,
): T[] {
  const ordered = [...markets];
  return orientation === "negative-above" ? ordered.reverse() : ordered;
}
