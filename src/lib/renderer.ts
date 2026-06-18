import { BookOrder, HalfBook, TokenBook } from "./orderBook";
import { fmtVol, powerOf10Ticks } from "./math";

// --- 1. Interfaces ---

export interface ChartTheme {
  bg: string;
  grid: string;
  axis: string;
  text: string;
}

export type Pointer = { screen: DOMPoint; data: DOMPoint };

export interface RenderFrameConfig {
  theme: ChartTheme;
  volScale: number;
}

export interface FrameContext {
  chart: { width: number; height: number };
  yAbsMax: number;
  dataToScreen: DOMMatrix;
  screenToData: DOMMatrix;
  theme: ChartTheme;
}

export function halfbookToDepth(
  orders: Iterable<BookOrder>,
  maxDepth: number = Infinity,
) {
  const points = [];
  let total = 0;
  for (const level of orders) {
    total += level.value / level.price;
    points.push(new DOMPoint(level.price, Math.min(total, maxDepth)));
    if (total >= maxDepth) return points;
  }

  return points;
}

export class MarketCurve {
  sell: DOMPoint[] = [];
  buy: DOMPoint[] = [];

  constructor(book: TokenBook<unknown>, transform: DOMMatrix) {}
}

// --- 2. The Plotter ---
export class OrderBookPlotter {
  private readonly ctx: CanvasRenderingContext2D;
  private readonly padding = { l: 60, r: 16, t: 24, b: 24 };

  // Opt-in hooks for the parent
  public onZoom?: (delta: number) => void;
  public onHover?: (pointer: Pointer | null) => void;

  // Cached matrix for event handling outside of draw cycle
  private latestScreenToData: DOMMatrix = new DOMMatrix();

  constructor(private readonly canvas: HTMLCanvasElement) {
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("2D canvas context is not available");
    this.ctx = ctx;

    // Bind events locally, but pass data up
    this.canvas.addEventListener("wheel", this.handleWheel, { passive: false });
    this.canvas.addEventListener("mousemove", this.handleMouseMove);
    this.canvas.addEventListener("mouseleave", this.handleMouseLeave);
  }

  destroy() {
    this.canvas.removeEventListener("wheel", this.handleWheel);
    this.canvas.removeEventListener("mousemove", this.handleMouseMove);
    this.canvas.removeEventListener("mouseleave", this.handleMouseLeave);
    this.onZoom = undefined;
    this.onHover = undefined;
  }

  screenToDataPoint(point: DOMPoint) {
    return point.matrixTransform(this.latestScreenToData);
  }

  // --- Event Handlers ---
  private handleWheel = (e: WheelEvent) => {
    if (!this.onZoom) return;

    e.preventDefault();
    let delta = e.deltaY * 0.002;
    // Handle different wheel modes (pixels, lines, pages)
    if (e.deltaMode === WheelEvent.DOM_DELTA_LINE) {
      const computedLineHeight =
        parseFloat(getComputedStyle(this.canvas).lineHeight) || 16;
      const lineHeight = window.devicePixelRatio * computedLineHeight;
      delta *= lineHeight;
    } else if (e.deltaMode === WheelEvent.DOM_DELTA_PAGE) {
      // Use the container's height for a "page" scroll, or window.innerHeight
      delta *= this.canvas.clientHeight;
    }

    this.onZoom(delta);
  };

  private handleMouseMove = (e: MouseEvent) => {
    if (!this.onHover) return;
    const rect = this.canvas.getBoundingClientRect();

    const screenX = e.clientX - rect.left; // CSS pixels, context handles the rest
    const screenY = e.clientY - rect.top;

    const screen = new DOMPoint(screenX, screenY);
    const data = screen.matrixTransform(this.latestScreenToData);

    this.onHover({ screen, data });
  };

  private handleMouseLeave = () => {
    if (this.onHover) this.onHover(null);
  };

  // --- Render Pipeline ---

  beginFrame(config: RenderFrameConfig): FrameContext {
    // 1. Synchronous Auto-Resize
    const dpr = window.devicePixelRatio || 1;
    const targetWidth = Math.floor(this.canvas.clientWidth * dpr);
    const targetHeight = Math.floor(this.canvas.clientHeight * dpr);

    this.canvas.width = targetWidth;
    this.canvas.height = targetHeight;

    // 2. Math Setup
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0); // scale context, not coordinates
    const { clientWidth: width, clientHeight: height } = this.canvas;
    const cW = width - this.padding.l - this.padding.r;
    const cH = height - this.padding.t - this.padding.b;

    // TODO: Instead of passing config.volScale, pass the y-range
    const yAbsMax = Math.pow(10, config.volScale);

    // 3. Matrix Calculation
    const scaleX = cW;
    const scaleY = cH / (2 * yAbsMax);
    const dataToScreen = new DOMMatrix()
      .translateSelf(this.padding.l, this.padding.t + cH / 2)
      .scaleSelf(scaleX, -scaleY);
    this.latestScreenToData = dataToScreen.inverse();

    // 4. Reset & Clear
    this.ctx.clearRect(0, 0, width, height);

    // Optional: Draw Background
    this.ctx.fillStyle = config.theme.bg;
    this.ctx.fillRect(0, 0, width, height);

    return {
      chart: { width: cW, height: cH },
      yAbsMax,
      dataToScreen,
      screenToData: this.latestScreenToData,
      theme: config.theme,
    };
  }

  drawAxes(fc: FrameContext) {
    const { theme, chart, yAbsMax, dataToScreen } = fc;

    this.ctx.strokeStyle = theme.axis;
    this.ctx.lineWidth = 1;
    this.ctx.strokeRect(
      this.padding.l,
      this.padding.t,
      chart.width,
      chart.height,
    );

    const yFracs = powerOf10Ticks(yAbsMax);
    this.ctx.font = "11px sans-serif";
    this.ctx.textBaseline = "middle";

    for (const frac of yFracs) {
      for (const sign of [1, -1]) {
        const yVal = sign * frac * yAbsMax;
        // Transform just the Y coordinate
        const screenY = new DOMPoint(0, yVal).matrixTransform(dataToScreen).y;

        // Grid line
        this.ctx.strokeStyle = theme.grid;
        this.ctx.beginPath();
        this.ctx.moveTo(this.padding.l, screenY);
        this.ctx.lineTo(this.canvas.clientWidth - this.padding.r, screenY);
        this.ctx.stroke();

        // Tick mark
        this.ctx.strokeStyle = theme.axis;
        this.ctx.beginPath();
        this.ctx.moveTo(this.padding.l - 5, screenY);
        this.ctx.lineTo(this.padding.l, screenY);
        this.ctx.moveTo(this.canvas.clientWidth - this.padding.r, screenY);
        this.ctx.lineTo(this.canvas.clientWidth - this.padding.r + 5, screenY);
        this.ctx.stroke();

        // Label
        const absV = frac * yAbsMax;
        this.ctx.fillStyle = theme.text;
        this.ctx.textAlign = "right";
        // FIX: This is not the correct place to decide the scale as 1k flips between 1k and 1000 every frame
        // We should decide the scale once for the entire chart and use integers for all labels
        this.ctx.fillText(
          (sign > 0 ? "" : "-") + fmtVol(absV),
          this.padding.l - 8,
          screenY,
        );
      }
    }

    // X-Axis Anchors
    const x0 = new DOMPoint(0, 0).matrixTransform(dataToScreen).x;
    const x1 = new DOMPoint(1, 0).matrixTransform(dataToScreen).x;

    this.ctx.fillStyle = theme.text;
    this.ctx.textAlign = "center";
    this.ctx.textBaseline = "top";
    this.ctx.fillText("0", x0, this.padding.t + chart.height + 8);
    this.ctx.fillText("1", x1, this.padding.t + chart.height + 8);
  }

  drawCurve(fc: FrameContext, book: TokenBook<unknown>, color: string) {
    // TODO: Make the lines not go out of the chart box
    const { yAbsMax, dataToScreen: transform } = fc;

    this.ctx.beginPath();
    this.ctx.strokeStyle = color;
    this.ctx.lineJoin = "round";
    this.ctx.lineCap = "round";
    this.ctx.lineWidth = 2;

    const { y: mid } = new DOMPoint(1, 0).matrixTransform(transform);

    const usdToYes = halfbookToDepth(book.usdToYes.asOrders(), yAbsMax);
    usdToYes.reverse();
    const buy = usdToYes.map((p) => transform.transformPoint(p));

    let current = buy[0];
    this.ctx.moveTo(current.x, current.y);

    for (const point of buy) {
      this.ctx.lineTo(current.x, point.y); // Vertical to the current volume
      this.ctx.lineTo(point.x, point.y); // Horizontal to the current price
      current = point;
    }

    current.y = mid;
    this.ctx.lineTo(current.x, mid); // Vertical to the mid

    const invTransform = transform.scale(1, -1, 1, 0, 0);

    const orders = [...book.yesToUsd.asSellOrders()].map((o) => ({
      ...o,
      price: Math.min(o.price, 1.0),
    }));
    const yesToUsd = halfbookToDepth(orders, yAbsMax);
    const sell = yesToUsd.map((p) => invTransform.transformPoint(p));

    if (isNaN(sell[0].y)) console.debug({ sell, yesToUsd });
    for (const point of sell) {
      this.ctx.lineTo(point.x, current.y); // Horizontal to current price
      this.ctx.lineTo(point.x, point.y); // Vertical to the current volume
      current = point;
    }

    this.ctx.stroke();
  }

  drawFilled(fc: FrameContext, book: HalfBook<unknown>, color: string) {
    // TODO:
  }

  drawPointer(fc: FrameContext, pointer: Pointer) {
    const { theme, chart } = fc;
    const { screen, data } = pointer;
    const { clientWidth: width, clientHeight: height } = this.canvas;

    // 1. Crosshairs
    this.ctx.strokeStyle = theme.axis;
    this.ctx.lineWidth = 1;
    this.ctx.setLineDash([4, 4]);
    this.ctx.beginPath();
    this.ctx.moveTo(screen.x, this.padding.t);
    this.ctx.lineTo(screen.x, this.padding.t + chart.height);
    this.ctx.stroke();
    this.ctx.setLineDash([]);

    // 2. Pure Canvas Tooltip Box
    const boxW = 110;
    const boxH = 40;
    const offset = 12;

    let boxX = screen.x + offset;
    let boxY = screen.y + offset;

    // Screen bounds checking
    if (boxX + boxW > width - this.padding.r) boxX = screen.x - boxW - offset;
    if (boxY + boxH > height - this.padding.b) boxY = screen.y - boxH - offset;

    // Draw Box
    this.ctx.fillStyle = theme.bg;
    this.ctx.fillRect(boxX, boxY, boxW, boxH);
    this.ctx.strokeStyle = theme.axis;
    this.ctx.strokeRect(boxX, boxY, boxW, boxH);

    // TODO: This text looks like shit
    // Draw Text inside box
    this.ctx.fillStyle = theme.text;
    this.ctx.font = "12px sans-serif";
    this.ctx.textAlign = "left";
    this.ctx.textBaseline = "top";
    this.ctx.fillText(`Price: ${data.x.toFixed(3)}`, boxX + 8, boxY + 8);
    this.ctx.fillText(
      `Vol:   ${fmtVol(Math.abs(data.y))}`,
      boxX + 8,
      boxY + 22,
    );

    // Bottom Axis Price Label
    this.ctx.textAlign = "center";
    this.ctx.fillText(
      data.x.toFixed(2),
      screen.x,
      this.padding.t + chart.height + 8,
    );
  }
}
