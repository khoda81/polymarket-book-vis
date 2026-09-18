import type { ChartDefinition } from "@/lib/chartDefinition";
import { marketColor } from "@/lib/math";
import { emptyTokenBook, type BookOrder } from "@/lib/orderBook";
import type { ChartTheme, Frame, OrderBookPlotter, StackDirection, BoxStyle } from "@/lib/renderer";
import { signedVolumeColor } from "@/lib/signedVolume";
import type { TokenId } from "@polymarket/client";

interface BookBoxView {
  readonly direction: StackDirection;
  readonly orders: Iterable<BookOrder>;
  readonly color: string;
  readonly fillDepth?: number;
}

export interface VolumeBookViewHost {
  readonly plotter: OrderBookPlotter;
  readonly definition: ChartDefinition;
  readonly activeTokens: ReadonlySet<TokenId>;
  readonly getBook: (
    tokenId: string,
  ) => ReturnType<typeof emptyTokenBook> | undefined;
  readonly getTheme: () => ChartTheme;
  readonly isActive: () => boolean;
  readonly requestDraw: () => void;
}

export class VolumeBookView {
  private pointer: { sx: number; sy: number } | null = null;
  private scale = 4.5;

  constructor(private readonly host: VolumeBookViewHost) {}

  zoom(delta: number): void {
    if (!this.host.isActive()) return;
    this.scale += delta;
    this.host.requestDraw();
  }

  setPointer(pointer: { sx: number; sy: number } | null): void {
    this.pointer = pointer;
    if (this.host.isActive()) this.host.requestDraw();
  }

  draw(): void {
    const yAbsMax = Math.pow(10, this.scale);
    const frame = this.host.plotter.beginFrame(
      this.host.getTheme(),
      {
        xRange: { min: 0, max: 1 },
        yRange: { min: -yAbsMax, max: yAbsMax },
      },
    );
    frame.drawAxes();

    const pointerData = this.pointer
      ? frame.toData(this.pointer)
      : null;
    const empty = emptyTokenBook();
    const placeholderColor = marketColor("", 0);

    drawBookView(frame, {
      direction: "up",
      orders: empty.usdToYes.asOrders(),
      color: placeholderColor,
    });
    drawBookView(frame, {
      direction: "down",
      orders: empty.yesToUsd.asSellOrders(),
      color: placeholderColor,
    });

    for (const [index, market] of
      this.host.definition.event.markets.entries()) {
      const tokenId = market.outcomes.yes.tokenId;
      if (!tokenId || !this.host.activeTokens.has(tokenId))
        continue;

      const book =
        this.host.getBook(String(tokenId)) ?? emptyTokenBook();
      const semanticScale =
        this.host.definition.pressureScales.get(
          String(tokenId),
        );
      const yesColor = semanticScale
        ? signedVolumeColor(1, semanticScale)
        : marketColor(this.host.definition.event.id, index);
      const noColor = semanticScale
        ? signedVolumeColor(-1, semanticScale)
        : yesColor;

      drawBookView(frame, {
        direction: "up",
        orders: book.usdToYes.asOrders(),
        color: yesColor,
        fillDepth: pointerData
          ? Math.max(pointerData.y, 0)
          : undefined,
      });
      drawBookView(frame, {
        direction: "down",
        orders: book.yesToUsd.asSellOrders(),
        color: noColor,
        fillDepth: pointerData
          ? Math.max(-pointerData.y, 0)
          : undefined,
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
  let fillRemaining = Math.min(
    view.fillDepth ?? 0,
    remainingHeight,
  );

  for (const level of view.orders) {
    const rowHeight = Math.min(level.take, remainingHeight);
    if (rowHeight <= 0) continue;

    const filledHeight = Math.min(rowHeight, fillRemaining);
    if (filledHeight > 0) {
      commitBoxRow(
        pen,
        level.price,
        filledHeight,
        filledStyle,
      );
      fillRemaining -= filledHeight;
    }

    const emptyHeight = rowHeight - filledHeight;
    if (emptyHeight > 0)
      commitBoxRow(
        pen,
        level.price,
        emptyHeight,
        emptyStyle,
      );

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

function boxStyle(
  color: string,
  filled: boolean,
): BoxStyle {
  return {
    stroke: color,
    fill: filled
      ? { kind: "solid-dim", alpha: 0.25 }
      : { kind: "none" },
  };
}
