export interface SignedVolumeColorScale {
  readonly luminance: number;
  /** Default chroma used when a side-specific chroma is not provided. */
  readonly chroma: number;
  readonly positiveHue: number;
  readonly negativeHue: number;
  readonly positiveLuminance?: number;
  readonly negativeLuminance?: number;
  readonly positiveChroma?: number;
  readonly negativeChroma?: number;
}

/**
 * Shared sign palette. Magnitude is deliberately absent from this scale:
 * signed pressure magnitude is represented by vertical ink area, while hue
 * communicates only direction.
 */
export const DEFAULT_SIGNED_VOLUME_COLOR_SCALE: SignedVolumeColorScale = {
  luminance: 0.7,
  chroma: 0.15,
  positiveHue: 190,
  negativeHue: 305,
};

/** Full-strength CSS color for the sign of a pressure value. */
export function signedVolumeColor(
  volume: number,
  scale: SignedVolumeColorScale = DEFAULT_SIGNED_VOLUME_COLOR_SCALE,
): string {
  if (volume === 0 || Number.isNaN(volume)) return "transparent";
  const negative = volume < 0;
  const hue = negative ? scale.negativeHue : scale.positiveHue;
  const luminance = negative
    ? (scale.negativeLuminance ?? scale.luminance)
    : (scale.positiveLuminance ?? scale.luminance);
  const chroma = negative
    ? (scale.negativeChroma ?? scale.chroma)
    : (scale.positiveChroma ?? scale.chroma);
  return `oklch(${luminance} ${chroma} ${hue})`;
}
