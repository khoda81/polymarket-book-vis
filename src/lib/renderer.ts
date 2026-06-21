import { BookOrder, HalfBook } from "./orderBook";
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
  /** Map a stable key to a color. Used by `Frame.drawBookView` so the
   * component never has to know how colors are generated. */
  color: (key: number | string) => string;
}

// --- Book views -----------------------------------------------------------

export type Side = "buy" | "sell";

/**
 * Declarative description of one wing of a book to render.
 *
 * - `side: "buy"`  → uses `book.asOrders()`, draws upward from the mid line.
 * - `side: "sell"` → uses `book.asSellOrders()` (price = 1/price), draws
 *   downward from the mid line.
 *
 * The mid line is `domain.yMin === -domain.yMax` (i.e. y=0 in data space);
 * the renderer never assumes this implicitly — it derives the baseline from
 * the domain.
 */
export interface BookView<K = unknown> {
  side: Side;
  book: HalfBook<K>;
  colorKey: number | string;
  /** Omit to stroke only. Provide `depth` to fill up to that signed volume. */
  fill?: { depth: number };
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

  private handleMouseLeave = () => {
    this.onPointer?.(null);
  };
}

// --- Frame: per-frame immediate-mode drawing context ----------------------

export class Frame {
  readonly viewport: Viewport;
  readonly domain: Domain;
  readonly transform: Transform; // data → screen
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

    const yAbsMax = Math.pow(10, config.volScale);
    this.domain = { xMin: 0, xMax: 1, yMin: -yAbsMax, yMax: yAbsMax };

    this.transform = fromDomainViewport(this.domain, this.viewport);
    this.screenToData = invert(this.transform);
    this.theme = config.theme;

    // 3. Clear + background
    this.ctx.clearRect(0, 0, width, height);
    this.ctx.fillStyle = config.theme.bg;
    this.ctx.fillRect(0, 0, width, height);

    // 4. Clamp all subsequent drawing to the chart rect.
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

  // --- Book views ---------------------------------------------------------

  drawBookView(view: BookView) {
    const color = this.theme.color(view.colorKey);
    if (view.fill) this.fillBookView(view, color);
    else this.strokeBookView(view, color);
  }

  private strokeBookView(view: BookView, color: string) {
    const { ctx, transform, domain } = this;
    const { side, book } = view;

    ctx.beginPath();
    ctx.strokeStyle = color;
    ctx.lineJoin = "round";
    ctx.lineCap = "round";
    ctx.lineWidth = 2;

    // Baseline at y=0 in data space (the mid line for a symmetric domain).
    const baseY = toScreenY(transform, 0, 0);

    const depth = halfbookToDepth(
      side === "buy" ? book.asOrders() : book.asSellOrders(),
      domain.yMax,
    );

    // Start at the left edge of the chart on the baseline.
    let currX = toScreenX(transform, domain.xMin, 0);
    let currY = baseY;
    ctx.moveTo(currX, currY);

    for (const p of depth) {
      const px = toScreenX(transform, p.x, p.y);
      const py = toScreenY(transform, p.x, p.y);
      ctx.lineTo(px, currY); // horizontal
      ctx.lineTo(px, py); // vertical
      currX = px;
      currY = py;
    }
    ctx.stroke();
  }

  private fillBookView(view: BookView, color: string) {
    const { ctx, transform, domain } = this;
    const { side, book, fill } = view;
    if (!fill) return;

    const limit = Math.min(Math.abs(fill.depth), domain.yMax);
    const depth = halfbookToDepth(
      side === "buy" ? book.asOrders() : book.asSellOrders(),
      limit,
    );

    const baseY = toScreenY(transform, 0, 0);
    const leftX = toScreenX(transform, domain.xMin, 0);

    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.moveTo(leftX, baseY);

    let currY = baseY;
    for (const p of depth) {
      const px = toScreenX(transform, p.x, p.y);
      const py = toScreenY(transform, p.x, p.y);
      ctx.lineTo(px, currY); // horizontal
      ctx.lineTo(px, py); // vertical
      currY = py;
    }
    ctx.lineTo(leftX, currY);
    ctx.closePath();
    ctx.fill();
  }

  // --- Stacked boxes ------------------------------------------------------

  /**
   * Draw a vertical stack of boxes growing from the mid line (y=0 in data
   * space). Each box's bottom is the previous box's top. `boxes` is given in
   * data space: `{ price, height }` where `price` is the left edge in data x
   * and `height` is the data-y extent (always positive; direction is taken
   * from `side`). Boxes are clamped to the chart rect by the frame's clip.
   */
  drawStackedBoxes(
    side: Side,
    boxes: Iterable<{ price: number; height: number }>,
    colorKey: number | string,
  ) {
    const { ctx, transform, domain } = this;
    const color = this.theme.color(colorKey);
    ctx.fillStyle = color;

    const baseY = toScreenY(transform, 0, 0);
    const dir = side === "buy" ? -1 : 1; // screen y grows downward
    const xMin = domain.xMin;
    const xMax = domain.xMax;

    let topY = baseY;
    for (const b of boxes) {
      const leftX = toScreenX(transform, Math.max(b.price, xMin), 0);
      const rightX = toScreenX(transform, xMax, 0);
      const h = b.height * Math.abs(transform.d);
      const boxY = dir > 0 ? topY : topY - h;
      ctx.fillRect(leftX, boxY, rightX - leftX, h);
      topY = dir > 0 ? topY + h : topY - h;
    }
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

// --- Depth iteration (no per-point allocation) -----------------------------

/**
 * Yield cumulative depth as `{x, y}` literals (not DOMPoint) up to `maxDepth`.
 * Reusing the same object via a closure would be faster but mutates shared
 * state; the literal-per-yield is cheap enough and keeps callers honest.
 */
export function* halfbookToDepth(
  orders: Iterable<BookOrder>,
  maxDepth: number = Infinity,
): Generator<{ x: number; y: number }> {
  let total = 0;
  for (const level of orders) {
    total += level.value / level.price;
    yield { x: level.price, y: Math.min(total, maxDepth) };
    if (total >= maxDepth) break;
  }
}

// Re-export for component convenience.
export { toDataX, toDataY };
