import { PAD } from "./constants";
import type { OrderBook } from "./orderBook";
import {
  // TODO: Use better human number rendering
  fmtVol,
  fmtUsd,
  powerOf10Ticks,
  hslColor,
  buildCurve,
  MarketCurve,
} from "./math";

export interface MarketInfo {
  groupItemTitle: string;
  clobTokenIds: string[];
  // TODO: This can be a datetime object
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
  curveIdx: number;
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

/** Draw a staircase curve from its pts array. Handles zero crossings in both directions. */
function drawDepthBook(
  ctx: CanvasRenderingContext2D,
  pts: { ratio: number; total: number }[],
  cx: (p: number) => number,
  cy: (v: number) => number,
) {
  if (!pts.length) return;
  const first = pts[0];
  ctx.moveTo(cx(0), cy(first.total));
  ctx.lineTo(cx(first.ratio), cy(first.total));
  let lastPoint = first;
  for (let i = 1; i < pts.length; i++) {
    const pt = pts[i];
    if (
      (lastPoint.total <= 0 && 0 < pt.total) ||
      (lastPoint.total >= 0 && 0 > pt.total)
    ) {
      const d = pt.total - lastPoint.total;
      const t = d === 0 ? 0 : -lastPoint.total / d;
      const crossRatio = lastPoint.ratio + t * (pt.ratio - lastPoint.ratio);
      ctx.lineTo(cx(crossRatio), cy(0));
      lastPoint = { ratio: crossRatio, total: 0 };
    }
    ctx.lineTo(cx(lastPoint.ratio), cy(pt.total));
    ctx.lineTo(cx(pt.ratio), cy(pt.total));
    lastPoint = pt;
  }
  ctx.lineTo(cx(1), cy(lastPoint.total));
}

/** Negate all totals in a pts array (flip the curve vertically). */
function negPts(
  pts: { ratio: number; total: number }[],
): { ratio: number; total: number }[] {
  return pts.map((p) => ({ ratio: p.ratio, total: -p.total }));
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

  // Y-axis ticks
  const yFracs = powerOf10Ticks(yAbsMax);
  for (const frac of yFracs) {
    for (const sign of [1, -1]) {
      const y = cy(sign * frac * yAbsMax);
      if (y < PAD.t - 2 || y > PAD.t + cH + 2) continue;

      drawTickLine(ctx, y, W, gridC, axC);

      const absV = frac * yAbsMax;
      ctx.fillStyle = txtC;
      ctx.textAlign = "right";
      ctx.textBaseline = "middle";
      ctx.fillText((sign > 0 ? "" : "-") + fmtVol(absV), PAD.l - 8, y);
    }
  }

  // X-axis anchors
  ctx.fillStyle = txtC;
  ctx.textAlign = "center";
  ctx.textBaseline = "top";
  ctx.fillText("0", cx(0), PAD.t + cH + 8);
  ctx.fillText("1", cx(1), PAD.t + cH + 8);

  const activeIdxs = Array.from(state.activeMarkets);

  // Build all market curves once
  const allCurves = activeIdxs.map((idx) => {
    const m = state.markets[idx];
    return buildCurve(state.books[m.clobTokenIds[0]]);
  });

  // Build user curves from placed orders — same MarketCurve, just drawn negated
  const allUserCurves = activeIdxs.map((idx) => {
    const uc = new MarketCurve();
    for (const o of state.userOrders) {
      if (o.marketIdx !== idx) continue;
      uc.insert(o.price, o.shares);
    }
    return uc;
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

  const rawPrice = inChart ? (mx! - PAD.l) / cW : 0;
  const rawShares = inChart ? (((cy(0) - my!) * 2) / cH) * yAbsMax : 0;
  const hovering = inChart && rawShares !== 0 && allCurves.length > 0;

  // Compute hover order preview
  let hoverOrder: HoverOrder | null = null;
  if (hovering) {
    const curveIdx = activeIdxs[0];
    const curve = allCurves[curveIdx];

    // Snap price to the nearest spread edge when in the gap
    let price = rawPrice;
    if (curve.bestAsk !== -Infinity && curve.bestBid !== -Infinity) {
      if (price > curve.bestBid && price < curve.bestAsk) {
        price =
          price - curve.bestBid < curve.bestAsk - price
            ? curve.bestBid
            : curve.bestAsk;
      }
    }

    hoverOrder = { price, shares: rawShares, curveIdx };
  }

  // Draw market curves
  activeIdxs.forEach((idx, i) => {
    const curve = allCurves[i];
    if (!curve.length) return;

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
    drawDepthBook(ctx, curve.pts, cx, cy);
    ctx.stroke();
    ctx.globalAlpha = 1;

    // Rotated zero-crossing label
    const centerX = curve.priceAtTotal(0);
    if (centerX !== null && !isNaN(centerX)) {
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
  });

  // Draw user curves (negated MarketCurve — mirrors the market curve)
  // The area between the market curve and the negated user curve = total liquidity
  activeIdxs.forEach((idx, i) => {
    const userCurve = allUserCurves[i];

    ctx.beginPath();
    ctx.strokeStyle = "rgba(255,255,255,0.6)";
    ctx.lineWidth = 1.5;
    ctx.lineJoin = "round";

    if (!userCurve.length) {
      // No orders: flat line at y=0 across the chart
      ctx.moveTo(PAD.l, cy(0));
      ctx.lineTo(W - PAD.r, cy(0));
    } else {
      drawDepthBook(ctx, negPts(userCurve.pts), cx, cy);
    }
    ctx.stroke();
  });

  // Draw hover preview
  if (hovering && hoverOrder) {
    const ho = hoverOrder;
    const curve = allCurves[ho.curveIdx];
    const userCurve = allUserCurves[ho.curveIdx];
    const color = hslColor(ho.curveIdx);
    const spreadPrice = curve.spreadPrice;

    // User curve value at the hover price (MarketCurve convention: asks +, bids -)
    // Negated for display: asks -, bids +
    const userAtPriceRaw = userCurve.length
      ? userCurve.totalAtPrice(ho.price)
      : 0;
    const userAtPrice = -userAtPriceRaw; // negated for display
    const marketAtPrice = curve.totalAtPrice(ho.price);

    // Side is determined by price vs spread
    const isBid = ho.price <= spreadPrice;

    // Order size = distance from user curve to cursor, signed by side
    const orderSize = isBid
      ? Math.max(0, ho.shares - userAtPrice)
      : Math.min(0, ho.shares - userAtPrice);
    const absOrder = Math.abs(orderSize);

    const cancelShares = isBid
      ? Math.max(0, Math.min(absOrder, userAtPrice - marketAtPrice))
      : Math.max(0, Math.min(absOrder, marketAtPrice - userAtPrice));
    const takeShares = absOrder - cancelShares;
    const takeCost = takeShares * ho.price;
    const cancelCost = cancelShares * ho.price;
    const totalCost = takeCost + cancelCost;
    const avgPrice = absOrder > 0 ? totalCost / absOrder : 0;

    // --- Bent user curve: clone + insert preview order ---
    const bentUserCurve = userCurve.clone();
    bentUserCurve.insert(ho.price, orderSize);
    ctx.beginPath();
    ctx.strokeStyle = "rgba(255,255,255,0.9)";
    ctx.lineWidth = 2;
    ctx.lineJoin = "round";
    if (!bentUserCurve.length) {
      ctx.moveTo(PAD.l, cy(0));
      ctx.lineTo(W - PAD.r, cy(0));
    } else {
      drawDepthBook(ctx, negPts(bentUserCurve.pts), cx, cy);
    }
    ctx.stroke();

    // --- Dots at key points ---
    const pointX = cx(ho.price);
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(pointX, cy(marketAtPrice), 3, 0, 2 * Math.PI);
    ctx.arc(pointX, cy(ho.shares), 3, 0, 2 * Math.PI);
    ctx.fill();

    // --- Dashed horizontal line at cursor level ---
    ctx.strokeStyle = isDark ? "rgba(255,255,255,0.5)" : "rgba(0,0,0,0.3)";
    ctx.lineWidth = 1;
    ctx.setLineDash([4, 4]);
    ctx.beginPath();
    ctx.moveTo(PAD.l, cy(ho.shares));
    ctx.lineTo(W - PAD.r, cy(ho.shares));
    ctx.stroke();
    ctx.setLineDash([]);

    // --- Overlay ---
    const side = isBid ? "BID" : "ASK";

    let html = `<div class="cpv-ov-label">${side} @ ${ho.price.toFixed(3)}</div>`;
    html += `<div class="cpv-ov-row"><span>Shares</span><b>${fmtVol(absOrder)}</b></div>`;

    if (cancelShares > 0) {
      html += `<div class="cpv-ov-row"><span>Cancel</span><b>${fmtVol(cancelShares)} @ ${fmtUsd(cancelCost)}</b></div>`;
    }
    if (takeShares > 0) {
      html += `<div class="cpv-ov-row"><span>Take</span><b>${fmtVol(takeShares)} @ ${fmtUsd(takeCost)}</b></div>`;
    }

    html += `<div class="cpv-ov-row"><span>Total</span><b class="cpv-ov-green">${fmtUsd(totalCost)}</b></div>`;
    if (absOrder > 0) {
      html += `<div class="cpv-ov-row"><span>Avg&nbsp;p</span><b>${avgPrice.toFixed(3)}</b></div>`;
    }

    overlay.innerHTML = html;
    overlay.style.display = "block";

    const ovW = overlay.offsetWidth || 180;
    const ovH = overlay.offsetHeight || 100;
    const ovX = Math.max(PAD.l, Math.min(mx! - PAD.r - ovW, W - PAD.r - ovW));
    const ovY =
      ho.shares > 0
        ? Math.max(PAD.t, my! - ovH - 12)
        : Math.min(my! + 12, H - PAD.b - ovH);
    overlay.style.left = ovX + "px";
    overlay.style.top = ovY + "px";
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
