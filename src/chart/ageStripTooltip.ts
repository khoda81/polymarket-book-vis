import { bookHoverAtPrice, type BookHoverSnapshot } from "@/lib/bookHover";
import type { TokenBook } from "@/lib/orderBook";
import {
  signedVolumeColor,
  type SignedVolumeColorScale,
} from "@/lib/signedVolume";
import type { AgeStripGeometry } from "./ageStripLayout";
import type { ViewMode } from "@/lib/chartState";

export interface AgeStripTooltipHost {
  readonly canvas: HTMLCanvasElement;
  readonly getViewMode: () => ViewMode;
  readonly getBook: (tokenId: string) => TokenBook<string> | undefined;
  readonly getTokenName: (tokenId: string) => string | undefined;
  readonly getOppositeTokenName: (
    tokenId: string,
  ) => string | undefined;
  readonly getPressureColorScale: (
    tokenId: string,
  ) => SignedVolumeColorScale;
}

interface HoverPointer {
  readonly sx: number;
  readonly sy: number;
  /** Viewport-space origin of the canvas, derived from the pointer event. */
  readonly canvasLeft: number;
  readonly canvasTop: number;
}

export class AgeStripTooltip {
  private readonly overlay: HTMLDivElement;
  private geometry: AgeStripGeometry | null = null;
  private pointer: HoverPointer | null = null;
  private signature = "";

  constructor(private readonly host: AgeStripTooltipHost) {
    // Portal outside the clipped canvas wrapper so the tooltip can overflow.
    this.overlay = document.createElement("div");
    this.overlay.className = "cpv-overlay";
    this.overlay.setAttribute("role", "tooltip");
    document.body.appendChild(this.overlay);

    host.canvas.addEventListener(
      "pointermove",
      this.handlePointerMove,
    );
    host.canvas.addEventListener(
      "pointerleave",
      this.handlePointerLeave,
    );
  }

  setGeometry(geometry: AgeStripGeometry | null): void {
    this.geometry = geometry;
    if (this.pointer) this.render(this.pointer);
    else if (!geometry) this.hide();
  }

  clear(): void {
    this.geometry = null;
    this.pointer = null;
    this.signature = "";
    this.hide();
  }

  destroy(): void {
    this.host.canvas.removeEventListener(
      "pointermove",
      this.handlePointerMove,
    );
    this.host.canvas.removeEventListener(
      "pointerleave",
      this.handlePointerLeave,
    );
    this.overlay.remove();
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

    const rowIndex = Math.floor(
      ((sy - vp.t) / vp.height) * geometry.rows.length,
    );
    const row = geometry.rows[rowIndex];
    if (!row) {
      this.hide();
      return;
    }

    const book = this.host.getBook(row.tokenId);
    if (!book) {
      this.hide();
      return;
    }

    // Age view is mirrored: opposite liquidity left, primary right.
    const displayPrice = (sx - vp.l) / vp.width;
    const hover = bookHoverAtPrice(book, 1 - displayPrice);
    if (hover.side === "spread") {
      this.hide();
      return;
    }

    const tokenName =
      hover.side === "bid"
        ? this.host.getTokenName(row.tokenId)
        : this.host.getOppositeTokenName(row.tokenId);
    const resolvedName = tokenName ?? "(unknown)";
    const signature = tooltipSignature(resolvedName, hover);

    if (signature !== this.signature) {
      renderAgeTooltip(
        this.overlay,
        resolvedName,
        hover,
        this.host.getPressureColorScale(row.tokenId),
      );
      this.signature = signature;
    }

    const anchorX = pointer.canvasLeft + sx;
    const rowCenterY =
      pointer.canvasTop +
      vp.t +
      ((rowIndex + 0.5) / geometry.rows.length) * vp.height;

    this.overlay.style.display = "block";
    this.overlay.style.left = `${anchorX}px`;
    this.overlay.style.top = `${rowCenterY}px`;
    this.overlay.style.transform =
      `${anchorX > window.innerWidth / 2
        ? "translateX(calc(-100% - 12px))"
        : "translateX(12px)"} ${rowCenterY > window.innerHeight / 2
          ? "translateY(calc(-100% - 12px))"
          : "translateY(12px)"}`;
  }

  private hide(): void {
    this.overlay.style.display = "none";
  }
}

export function tooltipSignature(
  tokenName: string,
  hover: BookHoverSnapshot,
): string {
  const isBid = hover.side === "bid";
  const tokenPrice = isBid ? hover.price : 1 - hover.price;
  const effectivePrice =
    hover.effectivePrice === null
      ? ""
      : formatProbability(
          isBid
            ? hover.effectivePrice
            : 1 - hover.effectivePrice,
        );

  return [
    tokenName,
    hover.side,
    formatProbability(tokenPrice),
    formatShares(hover.shares),
    effectivePrice,
  ].join("|");
}

export function renderAgeTooltip(
  overlay: HTMLDivElement,
  tokenName: string,
  hover: BookHoverSnapshot,
  colorScale: SignedVolumeColorScale,
): void {
  overlay.replaceChildren();

  const isBid = hover.side === "bid";
  const tokenPrice = isBid ? hover.price : 1 - hover.price;
  const effectivePrice =
    hover.effectivePrice === null
      ? null
      : isBid
        ? hover.effectivePrice
        : 1 - hover.effectivePrice;

  const title = document.createElement("div");
  title.className = "cpv-ov-label";
  title.textContent =
    `${tokenName}@${formatProbability(tokenPrice)}`;
  title.style.color = signedVolumeColor(
    isBid ? 1 : -1,
    colorScale,
  );
  overlay.appendChild(title);
  overlay.appendChild(
    tooltipRow("Shares", formatShares(hover.shares)),
  );

  if (effectivePrice !== null)
    overlay.appendChild(
      tooltipRow(
        "Effective",
        formatProbability(effectivePrice),
      ),
    );
}

function tooltipRow(
  name: string,
  value: string,
): HTMLDivElement {
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
