import type { ObservationTime } from "@/domain/pressure/observationClock";
import { AGE_ROW_BAND_PX } from "@/chart/age/ageStripTuning";
import { relativeTimeOffsetDisplay } from "@/shared/math";
import type { WallClock, WallClockWatch } from "@/shared/wallClock";
import {
  PRESSURE_MIN_VISIBLE_ALPHA,
  pressureValidityAlpha,
  type PressureFieldBand,
  type PressureValidity,
  type PressureVolumeUpperBound,
} from "@/domain/pressure/pressureField";
import type { Price } from "@/domain/books/price";
import type { ViewMode } from "@/domain/markets/chartState";
import {
  hideSharedTooltip,
  showSharedTooltip,
  tooltipRow,
} from "@/rendering/sharedTooltip";
import { ageStripRowAtY, type AgeStripGeometry } from "./ageStripLayout";
import { pressureVolumeAtY } from "./ageStripPressureProjection";
import {
  barYDirection,
  sideAtY,
  trackPriceAtDisplayX,
  trackPriceTicks,
  type PressureBar,
} from "./pressureRows";

export interface AgeStripTooltipHost {
  readonly wallClock: WallClock;
  readonly getGeometry: () => AgeStripGeometry | null;
  readonly getOpacityTime: () => ObservationTime;
  readonly canvas: HTMLCanvasElement;
  readonly getViewMode: () => ViewMode;
  readonly getVolumePerCssPixel: () => number;
  readonly getGhostHalfLifeMs: () => number;
  readonly getPressureBand: (
    track: string,
    price: Price,
    volume: number,
  ) => PressureFieldBand | undefined;
}

interface HoverPointer {
  readonly sx: number;
  readonly sy: number;
  readonly canvasLeft: number;
  readonly canvasTop: number;
}

interface PressureHover {
  readonly volume: PressureVolumeUpperBound;
  readonly validity: PressureValidity;
}

export class AgeStripTooltip {
  private readonly tooltipOwner = Symbol("age-strip-tooltip");
  private readonly watch: WallClockWatch;
  private pointer: HoverPointer | null = null;

  constructor(private readonly host: AgeStripTooltipHost) {
    host.canvas.addEventListener("pointermove", this.handlePointerMove);
    host.canvas.addEventListener("pointerleave", this.handlePointerLeave);
    this.watch = host.wallClock.watch((nowMs) => this.render(nowMs));
  }

  refresh(): void {
    this.watch.refresh();
  }

  clear(): void {
    this.pointer = null;
    this.refresh();
  }

  destroy(): void {
    this.watch.destroy();
    this.host.canvas.removeEventListener("pointermove", this.handlePointerMove);
    this.host.canvas.removeEventListener(
      "pointerleave",
      this.handlePointerLeave,
    );
    hideSharedTooltip(this.tooltipOwner);
  }

  private readonly handlePointerMove = (event: PointerEvent) => {
    this.pointer = {
      sx: event.offsetX,
      sy: event.offsetY,
      canvasLeft: event.clientX - event.offsetX,
      canvasTop: event.clientY - event.offsetY,
    };
    this.refresh();
  };

  private readonly handlePointerLeave = () => {
    this.clear();
  };

  private render(nowMs: number): number | null {
    const pointer = this.pointer;
    if (!pointer) {
      this.hide();
      return null;
    }
    const { sx, sy } = pointer;
    if (this.host.getViewMode() !== "age") {
      this.hide();
      return null;
    }

    const geometry = this.host.getGeometry();
    if (!geometry || geometry.rows.length === 0) {
      this.hide();
      return null;
    }

    const { viewport: vp } = geometry;
    if (sx < vp.l || sx > vp.l + vp.width) {
      this.hide();
      return null;
    }

    const row = ageStripRowAtY(geometry, sy);
    if (!row) {
      this.hide();
      return null;
    }

    const { centerCss, topCss, bottomCss } = row;
    const side = sideAtY(sy, centerCss);
    const bars = row.row.bars.filter((bar) => bar.side === side);
    if (bars.length === 0) {
      this.hide();
      return null;
    }

    const displayX = (sx - vp.l) / vp.width;
    const sideHeightCss =
      side === "above" ? centerCss - topCss : bottomCss - centerCss;
    const volume = pressureVolumeAtY(
      sy,
      centerCss,
      sideHeightCss,
      this.host.getVolumePerCssPixel() * AGE_ROW_BAND_PX,
    );

    // Several bars may share a half; quote the first one with visible
    // pressure under the pointer, else the first bar on that side.
    let bar: PressureBar = bars[0]!;
    let hover: PressureHover | null = null;
    if (volume !== null)
      for (const candidate of bars) {
        hover = this.visibleBand(candidate, displayX, volume);
        if (hover) {
          bar = candidate;
          break;
        }
      }

    const quotedPrice = bar.quote.price(
      trackPriceAtDisplayX(displayX, bar.priceAxis),
    );
    const marketName = row.row.label;
    const tokenName = bar.quote.label;
    const color = bar.color;

    const displayedVolume: PressureVolumeUpperBound | null =
      hover?.volume ??
      (volume === null ? null : { kind: "finite", shares: volume });
    const ageDisplay =
      hover?.validity.kind === "through"
        ? relativeTimeOffsetDisplay(
            (nowMs - hover.validity.validThroughMs) / 1_000,
          )
        : null;
    const ageText =
      hover?.validity.kind === "persistent"
        ? "now"
        : (ageDisplay?.text ?? (displayedVolume === null ? null : "∞"));
    const signature = [
      bar.track,
      marketName,
      formatProbability(quotedPrice),
      displayedVolume === null ? "" : formatPressureVolume(displayedVolume),
      ageText ?? "",
    ].join("|");

    showSharedTooltip(
      this.tooltipOwner,
      signature,
      (overlay) =>
        renderAgeTooltip(
          overlay,
          marketName,
          tokenName,
          quotedPrice,
          color,
          displayedVolume,
          ageText,
        ),
      pointer.canvasLeft + sx,
      pointer.canvasTop + centerCss,
      barYDirection(bar) < 0 ? "below" : "above",
    );

    return ageDisplay?.nextChangeMs != null
      ? nowMs + Math.ceil(ageDisplay.nextChangeMs) + 1
      : null;
  }

  private visibleBand(
    bar: PressureBar,
    displayX: number,
    volume: number,
  ): PressureHover | null {
    const band = this.host.getPressureBand(
      bar.track,
      trackPriceTicks(trackPriceAtDisplayX(displayX, bar.priceAxis)),
      volume,
    );
    if (!band) return null;
    const alpha = pressureValidityAlpha(
      band.validity,
      this.host.getOpacityTime(),
      this.host.getGhostHalfLifeMs(),
    );
    // The hovered band supplies its own upper volume and validity. Either
    // dimension may be unbounded/persistent.
    return alpha > PRESSURE_MIN_VISIBLE_ALPHA
      ? { volume: band.hiVolume, validity: band.validity }
      : null;
  }

  private hide(): void {
    hideSharedTooltip(this.tooltipOwner);
  }
}

export function renderAgeTooltip(
  overlay: HTMLDivElement,
  marketName: string,
  tokenName: string,
  tokenPrice: number,
  color: string,
  volume: PressureVolumeUpperBound | null,
  ageText: string | null,
): void {
  overlay.replaceChildren();

  const heading = document.createElement("div");
  heading.className = "cpv-ov-heading";

  const market = document.createElement("span");
  market.className = "cpv-ov-market";
  market.textContent = marketName;

  const token = document.createElement("span");
  token.className = "cpv-ov-token-price";
  token.textContent = `${tokenName} @ ${formatProbability(tokenPrice)}`;
  token.style.color = color;

  heading.append(market, token);
  overlay.appendChild(heading);

  if (volume === null) return;

  overlay.appendChild(tooltipRow("Shares", formatPressureVolume(volume)));
  overlay.appendChild(tooltipRow("Age", ageText ?? "∞"));
}

function formatProbability(value: number): string {
  return value.toFixed(3);
}

function formatPressureVolume(value: PressureVolumeUpperBound): string {
  return value.kind === "unbounded" ? "∞" : formatShares(value.shares);
}

function formatShares(value: number): string {
  if (!(value > 0)) return "0";
  return new Intl.NumberFormat(undefined, {
    notation: "compact",
    maximumFractionDigits: 2,
  }).format(value);
}
