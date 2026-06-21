import { fmtVol, powerOf10Ticks } from "./math";
import {
  Domain,
  Transform,
  Viewport,
  fromDomainViewport,
  invert,
  toDataX,
  toDataY,
  toScreenX,
  toScreenY,
} from "./transform";

// --- Theme ----------------------------------------------------------------

export interface ChartTheme {
  bg: string;
  grid: string;
  axis: string;
  text: string;
  /** Map a stable key to a color. */
  color: (key: number | string) => string;
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
  private disposed = false;

  constructor(
    private readonly ctx: CanvasRenderingContext2D,
    private readonly transform: Transform,
    initialStyle: BoxStyle,
  ) {
    this.currentStyle = initialStyle;
  }

  /** Grow the current box horizontally. Drawing happens on `commitRow`. */
  extendBox(deltaWidth: number) {
    this.assertOpen();
    if (!Number.isFinite(deltaWidth) || deltaWidth < 0)
      throw new Error(
        `Box width delta must be a finite non-negative number: ${deltaWidth}`,
      );
    this.currentWidth += deltaWidth;
  }

  /** Finish the current box segment, then start a new segment with `style`. */
  newBox(style: BoxStyle) {
    this.assertOpen();
    this.closeCurrentSegment();
    this.currentStyle = style;
  }

  /** Draw the pending row with `height`, then move to the next row. */
  commitRow(height: number) {
    this.assertOpen();
    if (!Number.isFinite(height) || height <= 0)
      throw new Error(
        `Box row height must be a finite positive number: ${height}`,
      );

    this.closeCurrentSegment();
    if (!this.rowSegments.length) {
      this.rowBaseline += height;
      this.previousRowWidth = 0;
      return;
    }

    const y0 = this.rowBaseline;
    const y1 = y0 + height;
    let cursor = 0;

    for (const [i, segment] of this.rowSegments.entries()) {
      this.fillBox(cursor, cursor + segment.width, y0, y1, segment.style);
      if (i > 0) this.strokeLine(segment.style.stroke, cursor, y0, cursor, y1);
      cursor += segment.width;
    }

    const outer = this.rowSegments[this.rowSegments.length - 1]!;
    this.strokeLine(outer.style.stroke, this.previousRowWidth, y0, cursor, y0);
    this.strokeLine(outer.style.stroke, cursor, y0, cursor, y1);

    this.rowBaseline = y1;
    this.previousRowWidth = cursor;
    this.rowSegments = [];
  }

  /** Mark this stack complete. Throws if a row has width but no committed height. */
  dispose() {
    this.assertOpen();
    if (this.currentWidth !== 0 || this.rowSegments.length)
      throw new Error("Cannot dispose a BoxPen with an uncommitted row");
    this.disposed = true;
  }

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

    const sx0 = toScreenX(this.transform, x0, y0);
    const sy0 = toScreenY(this.transform, x0, y0);
    const sx1 = toScreenX(this.transform, x1, y1);
    const sy1 = toScreenY(this.transform, x1, y1);

    this.ctx.save();
    this.ctx.globalAlpha *= style.fill.alpha;
    this.ctx.fillStyle = style.stroke;
    this.ctx.fillRect(
      Math.min(sx0, sx1),
      Math.min(sy0, sy1),
      Math.abs(sx1 - sx0),
      Math.abs(sy1 - sy0),
    );
    this.ctx.restore();
  }

  private strokeLine(
    color: string,
    x0: number,
    y0: number,
    x1: number,
    y1: number,
  ) {
    this.ctx.strokeStyle = color;
    this.ctx.lineWidth = 2;
    this.ctx.lineJoin = "round";
    this.ctx.lineCap = "round";
    this.ctx.beginPath();
    this.ctx.moveTo(
      toScreenX(this.transform, x0, y0),
      toScreenY(this.transform, x0, y0),
    );
    this.ctx.lineTo(
      toScreenX(this.transform, x1, y1),
      toScreenY(this.transform, x1, y1),
    );
    this.ctx.stroke();
  }

  private assertOpen() {
    if (this.disposed) throw new Error("Cannot use a disposed BoxPen");
  }
}

// --- Frame config ---------------------------------------------------------

export interface RenderFrameConfig {
  theme: ChartTheme;
  /** log10 of the absolute y bound. The frame's domain is `[-10^volScale, +10^volScale]`. */
  volScale: number;
}

// --- Plotter: canvas + events only ---------------------------------------

export class OrderBookPlotter {
  private readonly ctx: CanvasRenderingContext2D;
  // TODO: Can this be in `RenderFrameConfig`?
  private readonly padding = { l: 60, r: 16, t: 24, b: 24 };

  public onZoom?: (delta: number) => void;
  public onPointer?: (p: { x: number; y: number } | null) => void;

  constructor(private readonly canvas: HTMLCanvasElement) {
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

  /** Begin a frame. The returned `Frame` is the only thing you draw with. */
  beginFrame(config: RenderFrameConfig): Frame {
    return new Frame(this.canvas, this.ctx, this.padding, config);
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
    this.onPointer({ x: e.clientX - rect.left, y: e.clientY - rect.top });
  };

  private handleMouseLeave = () => this.onPointer?.(null);
}

// --- Frame: per-frame immediate-mode drawing context ----------------------

export class Frame {
  // TODO: We should store only viewport and domain or only transform
  readonly viewport: Viewport;
  readonly domain: Domain;
  readonly transform: Transform; // data → screen
  // TODO: Can get away with not storing this and doging desync chance
  readonly screenToData: Transform; // screen → data
  readonly theme: ChartTheme;

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly ctx: CanvasRenderingContext2D,
    private readonly padding: { l: number; r: number; t: number; b: number },
    config: RenderFrameConfig,
  ) {
    // 1. Synchronous auto-resize (device pixels)
    const dpr = window.devicePixelRatio || 1;
    const targetW = Math.floor(this.canvas.clientWidth * dpr);
    const targetH = Math.floor(this.canvas.clientHeight * dpr);
    if (this.canvas.width !== targetW || this.canvas.height !== targetH) {
      this.canvas.width = targetW;
      this.canvas.height = targetH;
    }

    // 2. Scale the context once; everything below uses CSS pixels.
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const { clientWidth: width, clientHeight: height } = this.canvas;
    const cW = width - this.padding.l - this.padding.r;
    const cH = height - this.padding.t - this.padding.b;

    this.viewport = {
      l: this.padding.l,
      t: this.padding.t,
      width: cW,
      height: cH,
    };

    // TODO: We should probably use y range instead of a "yAbsMax"
    const yAbsMax = Math.pow(10, config.volScale);
    this.domain = { xMin: 0, xMax: 1, yMin: -yAbsMax, yMax: yAbsMax };

    this.transform = fromDomainViewport(this.domain, this.viewport);
    this.screenToData = invert(this.transform);
    this.theme = config.theme;

    // Clear + background
    this.ctx.clearRect(0, 0, width, height);
    this.ctx.fillStyle = config.theme.bg;
    this.ctx.fillRect(0, 0, width, height);

    // FIX: This is a hack for now to make sure the axis is drawn before clip
    this.drawAxes();

    // TODO: Wait but doesn't this break the numbers?
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

  // --- Axes ---------------------------------------------------------------

  drawAxes() {
    const { ctx, viewport: vp, theme, domain, transform } = this;
    const { yMax } = domain;

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
        const screenY = toScreenY(transform, 0, yVal);

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

    // X-axis anchors at domain.xMin / domain.xMax
    const x0 = toScreenX(transform, domain.xMin, 0);
    const x1 = toScreenX(transform, domain.xMax, 0);
    ctx.fillStyle = theme.text;
    ctx.textAlign = "center";
    ctx.textBaseline = "top";
    ctx.fillText(String(domain.xMin), x0, vp.t + vp.height + 8);
    ctx.fillText(String(domain.xMax), x1, vp.t + vp.height + 8);
  }

  // --- Box stacks ---------------------------------------------------------

  boxPen(orientation: BoxPenOrientation, initialStyle: BoxStyle): BoxPen {
    const { transform, domain } = this;
    const xScale = Math.abs(transform.a);
    const yScale = Math.abs(transform.d);
    const originX =
      orientation.anchor === "left"
        ? toScreenX(transform, domain.xMin, 0)
        : toScreenX(transform, domain.xMax, 0);

    return new BoxPen(
      this.ctx,
      {
        a: orientation.anchor === "left" ? xScale : -xScale,
        b: 0,
        c: 0,
        d: orientation.direction === "up" ? -yScale : yScale,
        e: originX,
        f: toScreenY(transform, 0, 0),
      },
      initialStyle,
    );
  }

  // --- Pointer ------------------------------------------------------------

  /**
   * Draw crosshairs + tooltip for a pointer given in *data* coordinates.
   * The component converts its stored screen-space pointer to data using the
   * frame's `screenToData` before calling this, so there is never a desync.
   */
  drawPointer(
    data: { x: number; y: number },
    screen: { x: number; y: number },
  ) {
    const { ctx, viewport: vp, theme } = this;
    const { clientWidth: width, clientHeight: height } = this.canvas;

    ctx.strokeStyle = theme.axis;
    ctx.lineWidth = 1;
    ctx.setLineDash([4, 4]);
    ctx.beginPath();
    ctx.moveTo(screen.x, vp.t);
    ctx.lineTo(screen.x, vp.t + vp.height);
    ctx.stroke();
    ctx.setLineDash([]);

    const boxW = 110;
    const boxH = 40;
    const offset = 12;
    let boxX = screen.x + offset;
    let boxY = screen.y + offset;
    if (boxX + boxW > width - this.padding.r) boxX = screen.x - boxW - offset;
    if (boxY + boxH > height - this.padding.b) boxY = screen.y - boxH - offset;

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
    ctx.fillText(data.x.toFixed(2), screen.x, vp.t + vp.height + 8);
  }
}

export { toDataX, toDataY };
