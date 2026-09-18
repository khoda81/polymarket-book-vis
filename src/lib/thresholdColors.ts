import type { Event } from "@polymarket/client";
import { stableHue } from "./negRiskColors";
import type { SignedVolumeColorScale } from "./signedVolume";

export type ThresholdFamilyDirection = "prefix" | "suffix";

export interface ThresholdOutcomeColor {
  readonly marketId: string;
  readonly yesTokenId: string;
  readonly noTokenId: string;
  readonly thresholdIndex: number;
  readonly hue: number;
  readonly magnitude: number;
  readonly noHue: number;
  readonly noMagnitude: number;
  readonly yesAtomIndices: readonly number[];
  readonly noAtomIndices: readonly number[];
  readonly scale: SignedVolumeColorScale;
}

export interface ThresholdPalette {
  readonly direction: ThresholdFamilyDirection;
  readonly outcomes: readonly ThresholdOutcomeColor[];
  readonly byYesTokenId: ReadonlyMap<string, ThresholdOutcomeColor>;
  readonly byNoTokenId: ReadonlyMap<string, ThresholdOutcomeColor>;
}

interface RawThresholdMarket {
  readonly id?: unknown;
  readonly groupItemThreshold?: unknown;
}

const SEMANTIC_LUMINANCE = 0.72;
const SEMANTIC_CHROMA = 0.16;
const PRICE_MONOTONIC_EPSILON = 0.015;
const MIN_TOTAL_PRICE_TREND = 0.03;

/**
 * Detect an ordinary nested threshold family and construct its static interval
 * geometry. The raw Gamma threshold index is the structural signal; current YES
 * prices are used only to determine whether YES means a growing prefix or a
 * shrinking suffix of the ordered latent intervals.
 *
 * Returns null rather than guessing when the external data is incomplete or
 * ambiguous.
 */
export function buildThresholdPalette(
  event: Event,
  rawMarkets: readonly unknown[],
): ThresholdPalette | null {
  if (event.trading.negRiskAugmented === true || event.markets.length < 2)
    return null;

  const rawById = new Map<string, RawThresholdMarket>();
  for (const raw of rawMarkets) {
    if (!raw || typeof raw !== "object") continue;
    const market = raw as RawThresholdMarket;
    if (market.id === undefined) continue;
    rawById.set(String(market.id), market);
  }

  const rows = event.markets.map((market) => {
    const raw = rawById.get(String(market.id));
    const thresholdIndex = parseThresholdIndex(raw?.groupItemThreshold);
    const yesTokenId = market.outcomes.yes.tokenId;
    const noTokenId = market.outcomes.no.tokenId;
    const yesPrice = parseProbability(market.outcomes.yes.price);
    if (
      thresholdIndex === null ||
      !yesTokenId ||
      !noTokenId ||
      yesPrice === null
    )
      return null;
    return {
      marketId: String(market.id),
      yesTokenId: String(yesTokenId),
      noTokenId: String(noTokenId),
      thresholdIndex,
      yesPrice,
    };
  });

  if (rows.some((row) => row === null)) return null;
  const ordered = rows
    .filter((row): row is NonNullable<typeof row> => row !== null)
    .sort((a, b) => a.thresholdIndex - b.thresholdIndex);

  if (
    new Set(ordered.map((row) => row.thresholdIndex)).size !== ordered.length ||
    ordered.some((row, index) => row.thresholdIndex !== index)
  )
    return null;

  const direction = monotoneDirection(ordered.map((row) => row.yesPrice));
  if (!direction) return null;

  // N threshold markets partition one latent ordered variable into N+1 atoms:
  // A0 <= t0, A1 in (t0,t1], ..., AN > t_(N-1).
  const atomCount = ordered.length + 1;
  const phase = stableHue(`threshold:${event.id}`);
  const atoms = Array.from({ length: atomCount }, (_, index) => {
    const angle = degreesToRadians(phase + (360 * index) / atomCount);
    return { x: Math.cos(angle), y: Math.sin(angle) };
  });

  const allAtomIndices = rangeInclusive(0, atomCount - 1);
  const outcomes = ordered.map((row): ThresholdOutcomeColor => {
    // Keep latent atom numbering aligned with threshold row order. A growing
    // family is A0 vs rest, then A0+A1 vs rest. A shrinking family is the
    // reverse nesting: all-but-last vs last, then all-but-last-two vs those two.
    const yesAtomIndices =
      direction === "prefix"
        ? rangeInclusive(0, row.thresholdIndex)
        : rangeInclusive(0, atomCount - row.thresholdIndex - 2);
    const yesAtoms = new Set(yesAtomIndices);
    const noAtomIndices = allAtomIndices.filter((index) => !yesAtoms.has(index));

    const yesVector = meanVector(yesAtomIndices.map((index) => atoms[index]!));
    const noVector = meanVector(noAtomIndices.map((index) => atoms[index]!));
    const hue = vectorHue(yesVector);
    const magnitude = vectorMagnitude(yesVector);
    const noHue = vectorHue(noVector);
    const noMagnitude = vectorMagnitude(noVector);

    return {
      marketId: row.marketId,
      yesTokenId: row.yesTokenId,
      noTokenId: row.noTokenId,
      thresholdIndex: row.thresholdIndex,
      hue,
      magnitude,
      noHue,
      noMagnitude,
      yesAtomIndices,
      noAtomIndices,
      scale: semanticPairScale(hue, magnitude, noHue, noMagnitude),
    };
  });

  return {
    direction,
    outcomes,
    byYesTokenId: new Map(outcomes.map((outcome) => [outcome.yesTokenId, outcome])),
    byNoTokenId: new Map(outcomes.map((outcome) => [outcome.noTokenId, outcome])),
  };
}

export function semanticYesNeutralNoScale(
  hue: number,
): SignedVolumeColorScale {
  return {
    luminance: SEMANTIC_LUMINANCE,
    chroma: SEMANTIC_CHROMA,
    positiveLuminance: SEMANTIC_LUMINANCE,
    negativeLuminance: SEMANTIC_LUMINANCE,
    positiveHue: normalizeHue(hue),
    negativeHue: 0,
    positiveChroma: SEMANTIC_CHROMA,
    negativeChroma: 0,
  };
}

function semanticPairScale(
  yesHue: number,
  yesMagnitude: number,
  noHue: number,
  noMagnitude: number,
): SignedVolumeColorScale {
  return {
    luminance: SEMANTIC_LUMINANCE,
    chroma: SEMANTIC_CHROMA,
    positiveLuminance: SEMANTIC_LUMINANCE,
    negativeLuminance: SEMANTIC_LUMINANCE,
    positiveHue: normalizeHue(yesHue),
    negativeHue: normalizeHue(noHue),
    positiveChroma: SEMANTIC_CHROMA * clamp01(yesMagnitude),
    negativeChroma: SEMANTIC_CHROMA * clamp01(noMagnitude),
  };
}

function vectorHue(vector: { readonly x: number; readonly y: number }): number {
  return normalizeHue(radiansToDegrees(Math.atan2(vector.y, vector.x)));
}

function vectorMagnitude(vector: { readonly x: number; readonly y: number }): number {
  return clamp01(Math.hypot(vector.x, vector.y));
}

function monotoneDirection(
  prices: readonly number[],
): ThresholdFamilyDirection | null {
  if (prices.length < 2) return null;

  let nonDecreasing = true;
  let nonIncreasing = true;
  for (let i = 1; i < prices.length; i++) {
    if (prices[i]! + PRICE_MONOTONIC_EPSILON < prices[i - 1]!)
      nonDecreasing = false;
    if (prices[i]! - PRICE_MONOTONIC_EPSILON > prices[i - 1]!)
      nonIncreasing = false;
  }

  const totalChange = prices.at(-1)! - prices[0]!;
  if (
    nonDecreasing &&
    !nonIncreasing &&
    totalChange >= MIN_TOTAL_PRICE_TREND
  )
    return "prefix";
  if (
    nonIncreasing &&
    !nonDecreasing &&
    totalChange <= -MIN_TOTAL_PRICE_TREND
  )
    return "suffix";
  return null;
}

function parseThresholdIndex(value: unknown): number | null {
  const parsed =
    typeof value === "number"
      ? value
      : typeof value === "string" && value.trim() !== ""
        ? Number(value)
        : NaN;
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : null;
}

function parseProbability(value: unknown): number | null {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) && parsed >= 0 && parsed <= 1 ? parsed : null;
}

function meanVector(
  vectors: readonly { readonly x: number; readonly y: number }[],
): { x: number; y: number } {
  if (vectors.length === 0) return { x: 0, y: 0 };
  let x = 0;
  let y = 0;
  for (const vector of vectors) {
    x += vector.x;
    y += vector.y;
  }
  return { x: x / vectors.length, y: y / vectors.length };
}

function rangeInclusive(start: number, end: number): number[] {
  return Array.from({ length: end - start + 1 }, (_, index) => start + index);
}

function degreesToRadians(degrees: number): number {
  return (degrees * Math.PI) / 180;
}

function radiansToDegrees(radians: number): number {
  return (radians * 180) / Math.PI;
}

function normalizeHue(hue: number): number {
  return ((hue % 360) + 360) % 360;
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}
