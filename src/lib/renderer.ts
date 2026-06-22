import { fmtVol, powerOf10Ticks } from "./math";
import {
  Domain,
  Transform,
  Viewport,
  applyX,
  applyY,
  fromDomainViewport,
  invert,
} from "./transform";

// --- Theme ----------------------------------------------------------------

export interface ChartTheme {
  bg: string;
  grid: string;
  axis: string;
  text: string;
}

// --- Box pen ---------------------------------------------------------------

export type StackDirection = "up" | "down";
export type StackAnchor = "left" | "right";

export interface BoxPenOrientation {
  /** Direction positive pen-y rows move on screen. */
  readonly direction: StackDirection;
  /** Screen edge where pen-x = 0 starts. */
  readonly anchor: StackAnchor;
}

export type BoxFill =
  | { readonly kind: "none" }
  | { readonly kind: "solid-dim"; readonly alpha: number };

export interface BoxStyle {
  readonly stroke: string;
  readonly fill: BoxFill;
}

interface BoxSegment {
  readonly width: number;
  readonly style: BoxStyle;
}

/**
 * Immediate-mode renderer for one stack of boxes.
 *
 * The pen only knows abstract widths/heights. Callers translate domain concepts
 * (book side, price, asset amount, volume, etc.) before driving it.
 */
export class BoxPen {
  private rowBaseline = 0;
  private previousRowWidth = 0;
  private currentWidth = 0;
  private currentStyle: BoxStyle;
  private rowSegments: BoxSegment[] = [];

  constructor(
    readonly frame: Frame,
    initialStyle: BoxStyle,
    readonly boxTransform: Transform,
  ) {
    this.currentStyle = initialStyle;
  }

  /** Grow the current box horizontally. Drawing happens on `commitRow`. */
  extendBox(deltaWidth: number) {
    this.currentWidth += deltaWidth;
  }

  /** Finish the current box segment, then start a new segment with `style`. */
  newBox(style: BoxStyle) {
    this.closeCurrentSegment();
    this.currentStyle = style;
  }

  /** Draw the pending row with `height`, then move to the next row. */
  commitRow(height: number) {
    this.closeCurrentSegment();

    const y0 = this.rowBaseline;
    const y1 = y0 + height;
    let cursor = 0;

    for (const [i, segment] of this.rowSegments.entries()) {
      this.fillBox(cursor, cursor + segment.width, y0, y1, segment.style);
      if (i > 0) this.strokeLine(segment.style.stroke, cursor, y0, cursor, y1);
      cursor += segment.width;
    }

    if (this.rowSegments.length) {
      const outer = this.rowSegments[this.rowSegments.length - 1]!;
      this.strokeLine(
        outer.style.stroke,
        this.previousRowWidth,
        y0,
        cursor,
        y0,
      );
      this.strokeLine(outer.style.stroke, cursor, y0, cursor, y1);
    }

    this.rowBaseline = y1;
    this.previousRowWidth = cursor;
    this.rowSegments = [];
  }

  dispose() {}

  private closeCurrentSegment() {
    if (this.currentWidth === 0) return;
    this.rowSegments.push({
      width: this.currentWidth,
      style: this.currentStyle,
    });
    this.currentWidth = 0;
  }

  private fillBox(
    x0: number,
    x1: number,
    y0: number,
    y1: number,
    style: BoxStyle,
  ) {
    if (style.fill.kind === "none") return;

    const { sx: sx0, sy: sy0 } = this.toScreen(x0, y0);
    const { sx: sx1, sy: sy1 } = this.toScreen(x1, y1);

    this.frame.ctx.save();
    this.frame.ctx.globalAlpha *= style.fill.alpha;
    this.frame.ctx.fillStyle = style.stroke;
    this.frame.ctx.fillRect(
      Math.min(sx0, sx1),
      Math.min(sy0, sy1),
      Math.abs(sx1 - sx0),
      Math.abs(sy1 - sy0),
    );
    this.frame.ctx.restore();
  }

  private toScreen(x: number, y: number): { sx: number; sy: number } {
    const bx = applyX(this.boxTransform, x, y);
    const by = applyY(this.boxTransform, x, y);
    return this.frame.toScreen(bx, by);
  }

  private strokeLine(
    color: string,
    x0: number,
    y0: number,
    x1: number,
    y1: number,
  ) {
    this.frame.ctx.strokeStyle = color;
    this.frame.ctx.lineWidth = 2;
    this.frame.ctx.lineJoin = "round";
    this.frame.ctx.lineCap = "round";
    this.frame.ctx.beginPath();

    const p0 = this.toScreen(x0, y0);
    this.frame.ctx.moveTo(p0.sx, p0.sy);
    const p1 = this.toScreen(x1, y1);
    this.frame.ctx.lineTo(p1.sx, p1.sy);
    this.frame.ctx.stroke();
  }
}

// --- Plotter: canvas + events only ---------------------------------------

export class OrderBookPlotter {
  readonly ctx: CanvasRenderingContext2D;
  readonly padding = { l: 60, r: 16, t: 24, b: 24 };

  public onZoom?: (delta: number) => void;
  public onPointer?: (p: { sx: number; sy: number } | null) => void;

  constructor(readonly canvas: HTMLCanvasElement) {
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("2D canvas context is not available");
    this.ctx = ctx;

    this.canvas.addEventListener("wheel", this.handleWheel, { passive: false });
    this.canvas.addEventListener("mousemove", this.handleMouseMove);
    this.canvas.addEventListener("mouseleave", this.handleMouseLeave);
  }

  destroy() {
    this.canvas.removeEventListener("wheel", this.handleWheel);
    this.canvas.removeEventListener("mousemove", this.handleMouseMove);
    this.canvas.removeEventListener("mouseleave", this.handleMouseLeave);
    this.onZoom = undefined;
    this.onPointer = undefined;
  }

  /**
   * Sync the canvas backing store to its CSS size (× DPR). Call from the
   * ResizeObserver — not every frame — so per-frame work is independent of
   * layout.
   */
  resize() {
    const dpr = window.devicePixelRatio || 1;
    const targetW = Math.floor(this.canvas.clientWidth * dpr);
    const targetH = Math.floor(this.canvas.clientHeight * dpr);
    if (this.canvas.width !== targetW || this.canvas.height !== targetH) {
      this.canvas.width = targetW;
      this.canvas.height = targetH;
    }
  }

  /**
   * Begin a frame. The returned `Frame` is the only thing you draw with.
   * The plotter owns canvas/ctx/padding; the frame is a dumb immutable
   * wrapper over {domain, transform, theme}.
   */
  beginFrame(theme: ChartTheme, domain: Domain): Frame {
    const dpr = window.devicePixelRatio || 1;
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    const { clientWidth: width, clientHeight: height } = this.canvas;
    this.ctx.clearRect(0, 0, width, height);
    this.ctx.fillStyle = theme.bg;
    this.ctx.fillRect(0, 0, width, height);

    const viewport: Viewport = {
      l: this.padding.l,
      t: this.padding.t,
      width: width - this.padding.l - this.padding.r,
      height: height - this.padding.t - this.padding.b,
    };
    const transform = fromDomainViewport(domain, viewport);
    return new Frame(this, domain, transform, theme);
  }

  // --- Event handlers ---

  private handleWheel = (e: WheelEvent) => {
    if (!this.onZoom) return;
    e.preventDefault();

    let delta = e.deltaY * 0.002;
    if (e.deltaMode === WheelEvent.DOM_DELTA_LINE) {
      const lh = parseFloat(getComputedStyle(this.canvas).lineHeight) || 16;
      delta *= window.devicePixelRatio * lh;
    } else if (e.deltaMode === WheelEvent.DOM_DELTA_PAGE) {
      delta *= this.canvas.clientHeight;
    }
    this.onZoom(delta);
  };

  private handleMouseMove = (e: MouseEvent) => {
    if (!this.onPointer) return;
    const rect = this.canvas.getBoundingClientRect();
    this.onPointer({ sx: e.clientX - rect.left, sy: e.clientY - rect.top });
  };

  private handleMouseLeave = () => this.onPointer?.(null);
}

// --- Frame: per-frame immediate-mode drawing context ----------------------

/**
 * Dumb immutable wrapper over the chart's mapping state. Holds exactly the
 * degrees of freedom the renderer needs: the data range (`domain`), the
 * data→screen `transform`, and the `theme`. Everything else (viewport,
 * screen→data) is derived on demand, so there is nothing to desync.
 *
 * Canvas/ctx/padding live on the `plotter`; the frame borrows them for drawing.
 */
export class Frame {
  constructor(
    readonly plotter: OrderBookPlotter,
    readonly domain: Domain,
    readonly transform: Transform,
    readonly theme: ChartTheme,
  ) {}

  /** Canvas 2D context, borrowed from the plotter. */
  get ctx() {
    return this.plotter.ctx;
  }
  /** Canvas element, borrowed from the plotter. */
  get canvas() {
    return this.plotter.canvas;
  }
  /** Chart padding, borrowed from the plotter. */
  get padding() {
    return this.plotter.padding;
  }

  /** Screen rect of the chart area, derived from `transform` + `domain`. */
  get viewport(): Viewport {
    const l = applyX(this.transform, this.domain.xRange.min, 0);
    const r = applyX(this.transform, this.domain.xRange.max, 0);
    const t = applyY(this.transform, 0, this.domain.yRange.max);
    const b = applyY(this.transform, 0, this.domain.yRange.min);
    return { l, t, width: r - l, height: b - t };
  }

  /** Map a data point to screen coordinates. */
  toScreenX = (x: number, y: number) => applyX(this.transform, x, y);
  toScreenY = (x: number, y: number) => applyY(this.transform, x, y);
  toScreen = (x: number, y: number) => ({
    sx: this.toScreenX(x, y),
    sy: this.toScreenY(x, y),
  });

  /** Map a screen point to data coordinates by inverting `transform` on demand. */
  toDataX = (sx: number, sy: number) => applyX(invert(this.transform), sx, sy);
  toDataY = (sx: number, sy: number) => applyY(invert(this.transform), sx, sy);
  toData = ({ sx, sy }: { sx: number; sy: number }) => {
    const inv = invert(this.transform);
    return { x: applyX(inv, sx, sy), y: applyY(inv, sx, sy) };
  };

  // --- Axes ---------------------------------------------------------------

  drawAxes() {
    const { ctx, viewport: vp, theme, domain } = this;
    const yMax = domain.yRange.max;

    ctx.strokeStyle = theme.axis;
    ctx.lineWidth = 1;
    ctx.strokeRect(vp.l, vp.t, vp.width, vp.height);

    const yFracs = powerOf10Ticks(yMax);
    ctx.font = "11px sans-serif";
    ctx.textBaseline = "middle";

    for (const frac of yFracs) {
      // TODO: Instead of assuming symmetry we should probably go with evenly spaced ticks
      for (const sign of [1, -1]) {
        const yVal = sign * frac * yMax;
        const screenY = this.toScreenY(0, yVal);

        ctx.strokeStyle = theme.grid;
        ctx.beginPath();
        ctx.moveTo(vp.l, screenY);
        ctx.lineTo(vp.l + vp.width, screenY);
        ctx.stroke();

        ctx.strokeStyle = theme.axis;
        ctx.beginPath();
        ctx.moveTo(vp.l - 5, screenY);
        ctx.lineTo(vp.l, screenY);
        ctx.moveTo(vp.l + vp.width, screenY);
        ctx.lineTo(vp.l + vp.width + 5, screenY);
        ctx.stroke();

        ctx.fillStyle = theme.text;
        ctx.textAlign = "right";
        ctx.fillText(
          (sign > 0 ? "" : "-") + fmtVol(frac * yMax),
          vp.l - 8,
          screenY,
        );
      }
    }

    ctx.fillStyle = theme.text;
    ctx.textAlign = "center";
    ctx.textBaseline = "top";
    // X-axis anchors at domain.xRange.min / domain.xRange.max
    const x0 = this.toScreenX(domain.xRange.min, 0);
    const x1 = this.toScreenX(domain.xRange.max, 0);
    ctx.fillText(String(domain.xRange.min), x0, vp.t + vp.height + 8);
    ctx.fillText(String(domain.xRange.max), x1, vp.t + vp.height + 8);

    // Clamp all subsequent drawing to the chart rect.
    this.ctx.beginPath();
    this.ctx.rect(
      this.viewport.l,
      this.viewport.t,
      this.viewport.width,
      this.viewport.height,
    );
    this.ctx.clip();
  }

  // --- Box stacks ---------------------------------------------------------

  boxPen(orientation: BoxPenOrientation, initialStyle: BoxStyle): BoxPen {
    const boxTransform = {
      a: orientation.anchor === "left" ? 1 : -1,
      b: 0,
      c: 0,
      d: orientation.direction === "up" ? 1 : -1,
      e: 0,
      f: 0,
    };

    return new BoxPen(this, initialStyle, boxTransform);
  }

  // --- Pointer ------------------------------------------------------------

  /**
   * Draw crosshairs + tooltip for a pointer given in *data* coordinates.
   * The component converts its stored screen-space pointer to data using the
   * frame's `toData` before calling this, so there is never a desync.
   */
  drawPointer(
    data: { x: number; y: number },
    screen: { sx: number; sy: number },
  ) {
    const { ctx, viewport: vp, theme, canvas, padding } = this;
    const { clientWidth: width, clientHeight: height } = canvas;

    ctx.strokeStyle = theme.axis;
    ctx.lineWidth = 1;
    ctx.setLineDash([4, 4]);
    ctx.beginPath();
    ctx.moveTo(screen.sx, vp.t);
    ctx.lineTo(screen.sx, vp.t + vp.height);
    ctx.stroke();
    ctx.setLineDash([]);

    const boxW = 110;
    const boxH = 40;
    const offset = 12;
    let boxX = screen.sx + offset;
    let boxY = screen.sy + offset;
    if (boxX + boxW > width - padding.r) boxX = screen.sx - boxW - offset;
    if (boxY + boxH > height - padding.b) boxY = screen.sy - boxH - offset;

    ctx.fillStyle = theme.bg;
    ctx.fillRect(boxX, boxY, boxW, boxH);
    ctx.strokeStyle = theme.axis;
    ctx.strokeRect(boxX, boxY, boxW, boxH);

    ctx.fillStyle = theme.text;
    ctx.font = "12px sans-serif";
    ctx.textAlign = "left";
    ctx.textBaseline = "top";
    ctx.fillText(`Price: ${data.x.toFixed(3)}`, boxX + 8, boxY + 8);
    ctx.fillText(`Vol:   ${fmtVol(Math.abs(data.y))}`, boxX + 8, boxY + 22);

    ctx.textAlign = "center";
    ctx.fillText(data.x.toFixed(2), screen.sx, vp.t + vp.height + 8);
  }
}
