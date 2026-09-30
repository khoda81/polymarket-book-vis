import type { ObservedToken, ObservationFrame } from "./observationClock";
import { ghostPositionForAge } from "./ghostLegendTicks";

export interface GhostObservationColumn {
  /** Center of the physical display pixel represented by this marker. */
  readonly xCss: number;
  readonly tokens: readonly ObservedToken[];
}

/**
 * Project token observation times onto the ghost-age scale without arbitrary
 * spatial quantization. Tokens are grouped only when they genuinely land on
 * the same physical display pixel.
 */
export function ghostObservationColumns(
  frame: Extract<ObservationFrame, { kind: "observed" }>,
  halfLifeMs: number,
  widthCss: number,
  dpr: number,
  insetCss: number,
): readonly GhostObservationColumn[] {
  if (
    !(halfLifeMs > 0) ||
    !(widthCss > insetCss * 2) ||
    !(dpr > 0) ||
    !Number.isFinite(halfLifeMs) ||
    !Number.isFinite(widthCss) ||
    !Number.isFinite(dpr)
  )
    return [];

  const spanCss = widthCss - insetCss * 2;
  const minPixel = Math.floor(insetCss * dpr);
  const maxPixel = Math.max(
    minPixel,
    Math.ceil((widthCss - insetCss) * dpr) - 1,
  );
  const byPixel = new Map<number, ObservedToken[]>();

  for (const token of frame.tokens) {
    const xCss =
      insetCss +
      ghostPositionForAge(frame.newestMs - token.observedAtMs, halfLifeMs) *
        spanCss;

    // Pick the physical pixel whose center is nearest to the projected point.
    const pixel = Math.max(
      minPixel,
      Math.min(maxPixel, Math.round(xCss * dpr - 0.5)),
    );
    const tokens = byPixel.get(pixel) ?? [];
    tokens.push(token);
    byPixel.set(pixel, tokens);
  }

  return [...byPixel.entries()]
    .sort(([left], [right]) => left - right)
    .map(([pixel, tokens]) => ({
      xCss: (pixel + 0.5) / dpr,
      tokens,
    }));
}
