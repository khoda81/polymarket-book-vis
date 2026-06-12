import { PAD } from "./constants";
import {
  type Point,
  fmtVol,
  fmtUsd,
  powerOf10Ticks,
  hslColor,
  yAtX,
  sliceCurveToY,
  integrateCurve,
} from "./math";
import type { OrderBook } from "./ws";

export interface MarketInfo {
  groupItemTitle: string;
  clobTokenIds: string[];
  endDate: string;
}

export interface UserOrder {
  id: string;
  price: number;
  shares: number; // positive = buy (ask side), negative = sell (bid side)
  marketIdx: number;
}

export interface DrawState {
  markets: MarketInfo[];
  activeMarkets: Set<number>;
  books: Record<string, OrderBook>;
  userOrders: UserOrder[];
  volZoom: number;
  mx: number | null;
  my: number | null;
}

export interface DrawRefs {
  canvas: HTMLCanvasElement;
  overlay: HTMLDivElement;
}

export interface HoverOrder {
  price: number;
  shares: number;
  takeShares: number;
  limitShares: number;
  takeCost: number;
  limitCost: number;
  marketIdx: number;
}

export function buildCurve(book: OrderBook | undefined): {
  asks: Point[];
  bids: Point[];
} {
  if (!book) return { asks: [], bids: [] };

  const asksSorted = [...book.asks].sort((a, b) => +a.p - +b.p);
  const asks: Point[] = [];
  let total = 0;
  for (const o of asksSorted) {
    asks.push({ x: +o.p, y: total });
    total += o.s;
    asks.push({ x: +o.p, y: total });
  }
  asks.push({ x: 1, y: total });

  const bidsSorted = [...book.bids].sort((a, b) => +b.p - +a.p);
  const bids: Point[] = [];
  total = 0;
  for (const o of bidsSorted) {
    bids.push({ x: +o.p, y: total });
    total -= o.s;
    bids.push({ x: +o.p, y: total });
  }
  bids.push({ x: 0, y: total });

  return { asks, bids };
}

function drawTickLine(
  ctx: CanvasRenderingContext2D,
  y: number,
  W: number,
  gridC: string,
  axC: string,
) {
  ctx.strokeStyle = gridC;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(PAD.l, y);
  ctx.lineTo(W - PAD.r, y);
  ctx.stroke();

  ctx.strokeStyle = axC;
  ctx.beginPath();
  ctx.moveTo(PAD.l - 5, y);
  ctx.lineTo(PAD.l, y);
  ctx.moveTo(W - PAD.r, y);
  ctx.lineTo(W - PAD.r + 5, y);
  ctx.stroke();
}

export function draw(state: DrawState, refs: DrawRefs): void {
  const { canvas, overlay } = refs;
  const ctx = canvas.getContext("2d")!;
  const dpr = window.devicePixelRatio || 1;
  const wrap = canvas.parentElement!;
  const W = wrap.clientWidth;
  const H = wrap.clientHeight;
  if (W <= 0 || H <= 0) return;

  canvas.width = W * dpr;
  canvas.height = H * dpr;
  ctx.resetTransform();
  ctx.scale(dpr, dpr);

  const cW = W - PAD.l - PAD.r;
  const cH = H - PAD.t - PAD.b;
  ctx.clearRect(0, 0, W, H);

  const bodyStyle = window.getComputedStyle(document.body);
  const bgColor = bodyStyle.backgroundColor || "#fff";
  const isDark = bodyStyle.color === "rgb(238, 238, 238)";

  const gridC = "rgba(128,128,128,0.15)";
  const axC = "rgba(128,128,128,0.5)";
  const txtC = isDark ? "#aaa" : "#666";

  const yAbsMax = Math.pow(10, state.volZoom);
  const cx = (p: number) => PAD.l + p * cW;
  const cy = (v: number) => PAD.t + (1 - v / yAbsMax) * (cH / 2);

  ctx.font = "11px var(--font-sans,sans-serif)";

  // Bounding box
  ctx.strokeStyle = axC;
  ctx.lineWidth = 1;
  ctx.strokeRect(PAD.l, PAD.t, cW, cH);

  // Y-axis ticks (including zero)
  const yFracs = powerOf10Ticks(yAbsMax);
  const allTicks = [0, ...yFracs];
  for (const frac of allTicks) {
    for (const sign of frac === 0 ? [1] : [1, -1]) {
      const y = cy(sign * frac * yAbsMax);
      if (y < PAD.t - 2 || y > PAD.t + cH + 2) continue;

      const isZero = frac === 0;
      if (isZero) {
        ctx.strokeStyle = "rgba(128,128,128,0.8)";
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.moveTo(PAD.l, y);
        ctx.lineTo(W - PAD.r, y);
        ctx.stroke();
      }
      drawTickLine(ctx, y, W, gridC, axC);

      const absV = frac * yAbsMax;
      ctx.fillStyle = txtC;
      ctx.textAlign = "right";
      ctx.textBaseline = "middle";
      ctx.fillText(
        isZero ? "0" : (sign > 0 ? "" : "-") + fmtVol(absV),
        PAD.l - 8,
        y,
      );
    }
  }

  // X-axis anchors
  ctx.fillStyle = txtC;
  ctx.textAlign = "center";
  ctx.textBaseline = "top";
  ctx.fillText("0", cx(0), PAD.t + cH + 8);
  ctx.fillText("1", cx(1), PAD.t + cH + 8);

  const activeIdxs = Array.from(state.activeMarkets);

  // Build all curves once
  const allCurves = activeIdxs.map((idx) => {
    const m = state.markets[idx];
    return buildCurve(state.books[m.clobTokenIds[0]]);
  });

  // Hover detection
  const mx = state.mx;
  const my = state.my;
  const inChart =
    mx !== null &&
    my !== null &&
    mx >= PAD.l &&
    mx <= W - PAD.r &&
    my >= PAD.t &&
    my <= PAD.t + cH;

  const mPrice = inChart ? (mx! - PAD.l) / cW : 0;
  const mShares = inChart ? (((cy(0) - my!) * 2) / cH) * yAbsMax : 0;
  const hovering = inChart && mShares !== 0 && allCurves.length > 0;

  // Compute hover order preview
  let hoverOrder: HoverOrder | null = null;
  if (hovering) {
    const curveIdx = 0;
    const curve = allCurves[curveIdx];
    const isBuy = mShares > 0;
    const curveAtPrice = isBuy
      ? yAtX(curve.asks, mPrice)
      : -yAtX(curve.bids, mPrice); // bids are negative, flip for comparison

    const absShares = Math.abs(mShares);
    const absCurveAtPrice = Math.abs(curveAtPrice);

    const takeShares = Math.min(absShares, absCurveAtPrice);
    const limitShares = Math.max(0, absShares - absCurveAtPrice);

    // Take cost: ∫ price dy under the curve from 0 to takeShares
    let takeCost = 0;
    if (takeShares > 0) {
      if (isBuy) {
        takeCost = integrateCurve(sliceCurveToY(curve.asks, takeShares));
      } else {
        const negBids = curve.bids.map(({ x, y }) => ({ x, y: -y }));
        takeCost = integrateCurve(sliceCurveToY(negBids, takeShares));
      }
    }

    // Limit cost: price * limitShares
    const limitCost = limitShares * mPrice;

    hoverOrder = {
      price: mPrice,
      shares: mShares,
      takeShares,
      limitShares,
      takeCost,
      limitCost,
      marketIdx: activeIdxs[curveIdx],
    };
  }

  // Draw market curves
  activeIdxs.forEach((idx, i) => {
    const curve = allCurves[i];
    const combined = [...curve.bids.toReversed(), ...curve.asks];
    if (!combined.length) return;

    const color = hslColor(idx);
    const dim = hovering;

    ctx.beginPath();
    ctx.strokeStyle = dim
      ? color
          .replace("70%", "40%")
          .replace(")", ", 0.3)")
          .replace("hsl(", "hsla(")
      : color;
    ctx.lineWidth = dim ? 1.5 : 2.5;
    ctx.globalAlpha = dim ? 0.35 : 1;
    ctx.lineJoin = "round";
    curve.bids.toReversed().forEach((pt) => ctx.lineTo(cx(pt.x), cy(pt.y)));
    curve.asks.forEach((pt) => ctx.lineTo(cx(pt.x), cy(pt.y)));
    ctx.stroke();
    ctx.globalAlpha = 1;

    // Rotated zero-crossing label
    const zPts = combined.filter((p) => p.y === 0);
    if (zPts.length >= 1) {
      const centerX =
        zPts.length > 1 ? (zPts[0].x + zPts[zPts.length - 1].x) / 2 : zPts[0].x;
      if (!isNaN(centerX)) {
        const lx = cx(centerX);
        const ly = cy(0) - 12;
        ctx.save();
        ctx.translate(lx, ly);
        ctx.rotate(-Math.PI / 2);
        ctx.font = "bold 10px var(--font-sans,sans-serif)";
        const tw = ctx.measureText(state.markets[idx].groupItemTitle).width;
        ctx.globalAlpha = dim ? 0.3 : 1;
        ctx.fillStyle = bgColor;
        ctx.fillRect(-4, -7, tw + 12, 14);
        ctx.strokeStyle = color;
        ctx.lineWidth = 0.75;
        ctx.strokeRect(-4, -7, tw + 12, 14);
        ctx.fillStyle = color;
        ctx.textAlign = "left";
        ctx.textBaseline = "middle";
        ctx.fillText(state.markets[idx].groupItemTitle, 2, 0);
        ctx.globalAlpha = 1;
        ctx.restore();
      }
    }
  });

  // Draw user order rectangles
  for (const order of state.userOrders) {
    const curveIdx = activeIdxs.indexOf(order.marketIdx);
    if (curveIdx < 0) continue;
    const curve = allCurves[curveIdx];
    const color = hslColor(order.marketIdx);
    const isBuy = order.shares > 0;
    const absShares = Math.abs(order.shares);

    // Find cumulative volume ahead of this order in the book
    const bookCurve = isBuy ? curve.asks : curve.bids;
    const cumAtPrice = Math.abs(yAtX(bookCurve, order.price));

    const y0 = isBuy ? cumAtPrice : -cumAtPrice;
    const y1 = isBuy ? cumAtPrice + absShares : -(cumAtPrice + absShares);

    // Find next price level for width
    let xEnd = 1;
    for (let i = 1; i < bookCurve.length; i++) {
      if (bookCurve[i].x > order.price) {
        xEnd = bookCurve[i].x;
        break;
      }
    }

    const px = cx(order.price);
    const pxEnd = cx(xEnd);
    const py0 = cy(y0);
    const py1 = cy(y1);

    // Fill
    ctx.fillStyle = isBuy
      ? "rgba(29, 158, 117, 0.25)"
      : "rgba(226, 75, 74, 0.25)";
    ctx.fillRect(px, py1, pxEnd - px, py0 - py1);

    // Border
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.5;
    ctx.setLineDash([3, 3]);
    ctx.strokeRect(px, py1, pxEnd - px, py0 - py1);
    ctx.setLineDash([]);
  }

  // Draw hover preview
  if (hovering && hoverOrder) {
    const ho = hoverOrder;
    const isBuy = mShares > 0;
    const curveIdx = 0;
    const curve = allCurves[curveIdx];
    const color = hslColor(activeIdxs[curveIdx]);

    // --- Take region: area under curve from 0 to takeShares ---
    if (ho.takeShares > 0) {
      ctx.fillStyle = "rgba(100, 180, 255, 0.18)";
      ctx.beginPath();
      if (isBuy) {
        const sliced = sliceCurveToY(curve.asks, ho.takeShares);
        ctx.moveTo(cx(sliced[0].x), cy(0));
        for (const pt of sliced) ctx.lineTo(cx(pt.x), cy(pt.y));
        ctx.lineTo(cx(sliced[sliced.length - 1].x), cy(0));
      } else {
        // bids: y is negative. Slice in negated space, draw in original.
        const negBids = curve.bids.map(({ x, y }) => ({ x, y: -y }));
        const sliced = sliceCurveToY(negBids, ho.takeShares);
        ctx.moveTo(cx(sliced[0].x), cy(0));
        for (const pt of sliced) ctx.lineTo(cx(pt.x), cy(-pt.y));
        ctx.lineTo(cx(sliced[sliced.length - 1].x), cy(0));
      }
      ctx.closePath();
      ctx.fill();
    }

    // --- Limit rectangle: from curveAtPrice to mShares at mPrice ---
    if (ho.limitShares > 0) {
      const curveAtPrice = isBuy
        ? yAtX(curve.asks, mPrice)
        : -yAtX(curve.bids, mPrice);

      // Find next price level for width
      const bookCurve = isBuy ? curve.asks : curve.bids;
      let xEnd = 1;
      for (let i = 1; i < bookCurve.length; i++) {
        if (bookCurve[i].x > mPrice) {
          xEnd = bookCurve[i].x;
          break;
        }
      }

      const px = cx(mPrice);
      const pxEnd = cx(xEnd);
      const pyCurve = cy(curveAtPrice);
      const pyMouse = cy(mShares);

      // Hatched fill for limit
      ctx.fillStyle = isBuy
        ? "rgba(29, 158, 117, 0.2)"
        : "rgba(226, 75, 74, 0.2)";
      ctx.fillRect(
        px,
        Math.min(pyCurve, pyMouse),
        pxEnd - px,
        Math.abs(pyMouse - pyCurve),
      );

      // Dashed border
      ctx.strokeStyle = color;
      ctx.lineWidth = 1.5;
      ctx.setLineDash([4, 4]);
      ctx.strokeRect(
        px,
        Math.min(pyCurve, pyMouse),
        pxEnd - px,
        Math.abs(pyMouse - pyCurve),
      );
      ctx.setLineDash([]);
    }

    // --- Dashed horizontal line at mShares level ---
    ctx.strokeStyle = isDark ? "rgba(255,255,255,0.5)" : "rgba(0,0,0,0.3)";
    ctx.lineWidth = 1;
    ctx.setLineDash([4, 4]);
    ctx.beginPath();
    ctx.moveTo(PAD.l, cy(mShares));
    ctx.lineTo(W - PAD.r, cy(mShares));
    ctx.stroke();
    ctx.setLineDash([]);

    // --- Overlay ---
    const side = isBuy ? "BUY" : "SELL";
    const totalCost = ho.takeCost + ho.limitCost;
    const avgPrice = totalCost / Math.abs(mShares);

    let html = `<div class="cpv-ov-label">${side} @ ${mPrice.toFixed(3)}</div>`;
    html += `<div class="cpv-ov-row"><span>Shares</span><b>${fmtVol(Math.abs(mShares))}</b></div>`;

    if (ho.takeShares > 0) {
      html += `<div class="cpv-ov-row"><span>Take</span><b>${fmtVol(ho.takeShares)} @ ${fmtUsd(ho.takeCost)}</b></div>`;
    }
    if (ho.limitShares > 0) {
      html += `<div class="cpv-ov-row"><span>Limit</span><b>${fmtVol(ho.limitShares)} @ ${fmtUsd(ho.limitCost)}</b></div>`;
    }

    html += `<div class="cpv-ov-row"><span>Total</span><b class="cpv-ov-green">${fmtUsd(totalCost)}</b></div>`;
    html += `<div class="cpv-ov-row"><span>Avg&nbsp;p</span><b>${avgPrice.toFixed(3)}</b></div>`;

    overlay.innerHTML = html;
    overlay.style.display = "block";

    const ovW = overlay.offsetWidth || 180;
    const ovX = mx! + 16 + ovW > W ? mx! - ovW - 8 : mx! + 16;
    overlay.style.left = ovX + "px";
    overlay.style.top = Math.max(PAD.t, Math.min(my! - 20, H - 140)) + "px";
  } else {
    overlay.style.display = "none";
  }

  // Crosshair vertical line
  if (mx !== null && mx >= PAD.l && mx <= W - PAD.r) {
    ctx.strokeStyle = axC;
    ctx.lineWidth = 1;
    ctx.setLineDash([4, 4]);
    ctx.beginPath();
    ctx.moveTo(mx, PAD.t);
    ctx.lineTo(mx, PAD.t + cH);
    ctx.stroke();
    ctx.setLineDash([]);

    const price = (mx - PAD.l) / cW;
    ctx.fillStyle = txtC;
    ctx.textAlign = "center";
    ctx.textBaseline = "top";
    ctx.font = "10px var(--font-sans,sans-serif)";
    ctx.fillText(price.toFixed(2), mx, PAD.t + cH + 8);
  }
}
