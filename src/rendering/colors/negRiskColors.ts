import type { Event, MarketId, TokenId } from "@polymarket/client";
import {
  DEFAULT_SIGNED_VOLUME_COLOR_SCALE,
  type SignedVolumeColorScale,
} from "./signedVolume";

export interface NegRiskOutcomeColor {
  readonly marketId: MarketId;
  readonly yesTokenId: TokenId;
  readonly noTokenId: TokenId;
  /** Unit-circle phase assigned to this categorical outcome. */
  readonly hue: number;
  /** Pressure colors for this market's YES / complement-NO sides. */
  readonly scale: SignedVolumeColorScale;
}

export interface NegRiskPalette {
  readonly groupId: string;
  readonly outcomes: readonly NegRiskOutcomeColor[];
  readonly byYesTokenId: ReadonlyMap<TokenId, NegRiskOutcomeColor>;
}

/**
 * Construct the static categorical color geometry for an ordinary negative-risk
 * event. Augmented negative-risk is intentionally excluded until placeholder
 * slot semantics are represented explicitly.
 *
 * Invalid/incomplete external event data never leaks into the renderer: callers
 * either receive one coherent NegRiskPalette or null.
 */
export function buildNegRiskPalette(event: Event): NegRiskPalette | null {
  if (event.trading.negRisk !== true) return null;
  if (event.trading.negRiskAugmented === true) return null;

  const candidates = event.markets
    .filter((market) => market.state.negRisk === true)
    .map((market) => {
      const yesTokenId = market.outcomes.yes.tokenId;
      const noTokenId = market.outcomes.no.tokenId;
      if (!yesTokenId || !noTokenId) return null;
      return {
        marketId: market.id,
        yesTokenId,
        noTokenId,
      };
    });

  if (
    candidates.length < 2 ||
    candidates.some((candidate) => candidate === null)
  )
    return null;

  const slots = candidates
    .filter(
      (candidate): candidate is NonNullable<typeof candidate> =>
        candidate !== null,
    )
    .sort((a, b) => compareStableIds(a.marketId, b.marketId));

  if (new Set(slots.map((slot) => slot.marketId)).size !== slots.length)
    return null;
  if (new Set(slots.map((slot) => slot.yesTokenId)).size !== slots.length)
    return null;

  const groupId = event.trading.negRiskMarketId?.trim() || event.id;
  const phase = stableHue(groupId);
  const count = slots.length;
  const complementMagnitude = 1 / (count - 1);

  const outcomes = slots.map((slot, index): NegRiskOutcomeColor => {
    const hue = normalizeHue(phase + (360 * index) / count);
    return {
      ...slot,
      hue,
      scale: {
        ...DEFAULT_SIGNED_VOLUME_COLOR_SCALE,
        positiveLuminance: 0.72,
        negativeLuminance: 0.72,
        positiveHue: hue,
        negativeHue: normalizeHue(hue + 180),
        positiveChroma: DEFAULT_SIGNED_VOLUME_COLOR_SCALE.chroma,
        negativeChroma:
          DEFAULT_SIGNED_VOLUME_COLOR_SCALE.chroma * complementMagnitude,
      },
    };
  });

  return {
    groupId,
    outcomes,
    byYesTokenId: new Map(
      outcomes.map((outcome) => [outcome.yesTokenId, outcome]),
    ),
  };
}

function compareStableIds(a: string, b: string): number {
  if (/^\d+$/.test(a) && /^\d+$/.test(b)) {
    const ai = BigInt(a);
    const bi = BigInt(b);
    return ai < bi ? -1 : ai > bi ? 1 : 0;
  }
  return a.localeCompare(b);
}

/** FNV-1a gives a cheap deterministic pseudo-random phase for arbitrary ids. */
export function stableHue(seed: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < seed.length; i++) {
    hash ^= seed.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0) % 360;
}

function normalizeHue(hue: number): number {
  return ((hue % 360) + 360) % 360;
}
