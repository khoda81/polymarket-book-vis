import type { Market, TokenId } from "@polymarket/client";

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
  readonly conditionId: string;
  readonly assetIds: readonly string[];
  readonly winningTokenId: string | null;
  readonly winningOutcome: string | null;
}

export function initialMarketLifecycle(
  market: Market,
): MarketLifecycle {
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
  const winningTokenId = update.winningTokenId;
  if (!winningTokenId) return current;

  if (
    winningTokenId !== String(primaryTokenId) &&
    winningTokenId !== String(oppositeTokenId)
  )
    return current;

  const winningOutcome =
    update.winningOutcome ??
    (winningTokenId === String(primaryTokenId)
      ? primaryOutcome
      : oppositeOutcome);

  return {
    kind: "resolved",
    winningTokenId: winningTokenId as TokenId,
    winningOutcome,
  };
}

export function summarizeEventMarketStatus(
  lifecycles: Iterable<MarketLifecycle>,
): EventMarketStatus {
  const values = [...lifecycles];
  if (
    values.length > 0 &&
    values.every((state) => state.kind === "resolved")
  )
    return { kind: "resolved" };

  if (
    values.length > 0 &&
    values.every((state) => state.kind !== "live")
  )
    return { kind: "awaiting-resolution" };

  return { kind: "trading" };
}

function resolvedWinnerFromPrices(
  market: Market,
): MarketLifecycle | null {
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
