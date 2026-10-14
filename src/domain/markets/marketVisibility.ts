import type { Market, MarketId } from "@polymarket/client";
import type { MarketLifecycle } from "./marketLifecycle";

export type HiddenMarketReason =
  | "user"
  | "empty-book"
  | "resolved-default"
  | "closed-default"
  | "unavailable-default";

export type MarketVisibility =
  | { readonly kind: "visible" }
  | {
      readonly kind: "hidden";
      readonly reason: HiddenMarketReason;
    };

export type StoredMarketVisibility =
  "hidden-user" | "visible-user" | "hidden-empty" | "hidden-resolved";

export interface KeyValueStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

const STORAGE_KEY = "polymarket-book-vis.market-visibility.v2";
const LEGACY_HIDDEN_STORAGE_KEY =
  "polymarket-book-vis.age-strip-hidden-markets.v1";

export function initialMarketVisibility(
  stored: StoredMarketVisibility | undefined,
  lifecycle: MarketLifecycle,
  availableForLiveOrders: boolean,
): MarketVisibility {
  if (stored === "hidden-user") return { kind: "hidden", reason: "user" };
  if (stored === "visible-user") return { kind: "visible" };
  if (stored === "hidden-empty")
    return { kind: "hidden", reason: "empty-book" };
  if (stored === "hidden-resolved")
    return { kind: "hidden", reason: "resolved-default" };

  if (lifecycle.kind === "resolved")
    return { kind: "hidden", reason: "resolved-default" };
  if (lifecycle.kind === "awaiting-resolution")
    return { kind: "hidden", reason: "closed-default" };
  if (!availableForLiveOrders)
    return { kind: "hidden", reason: "unavailable-default" };
  return { kind: "visible" };
}

export function isMarketVisible(visibility: MarketVisibility): boolean {
  return visibility.kind === "visible";
}

export function loadStoredMarketVisibility(
  storage: KeyValueStorage = window.localStorage,
): Map<string, StoredMarketVisibility> {
  const result = new Map<string, StoredMarketVisibility>();

  try {
    const raw = storage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed: unknown = JSON.parse(raw);
      if (
        parsed !== null &&
        typeof parsed === "object" &&
        !Array.isArray(parsed)
      )
        for (const [marketId, value] of Object.entries(parsed))
          if (
            value === "hidden-user" ||
            value === "visible-user" ||
            value === "hidden-empty" ||
            value === "hidden-resolved"
          )
            result.set(marketId, value);
    }
  } catch (error) {
    console.warn("Could not restore market visibility preferences:", error);
  }

  // Preserve existing user-hidden choices when upgrading from the v1 array.
  try {
    const raw = storage.getItem(LEGACY_HIDDEN_STORAGE_KEY);
    if (raw) {
      const parsed: unknown = JSON.parse(raw);
      if (Array.isArray(parsed))
        for (const marketId of parsed)
          if (typeof marketId === "string" && !result.has(marketId))
            result.set(marketId, "hidden-user");
    }
  } catch (error) {
    console.warn("Could not restore legacy hidden market preferences:", error);
  }

  return result;
}

export function persistStoredMarketVisibility(
  marketId: string,
  visibility: StoredMarketVisibility | null,
  storage: KeyValueStorage = window.localStorage,
): void {
  try {
    const stored = loadStoredMarketVisibility(storage);
    if (visibility === null) stored.delete(marketId);
    else stored.set(marketId, visibility);
    storage.setItem(
      STORAGE_KEY,
      JSON.stringify(Object.fromEntries(stored.entries())),
    );
  } catch (error) {
    console.warn("Could not persist market visibility preference:", error);
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
