import type { PolymarketCPV } from "./component";
import type { TokenBook } from "@/lib/orderBook";
import { installAgeStripView as installOptimizedAgeStripView } from "./ageStripsOptimized";

const HIDDEN_MARKETS_STORAGE_KEY =
  "polymarket-book-vis.age-strip-hidden-markets.v1";
const persistedHiddenMarketIds = loadHiddenMarketIds();

interface AdapterMarket {
  id: string;
  question: string;
  outcomes: { yes: { tokenId: string | null } };
  state?: unknown;
  [key: string]: unknown;
}

interface AdapterEvent {
  markets: AdapterMarket[];
}

/**
 * Add the stable-DOM / QoL layer around the optimized age-strip renderer.
 *
 * Same-parent appendChild calls are suppressed in age mode because moving an
 * existing child to the end of its own parent still emits DOM mutations. That
 * used to trigger expensive MutationObservers (notably password managers).
 */
export function installAgeStripView(chart: PolymarketCPV): void {
  installOptimizedAgeStripView(chart);

  const component = chart as unknown as {
    viewMode: "volume" | "age";
    refs: Record<string, HTMLElement>;
    activeTokens: Set<string>;
    books: Record<string, TokenBook<string>>;
    buildToggles(event: AdapterEvent): void;
    updateSpreadAge(tokenId: string, nowMs: number): void;
    load(event: unknown): Promise<void>;
    reqDraw(): void;
  };

  const toggles = component.refs.toggles;
  const canvasWrap = component.refs.canvasWrap;
  const hiddenTray = canvasWrap.nextElementSibling as HTMLElement | null;
  const initializedVisibility = new Set<string>();

  suppressSameParentAppend(toggles, () => component.viewMode === "age");
  if (hiddenTray?.classList.contains("cpv-hidden-markets"))
    suppressSameParentAppend(hiddenTray, () => component.viewMode === "age");

  const originalBuildToggles = component.buildToggles.bind(component);
  component.buildToggles = (event: AdapterEvent) => {
    originalBuildToggles(event);
    configureMarketControls(component, event, toggles);
  };

  const originalUpdateSpreadAge = component.updateSpreadAge.bind(component);
  component.updateSpreadAge = (tokenId: string, nowMs: number) => {
    originalUpdateSpreadAge(tokenId, nowMs);
    if (initializedVisibility.has(tokenId)) return;
    initializedVisibility.add(tokenId);

    const book = component.books[tokenId];
    if (!book || hasRealOrders(book)) return;

    const label = findControlByToken(toggles, hiddenTray, tokenId);
    const marketId = label?.dataset.marketId;
    const checkbox = label?.querySelector<HTMLInputElement>("input[type=checkbox]");
    if (!label || !checkbox || !marketId) return;

    // A stored user preference wins over the automatic empty-book default.
    if (persistedHiddenMarketIds.has(marketId)) return;

    checkbox.checked = false;
    component.activeTokens.delete(tokenId);
    component.reqDraw();
  };

  const originalLoad = component.load.bind(component);
  component.load = async (event: unknown) => {
    initializedVisibility.clear();
    await originalLoad(event);
  };
}

function configureMarketControls(
  component: { activeTokens: Set<string> },
  event: AdapterEvent,
  toggles: HTMLElement,
): void {
  const marketByToken = new Map<string, AdapterMarket>();
  for (const market of event.markets) {
    const tokenId = market.outcomes.yes.tokenId;
    if (tokenId) marketByToken.set(tokenId, market);
  }

  const orderByToken = resolutionOrder(event.markets);
  for (const label of toggles.querySelectorAll<HTMLLabelElement>(
    "label[data-token-id]",
  )) {
    const tokenId = label.dataset.tokenId;
    if (!tokenId) continue;
    const market = marketByToken.get(tokenId);
    if (!market) continue;

    label.dataset.marketId = market.id;
    label.dataset.marketOrder = String(orderByToken.get(tokenId) ?? 0);

    const checkbox = label.querySelector<HTMLInputElement>("input[type=checkbox]");
    if (!checkbox) continue;

    if (persistedHiddenMarketIds.has(market.id)) {
      checkbox.checked = false;
      component.activeTokens.delete(tokenId);
    }

    if (label.dataset.persistHiddenBound === "1") continue;
    label.dataset.persistHiddenBound = "1";
    checkbox.addEventListener("change", () => {
      if (checkbox.checked) persistedHiddenMarketIds.delete(market.id);
      else persistedHiddenMarketIds.add(market.id);
      persistHiddenMarketIds();
    });
  }
}

function resolutionOrder(markets: readonly AdapterMarket[]): Map<string, number> {
  const sorted = markets
    .map((market, originalIndex) => ({
      market,
      originalIndex,
      timestamp: resolutionTimestamp(market),
    }))
    .sort((a, b) => {
      const aKnown = Number.isFinite(a.timestamp);
      const bKnown = Number.isFinite(b.timestamp);
      if (aKnown && bKnown)
        return a.timestamp - b.timestamp || a.originalIndex - b.originalIndex;
      if (aKnown !== bKnown) return aKnown ? -1 : 1;
      return a.originalIndex - b.originalIndex;
    });

  const order = new Map<string, number>();
  for (const [index, { market }] of sorted.entries()) {
    const tokenId = market.outcomes.yes.tokenId;
    if (tokenId) order.set(tokenId, index);
  }
  return order;
}

function resolutionTimestamp(market: AdapterMarket): number {
  const state = asRecord(market.state);
  const candidates = [
    state?.endDate,
    state?.end_date,
    market.endDate,
    market.endDateIso,
    market.end_date,
    market.end_date_iso,
  ];

  for (const candidate of candidates) {
    if (candidate instanceof Date) return candidate.getTime();
    if (typeof candidate === "number" && Number.isFinite(candidate))
      return candidate;
    if (typeof candidate === "string") {
      const parsed = Date.parse(candidate);
      if (Number.isFinite(parsed)) return parsed;
    }
  }
  return Number.POSITIVE_INFINITY;
}

function hasRealOrders(book: TokenBook<string>): boolean {
  // yesToUsd always contains the synthetic `mint` level. Ignore it here.
  return book.usdToYes.size > 0 || book.yesToUsd.size > 1;
}

function findControlByToken(
  toggles: HTMLElement,
  hiddenTray: HTMLElement | null,
  tokenId: string,
): HTMLLabelElement | null {
  for (const root of [toggles, hiddenTray]) {
    if (!root) continue;
    for (const label of root.querySelectorAll<HTMLLabelElement>(
      "label[data-token-id]",
    ))
      if (label.dataset.tokenId === tokenId) return label;
  }
  return null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object"
    ? (value as Record<string, unknown>)
    : null;
}

function loadHiddenMarketIds(): Set<string> {
  try {
    const raw = window.localStorage.getItem(HIDDEN_MARKETS_STORAGE_KEY);
    if (!raw) return new Set();
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed)
      ? new Set(parsed.filter((value): value is string => typeof value === "string"))
      : new Set();
  } catch {
    return new Set();
  }
}

function persistHiddenMarketIds(): void {
  try {
    window.localStorage.setItem(
      HIDDEN_MARKETS_STORAGE_KEY,
      JSON.stringify([...persistedHiddenMarketIds]),
    );
  } catch {
    // Preferences are best-effort only.
  }
}

function suppressSameParentAppend(
  parent: HTMLElement,
  enabled: () => boolean,
): void {
  const nativeAppendChild = parent.appendChild.bind(parent);

  parent.appendChild = (<T extends Node>(node: T): T => {
    if (enabled() && node.parentNode === parent) return node;
    return nativeAppendChild(node) as T;
  }) as typeof parent.appendChild;
}
