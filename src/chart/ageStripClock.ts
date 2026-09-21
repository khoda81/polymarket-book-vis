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

export class AgeStripClock {
  private readonly canvas: HTMLCanvasElement;
  private readonly intersectionObserver: IntersectionObserver;
  private geometry: AgeStripGeometry | null = null;
  private viewportVisible = true;
  private enabled = true;
  private timer: number | undefined;
  private raf: number | undefined;

  constructor(private readonly host: AgeStripClockHost) {
    this.canvas = document.createElement("canvas");
    this.canvas.className = "cpv-clock-canvas";
    this.canvas.setAttribute("aria-hidden", "true");
    host.canvasWrap.appendChild(this.canvas);

    this.intersectionObserver = new IntersectionObserver(
      ([entry]) => {
        const visible = entry?.isIntersecting ?? false;
        if (visible === this.viewportVisible) return;
        this.viewportVisible = visible;

        if (!visible) {
          this.cancelRefresh();
          return;
        }
        this.refresh();
      },
      { root: null, rootMargin: "160px 0px" },
    );
    this.intersectionObserver.observe(host.canvasWrap);
  }

  setGeometry(geometry: AgeStripGeometry | null): void {
    this.geometry = geometry;
    this.refresh();
  }

  setEnabled(enabled: boolean): void {
    if (enabled === this.enabled) return;
    this.enabled = enabled;
    this.canvas.style.display = enabled ? "block" : "none";
    if (enabled) this.refresh();
    else {
      this.cancelRefresh();
      this.clear();
    }
  }

  refresh(): void {
    this.cancelRefresh();

    const geometry = this.geometry;
    if (
      !this.enabled ||
      !geometry ||
      geometry.rows.length === 0 ||
      !this.viewportVisible ||
      this.host.getViewMode() !== "age"
    )
      return;

    const dpr = window.devicePixelRatio || 1;
    const width = Math.max(1, Math.round(geometry.canvasWidth * dpr));
    const height = Math.max(1, Math.round(geometry.canvasHeight * dpr));
    if (this.canvas.width !== width) this.canvas.width = width;
    if (this.canvas.height !== height) this.canvas.height = height;

    const ctx = this.canvas.getContext("2d");
    if (!ctx) return;

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
    if (Number.isFinite(nextChangeMs)) this.scheduleRefresh(nextChangeMs);
  }

  clear(): void {
    const ctx = this.canvas.getContext?.("2d");
    if (!ctx) return;
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
  }

  reset(): void {
    this.cancelRefresh();
    this.geometry = null;
    this.clear();
  }

  destroy(): void {
    this.cancelRefresh();
    this.intersectionObserver.disconnect();
    this.canvas.remove();
  }

  private scheduleRefresh(delayMs: number): void {
    // Millisecond labels are meaningful, but a 1ms timeout is not.
    if (delayMs <= 34) {
      this.raf = requestAnimationFrame(() => {
        this.raf = undefined;
        this.refresh();
      });
      return;
    }

    this.timer = window.setTimeout(
      () => {
        this.timer = undefined;
        this.refresh();
      },
      Math.max(1, Math.ceil(delayMs) + 1),
    );
  }

  private cancelRefresh(): void {
    if (this.timer !== undefined) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    if (this.raf !== undefined) {
      cancelAnimationFrame(this.raf);
      this.raf = undefined;
    }
  }
}
