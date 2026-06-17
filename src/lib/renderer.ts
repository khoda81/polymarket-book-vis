import { EventBook } from "./orderBook";
import { fmtVol, powerOf10Ticks } from "./math";

// --- 1. Interfaces ---

export interface ChartTheme {
  bg: string;
  grid: string;
  axis: string;
  text: string;
}

export interface RenderFrameConfig {
  theme: ChartTheme;
  volZoom: number;
  pointer: { screen: DOMPoint; data: DOMPoint } | null;
}

export interface FrameContext {
  ctx: CanvasRenderingContext2D;
  cW: number;
  cH: number;
  yAbsMax: number;
  dataToScreen: DOMMatrix;
  screenToData: DOMMatrix;
  theme: ChartTheme;
}

export class MarketCurve {
  sell: DOMPoint[] = [];
  buy: DOMPoint[] = [];

  constructor(book: EventBook<unknown>, transform: DOMMatrix) {
    let total = 0;
    for (const [_id, level] of book.usdToYes.ordersDescending()) {
      total += level.value / level.price;
      this.buy.push(transform.transformPoint(new DOMPoint(level.price, total)));
    }
    this.buy.push(transform.transformPoint(new DOMPoint(0, total)));
    total = 0;
    for (const level of book.yesToUsd.asSellOrders()) {
      total -= level.value / level.price;
      this.sell.push(
        transform.transformPoint(new DOMPoint(level.price, total)),
      );
    }
    this.sell.push(transform.transformPoint(new DOMPoint(1, total)));
  }
}

// --- 2. The Plotter ---

export class OrderBookPlotter {
  private readonly ctx: CanvasRenderingContext2D;
  private readonly padding = { l: 60, r: 16, t: 24, b: 24 };

  // Opt-in hooks for the parent
  public onZoom?: (delta: number) => void;
  public onHover?: (
    screenPoint: DOMPoint | null,
    dataPoint: DOMPoint | null,
  ) => void;

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
    e.preventDefault();
    if (!this.onZoom) return;

    let delta = e.deltaY;
    switch (e.deltaMode) {
      case WheelEvent.DOM_DELTA_LINE:
        delta *= 16;
        break;
      case WheelEvent.DOM_DELTA_PAGE:
        delta *= 100;
        break;
    }
    this.onZoom(delta * 0.002);
  };

  private handleMouseMove = (e: MouseEvent) => {
    if (!this.onHover) return;
    const rect = this.canvas.getBoundingClientRect();
    const screenX = e.clientX - rect.left;
    const screenY = e.clientY - rect.top;

    const screenPoint = new DOMPoint(screenX, screenY);
    const dataPoint = screenPoint.matrixTransform(this.latestScreenToData);

    this.onHover(screenPoint, dataPoint);
  };

  private handleMouseLeave = () => {
    if (this.onHover) this.onHover(null, null);
  };

  // --- Render Pipeline ---

  beginFrame(config: RenderFrameConfig): FrameContext {
    // 1. Synchronous Auto-Resize
    const dpr = window.devicePixelRatio || 1;
    const targetWidth = Math.floor(this.canvas.clientWidth * dpr);
    const targetHeight = Math.floor(this.canvas.clientHeight * dpr);

    if (
      this.canvas.width !== targetWidth ||
      this.canvas.height !== targetHeight
    ) {
      this.canvas.width = targetWidth;
      this.canvas.height = targetHeight;
    }

    // 2. Math Setup
    const { width, height } = this.canvas;
    const cW = width - this.padding.l - this.padding.r;
    const cH = height - this.padding.t - this.padding.b;

    // TODO: Instead of passing config.volZoom, pass the y-range
    const yAbsMax = Math.pow(10, config.volZoom);

    // 3. Matrix Calculation
    const scaleX = cW;
    const scaleY = cH / (2 * yAbsMax);
    const dataToScreen = new DOMMatrix()
      .translateSelf(this.padding.l, this.padding.t + cH / 2)
      .scaleSelf(scaleX, -scaleY);
    this.latestScreenToData = dataToScreen.inverse();

    // 4. Reset & Clear
    this.ctx.setTransform(1, 0, 0, 1, 0, 0);
    this.ctx.clearRect(0, 0, width, height);

    // Optional: Draw Background
    this.ctx.fillStyle = config.theme.bg;
    this.ctx.fillRect(0, 0, width, height);

    return {
      ctx: this.ctx,
      cW,
      cH,
      yAbsMax,
      dataToScreen,
      screenToData: this.latestScreenToData,
      theme: config.theme,
    };
  }

  drawAxes(fc: FrameContext) {
    const { ctx, theme, cW, cH, yAbsMax, dataToScreen } = fc;

    ctx.strokeStyle = theme.axis;
    ctx.lineWidth = 1;
    ctx.strokeRect(this.padding.l, this.padding.t, cW, cH);

    const yFracs = powerOf10Ticks(yAbsMax);
    ctx.font = "11px sans-serif";
    ctx.textBaseline = "middle";

    for (const frac of yFracs) {
      for (const sign of [1, -1]) {
        const yVal = sign * frac * yAbsMax;
        // Transform just the Y coordinate
        const screenY = new DOMPoint(0, yVal).matrixTransform(dataToScreen).y;

        // Grid line
        ctx.strokeStyle = theme.grid;
        ctx.beginPath();
        ctx.moveTo(this.padding.l, screenY);
        ctx.lineTo(this.canvas.width - this.padding.r, screenY);
        ctx.stroke();

        // Tick mark
        ctx.strokeStyle = theme.axis;
        ctx.beginPath();
        ctx.moveTo(this.padding.l - 5, screenY);
        ctx.lineTo(this.padding.l, screenY);
        ctx.moveTo(this.canvas.width - this.padding.r, screenY);
        ctx.lineTo(this.canvas.width - this.padding.r + 5, screenY);
        ctx.stroke();

        // Label
        const absV = frac * yAbsMax;
        ctx.fillStyle = theme.text;
        ctx.textAlign = "right";
        ctx.fillText(
          (sign > 0 ? "" : "-") + fmtVol(absV),
          this.padding.l - 8,
          screenY,
        );
      }
    }

    // X-Axis Anchors
    const x0 = new DOMPoint(0, 0).matrixTransform(dataToScreen).x;
    const x1 = new DOMPoint(1, 0).matrixTransform(dataToScreen).x;

    ctx.fillStyle = theme.text;
    ctx.textAlign = "center";
    ctx.textBaseline = "top";
    ctx.fillText("0", x0, this.padding.t + cH + 8);
    ctx.fillText("1", x1, this.padding.t + cH + 8);
  }

  drawCurve(fc: FrameContext, book: EventBook<unknown>, color: string) {
    const { ctx, dataToScreen } = fc;
    const depth = new MarketCurve(book, dataToScreen);

    ctx.save();

    ctx.beginPath();
    ctx.strokeStyle = color; // Expecting HSLA string or HEX
    // ctx.fillStyle = "red"; // Expecting HSLA string or HEX
    ctx.lineJoin = "round";
    ctx.lineCap = "round";
    ctx.lineWidth = 3;

    const end = new DOMPoint(1, 0).matrixTransform(dataToScreen);

    depth.buy.reverse();
    let current = { ...end };
    if (depth.buy.length) current.y = depth.buy[0].y;

    for (const point of depth.buy) {
      ctx.lineTo(point.x, current.y); // Horizontal to the next price
      ctx.lineTo(point.x, point.y); // Vertical drop to the lower volume
      current = point;
    }
    ctx.lineTo(current.x, end.y); // Horizontal to the next price

    current = depth.sell.length ? depth.sell[0] : end;
    this.ctx.lineTo(current.x, end.y);

    for (const point of depth.sell) {
      this.ctx.lineTo(point.x, current.y);
      current = point;
      this.ctx.lineTo(point.x, current.y);
    }

    ctx.stroke();
    ctx.restore();
  }

  drawPointer(fc: FrameContext, config: RenderFrameConfig) {
    if (!config.pointer) return;

    const { ctx, theme, cH } = fc;
    const { screen, data } = config.pointer;
    const { width, height } = this.canvas;

    // 1. Crosshairs
    ctx.strokeStyle = theme.axis;
    ctx.lineWidth = 1;
    ctx.setLineDash([4, 4]);
    ctx.beginPath();
    ctx.moveTo(screen.x, this.padding.t);
    ctx.lineTo(screen.x, this.padding.t + cH);
    ctx.stroke();
    ctx.setLineDash([]);

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
    ctx.fillStyle = theme.bg;
    ctx.fillRect(boxX, boxY, boxW, boxH);
    ctx.strokeStyle = theme.axis;
    ctx.strokeRect(boxX, boxY, boxW, boxH);

    // Draw Text inside box
    ctx.fillStyle = theme.text;
    ctx.font = "12px sans-serif";
    ctx.textAlign = "left";
    ctx.textBaseline = "top";
    ctx.fillText(`Price: ${data.x.toFixed(3)}`, boxX + 8, boxY + 8);
    ctx.fillText(`Vol:   ${fmtVol(Math.abs(data.y))}`, boxX + 8, boxY + 22);

    // Bottom Axis Price Label
    ctx.textAlign = "center";
    ctx.fillText(data.x.toFixed(2), screen.x, this.padding.t + cH + 8);
  }
}
