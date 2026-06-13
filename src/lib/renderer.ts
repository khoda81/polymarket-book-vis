import { PAD } from "./constants";
import {
  MarketCurve,
  buildCurve,
  fmtVol,
  fmtUsd,
  powerOf10Ticks,
  hslColor,
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
  curve: MarketCurve;
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

    hoverOrder = { price, shares: rawShares, curve, curveIdx };
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
    let lastPoint = { ratio: 0, total: 0 };
    for (const pt of curve.pts) {
      if (lastPoint.total <= 0 && 0 < pt.total) {
        ctx.lineTo(cx(lastPoint.ratio), cy(0));
        ctx.lineTo(cx(pt.ratio), cy(0));
        lastPoint = { ratio: pt.ratio, total: 0 };
      }

      ctx.lineTo(cx(lastPoint.ratio), cy(pt.total));
      ctx.lineTo(cx(pt.ratio), cy(pt.total));
      lastPoint = pt;
    }

    ctx.lineTo(cx(1), cy(lastPoint.total));
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

  // Draw user order rectangles
  for (const order of state.userOrders) {
    const curveIdx = activeIdxs.indexOf(order.marketIdx);
    if (curveIdx < 0) continue;
    const curve = allCurves[curveIdx];
    const color = hslColor(order.marketIdx);
    const isBuy = order.shares > 0;
    const absShares = Math.abs(order.shares);

    const cumAtPrice = curve.totalAtPrice(order.price);
    const y0 = cumAtPrice;
    const y1 = isBuy ? cumAtPrice + absShares : cumAtPrice - absShares;

    const xEnd = curve.nextPriceAfter(order.price);

    const px = cx(order.price);
    const pxEnd = cx(xEnd);
    const py0 = cy(y0);
    const py1 = cy(y1);

    ctx.fillStyle = isBuy
      ? "rgba(29, 158, 117, 0.25)"
      : "rgba(226, 75, 74, 0.25)";
    ctx.fillRect(px, py1, pxEnd - px, py0 - py1);

    ctx.strokeStyle = color;
    ctx.lineWidth = 1.5;
    ctx.setLineDash([3, 3]);
    ctx.strokeRect(px, py1, pxEnd - px, py0 - py1);
    ctx.setLineDash([]);
  }

  // Draw hover preview
  if (hovering && hoverOrder) {
    const ho = hoverOrder;
    const curve = allCurves[ho.curveIdx];
    const color = hslColor(ho.curveIdx);
    const isBuy = ho.shares > 0;
    const absShares = Math.abs(ho.shares);

    // Market curve value at the hover price
    const marketAtPrice = curve.totalAtPrice(ho.price);

    // User's cumulative position at this price (sum of existing orders)
    const userOrdersAtMarket = state.userOrders.filter(
      (o) => o.marketIdx === activeIdxs[ho.curveIdx],
    );
    let userCum = 0;
    for (const o of userOrdersAtMarket) {
      if (isBuy && o.shares > 0 && o.price <= ho.price) userCum += o.shares;
      else if (!isBuy && o.shares < 0 && o.price >= ho.price)
        userCum += o.shares;
    }

    // The baseline for the new order is the user's existing curve
    const baseline = isBuy
      ? Math.max(marketAtPrice, userCum)
      : Math.min(marketAtPrice, userCum);

    // Order size = distance from cursor to baseline
    const orderShares = isBuy
      ? Math.max(0, ho.shares - baseline)
      : Math.max(0, baseline - ho.shares);

    // Cancel: portion that reduces existing orders (cursor between baseline and market)
    // Take: portion that fills market liquidity (cursor beyond market curve)
    const cancelShares = isBuy
      ? Math.max(0, Math.min(orderShares, baseline - marketAtPrice))
      : Math.max(0, Math.min(orderShares, marketAtPrice - baseline));
    const takeShares = orderShares - cancelShares;
    const takeCost = takeShares * ho.price;
    const cancelCost = cancelShares * ho.price;
    const totalCost = takeCost + cancelCost;
    const avgPrice = orderShares > 0 ? totalCost / orderShares : 0;

    // --- Take region: rectangle from baseline to cursor level ---
    ctx.fillStyle = isBuy
      ? "rgba(29, 158, 117, 0.18)"
      : "rgba(226, 75, 74, 0.18)";
    ctx.beginPath();
    ctx.moveTo(cx(ho.price), cy(baseline));
    ctx.lineTo(cx(ho.price), cy(ho.shares));
    ctx.lineTo(cx(isBuy ? 1 : 0), cy(ho.shares));
    ctx.lineTo(cx(isBuy ? 1 : 0), cy(baseline));
    ctx.closePath();
    ctx.fill();

    // --- Highlight the curve from spread to hover price ---
    const sidePts = isBuy ? curve.asks : curve.bids;
    const spreadEdge = isBuy ? curve.bestAsk : curve.bestBid;
    if (sidePts.length > 0) {
      ctx.strokeStyle = color;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      // Start at the spread edge at zero volume
      ctx.moveTo(cx(spreadEdge), cy(0));
      let prevRatio = spreadEdge;
      let prevTotal = 0;
      for (const pt of sidePts) {
        // Stop drawing past the hover price
        if (isBuy ? pt.ratio > ho.price : pt.ratio < ho.price) {
          const dr = pt.ratio - prevRatio;
          const t = dr === 0 ? 0 : (ho.price - prevRatio) / dr;
          const interpTotal = prevTotal + t * (pt.total - prevTotal);
          ctx.lineTo(cx(ho.price), cy(isBuy ? interpTotal : -interpTotal));
          break;
        }
        ctx.lineTo(cx(pt.ratio), cy(isBuy ? pt.total : -pt.total));
        prevRatio = pt.ratio;
        prevTotal = pt.total;
      }
      // Close back along the baseline
      ctx.lineTo(cx(ho.price), cy(0));
      ctx.closePath();
      ctx.stroke();
    }

    // --- Dots at key points ---
    const pointX = cx(ho.price);
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(pointX, cy(marketAtPrice), 3, 0, 2 * Math.PI);
    ctx.arc(pointX, cy(ho.shares), 3, 0, 2 * Math.PI);
    if (userCum !== 0) {
      ctx.arc(pointX, cy(userCum), 3, 0, 2 * Math.PI);
    }
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
    const side = isBuy ? "BUY" : "SELL";

    let html = `<div class="cpv-ov-label">${side} @ ${ho.price.toFixed(3)}</div>`;
    html += `<div class="cpv-ov-row"><span>Shares</span><b>${fmtVol(orderShares)}</b></div>`;

    if (cancelShares > 0) {
      html += `<div class="cpv-ov-row"><span>Cancel</span><b>${fmtVol(cancelShares)} @ ${fmtUsd(cancelCost)}</b></div>`;
    }
    if (takeShares > 0) {
      html += `<div class="cpv-ov-row"><span>Take</span><b>${fmtVol(takeShares)} @ ${fmtUsd(takeCost)}</b></div>`;
    }

    html += `<div class="cpv-ov-row"><span>Total</span><b class="cpv-ov-green">${fmtUsd(totalCost)}</b></div>`;
    if (orderShares > 0) {
      html += `<div class="cpv-ov-row"><span>Avg&nbsp;p</span><b>${avgPrice.toFixed(3)}</b></div>`;
    }

    overlay.innerHTML = html;
    overlay.style.display = "block";

    const ovW = overlay.offsetWidth || 180;
    const ovH = overlay.offsetHeight || 100;
    // Center horizontally on cursor, clamp to chart bounds
    const ovX = Math.max(PAD.l, Math.min(mx! - PAD.r - ovW, W - PAD.r - ovW));
    // Place above cursor for buys (positive y), below for sells (negative y)
    const ovY = isBuy
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
