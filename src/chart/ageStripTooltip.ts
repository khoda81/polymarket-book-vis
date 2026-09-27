import { AGE_ROW_BAND_PX, getAgeStripTuning } from "@/lib/ageStripTuning";
import { relativeTimeDisplay } from "@/lib/math";
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
  agePressureSourceSideAtY,
  pressurePriceAtDisplayX,
  pressureVolumeAtY,
  semanticPriceAtDisplayX,
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
    const sourceSide = agePressureSourceSideAtY(sy, centerCss);
    const perspective = agePressurePerspective(sourceSide);

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

    const nowMs = Date.now();
    let hover: PressureHover | null = null;
    if (volume !== null) {
      const memory = this.host.getPressureMemory(sourceTokenId);
      const band = memory?.bandAtPoint(pressurePrice, volume);

      if (band) {
        const alpha = stalenessAlpha(
          band.validThroughMs,
          nowMs,
          getAgeStripTuning().ghostHalfLifeMs,
        );
        if (alpha > PRESSURE_MIN_VISIBLE_ALPHA)
          hover = {
            // This band is a slice of the cumulative rectangle that existed at
            // this timestamp. Its upper edge is that rectangle's volume.
            shares: band.hiVolume,
            validThroughMs: band.validThroughMs,
          };
      }
    }

    const displayedShares = hover?.shares ?? volume;
    const ageDisplay = hover
      ? relativeTimeDisplay(
          Math.max(0, nowMs - hover.validThroughMs) / 1_000,
          "elapsed",
        )
      : null;
    const ageText = ageDisplay?.text ?? (displayedShares === null ? null : "∞");
    const signature = [
      semanticTokenId,
      formatProbability(semanticPrice),
      displayedShares === null ? "" : formatShares(displayedShares),
      ageText ?? "",
    ].join("|");

    showSharedTooltip(
      this.tooltipOwner,
      signature,
      (overlay) =>
        renderAgeTooltip(
          overlay,
          tokenName,
          semanticPrice,
          color,
          displayedShares,
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
  tokenName: string,
  tokenPrice: number,
  color: string,
  shares: number | null,
  ageText: string | null,
): void {
  overlay.replaceChildren();

  const title = document.createElement("div");
  title.className = "cpv-ov-label";
  title.textContent = `${tokenName}@${formatProbability(tokenPrice)}`;
  title.style.color = color;
  overlay.appendChild(title);

  if (shares === null) return;

  overlay.appendChild(tooltipRow("Shares", formatShares(shares)));
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
