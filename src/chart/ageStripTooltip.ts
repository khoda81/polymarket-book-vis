import { AGE_ROW_BAND_PX, getAgeStripTuning } from "@/lib/ageStripTuning";
import {
  PRESSURE_MIN_VISIBLE_ALPHA,
  stalenessAlpha,
} from "@/lib/pressureField";
import type { PressureFrontierMemory } from "@/lib/pressureFrontierMemory";
import {
  signedVolumeColor,
  type SignedVolumeColorScale,
} from "@/lib/signedVolume";
import type { ViewMode } from "@/lib/chartState";
import {
  hideSharedTooltip,
  releaseSharedTooltip,
  showSharedTooltip,
} from "@/lib/sharedTooltip";
import {
  ageStripRowAtY,
  ageStripRowCenterY,
  type AgeStripGeometry,
} from "./ageStripLayout";
import {
  agePressurePerspective,
  agePressureSideAtY,
  pressurePriceAtDisplayX,
  pressureVolumeAtY,
  tokenPriceAtDisplayX,
} from "./ageStripPressureProjection";

export interface AgeStripTooltipHost {
  readonly canvas: HTMLCanvasElement;
  readonly getViewMode: () => ViewMode;
  readonly getPressureMemory: (
    tokenId: string,
  ) => PressureFrontierMemory | undefined;
  /** Must resolve the label for the actual token id passed in. */
  readonly getTokenName: (tokenId: string) => string | undefined;
  readonly getPressureColorScale: (tokenId: string) => SignedVolumeColorScale;
}

interface HoverPointer {
  readonly sx: number;
  readonly sy: number;
  readonly canvasLeft: number;
  readonly canvasTop: number;
}

interface PressureHover {
  readonly shares: number;
  readonly validThroughMs: number;
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

    const centerCss = ageStripRowCenterY(geometry, row);
    const side = agePressureSideAtY(sy, centerCss);
    const perspective = agePressurePerspective(side);
    const tokenId =
      side === "primary" ? row.tokenId : (row.oppositeTokenId ?? null);
    if (!tokenId) {
      this.hide();
      return;
    }

    const displayPrice = clamp01((sx - vp.l) / vp.width);
    const tokenPrice = tokenPriceAtDisplayX(displayPrice, perspective);
    const pressurePrice = pressurePriceAtDisplayX(displayPrice, perspective);
    const tokenName = this.host.getTokenName(tokenId) ?? "(unknown)";
    const color = signedVolumeColor(
      perspective.colorSign,
      this.host.getPressureColorScale(row.tokenId),
    );

    const rowHeightCss = rowHeight(geometry, row);
    const volume = pressureVolumeAtY(
      sy,
      centerCss,
      rowHeightCss,
      getAgeStripTuning().volumePerCssPixel,
    );

    let hover: PressureHover | null = null;
    if (volume !== null) {
      const memory = this.host.getPressureMemory(tokenId);
      const band = memory
        ?.bandsAtPrice(pressurePrice)
        .find(
          (candidate) =>
            candidate.loVolume <= volume && volume < candidate.hiVolume,
        );

      if (band) {
        const nowMs = Date.now();
        const alpha = stalenessAlpha(
          band.validThroughMs,
          nowMs,
          getAgeStripTuning().ghostHalfLifeMs,
        );
        if (alpha > PRESSURE_MIN_VISIBLE_ALPHA)
          hover = {
            shares: volume,
            validThroughMs: band.validThroughMs,
          };
      }
    }

    const signature = [
      tokenId,
      formatProbability(tokenPrice),
      hover ? formatShares(hover.shares) : "",
      hover ? formatAge(Date.now() - hover.validThroughMs) : "",
    ].join("|");

    showSharedTooltip(
      this.tooltipOwner,
      signature,
      (overlay) =>
        renderAgeTooltip(
          overlay,
          tokenName,
          tokenPrice,
          color,
          hover,
          Date.now(),
        ),
      pointer.canvasLeft + sx,
      pointer.canvasTop + centerCss,
    );
  }

  private hide(): void {
    hideSharedTooltip(this.tooltipOwner);
  }
}

export function renderAgeTooltip(
  overlay: HTMLDivElement,
  tokenName: string,
  tokenPrice: number,
  color: string,
  hover: PressureHover | null,
  nowMs: number,
): void {
  overlay.replaceChildren();

  const title = document.createElement("div");
  title.className = "cpv-ov-label";
  title.textContent = `${tokenName}@${formatProbability(tokenPrice)}`;
  title.style.color = color;
  overlay.appendChild(title);

  if (!hover) return;

  overlay.appendChild(tooltipRow("Shares", formatShares(hover.shares)));
  overlay.appendChild(
    tooltipRow("Age", formatAge(nowMs - hover.validThroughMs)),
  );
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

function formatShares(value: number): string {
  if (!(value > 0)) return "0";
  return new Intl.NumberFormat(undefined, {
    notation: "compact",
    maximumFractionDigits: 2,
  }).format(value);
}

function formatAge(ageMs: number): string {
  const ms = Math.max(0, ageMs);
  if (ms < 1_000) return "now";
  if (ms < 60_000) return `${formatCompact(ms / 1_000)}s`;
  if (ms < 3_600_000) return `${formatCompact(ms / 60_000)}m`;
  if (ms < 86_400_000) return `${formatCompact(ms / 3_600_000)}h`;
  return `${formatCompact(ms / 86_400_000)}d`;
}

function formatCompact(value: number): string {
  const rounded = Math.round(value * 10) / 10;
  return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1);
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}
