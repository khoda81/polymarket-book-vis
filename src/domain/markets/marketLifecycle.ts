import type {
  ClobAssetId,
  ConditionId,
  Market,
  TokenId,
} from "@polymarket/client";

export type MarketLifecycle =
  | { readonly kind: "live" }
  | { readonly kind: "awaiting-resolution" }
  | {
      readonly kind: "resolved";
      readonly winningTokenId: TokenId;
      readonly winningOutcome: string;
    };

export type EventMarketStatus =
  | { readonly kind: "trading" }
  | { readonly kind: "awaiting-resolution" }
  | { readonly kind: "resolved" };

export interface MarketResolutionUpdate {
  readonly conditionId: ConditionId;
  readonly assetIds: readonly ClobAssetId[];
  readonly winningAssetId: ClobAssetId | null;
  readonly winningOutcome: string | null;
  /** Latest market time justified by the resolution stream, if known. */
  readonly resolvedAtMs: number | null;
}

export function initialMarketLifecycle(market: Market): MarketLifecycle {
  const winner = resolvedWinnerFromPrices(market);
  if (winner) return winner;

  if (
    market.state.closed === true ||
    market.resolution.umaResolutionStatus === "resolved" ||
    market.resolution.umaResolutionStatus === "settled"
  )
    return { kind: "awaiting-resolution" };

  return { kind: "live" };
}

interface BinaryTokens {
  readonly yes: { readonly label: string; readonly tokenId: TokenId };
  readonly no: { readonly label: string; readonly tokenId: TokenId };
}

export function resolveMarketLifecycle(
  current: MarketLifecycle,
  update: MarketResolutionUpdate,
  market: BinaryTokens,
): MarketLifecycle {
  const side =
    update.winningAssetId === market.yes.tokenId
      ? "yes"
      : update.winningAssetId === market.no.tokenId
        ? "no"
        : null;
  if (!side) return current;

  return {
    kind: "resolved",
    winningTokenId: market[side].tokenId,
    winningOutcome: update.winningOutcome ?? market[side].label,
  };
}

/** The winning side of a resolved binary market and the label to show. */
export function resolvedOutcome(
  market: BinaryTokens,
  lifecycle: Extract<MarketLifecycle, { kind: "resolved" }>,
): { readonly side: "yes" | "no" | null; readonly label: string } {
  const side =
    lifecycle.winningTokenId === market.yes.tokenId
      ? "yes"
      : lifecycle.winningTokenId === market.no.tokenId
        ? "no"
        : null;
  return {
    side,
    label: (side && market[side].label) || lifecycle.winningOutcome,
  };
}

export function summarizeEventMarketStatus(
  lifecycles: Iterable<MarketLifecycle>,
): EventMarketStatus {
  const values = [...lifecycles];
  if (values.length > 0 && values.every((state) => state.kind === "resolved"))
    return { kind: "resolved" };

  if (values.length > 0 && values.every((state) => state.kind !== "live"))
    return { kind: "awaiting-resolution" };

  return { kind: "trading" };
}

function resolvedWinnerFromPrices(market: Market): MarketLifecycle | null {
  const yes = exactResolutionPrice(market.outcomes.yes.price);
  const no = exactResolutionPrice(market.outcomes.no.price);
  if (yes === null || no === null || yes === no) return null;

  if (yes === 1 && market.outcomes.yes.tokenId)
    return {
      kind: "resolved",
      winningTokenId: market.outcomes.yes.tokenId,
      winningOutcome: market.outcomes.yes.label,
    };

  if (no === 1 && market.outcomes.no.tokenId)
    return {
      kind: "resolved",
      winningTokenId: market.outcomes.no.tokenId,
      winningOutcome: market.outcomes.no.label,
    };

  return null;
}

function exactResolutionPrice(value: string | null): 0 | 1 | null {
  if (value === null) return null;
  const parsed = Number(value);
  if (parsed === 0) return 0;
  if (parsed === 1) return 1;
  return null;
}
