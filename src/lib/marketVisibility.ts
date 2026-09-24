import type { Market, MarketId } from "@polymarket/client";
import type { MarketLifecycle } from "./marketLifecycle";
export type HiddenMarketReason = "user" | "empty-book" | "resolved-default";

export type AutoHiddenReason = Extract<HiddenMarketReason, "empty-book">;

export type MarketVisibility =
  | { readonly kind: "visible" }
  | {
      readonly kind: "hidden";
      readonly reason: HiddenMarketReason;
    };

const STORAGE_KEY = "polymarket-book-vis.age-strip-hidden-markets.v1";

export function initialMarketVisibility(
  userHidden: boolean,
  lifecycle: MarketLifecycle,
): MarketVisibility {
  if (userHidden) return { kind: "hidden", reason: "user" };
  if (lifecycle.kind === "resolved")
    return { kind: "hidden", reason: "resolved-default" };
  return { kind: "visible" };
}

export function isMarketVisible(visibility: MarketVisibility): boolean {
  return visibility.kind === "visible";
}

export function loadUserHiddenMarketIds(): Set<string> {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return new Set();
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed)
      ? new Set(
          parsed.filter((value): value is string => typeof value === "string"),
        )
      : new Set();
  } catch (error) {
    console.warn("Could not restore hidden market preferences:", error);
    return new Set();
  }
}

export function persistUserHiddenMarketIds(
  marketIds: ReadonlySet<string>,
): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify([...marketIds]));
  } catch (error) {
    console.warn("Could not persist hidden market preferences:", error);
  }
}

export interface MarketIdentified {
  readonly market: Pick<Market, "id">;
}

export interface MarketVisibilityPartition<T extends MarketIdentified> {
  readonly visible: readonly T[];
  readonly hidden: readonly T[];
}

export function partitionMarketVisibility<T extends MarketIdentified>(
  markets: readonly T[],
  visibilityByMarketId: ReadonlyMap<MarketId, MarketVisibility>,
): MarketVisibilityPartition<T> {
  const visible: T[] = [];
  const hidden: T[] = [];

  for (const market of markets) {
    const visibility = visibilityByMarketId.get(market.market.id) ?? {
      kind: "visible" as const,
    };
    (isMarketVisible(visibility) ? visible : hidden).push(market);
  }

  return { visible, hidden };
}

export interface VisibilityInitializableMarket extends MarketIdentified {
  readonly lifecycle: MarketLifecycle;
}

export function loadMarketVisibility(
  markets: readonly VisibilityInitializableMarket[],
): Map<MarketId, MarketVisibility> {
  const userHidden = loadUserHiddenMarketIds();
  return new Map(
    markets.map((market) => [
      market.market.id,
      initialMarketVisibility(
        userHidden.has(market.market.id),
        market.lifecycle,
      ),
    ]),
  );
}

export function setMarketVisibility(
  current: ReadonlyMap<MarketId, MarketVisibility>,
  marketId: MarketId,
  next: MarketVisibility,
): Map<MarketId, MarketVisibility> {
  const updated = new Map(current);
  updated.set(marketId, next);
  return updated;
}

export function setUserMarketVisible(
  current: ReadonlyMap<MarketId, MarketVisibility>,
  marketId: MarketId,
  visible: boolean,
): Map<MarketId, MarketVisibility> {
  return setMarketVisibility(
    current,
    marketId,
    visible ? { kind: "visible" } : { kind: "hidden", reason: "user" },
  );
}

export function mergeUserHiddenMarketIds(
  persisted: ReadonlySet<string>,
  visibilityByMarketId: ReadonlyMap<MarketId, MarketVisibility>,
): Set<string> {
  const userHidden = new Set(persisted);

  // Each ChartHost only owns the markets in one event. Update those entries
  // without discarding user preferences belonging to every other chart.
  for (const [marketId, visibility] of visibilityByMarketId) {
    if (visibility.kind === "hidden" && visibility.reason === "user")
      userHidden.add(marketId);
    else userHidden.delete(marketId);
  }

  return userHidden;
}

export function persistUserVisibility(
  visibilityByMarketId: ReadonlyMap<MarketId, MarketVisibility>,
): void {
  persistUserHiddenMarketIds(
    mergeUserHiddenMarketIds(loadUserHiddenMarketIds(), visibilityByMarketId),
  );
}
