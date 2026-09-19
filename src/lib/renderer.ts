import { axisTicks, fmtVol } from "./math";
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

export interface DataAreaStyle {
  readonly fill: string;
  readonly fillAlpha: number;
  readonly stroke?: string;
  readonly lineWidth?: number;
}

export interface ColoredStepSegment {
  readonly lo: number;
  readonly hi: number;
  readonly y: number;
  readonly color: string;
}

export interface AxisOptions {
  readonly yTicks?: readonly number[];
  readonly formatY?: (value: number) => string;
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

  public onZoom?: (
    delta: number,
    verticalAnchor: number,
  ) => boolean;
  public onPan?: (verticalDelta: number) => void;
  public onResetZoom?: () => void;
  public onPointer?: (p: { sx: number; sy: number } | null) => void;
  private dragging = false;
  private lastDragY = 0;
  private cssWidth = 0;
  private cssHeight = 0;
  private backingDpr = 0;

  constructor(readonly canvas: HTMLCanvasElement) {
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("2D canvas context is not available");
    this.ctx = ctx;

    // Establish the initial cached CSS size once. Subsequent observer-driven
    // resizes use ResizeObserver's measured box and avoid another layout read.
    this.resize();

    this.canvas.addEventListener("wheel", this.handleWheel, { passive: false });
    this.canvas.addEventListener("pointerdown", this.handlePointerDown);
    this.canvas.addEventListener("pointermove", this.handlePointerMove);
    this.canvas.addEventListener("pointerup", this.handlePointerUp);
    this.canvas.addEventListener("pointercancel", this.handlePointerUp);
    this.canvas.addEventListener("mouseleave", this.handleMouseLeave);
    this.canvas.addEventListener("dblclick", this.handleDoubleClick);
  }

  destroy() {
    this.canvas.removeEventListener("wheel", this.handleWheel);
    this.canvas.removeEventListener("pointerdown", this.handlePointerDown);
    this.canvas.removeEventListener("pointermove", this.handlePointerMove);
    this.canvas.removeEventListener("pointerup", this.handlePointerUp);
    this.canvas.removeEventListener("pointercancel", this.handlePointerUp);
    this.canvas.removeEventListener("mouseleave", this.handleMouseLeave);
    this.canvas.removeEventListener("dblclick", this.handleDoubleClick);
    this.onZoom = undefined;
    this.onPan = undefined;
    this.onResetZoom = undefined;
    this.onPointer = undefined;
  }

  /** CSS-space width captured by the most recent resize. */
  get width(): number {
    return this.cssWidth;
  }

  /** CSS-space height captured by the most recent resize. */
  get height(): number {
    return this.cssHeight;
  }

  /** Explicit layout read for initial sizing / deliberate CSS-size changes. */
  resize() {
    this.resizeTo(this.canvas.clientWidth, this.canvas.clientHeight);
  }

  /**
   * Record a CSS-space size already measured by ResizeObserver.
   *
   * Deliberately do not resize the backing store here. Assigning canvas.width
   * or canvas.height clears the bitmap immediately, and ResizeObserver runs
   * outside our draw callback. Deferring the destructive resize to beginFrame
   * keeps resize + clear + redraw in one task, so the browser never gets a
   * chance to present an empty intermediate canvas.
   */
  resizeTo(width: number, height: number) {
    this.cssWidth = width;
    this.cssHeight = height;
  }

  /**
   * Begin a frame. The returned `Frame` is the only thing you draw with.
   * The plotter owns canvas/ctx/padding; the frame is a dumb immutable
   * wrapper over {domain, transform, theme}.
   */
  beginFrame(theme: ChartTheme, domain: Domain): Frame {
    const dpr = window.devicePixelRatio || 1;
    const targetW = Math.floor(this.cssWidth * dpr);
    const targetH = Math.floor(this.cssHeight * dpr);
    if (
      this.canvas.width !== targetW ||
      this.canvas.height !== targetH ||
      dpr !== this.backingDpr
    ) {
      // Backing-store resize is destructive. Doing it here makes it atomic
      // with the redraw from the browser's point of view.
      this.canvas.width = targetW;
      this.canvas.height = targetH;
      this.backingDpr = dpr;
    }

    // Undo the previous frame's ctx state (clip path, styles, lineDash, …).
    // restore() is a no-op after a backing-store resize because that reset also
    // resets the context state stack.
    this.ctx.restore();
    this.ctx.save();
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    // Crucially, do not touch clientWidth/clientHeight here. Those are layout
    // reads and can synchronously flush the entire dashboard after DOM writes.
    const width = this.cssWidth;
    const height = this.cssHeight;
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

    let delta = e.deltaY * 0.002;
    if (e.deltaMode === WheelEvent.DOM_DELTA_LINE) {
      const lh = parseFloat(getComputedStyle(this.canvas).lineHeight) || 16;
      delta *= window.devicePixelRatio * lh;
    } else if (e.deltaMode === WheelEvent.DOM_DELTA_PAGE) {
      delta *= this.cssHeight;
    }
    const rect = this.canvas.getBoundingClientRect();
    const chartHeight = this.cssHeight - this.padding.t - this.padding.b;
    const y = e.clientY - rect.top;
    const verticalAnchor = Math.max(
      0,
      Math.min(1, (this.cssHeight - this.padding.b - y) / chartHeight),
    );
    if (!this.onZoom(delta, verticalAnchor)) return;
    e.preventDefault();
  };

  private handlePointerDown = (e: PointerEvent) => {
    if (e.button !== 0 || !this.onPan) return;
    e.preventDefault();
    this.dragging = true;
    this.lastDragY = e.clientY;
    this.canvas.setPointerCapture(e.pointerId);
  };

  private handlePointerMove = (e: PointerEvent) => {
    const rect = this.canvas.getBoundingClientRect();
    this.onPointer?.({ sx: e.clientX - rect.left, sy: e.clientY - rect.top });

    if (!this.dragging || !this.onPan) return;
    const chartHeight = this.cssHeight - this.padding.t - this.padding.b;
    this.onPan((e.clientY - this.lastDragY) / chartHeight);
    this.lastDragY = e.clientY;
  };

  private handlePointerUp = (e: PointerEvent) => {
    if (!this.dragging) return;
    this.dragging = false;
    if (this.canvas.hasPointerCapture(e.pointerId))
      this.canvas.releasePointerCapture(e.pointerId);
  };

  private handleMouseLeave = () => {
    if (!this.dragging) this.onPointer?.(null);
  };

  private handleDoubleClick = () => this.onResetZoom?.();
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

  drawAxes(options: AxisOptions = {}) {
    const { ctx, viewport: vp, theme, domain } = this;
    const formatY = options.formatY ?? fmtVol;

    ctx.strokeStyle = theme.axis;
    ctx.lineWidth = 1;
    ctx.strokeRect(vp.l, vp.t, vp.width, vp.height);

    const yTicks = options.yTicks ?? axisTicks(domain.yRange, vp.height);
    ctx.font = "11px sans-serif";
    ctx.textBaseline = "middle";

    for (const yVal of yTicks) {
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
      ctx.fillText(formatY(yVal), vp.l - 8, screenY);
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

  /**
   * Draw a filled area under one data-space polyline. The fill closes at the
   * baseline, but the stroke intentionally follows only the sides and top.
   */
  drawDataArea(
    top: readonly { readonly x: number; readonly y: number }[],
    baseline: number,
    style: DataAreaStyle,
  ) {
    if (top.length === 0) return;
    const first = top[0];
    const last = top[top.length - 1];

    this.ctx.save();
    this.ctx.beginPath();
    this.ctx.moveTo(this.toScreenX(first.x, baseline), this.toScreenY(0, baseline));
    for (const point of top)
      this.ctx.lineTo(this.toScreenX(point.x, point.y), this.toScreenY(0, point.y));
    this.ctx.lineTo(this.toScreenX(last.x, baseline), this.toScreenY(0, baseline));
    this.ctx.closePath();
    this.ctx.fillStyle = style.fill;
    this.ctx.globalAlpha = style.fillAlpha;
    this.ctx.fill();
    this.ctx.restore();

    if (!style.stroke) return;
    this.ctx.strokeStyle = style.stroke;
    this.ctx.lineWidth = style.lineWidth ?? 2;
    this.ctx.lineJoin = "miter";
    this.ctx.beginPath();
    this.ctx.moveTo(this.toScreenX(first.x, baseline), this.toScreenY(0, baseline));
    for (const point of top)
      this.ctx.lineTo(this.toScreenX(point.x, point.y), this.toScreenY(0, point.y));
    this.ctx.lineTo(this.toScreenX(last.x, baseline), this.toScreenY(0, baseline));
    this.ctx.stroke();
  }

  /** Draw a color-varying step line without closing it against a baseline. */
  drawColoredStep(segments: readonly ColoredStepSegment[], lineWidth = 2) {
    let previous: ColoredStepSegment | undefined;
    for (const segment of segments) {
      this.ctx.strokeStyle = segment.color;
      this.ctx.lineWidth = lineWidth;
      this.ctx.lineJoin = "miter";
      this.ctx.beginPath();

      if (previous) {
        this.ctx.moveTo(
          this.toScreenX(segment.lo, previous.y),
          this.toScreenY(0, previous.y),
        );
        this.ctx.lineTo(
          this.toScreenX(segment.lo, segment.y),
          this.toScreenY(0, segment.y),
        );
      } else {
        this.ctx.moveTo(
          this.toScreenX(segment.lo, segment.y),
          this.toScreenY(0, segment.y),
        );
      }

      this.ctx.lineTo(
        this.toScreenX(segment.hi, segment.y),
        this.toScreenY(0, segment.y),
      );
      this.ctx.stroke();
      previous = segment;
    }
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
    yLabel: string = "Vol",
    formatY: (value: number) => string = (value) => fmtVol(Math.abs(value)),
  ) {
    const { ctx, viewport: vp, theme, padding } = this;
    const width = this.plotter.width;
    const height = this.plotter.height;

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
    ctx.fillText(`${yLabel}: ${formatY(data.y)}`, boxX + 8, boxY + 22);

    ctx.textAlign = "center";
    ctx.fillText(data.x.toFixed(2), screen.sx, vp.t + vp.height + 8);
  }
}
