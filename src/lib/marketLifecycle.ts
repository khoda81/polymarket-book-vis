import type { ClobAssetId, ConditionId, Market, TokenId } from "@polymarket/client";

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

export function resolveMarketLifecycle(
  current: MarketLifecycle,
  update: MarketResolutionUpdate,
  primaryTokenId: TokenId,
  oppositeTokenId: TokenId | null,
  primaryOutcome: string,
  oppositeOutcome: string,
): MarketLifecycle {
  const winningAssetId = update.winningAssetId;
  if (!winningAssetId) return current;

  const winningTokenId =
    winningAssetId === primaryTokenId
      ? primaryTokenId
      : oppositeTokenId !== null && winningAssetId === oppositeTokenId
        ? oppositeTokenId
        : null;
  if (!winningTokenId) return current;

  const winningOutcome =
    update.winningOutcome ??
    (winningTokenId === primaryTokenId ? primaryOutcome : oppositeOutcome);

  return {
    kind: "resolved",
    winningTokenId,
    winningOutcome,
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
