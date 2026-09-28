export type AgeRowOrientation = "positive-above" | "negative-above";

export const DEFAULT_AGE_ROW_ORIENTATION: AgeRowOrientation = "negative-above";

export interface AgeRowOrientationHints {
  readonly sortBy?: string | null;
  readonly title?: string | null;
}

export function inferAgeRowOrientation({
  sortBy,
  title,
}: AgeRowOrientationHints): AgeRowOrientation {
  if (sortBy === "price") return "positive-above";

  if (
    sortBy === "ascending" &&
    /\bcontinues?\s+through\b/i.test(title ?? "")
  )
    return "positive-above";

  return DEFAULT_AGE_ROW_ORIENTATION;
}

export function flipAgeRowOrientation(
  orientation: AgeRowOrientation,
): AgeRowOrientation {
  return orientation === "positive-above" ? "negative-above" : "positive-above";
}

/** CSS-space direction away from the row centerline for a semantic side. */
export function ageRowYDirection(
  colorSign: -1 | 1,
  orientation: AgeRowOrientation,
): -1 | 1 {
  const positiveAbove = orientation === "positive-above";
  const above = colorSign > 0 ? positiveAbove : !positiveAbove;
  return above ? -1 : 1;
}
