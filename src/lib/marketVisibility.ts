export type HiddenMarketReason =
  | "user"
  | "not-accepting-orders"
  | "empty-book"
  | "resolved";

export type MarketVisibility =
  | { readonly kind: "visible" }
  | {
      readonly kind: "hidden";
      readonly reason: HiddenMarketReason;
    };

const STORAGE_KEY =
  "polymarket-book-vis.age-strip-hidden-markets.v1";

export function initialMarketVisibility(
  acceptingOrders: boolean,
  userHidden: boolean,
): MarketVisibility {
  if (userHidden) return { kind: "hidden", reason: "user" };
  if (!acceptingOrders)
    return { kind: "hidden", reason: "not-accepting-orders" };
  return { kind: "visible" };
}

export function isMarketVisible(
  visibility: MarketVisibility,
): boolean {
  return visibility.kind === "visible";
}

export function loadUserHiddenMarketIds(): Set<string> {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return new Set();
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed)
      ? new Set(
          parsed.filter(
            (value): value is string => typeof value === "string",
          ),
        )
      : new Set();
  } catch {
    return new Set();
  }
}

export function persistUserHiddenMarketIds(
  marketIds: ReadonlySet<string>,
): void {
  try {
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify([...marketIds]),
    );
  } catch {
    // Preferences are best effort.
  }
}


export interface MarketIdentified {
  readonly marketId: string;
}

export interface MarketVisibilityPartition<T extends MarketIdentified> {
  readonly visible: readonly T[];
  readonly hidden: readonly T[];
}

export function partitionMarketVisibility<T extends MarketIdentified>(
  markets: readonly T[],
  visibilityByMarketId: ReadonlyMap<string, MarketVisibility>,
): MarketVisibilityPartition<T> {
  const visible: T[] = [];
  const hidden: T[] = [];

  for (const market of markets) {
    const visibility =
      visibilityByMarketId.get(market.marketId) ??
      { kind: "visible" as const };
    (isMarketVisible(visibility) ? visible : hidden).push(market);
  }

  return { visible, hidden };
}


export interface VisibilityInitializableMarket extends MarketIdentified {
  readonly acceptingOrders: boolean;
}

export function loadMarketVisibility(
  markets: readonly VisibilityInitializableMarket[],
): Map<string, MarketVisibility> {
  const userHidden = loadUserHiddenMarketIds();
  return new Map(
    markets.map((market) => [
      market.marketId,
      initialMarketVisibility(
        market.acceptingOrders,
        userHidden.has(market.marketId),
      ),
    ]),
  );
}

export function setMarketVisibility(
  current: ReadonlyMap<string, MarketVisibility>,
  marketId: string,
  next: MarketVisibility,
): Map<string, MarketVisibility> {
  const updated = new Map(current);
  updated.set(marketId, next);
  return updated;
}

export function setUserMarketVisible(
  current: ReadonlyMap<string, MarketVisibility>,
  marketId: string,
  visible: boolean,
): Map<string, MarketVisibility> {
  return setMarketVisibility(
    current,
    marketId,
    visible
      ? { kind: "visible" }
      : { kind: "hidden", reason: "user" },
  );
}

export function persistUserVisibility(
  visibilityByMarketId: ReadonlyMap<string, MarketVisibility>,
): void {
  const userHidden = new Set<string>();
  for (const [marketId, visibility] of visibilityByMarketId)
    if (
      visibility.kind === "hidden" &&
      visibility.reason === "user"
    )
      userHidden.add(marketId);
  persistUserHiddenMarketIds(userHidden);
}
