import type { PolymarketCPV } from "./component";
import { installAgeStripView as installOptimizedAgeStripView } from "./ageStripsOptimized";

/**
 * Install the optimized age-strip renderer while suppressing redundant DOM
 * reparenting during age-mode redraws.
 *
 * The renderer calls appendChild() on every market label each draw even when
 * the label is already in the correct visible/hidden container. appendChild()
 * on an existing child still removes/reinserts it, generating child-list
 * mutations, style work, and MutationObserver callbacks (notably LastPass).
 *
 * Rendering already sorts controls by data-market-order before using them, so
 * DOM sibling order is irrelevant in age mode. Moves between the visible and
 * hidden containers still go through normally. Volume mode keeps native
 * appendChild semantics so its legend can restore its original ordering.
 */
export function installAgeStripView(chart: PolymarketCPV): void {
  installOptimizedAgeStripView(chart);

  const component = chart as unknown as {
    viewMode: "volume" | "age";
    refs: Record<string, HTMLElement>;
  };

  const toggles = component.refs.toggles;
  const canvasWrap = component.refs.canvasWrap;
  const hiddenTray = canvasWrap.nextElementSibling as HTMLElement | null;

  suppressSameParentAppend(toggles, () => component.viewMode === "age");
  if (hiddenTray?.classList.contains("cpv-hidden-markets"))
    suppressSameParentAppend(hiddenTray, () => component.viewMode === "age");
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
