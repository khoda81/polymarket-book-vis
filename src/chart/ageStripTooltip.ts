import type { TokenBook } from "@/lib/orderBook";
import {
  signedVolumeColor,
  type SignedVolumeColorScale,
} from "@/lib/signedVolume";
import {
  ageStripRowAtY,
  ageStripRowCenterY,
  type AgeStripGeometry,
} from "./ageStripLayout";
import type { ViewMode } from "@/lib/chartState";
import {
  hideSharedTooltip,
  releaseSharedTooltip,
  showSharedTooltip,
} from "@/lib/sharedTooltip";
import { priceToNumber } from "@/lib/price";

export interface AgeStripTooltipHost {
  readonly canvas: HTMLCanvasElement;
  readonly getViewMode: () => ViewMode;
  readonly getBook: (tokenId: string) => TokenBook | undefined;
  readonly getTokenName: (tokenId: string) => string | undefined;
  readonly getOppositeTokenName: (tokenId: string) => string | undefined;
  readonly getOppositeTokenId: (tokenId: string) => string | undefined;
  readonly getPressureColorScale: (tokenId: string) => SignedVolumeColorScale;
}

interface HoverPointer {
  readonly sx: number;
  readonly sy: number;
  readonly canvasLeft: number;
  readonly canvasTop: number;
}

interface SupplyHover {
  readonly price: number;
  readonly shares: number;
  readonly effectivePrice: number;
}

export class AgeStripTooltip {
  private readonly tooltipOwner = Symbol("age-strip-tooltip");
  private geometry: AgeStripGeometry | null = null;
  private pointer: HoverPointer | null = null;

  constructor(private readonly host: AgeStripTooltipHost) {
    host.canvas.addEventListener("pointermove", this.handlePointerMove);
    host.canvas.addEventListener("pointerleave", this.handlePointerLeave);
  }

  setGeometry(geometry: AgeStripGeometry | null): void {
    this.geometry = geometry;
    if (this.pointer) this.render(this.pointer);
    else if (!geometry) this.hide();
  }

  clear(): void {
    this.geometry = null;
    this.pointer = null;
    this.hide();
  }

  destroy(): void {
    this.host.canvas.removeEventListener("pointermove", this.handlePointerMove);
    this.host.canvas.removeEventListener(
      "pointerleave",
      this.handlePointerLeave,
    );
    releaseSharedTooltip(this.tooltipOwner);
  }

  private readonly handlePointerMove = (event: PointerEvent) => {
    this.pointer = {
      sx: event.offsetX,
      sy: event.offsetY,
      canvasLeft: event.clientX - event.offsetX,
      canvasTop: event.clientY - event.offsetY,
    };
    this.render(this.pointer);
  };

  private readonly handlePointerLeave = () => {
    this.pointer = null;
    this.hide();
  };

  private render(pointer: HoverPointer): void {
    const { sx, sy } = pointer;
    if (this.host.getViewMode() !== "age") {
      this.hide();
      return;
    }

    const geometry = this.geometry;
    if (!geometry || geometry.rows.length === 0) {
      this.hide();
      return;
    }

    const { viewport: vp } = geometry;
    if (
      sx < vp.l ||
      sx > vp.l + vp.width ||
      sy < vp.t ||
      sy >= vp.t + vp.height
    ) {
      this.hide();
      return;
    }

    const row = ageStripRowAtY(geometry, sy);
    if (!row) {
      this.hide();
      return;
    }

    const rowCenterCss = ageStripRowCenterY(geometry, row);
    const rowCenterY = pointer.canvasTop + rowCenterCss;
    const anchorX = pointer.canvasLeft + sx;

    if (row.resolution) {
      const resolution = row.resolution;
      const signature = [
        "resolved",
        resolution.side,
        resolution.outcome,
        resolution.marketEndMs ?? "",
      ].join("|");

      showSharedTooltip(
        this.tooltipOwner,
        signature,
        (overlay) =>
          renderResolutionTooltip(
            overlay,
            resolution.side,
            resolution.outcome,
            resolution.marketEndMs,
            this.host.getPressureColorScale(row.tokenId),
          ),
        anchorX,
        rowCenterY,
      );
      return;
    }

    const primary = sy >= rowCenterCss;
    const tokenId = primary
      ? row.tokenId
      : this.host.getOppositeTokenId(row.tokenId);
    if (!tokenId) {
      this.hide();
      return;
    }

    const book = this.host.getBook(tokenId);
    if (!book) {
      this.hide();
      return;
    }

    const displayPrice = clamp01((sx - vp.l) / vp.width);
    const tokenPrice = primary ? 1 - displayPrice : displayPrice;
    const hover = supplyHoverAtPrice(book, tokenPrice);
    if (!hover) {
      this.hide();
      return;
    }

    const tokenName = primary
      ? this.host.getTokenName(row.tokenId)
      : this.host.getOppositeTokenName(row.tokenId);
    const resolvedName = tokenName ?? "(unknown)";
    const colorScale = this.host.getPressureColorScale(row.tokenId);
    const signature = [
      resolvedName,
      formatProbability(hover.price),
      formatShares(hover.shares),
      formatProbability(hover.effectivePrice),
      primary ? "primary" : "opposite",
    ].join("|");

    showSharedTooltip(
      this.tooltipOwner,
      signature,
      (overlay) =>
        renderAgeTooltip(
          overlay,
          resolvedName,
          hover,
          signedVolumeColor(primary ? 1 : -1, colorScale),
        ),
      anchorX,
      rowCenterY,
    );
  }

  private hide(): void {
    hideSharedTooltip(this.tooltipOwner);
  }
}

export function renderAgeTooltip(
  overlay: HTMLDivElement,
  tokenName: string,
  hover: SupplyHover,
  color: string,
): void {
  overlay.replaceChildren();

  const title = document.createElement("div");
  title.className = "cpv-ov-label";
  title.textContent = `${tokenName}@${formatProbability(hover.price)}`;
  title.style.color = color;
  overlay.appendChild(title);
  overlay.appendChild(tooltipRow("Shares", formatShares(hover.shares)));
  overlay.appendChild(
    tooltipRow("Effective", formatProbability(hover.effectivePrice)),
  );
}

export function renderResolutionTooltip(
  overlay: HTMLDivElement,
  side: "primary" | "opposite",
  outcome: string,
  marketEndMs: number | null,
  colorScale: SignedVolumeColorScale,
): void {
  overlay.replaceChildren();

  const title = document.createElement("div");
  title.className = "cpv-ov-label";
  title.textContent = "Resolved";
  title.style.color = signedVolumeColor(
    side === "primary" ? 1 : -1,
    colorScale,
  );
  overlay.appendChild(title);

  overlay.appendChild(tooltipRow("Winner", outcome || "(unknown)"));

  if (marketEndMs !== null && Number.isFinite(marketEndMs))
    overlay.appendChild(
      tooltipRow("Market end", formatResolutionTime(marketEndMs)),
    );
}

function supplyHoverAtPrice(
  book: TokenBook,
  limitPrice: number,
): SupplyHover | null {
  const price = clamp01(limitPrice);
  let shares = 0;
  let cost = 0;

  for (const order of book.yesToUsd.asSellOrders()) {
    if (!Number.isFinite(order.take) || order.take <= 0) continue;
    const orderPrice = priceToNumber(order.price);
    if (orderPrice > price) break;
    shares += order.take;
    cost += orderPrice * order.take;
  }

  if (!(shares > 0)) return null;
  return { price, shares, effectivePrice: clamp01(cost / shares) };
}

const RESOLUTION_TIME_FORMATTER = new Intl.DateTimeFormat(undefined, {
  month: "short",
  day: "numeric",
  hour: "2-digit",
  minute: "2-digit",
});

function formatResolutionTime(timestampMs: number): string {
  return RESOLUTION_TIME_FORMATTER.format(new Date(timestampMs));
}

function tooltipRow(name: string, value: string): HTMLDivElement {
  const row = document.createElement("div");
  row.className = "cpv-ov-row";

  const key = document.createElement("span");
  key.textContent = name;

  const amount = document.createElement("b");
  amount.textContent = value;

  row.append(key, amount);
  return row;
}

function formatProbability(value: number): string {
  return value.toFixed(3);
}

function formatShares(value: number): string {
  if (!(value > 0)) return "0";
  return new Intl.NumberFormat(undefined, {
    notation: "compact",
    maximumFractionDigits: 2,
  }).format(value);
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}
