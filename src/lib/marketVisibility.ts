export type HiddenMarketReason =
  | "user"
  | "not-accepting-orders"
  | "empty-book";

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
