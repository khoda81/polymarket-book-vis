import {
  emptyTokenBook,
  type BookOrder,
  type TokenBook,
} from "@/domain/books/orderBook";
import { priceToNumber } from "@/domain/books/price";
import type {
  ChartTheme,
  Frame,
  OrderBookPlotter,
  StackDirection,
  BoxStyle,
} from "@/rendering/renderer";

interface BookBoxView {
  readonly direction: StackDirection;
  readonly orders: Iterable<BookOrder>;
  readonly color: string;
  readonly fillDepth?: number;
}

/** One book to draw: bids stack up, asks stack down. */
export interface VolumeSeries {
  readonly key: string;
  /** Undefined until the book's first snapshot; drawn as empty. */
  readonly book: TokenBook | undefined;
  readonly bidColor: string;
  readonly askColor: string;
}

export interface VolumeBookViewHost {
  readonly plotter: OrderBookPlotter;
  /** Books to draw, in drawing order. */
  readonly getSeries: () => readonly VolumeSeries[];
  readonly getTheme: () => ChartTheme;
  readonly isActive: () => boolean;
  readonly requestDraw: () => void;
  readonly getScale: () => number;
  readonly setScale: (scale: number) => void;
}

export class VolumeBookView {
  private pointer: { sx: number; sy: number } | null = null;

  constructor(private readonly host: VolumeBookViewHost) {}

  zoom(delta: number): boolean {
    if (!this.host.isActive()) return false;
    this.host.setScale(this.host.getScale() + delta);
    this.host.requestDraw();
    return true;
  }

  setPointer(pointer: { sx: number; sy: number } | null): void {
    this.pointer = pointer;
    if (this.host.isActive()) this.host.requestDraw();
  }

  draw(): void {
    const yAbsMax = Math.pow(10, this.host.getScale());
    const frame = this.host.plotter.beginFrame(this.host.getTheme(), {
      xRange: { min: 0, max: 1 },
      yRange: { min: -yAbsMax, max: yAbsMax },
    });
    frame.drawAxes();

    const pointerData = this.pointer ? frame.toData(this.pointer) : null;
    const empty = emptyTokenBook();

    for (const series of this.host.getSeries()) {
      const book = series.book ?? empty;

      drawBookView(frame, {
        direction: "up",
        orders: book.usdToYes.asOrders(),
        color: series.bidColor,
        fillDepth: pointerData ? Math.max(pointerData.y, 0) : undefined,
      });
      drawBookView(frame, {
        direction: "down",
        orders: book.yesToUsd.asSellOrders(),
        color: series.askColor,
        fillDepth: pointerData ? Math.max(-pointerData.y, 0) : undefined,
      });
    }

    if (this.pointer && pointerData)
      frame.drawPointer(pointerData, this.pointer);
  }
}

function drawBookView(frame: Frame, view: BookBoxView): void {
  const emptyStyle = boxStyle(view.color, false);
  const filledStyle = boxStyle(view.color, true);
  const pen = frame.boxPen(
    { direction: view.direction, anchor: "left" },
    emptyStyle,
  );

  let remainingHeight = frame.domain.yRange.max;
  let fillRemaining = Math.min(view.fillDepth ?? 0, remainingHeight);

  for (const level of view.orders) {
    const rowHeight = Math.min(level.take, remainingHeight);
    if (rowHeight <= 0) continue;

    const filledHeight = Math.min(rowHeight, fillRemaining);
    if (filledHeight > 0) {
      commitBoxRow(pen, priceToNumber(level.price), filledHeight, filledStyle);
      fillRemaining -= filledHeight;
    }

    const emptyHeight = rowHeight - filledHeight;
    if (emptyHeight > 0)
      commitBoxRow(pen, priceToNumber(level.price), emptyHeight, emptyStyle);

    remainingHeight -= rowHeight;
    if (remainingHeight <= 0) break;
  }
}

function commitBoxRow(
  pen: ReturnType<Frame["boxPen"]>,
  width: number,
  height: number,
  style: BoxStyle,
): void {
  pen.newBox(style);
  pen.extendBox(width);
  pen.commitRow(height);
}

function boxStyle(color: string, filled: boolean): BoxStyle {
  return {
    stroke: color,
    fill: filled ? { kind: "solid-dim", alpha: 0.25 } : { kind: "none" },
  };
}
