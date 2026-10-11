import { AGE_ROW_BAND_PX } from "../../chart/age/ageStripTuning";
import { CHART_VERTICAL_PADDING_PX } from "../../rendering/renderer";

export interface ScrollAnchor {
  readonly eventId: string;
  readonly marketId?: string;
  readonly offset: number;
}

function marketPosition(root: HTMLElement, marketId: string) {
  for (const stage of root.querySelectorAll<HTMLElement>(
    "[data-visible-market-ids]",
  )) {
    const index = stage.dataset.visibleMarketIds!.split(" ").indexOf(marketId);
    if (index >= 0)
      return {
        stage,
        index,
        top:
          stage.getBoundingClientRect().top +
          CHART_VERTICAL_PADDING_PX / 2 +
          (index + 0.5) * AGE_ROW_BAND_PX,
      };
  }
  return null;
}

/** Anchor metadata rows, so surface virtualization cannot remove the anchor. */
export function captureScrollAnchor(root: HTMLElement): ScrollAnchor | null {
  const clip = root.getBoundingClientRect();
  const candidates: ScrollAnchor[] = [];
  for (const entry of root.querySelectorAll<HTMLElement>(
    "[data-series-event]",
  )) {
    const bounds = entry.getBoundingClientRect();
    if (bounds.bottom <= clip.top || bounds.top >= clip.bottom) continue;
    const eventId = entry.dataset.seriesEvent!;
    candidates.push({ eventId, offset: bounds.top - clip.top });
    for (const stage of entry.querySelectorAll<HTMLElement>(
      "[data-visible-market-ids]",
    )) {
      const top =
        stage.getBoundingClientRect().top + CHART_VERTICAL_PADDING_PX / 2;
      stage.dataset
        .visibleMarketIds!.split(" ")
        .filter(Boolean)
        .forEach((marketId, index) => {
          const offset = top + (index + 0.5) * AGE_ROW_BAND_PX - clip.top;
          if (offset >= 0 && offset < clip.height)
            candidates.push({ eventId, marketId, offset });
        });
    }
  }
  return (
    candidates
      .filter((candidate) => candidate.offset >= 0)
      .sort((a, b) => a.offset - b.offset)[0] ??
    candidates[0] ??
    null
  );
}

export function restoreScrollAnchor(
  root: HTMLElement,
  anchor: ScrollAnchor | null,
): void {
  if (!anchor) return;
  const entry = root.querySelector<HTMLElement>(
    `[data-series-event="${CSS.escape(anchor.eventId)}"]`,
  );
  const top =
    (anchor.marketId ? marketPosition(root, anchor.marketId)?.top : null) ??
    entry?.getBoundingClientRect().top;
  if (top !== undefined)
    root.scrollTop += top - root.getBoundingClientRect().top - anchor.offset;
}

export function scrollToMarket(root: HTMLElement, marketId: string): void {
  const position = marketPosition(root, marketId);
  if (!position) return;
  const entry = position.stage.closest<HTMLElement>("[data-series-event]");
  const headerTop = entry?.getBoundingClientRect().top;
  // Keep the event's title and rules in view when the first row fits below them.
  const top =
    position.index === 0 &&
    headerTop !== undefined &&
    position.top - headerTop < root.clientHeight - AGE_ROW_BAND_PX
      ? headerTop
      : position.top - AGE_ROW_BAND_PX;
  root.scrollTop += top - root.getBoundingClientRect().top;
}
