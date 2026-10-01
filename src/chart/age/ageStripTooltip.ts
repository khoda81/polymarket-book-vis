import type { ObservationTime } from "@/domain/pressure/observationClock";
import { AGE_ROW_BAND_PX } from "@/chart/age/ageStripTuning";
import { relativeTimeOffsetDisplay } from "@/shared/math";
import {
  PRESSURE_MIN_VISIBLE_ALPHA,
  pressureValidityAlpha,
  type PressureFieldBand,
  type PressureValidity,
  type PressureVolumeUpperBound,
} from "@/domain/pressure/pressureField";
import type { Price } from "@/domain/books/price";
import {
  signedVolumeColor,
  type SignedVolumeColorScale,
} from "@/rendering/colors/signedVolume";
import type { ViewMode } from "@/domain/markets/chartState";
import {
  hideSharedTooltip,
  releaseSharedTooltip,
  showSharedTooltip,
} from "@/rendering/sharedTooltip";
import {
  ageStripRowAtY,
  ageStripRowCenterY,
  type AgeStripGeometry,
} from "./ageStripLayout";
import type { AgeRowOrientation } from "./ageStripOrientation";
import {
  agePressurePerspective,
  agePressureSourceSideAtY,
  pressurePriceAtDisplayX,
  pressureVolumeAtY,
  semanticPriceAtDisplayX,
} from "./ageStripPressureProjection";

export interface AgeStripTooltipHost {
  readonly getOpacityTime: () => ObservationTime;
  readonly canvas: HTMLCanvasElement;
  readonly getViewMode: () => ViewMode;
  readonly getRowOrientation: () => AgeRowOrientation;
  readonly getVolumePerCssPixel: () => number;
  readonly getGhostHalfLifeMs: () => number;
  readonly getPressureBand: (
    tokenId: string,
    price: Price,
    volume: number,
  ) => PressureFieldBand | undefined;
  /** Must resolve labels for the actual token id passed in. */
  readonly getTokenName: (tokenId: string) => string | undefined;
  readonly getMarketName: (tokenId: string) => string | undefined;
  readonly getPressureColorScale: (tokenId: string) => SignedVolumeColorScale;
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
  private geometry: AgeStripGeometry | null = null;
  private pointer: HoverPointer | null = null;
  private refreshTimer: number | undefined;
  private refreshRaf: number | undefined;

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
    this.cancelRefresh();
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
    this.cancelRefresh();

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

    const centerCss = ageStripRowCenterY(geometry, row);
    const rowOrientation = this.host.getRowOrientation();
    const sourceSide = agePressureSourceSideAtY(sy, centerCss, rowOrientation);
    const perspective = agePressurePerspective(sourceSide, rowOrientation);

    const sourceTokenId =
      sourceSide === "primary" ? row.tokenId : (row.oppositeTokenId ?? null);
    const semanticTokenId =
      perspective.semanticSide === "primary"
        ? row.tokenId
        : (row.oppositeTokenId ?? null);
    if (!sourceTokenId || !semanticTokenId) {
      this.hide();
      return;
    }

    const displayPrice = clamp01((sx - vp.l) / vp.width);
    const semanticPrice = semanticPriceAtDisplayX(displayPrice, perspective);
    const pressurePrice = pressurePriceAtDisplayX(displayPrice, perspective);
    const tokenName = this.host.getTokenName(semanticTokenId) ?? "(unknown)";
    const marketName = this.host.getMarketName(semanticTokenId) ?? "(unknown)";
    const color = signedVolumeColor(
      perspective.colorSign,
      this.host.getPressureColorScale(row.tokenId),
    );

    const rowHeightCss = rowHeight(geometry, row);
    const volume = pressureVolumeAtY(
      sy,
      centerCss,
      rowHeightCss,
      this.host.getVolumePerCssPixel(),
    );

    const nowMs = Date.now();
    let hover: PressureHover | null = null;
    if (volume !== null) {
      const band = this.host.getPressureBand(
        sourceTokenId,
        pressurePrice,
        volume,
      );

      if (band) {
        const alpha = pressureValidityAlpha(
          band.validity,
          this.host.getOpacityTime(),
          this.host.getGhostHalfLifeMs(),
        );
        if (alpha > PRESSURE_MIN_VISIBLE_ALPHA)
          hover = {
            // The hovered band supplies its own upper volume and validity.
            // Either dimension may be unbounded/persistent.
            volume: band.hiVolume,
            validity: band.validity,
          };
      }
    }

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
      semanticTokenId,
      marketName,
      formatProbability(semanticPrice),
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
          semanticPrice,
          color,
          displayedVolume,
          ageText,
        ),
      pointer.canvasLeft + sx,
      pointer.canvasTop + centerCss,
      perspective.yDirection < 0 ? "below" : "above",
    );

    if (ageDisplay?.nextChangeMs != null)
      this.scheduleRefresh(ageDisplay.nextChangeMs);
  }

  private scheduleRefresh(delayMs: number): void {
    if (delayMs <= 34) {
      this.refreshRaf = requestAnimationFrame(() => {
        this.refreshRaf = undefined;
        if (this.pointer) this.render(this.pointer);
      });
      return;
    }

    this.refreshTimer = window.setTimeout(
      () => {
        this.refreshTimer = undefined;
        if (this.pointer) this.render(this.pointer);
      },
      Math.max(1, Math.ceil(delayMs) + 1),
    );
  }

  private cancelRefresh(): void {
    if (this.refreshTimer !== undefined) {
      clearTimeout(this.refreshTimer);
      this.refreshTimer = undefined;
    }
    if (this.refreshRaf !== undefined) {
      cancelAnimationFrame(this.refreshRaf);
      this.refreshRaf = undefined;
    }
  }

  private hide(): void {
    this.cancelRefresh();
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

function rowHeight(
  geometry: AgeStripGeometry,
  row: AgeStripGeometry["rows"][number],
): number {
  if (row.topY !== undefined && row.bottomY !== undefined)
    return row.bottomY - row.topY;
  return AGE_ROW_BAND_PX;
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

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}
