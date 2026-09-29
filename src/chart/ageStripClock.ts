import { relativeTimeDisplay } from "@/lib/math";
import type { ChartTheme } from "@/lib/renderer";
import type { ViewMode } from "@/lib/chartState";
import {
  AGE_LABEL_HORIZONTAL_INSET_PX,
  type AgeStripGeometry,
} from "./ageStripLayout";

export interface AgeStripTiming {
  readonly recordingSinceMs: number | null;
  readonly resolutionMs: number | null;
}

export interface AgeStripClockHost {
  readonly canvasWrap: HTMLElement;
  readonly getViewMode: () => ViewMode;
  readonly getTheme: () => ChartTheme;
  readonly getTiming: (tokenId: string) => AgeStripTiming | undefined;
}

/**
 * Pure annotation layer for age-view time labels.
 *
 * Scheduling belongs to the owning render loop. A refresh returns the wall-clock
 * delay until its currently rendered text can next change, allowing the caller
 * to fold clock deadlines into the same invalidation stream as pressure decay.
 */
export class AgeStripClock {
  private readonly canvas: HTMLCanvasElement;
  private geometry: AgeStripGeometry | null = null;
  private enabled = true;

  constructor(private readonly host: AgeStripClockHost) {
    this.canvas = document.createElement("canvas");
    this.canvas.className = "cpv-clock-canvas";
    this.canvas.setAttribute("aria-hidden", "true");
    host.canvasWrap.appendChild(this.canvas);
  }

  setGeometry(geometry: AgeStripGeometry | null): number | null {
    this.geometry = geometry;
    return this.refresh();
  }

  setEnabled(enabled: boolean): void {
    if (enabled === this.enabled) return;
    this.enabled = enabled;
    this.canvas.style.display = enabled ? "block" : "none";
    if (enabled) this.refresh();
    else this.clear();
  }

  refresh(): number | null {
    const geometry = this.geometry;
    if (
      !this.enabled ||
      !geometry ||
      geometry.rows.length === 0 ||
      this.host.getViewMode() !== "age"
    )
      return null;

    const dpr = window.devicePixelRatio || 1;
    const width = Math.max(1, Math.round(geometry.canvasWidth * dpr));
    const height = Math.max(1, Math.round(geometry.canvasHeight * dpr));
    if (this.canvas.width !== width) this.canvas.width = width;
    if (this.canvas.height !== height) this.canvas.height = height;

    const ctx = this.canvas.getContext("2d");
    if (!ctx) return null;

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, geometry.canvasWidth, geometry.canvasHeight);
    ctx.textBaseline = "middle";
    ctx.fillStyle = this.host.getTheme().text;

    const nowMs = Date.now();
    const { viewport: vp } = geometry;
    const rowCount = geometry.rows.length;
    const timeX = Math.max(4, vp.l - AGE_LABEL_HORIZONTAL_INSET_PX);
    let nextChangeMs = Infinity;

    for (const [rowIndex, row] of geometry.rows.entries()) {
      const timing = this.host.getTiming(row.tokenId);
      if (!timing) continue;

      const rowCenterY =
        row.centerY ?? vp.t + ((rowIndex + 0.5) / rowCount) * vp.height;

      ctx.font = "9px sans-serif";
      ctx.textAlign = "right";

      const since = timing.recordingSinceMs;
      if (since !== null && Number.isFinite(since)) {
        const display = relativeTimeDisplay(
          Math.max(0, nowMs - since) / 1000,
          "elapsed",
        );
        ctx.globalAlpha = 0.55;
        ctx.fillText(display.text, timeX, rowCenterY - 5);
        if (display.nextChangeMs !== null)
          nextChangeMs = Math.min(nextChangeMs, display.nextChangeMs);
      }

      const resolutionMs = timing.resolutionMs;
      if (resolutionMs !== null && Number.isFinite(resolutionMs)) {
        const display = relativeTimeDisplay(
          Math.max(0, resolutionMs - nowMs) / 1000,
          "remaining",
        );
        ctx.globalAlpha = 0.82;
        ctx.fillText(
          display.text === "due" ? "due" : `T−${display.text}`,
          timeX,
          rowCenterY + 5,
        );
        if (display.nextChangeMs !== null)
          nextChangeMs = Math.min(nextChangeMs, display.nextChangeMs);
      }
    }

    ctx.globalAlpha = 1;
    return Number.isFinite(nextChangeMs) ? nextChangeMs : null;
  }

  clear(): void {
    const ctx = this.canvas.getContext?.("2d");
    if (!ctx) return;
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
  }

  reset(): void {
    this.geometry = null;
    this.clear();
  }

  destroy(): void {
    this.canvas.remove();
  }
}
