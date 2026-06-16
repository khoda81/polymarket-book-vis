import { PAD } from "./constants";
import { FullOrderBook } from "./orderBook";
import { fmtVol, hslColor, powerOf10Ticks } from "./math";
import { o } from "node_modules/@polymarket/client/dist/sports-DNd7kOz2";

export interface MarketInfo {
  groupItemTitle: string;
  clobTokenIds: string[];
  endDate: string;
}

interface ScreenPoint {
  x: number;
  y: number;
}

interface DepthPoint {
  price: number;
  total: number;
}

export class MarketCurve {
  asks: DepthPoint[];
  bids: DepthPoint[];

  constructor(book: FullOrderBook<unknown>) {
    this.asks = [];
    this.bids = [];

    let total = 0;
    for (const level of book.asks.entriesAscending()) {
      total += level.volume;
      this.asks.push({ price: level.price, total });
    }

    total = 0;
    for (const level of book.bids.entriesAscending()) {
      total += level.volume;
      this.bids.push({ price: 1 - level.price, total });
    }
  }
}

function toHsla(color: string, alpha: number): string {
  return color.replace("hsl(", "hsla(").replace(")", `, ${alpha})`);
}

type Colors = {
  text: string;
  grid: string;
  axis: string;
};

export class OrderBookPlotter {
  private readonly ctx: CanvasRenderingContext2D;
  /** The absolute maximum y value for the data. */
  private pointer: ScreenPoint | null = null;
  private padding = { l: 60, r: 16, t: 24, b: 24 } as const;

  private resizeObserver: ResizeObserver;
  constructor(private readonly canvas: HTMLCanvasElement) {
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("2D canvas context is not available");
    this.ctx = ctx;

    this.resizeObserver = new ResizeObserver((entries) => {
      const entry = entries[0];
      const width = entry.contentRect.width;
      const height = entry.contentRect.height;
      const dpr = window.devicePixelRatio || 1;

      this.canvas.width = Math.floor(width * dpr);
      this.canvas.height = Math.floor(height * dpr);

      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    });

    this.resizeObserver.observe(this.canvas);
  }

  destroy() {
    this.resizeObserver.disconnect();
  }

  private computeDataTransform(yAbsMax: number): DOMMatrix {
    const width = this.canvas.width - PAD.l - PAD.r;
    const height = this.canvas.height - PAD.t - PAD.b;

    const scaleX = width;
    const scaleY = height / (2 * yAbsMax);

    const dataToScreen = new DOMMatrix()
      .translateSelf(PAD.l, PAD.t + height / 2)
      .scaleSelf(scaleX, -scaleY);

    return dataToScreen;
  }

  private drawAxes(dataToScreen: DOMMatrix, colors: Colors) {
    const ctx = this.ctx;

    ctx.strokeStyle = colors.axis;
    ctx.lineWidth = 1;

    ctx.strokeRect(PAD.l, PAD.t, width, height);

    const yFracs = powerOf10Ticks(this.yAbsMax);
    for (const frac of yFracs) {
      for (const sign of [1, -1]) {
        const yVal = sign * frac * this.yAbsMax;
        const { y } = this.toScreenPoint(0, yVal);

        ctx.strokeStyle = gridC;
        ctx.beginPath();
        ctx.moveTo(PAD.l, y);
        ctx.lineTo(this.canvas.width - PAD.r, y);
        ctx.stroke();

        ctx.strokeStyle = axC;
        ctx.beginPath();
        ctx.moveTo(PAD.l - 5, y);
        ctx.lineTo(PAD.l, y);
        ctx.moveTo(this.canvas.width - PAD.r, y);
        ctx.lineTo(this.canvas.width - PAD.r + 5, y);
        ctx.stroke();

        const absV = frac * this.yAbsMax;
        ctx.fillStyle = txtC;
        ctx.textAlign = "right";
        ctx.textBaseline = "middle";
        ctx.fillText((sign > 0 ? "" : "-") + fmtVol(absV), PAD.l - 8, y);
      }
    }

    const x0 = this.toScreenPoint(0, 0).x;
    const x1 = this.toScreenPoint(1, 0).x;

    ctx.fillStyle = txtC;
    ctx.textAlign = "center";
    ctx.textBaseline = "top";
    ctx.fillText("0", x0, PAD.t + cH + 8);
    ctx.fillText("1", x1, PAD.t + cH + 8);
  }

  private drawDepthStair(
    points: DepthPoint[],
    startX: number,
    endX: number,
    startY: number,
  ) {
    if (!points.length) {
      this.ctx.moveTo(startX, startY);
      this.ctx.lineTo(endX, startY);
      return;
    }

    this.ctx.moveTo(startX, startY);
    this.ctx.lineTo(points[0].price, startY);

    let y = startY;
    for (const point of points) {
      this.ctx.lineTo(point.price, y);
      y = point.total;
      this.ctx.lineTo(point.price, y);
    }

    this.ctx.lineTo(endX, y);
  }

  private drawDepth(depth: MarketCurve, color: string, alpha = 1) {
    const ctx = this.ctx;

    ctx.beginPath();
    ctx.strokeStyle = toHsla(color, alpha);
    ctx.lineJoin = "round";
    const scaleY = Math.abs(this.dataToScreen.d);
    ctx.lineWidth = 2 / scaleY;

    const bidStart = depth.bids.length ? depth.bids[0].total : 0;
    this.drawDepthStair(depth.bids, 0, 1, bidStart);

    const askStart = 0;
    this.drawDepthStair(depth.asks, 0, 1, askStart);

    ctx.stroke();
  }

  beginFrame({ volZoom }: { volZoom: number }) {
    const yAbsMax = Math.pow(10, volZoom);
    const transform = this.computeDataTransform(yAbsMax);

    this.ctx.resetTransform();
    this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    this.ctx.font = "11px var(--font-sans,sans-serif)";

    return transform;
  }

  drawCurve(transform: DOMMatrix, book: FullOrderBook<unknown>): void {
    const ctx = this.ctx;

    ctx.save();
    ctx.setTransform(transform);

    const depth = new MarketCurve(book);
    this.drawDepth(depth, hslColor(idx), 0.9);

    // const userDepth = buildUserDepth(state.userOrders, idx);
    // this.drawDepth(userDepth, "hsl(0, 0%, 100%)", 0.65);

    ctx.restore();
  }

  drawPointer(pointer: DOMPoint | null): void {
    if (!pointer) {
      this.overlay.style.display = "none";
      return;
    }

    const ctx = this.ctx;

    ctx.strokeStyle = axC;
    ctx.lineWidth = 1;
    ctx.setLineDash([4, 4]);
    ctx.beginPath();
    ctx.moveTo(pointer.x, PAD.t);
    ctx.lineTo(pointer.x, PAD.t + cH);
    ctx.stroke();
    ctx.setLineDash([]);

    const clampedPrice = pointerData.x;
    const overlayHtml = [
      `<div class="cpv-ov-label">Price: ${clampedPrice.toFixed(3)}</div>`,
      `<div class="cpv-ov-row"><span>Amount</span><b>${fmtVol(pointerData.y)}</b></div>`,
    ].join("");

    this.overlay.innerHTML = overlayHtml;
    this.overlay.style.display = "block";

    const ovW = this.overlay.offsetWidth || 180;
    const ovH = this.overlay.offsetHeight || 80;
    const ovX = Math.max(
      PAD.l,
      Math.min(pointer.x + 12, this.canvas.width - PAD.r - ovW),
    );
    const ovY = Math.max(
      PAD.t,
      Math.min(pointer.y + 12, this.canvas.height - PAD.b - ovH),
    );

    this.overlay.style.left = `${ovX}px`;
    this.overlay.style.top = `${ovY}px`;

    ctx.fillStyle = txtC;
    ctx.textAlign = "center";
    ctx.textBaseline = "top";
    ctx.font = "10px var(--font-sans,sans-serif)";
    ctx.fillText(clampedPrice.toFixed(2), pointer.x, PAD.t + cH + 8);
  }
}
