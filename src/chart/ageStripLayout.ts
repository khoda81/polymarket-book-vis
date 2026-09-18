import { AGE_ROW_BAND_PX } from "@/lib/ageStripTuning";
import type { Frame } from "@/lib/renderer";
import type { TokenBook } from "@/lib/orderBook";
import type { Event } from "@polymarket/client";

const AGE_LABEL_MIN_GUTTER_PX = 16;
const AGE_LABEL_MAX_GUTTER_PX = 100;
const AGE_MARKET_ICON_SIZE_PX = 16;
const AGE_MARKET_ICON_GAP_PX = 8;

export const AGE_LABEL_HORIZONTAL_INSET_PX = 8;
const AGE_TIME_META_WIDTH_PX = 52;
export const AGE_TIME_GUTTER_PX =
  AGE_TIME_META_WIDTH_PX + AGE_LABEL_HORIZONTAL_INSET_PX * 2 + 1;

export const VOLUME_LEFT_PADDING_PX = 60;
export const VOLUME_RIGHT_PADDING_PX = 16;

let ageLabelMeasureCtx: CanvasRenderingContext2D | null | undefined;

export function ageLabelGutterWidth(
  labels: readonly HTMLLabelElement[],
): number {
  if (labels.length === 0) return AGE_LABEL_MIN_GUTTER_PX;

  const iconExtra = labels.some(
    (label) =>
      label.dataset.ageSuppressMarketIdentity !== "true" &&
      label.querySelector(".cpv-market-icon") !== null,
  )
    ? AGE_MARKET_ICON_SIZE_PX + AGE_MARKET_ICON_GAP_PX
    : 0;

  let widest = 0;
  for (const label of labels) {
    const cached = Number(label.dataset.ageLabelWidth);
    if (!Number.isFinite(cached)) continue;
    widest = Math.max(widest, cached);
  }

  return Math.ceil(
    clamp(
      widest +
        iconExtra +
        AGE_LABEL_HORIZONTAL_INSET_PX * 2 +
        1,
      AGE_LABEL_MIN_GUTTER_PX,
      AGE_LABEL_MAX_GUTTER_PX,
    ),
  );
}

export function measureAgeLabelTextWidth(text: string): number {
  const ctx = getAgeLabelMeasureContext();
  if (!ctx) return text.length * 6;
  ctx.font = "11px sans-serif";
  return ctx.measureText(text).width;
}

export function sameDisplayTitle(
  a: string,
  b: string | null | undefined,
): boolean {
  if (!b) return false;
  return normalizeDisplayTitle(a) === normalizeDisplayTitle(b);
}

export function positionRowControls(
  labels: readonly HTMLLabelElement[],
  frame: Frame,
  rowCount: number,
): void {
  const dpr = window.devicePixelRatio || 1;
  for (const [index, label] of labels.entries()) {
    const y = rowCount - 1 - index;
    const geometry = rowRasterGeometry(frame.toScreenY(0, y), dpr);
    const top = `${geometry.centerCss}px`;
    if (label.style.top !== top) label.style.top = top;
  }
}

export interface AgeStripGeometry {
  readonly viewport: {
    readonly l: number;
    readonly t: number;
    readonly width: number;
    readonly height: number;
  };
  readonly rows: readonly { readonly tokenId: string }[];
  readonly canvasWidth: number;
  readonly canvasHeight: number;
}

export interface RowRasterGeometry {
  readonly deviceHeight: number;
  readonly topCss: number;
  readonly heightCss: number;
  readonly centerCss: number;
}

export function rowRasterGeometry(
  desiredCenterCss: number,
  dpr: number,
): RowRasterGeometry {
  const deviceHeight = Math.max(1, Math.round(AGE_ROW_BAND_PX * dpr));
  const topDevice = Math.round(
    desiredCenterCss * dpr - deviceHeight / 2,
  );
  const topCss = topDevice / dpr;
  const heightCss = deviceHeight / dpr;
  return {
    deviceHeight,
    topCss,
    heightCss,
    centerCss: topCss + heightCss / 2,
  };
}

export function hasRealOrders(book: TokenBook<string>): boolean {
  // yesToUsd always includes the synthetic mint level.
  return book.usdToYes.size > 0 || book.yesToUsd.size > 1;
}

export function resolutionOrder(
  event: Event,
  rawMarkets: readonly unknown[],
): Map<string, number> {
  const rawById = new Map<string, unknown>();
  for (const rawMarket of rawMarkets) {
    const record = asRecord(rawMarket);
    if (typeof record?.id === "string")
      rawById.set(record.id, rawMarket);
  }

  const sorted = event.markets
    .map((market, originalIndex) => ({
      market,
      originalIndex,
      timestamp: resolutionTimestamp(
        rawById.get(market.id),
        market,
      ),
    }))
    .sort((a, b) => {
      const aKnown = Number.isFinite(a.timestamp);
      const bKnown = Number.isFinite(b.timestamp);
      if (aKnown && bKnown)
        return (
          a.timestamp - b.timestamp ||
          a.originalIndex - b.originalIndex
        );
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

export function resolutionTimestamp(
  ...sources: readonly unknown[]
): number {
  for (const source of sources) {
    const record = asRecord(source);
    if (!record) continue;
    const state = asRecord(record.state);
    for (const candidate of [
      state?.endDate,
      state?.end_date,
      record.endDate,
      record.endDateIso,
      record.end_date,
      record.end_date_iso,
    ]) {
      if (candidate instanceof Date) return candidate.getTime();
      if (
        typeof candidate === "number" &&
        Number.isFinite(candidate)
      )
        return candidate;
      if (typeof candidate === "string") {
        const parsed = Date.parse(candidate);
        if (Number.isFinite(parsed)) return parsed;
      }
    }
  }
  return Infinity;
}

export function normalizedWheelDelta(event: WheelEvent): number {
  let delta = event.deltaY;
  if (event.deltaMode === WheelEvent.DOM_DELTA_LINE) delta *= 16;
  else if (event.deltaMode === WheelEvent.DOM_DELTA_PAGE) delta *= 400;
  return clamp(delta, -500, 500);
}

function getAgeLabelMeasureContext(): CanvasRenderingContext2D | null {
  if (ageLabelMeasureCtx !== undefined) return ageLabelMeasureCtx;
  const canvas = document.createElement("canvas");
  ageLabelMeasureCtx =
    typeof canvas.getContext === "function"
      ? canvas.getContext("2d")
      : null;
  return ageLabelMeasureCtx;
}

function normalizeDisplayTitle(value: string): string {
  return value
    .normalize("NFKC")
    .trim()
    .replace(/\s+/g, " ")
    .toLowerCase();
}

function asRecord(
  value: unknown,
): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object"
    ? (value as Record<string, unknown>)
    : undefined;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}
