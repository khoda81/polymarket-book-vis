import { PAD } from "./constants";
import {
  type Point,
  fmtVol,
  fmtUsd,
  powerOf10Ticks,
  hslColor,
  sliceCurveToY,
  calculateArea,
} from "./math";
import type { OrderBook } from "./ws";

export interface MarketInfo {
  groupItemTitle: string;
  clobTokenIds: string[];
  endDate: string;
}

export interface DrawState {
  markets: MarketInfo[];
  activeMarkets: Set<number>;
  books: Record<string, OrderBook>;
  volZoom: number;
  mx: number | null;
  my: number | null;
}

export interface DrawRefs {
  canvas: HTMLCanvasElement;
  overlay: HTMLDivElement;
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
        // Zero line: thicker, different color
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

  const mShares = inChart ? (((cy(0) - my!) * 2) / cH) * yAbsMax : 0;
  const hovering = inChart && mShares !== 0 && allCurves.length > 0;

  // Draw market curves
  activeIdxs.forEach((idx, i) => {
    const curve = allCurves[i];
    const combined = [...curve.bids.toReversed(), ...curve.asks];
    if (!combined.length) return;

    const color = hslColor(idx)!;
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

  // Draw hover region
  if (hovering) {
    const isBid = mShares < 0;
    const startIdx = 0;
    const endIdx = allCurves.length;

    const cL = allCurves[startIdx].bids;
    const cR =
      endIdx <= allCurves.length
        ? allCurves[endIdx - 1].asks
        : [
            { x: 1, y: 0 },
            { x: 1, y: mShares },
          ];

    if (cL.length && cR.length) {
      const sliceL = sliceCurveToY(
        cL.map(({ x, y }) => ({ x, y: -y })),
        -mShares,
      ).map(({ x, y }) => ({ x, y: -y }));
      const sliceR = sliceCurveToY(cR, mShares);

      if (sliceL.length && sliceR.length) {
        const colorL = hslColor(activeIdxs[startIdx])!;
        const colorR = hslColor(activeIdxs[endIdx - 1])!;

        // Filled region
        ctx.fillStyle = "rgba(100, 180, 255, 0.18)";
        ctx.beginPath();
        ctx.moveTo(cx(sliceL[0].x), cy(0));
        for (const pt of sliceL) ctx.lineTo(cx(pt.x), cy(pt.y));
        ctx.lineTo(cx(sliceR[sliceR.length - 1].x), cy(mShares));
        for (const pt of [...sliceR].reverse()) ctx.lineTo(cx(pt.x), cy(pt.y));
        ctx.closePath();
        ctx.fill();

        // Dashed horizontal cap line
        ctx.strokeStyle = isDark ? "rgba(255,255,255,0.5)" : "rgba(0,0,0,0.3)";
        ctx.lineWidth = 1.5;
        ctx.setLineDash([4, 4]);
        ctx.beginPath();
        ctx.moveTo(cx(sliceL[sliceL.length - 1].x), cy(mShares));
        ctx.lineTo(cx(sliceR[sliceR.length - 1].x), cy(mShares));
        ctx.stroke();
        ctx.setLineDash([]);

        // Active left edge
        ctx.strokeStyle = colorL;
        ctx.lineWidth = 2.5;
        ctx.beginPath();
        sliceL.forEach((pt, j) =>
          j === 0
            ? ctx.moveTo(cx(pt.x), cy(pt.y))
            : ctx.lineTo(cx(pt.x), cy(pt.y)),
        );
        ctx.stroke();

        // Active right edge
        ctx.strokeStyle = colorR;
        ctx.lineWidth = 2.5;
        ctx.beginPath();
        sliceR.forEach((pt, j) =>
          j === 0
            ? ctx.moveTo(cx(pt.x), cy(pt.y))
            : ctx.lineTo(cx(pt.x), cy(pt.y)),
        );
        ctx.stroke();

        // Compute area = USD cost
        const costUsd = calculateArea(sliceL, sliceR);

        const mL = state.markets[activeIdxs[startIdx]]?.groupItemTitle;
        const mR = state.markets[activeIdxs[endIdx - 1]]?.groupItemTitle;
        const label = `${mL} → ${mR}`;

        overlay.innerHTML = `
          <div class="cpv-ov-label">${label}</div>
          <div class="cpv-ov-row">
            <span>Cost</span><b class="cpv-ov-green">${fmtUsd(costUsd)}</b>
          </div>
          <div class="cpv-ov-row">
            <span>Payout</span><b>${fmtVol(Math.abs(mShares))} shares</b>
          </div>
          <div class="cpv-ov-row">
            <span>Implied&nbsp;p</span><b>${(costUsd / Math.abs(mShares)).toFixed(3)}</b>
          </div>`;
        overlay.style.display = "block";

        const ovW = overlay.offsetWidth || 180;
        const ovX = mx! + 16 + ovW > W ? mx! - ovW - 8 : mx! + 16;
        overlay.style.left = ovX + "px";
        overlay.style.top = Math.max(PAD.t, Math.min(my! - 20, H - 120)) + "px";
      } else {
        overlay.style.display = "none";
      }
    }
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
