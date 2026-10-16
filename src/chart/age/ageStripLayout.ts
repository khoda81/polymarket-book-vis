import { clamp } from "@/shared/math";
import type { TokenBook } from "@/domain/books/orderBook";
import type { PressureRow } from "./pressureRows";

const AGE_LABEL_MIN_GUTTER_PX = 16;
const AGE_LABEL_MAX_GUTTER_PX = 100;
const AGE_MARKET_ICON_SIZE_PX = 16;
const AGE_MARKET_ICON_GAP_PX = 8;

export const AGE_LABEL_HORIZONTAL_INSET_PX = 8;
const AGE_TIME_META_WIDTH_PX = 36;
export const AGE_TIME_GUTTER_PX =
  AGE_TIME_META_WIDTH_PX + AGE_LABEL_HORIZONTAL_INSET_PX * 2 + 1;

export const VOLUME_LEFT_PADDING_PX = 48;
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

  // Deadline text has a stable reserved width, so clock updates do not resize
  // the chart or invalidate pressure geometry.
  let widest = 68;
  for (const label of labels) {
    const titleWidth = measureAgeLabelTextWidth(label.dataset.ageLabel ?? "");
    const status = label.dataset.ageStatus ?? "";
    const statusWidth = status ? measureAgeLabelTextWidth(status) + 8 : 0;
    widest = Math.max(widest, titleWidth + statusWidth);
  }

  return Math.ceil(
    clamp(
      widest + iconExtra + AGE_LABEL_HORIZONTAL_INSET_PX * 2 + 1,
      AGE_LABEL_MIN_GUTTER_PX,
      AGE_LABEL_MAX_GUTTER_PX,
    ),
  );
}

function measureAgeLabelTextWidth(text: string): number {
  const ctx = getAgeLabelMeasureContext();
  if (!ctx) return text.length * 6;
  ctx.font = "11px sans-serif";
  return ctx.measureText(text).width;
}

export function positionRowControls(
  labels: readonly (HTMLLabelElement | null)[],
  rows: readonly RowRasterGeometry[],
): void {
  for (const [index, label] of labels.entries()) {
    const row = rows[index];
    if (!label || !row) continue;
    const top = `${row.centerCss}px`;
    if (label.style.top !== top) label.style.top = top;
  }
}

/** A row as drawn: its content and its snapped screen-space band. */
export interface DrawnAgeRow extends RowRasterGeometry {
  readonly row: PressureRow;
}

export interface AgeStripGeometry {
  readonly viewport: {
    readonly l: number;
    readonly t: number;
    readonly width: number;
    readonly height: number;
  };
  readonly rows: readonly DrawnAgeRow[];
  readonly canvasWidth: number;
  readonly canvasHeight: number;
}

export function ageStripRowAtY(
  geometry: AgeStripGeometry,
  y: number,
): DrawnAgeRow | null {
  return (
    geometry.rows.find((row) => y >= row.topCss && y < row.bottomCss) ?? null
  );
}

export interface RowRasterGeometry {
  readonly topCss: number;
  readonly centerCss: number;
  readonly bottomCss: number;
  readonly heightCss: number;
}

/**
 * Snap every shared row edge and centerline to a single device-pixel grid.
 * Quantizing absolute boundaries (rather than each row's length) partitions
 * pixels exactly, even at fractional DPR. Nominal CSS-space layout is kept.
 */
export function rasterizeAgeRows(
  viewportTopCss: number,
  viewportHeightCss: number,
  rowCount: number,
  canvasHeightCss: number,
  framebufferHeight: number,
): readonly RowRasterGeometry[] {
  if (rowCount <= 0) return [];
  const scaleY = framebufferHeight / canvasHeightCss;
  const halfRowCount = rowCount * 2;
  const boundaries = Array.from({ length: halfRowCount + 1 }, (_, index) =>
    Math.round(
      (viewportTopCss + (viewportHeightCss * index) / halfRowCount) * scaleY,
    ),
  );

  return Array.from({ length: rowCount }, (_, index) => {
    const topDevice = boundaries[index * 2]!;
    const centerDevice = boundaries[index * 2 + 1]!;
    const bottomDevice = boundaries[index * 2 + 2]!;
    return {
      topCss: topDevice / scaleY,
      centerCss: centerDevice / scaleY,
      bottomCss: bottomDevice / scaleY,
      heightCss: (bottomDevice - topDevice) / scaleY,
    };
  });
}

export function hasRealOrders(book: TokenBook): boolean {
  return book.usdToYes.size > 0 || book.yesToUsd.size > 0;
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
    typeof canvas.getContext === "function" ? canvas.getContext("2d") : null;
  return ageLabelMeasureCtx;
}
