import { pressureInkThicknessCss } from "@/lib/pressureInk";
import type { TokenBook } from "@/lib/orderBook";
import {
  ghostAlpha,
  type PressureBand,
  type PressureCell,
} from "@/lib/pressureMemory";
import type { Frame } from "@/lib/renderer";
import {
  signedVolumeColor,
  signedVolumeSegments,
  type SignedVolumeColorScale,
} from "@/lib/signedVolume";
import {
  rowRasterGeometry,
  type RowRasterGeometry,
} from "./ageStripLayout";

/** Draw per-row probability rails using each market's semantic token colors. */
export function drawAgeAxes(
  frame: Frame,
  rowCount: number,
  labels: readonly HTMLLabelElement[],
  colorScaleForToken: (tokenId: string) => SignedVolumeColorScale,
): void {
  const { ctx, viewport: vp } = frame;
  const dpr = window.devicePixelRatio || 1;

  ctx.lineWidth = 1;
  for (const [index, label] of labels.entries()) {
    const tokenId = label.dataset.tokenId;
    if (!tokenId) continue;

    const y = rowCount - 1 - index;
    const geometry = rowRasterGeometry(
      frame.toScreenY(0, y),
      dpr,
    );
    const scale = colorScaleForToken(tokenId);

    // Mirrored token orientation: opposite on the left, primary on the right.
    ctx.strokeStyle = signedVolumeColor(-1, scale);
    ctx.beginPath();
    ctx.moveTo(vp.l, geometry.topCss);
    ctx.lineTo(
      vp.l,
      geometry.topCss + geometry.heightCss,
    );
    ctx.stroke();

    ctx.strokeStyle = signedVolumeColor(1, scale);
    ctx.beginPath();
    ctx.moveTo(vp.l + vp.width, geometry.topCss);
    ctx.lineTo(
      vp.l + vp.width,
      geometry.topCss + geometry.heightCss,
    );
    ctx.stroke();
  }

  ctx.beginPath();
  ctx.rect(vp.l, vp.t, vp.width, vp.height);
  ctx.clip();
}

export function drawLivePressureStrip(
  frame: Frame,
  y: number,
  book: TokenBook<string>,
  colorScale: SignedVolumeColorScale,
  volumePerCssPixel: number,
  rowOffsetCss = 0,
): void {
  const { ctx, viewport: vp } = frame;
  const dpr = window.devicePixelRatio || 1;
  const geometry = offsetRowGeometry(
    rowRasterGeometry(frame.toScreenY(0, y), dpr),
    rowOffsetCss,
  );
  const reserveShares =
    volumePerCssPixel * geometry.heightCss;

  ctx.save();
  ctx.beginPath();
  ctx.rect(
    vp.l,
    geometry.topCss,
    vp.width,
    geometry.heightCss,
  );
  ctx.clip();

  for (const segment of signedVolumeSegments(book)) {
    if (
      segment.volume === 0 ||
      Number.isNaN(segment.volume)
    )
      continue;

    // signedVolumeSegments is expressed in canonical primary-token price.
    // Mirror it for age view so opposite liquidity is left and primary right.
    const displayLo = 1 - clamp(segment.hi, 0, 1);
    const displayHi = 1 - clamp(segment.lo, 0, 1);
    const x0 = snapToDevicePixel(
      vp.l + displayLo * vp.width,
      dpr,
    );
    const x1 = snapToDevicePixel(
      vp.l + displayHi * vp.width,
      dpr,
    );
    if (!(x1 > x0)) continue;

    const thickness = pressureInkThicknessCss(
      segment.volume,
      reserveShares,
      geometry.heightCss,
    );

    if (!(thickness > 0)) continue;

    ctx.fillStyle = signedVolumeColor(
      segment.volume,
      colorScale,
    );

    const boundedThickness = Math.max(0.5 / dpr, thickness);
    ctx.fillRect(
      x0,
      geometry.centerCss - boundedThickness / 2,
      x1 - x0,
      boundedThickness,
    );
  }

  ctx.restore();
}

function snapToDevicePixel(
  value: number,
  dpr: number,
): number {
  return Math.round(value * dpr) / dpr;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}


export function drawPressureMemoryStrip(
  frame: Frame,
  y: number,
  cells: readonly PressureCell[],
  colorScale: SignedVolumeColorScale,
  volumePerCssPixel: number,
  ghostHalfLifeMs: number,
  nowMs: number,
  rowOffsetCss = 0,
): void {
  const { ctx, viewport: vp } = frame;
  const dpr = window.devicePixelRatio || 1;
  const geometry = offsetRowGeometry(
    rowRasterGeometry(frame.toScreenY(0, y), dpr),
    rowOffsetCss,
  );
  const reserveShares =
    volumePerCssPixel * geometry.heightCss;

  ctx.save();
  ctx.beginPath();
  ctx.rect(
    vp.l,
    geometry.topCss,
    vp.width,
    geometry.heightCss,
  );
  ctx.clip();

  for (const cell of cells) {
    const displayLo = 1 - clamp(cell.hi, 0, 1);
    const displayHi = 1 - clamp(cell.lo, 0, 1);
    const x0 = snapToDevicePixel(
      vp.l + displayLo * vp.width,
      dpr,
    );
    const x1 = snapToDevicePixel(
      vp.l + displayHi * vp.width,
      dpr,
    );
    if (!(x1 > x0)) continue;

    drawMemoryBands(
      ctx,
      geometry.centerCss,
      x0,
      x1,
      cell.bands,
      colorScale,
      reserveShares,
      geometry.heightCss,
      ghostHalfLifeMs,
      nowMs,
    );
  }

  ctx.restore();
}

function drawMemoryBands(
  ctx: CanvasRenderingContext2D,
  centerY: number,
  x0: number,
  x1: number,
  bands: readonly PressureBand[],
  colorScale: SignedVolumeColorScale,
  reserveShares: number,
  rowHeightCss: number,
  ghostHalfLifeMs: number,
  nowMs: number,
): void {
  // Paint outer history first, then progressively newer inner envelopes.
  //
  // This is deliberately *not* drawn as adjacent translucent shells. Canvas
  // anti-aliases each fill independently, so two shell edges sharing the same
  // fractional pixel can double-blend and look like a dark stroke. Nested
  // rectangles have only one anti-aliased edge at each boundary.
  //
  // For equal colors the alpha correction below reproduces the exact requested
  // opacity for every band. If the side changed, source-over naturally mixes
  // the old/new colors at the boundary and gives us the desired "rainbow"
  // history without dark seams.
  let coveredAlpha = 0;

  for (let index = bands.length - 1; index >= 0; index--) {
    const band = bands[index]!;
    const targetAlpha =
      band.state.kind === "live"
        ? 1
        : ghostAlpha(
            band.state.sinceMs,
            nowMs,
            ghostHalfLifeMs,
          );
    if (!(targetAlpha > 1 / 255)) continue;

    // PressureMemory guarantees newer/inner bands are at least as opaque as
    // older/outer bands. Solve source-over for the alpha needed to move from
    // the already-painted outer alpha to this band's target alpha.
    const sourceAlpha =
      coveredAlpha >= 1
        ? 0
        : Math.max(
            0,
            Math.min(
              1,
              (targetAlpha - coveredAlpha) /
                (1 - coveredAlpha),
            ),
          );
    coveredAlpha = Math.max(coveredAlpha, targetAlpha);
    if (!(sourceAlpha > 1 / 255)) continue;

    const thickness = pressureInkThicknessCss(
      band.hiVolume,
      reserveShares,
      rowHeightCss,
    );
    if (!(thickness > 0)) continue;

    ctx.globalAlpha = sourceAlpha;
    ctx.fillStyle = signedVolumeColor(
      band.side,
      colorScale,
    );
    ctx.fillRect(
      x0,
      centerY - thickness / 2,
      x1 - x0,
      thickness,
    );
  }
}

export function drawResolvedMarketStrip(
  frame: Frame,
  y: number,
  side: "primary" | "opposite",
  outcome: string,
  colorScale: SignedVolumeColorScale,
  rowOffsetCss = 0,
): void {
  const { ctx, viewport: vp } = frame;
  const dpr = window.devicePixelRatio || 1;
  const geometry = offsetRowGeometry(
    rowRasterGeometry(frame.toScreenY(0, y), dpr),
    rowOffsetCss,
  );
  const color = signedVolumeColor(
    side === "primary" ? 1 : -1,
    colorScale,
  );

  ctx.save();
  ctx.beginPath();
  ctx.rect(
    vp.l,
    geometry.topCss,
    vp.width,
    geometry.heightCss,
  );
  ctx.clip();

  // Resolution lives behind pressure memory: surviving ghosts remain legible,
  // while the empty book still carries a persistent semantic result.
  ctx.fillStyle = color;
  ctx.globalAlpha = 0.025;
  ctx.fillRect(
    vp.l,
    geometry.topCss,
    vp.width,
    geometry.heightCss,
  );

  ctx.strokeStyle = color;
  ctx.lineWidth = 1;
  ctx.globalAlpha = 0.18;
  const spacing = 18;
  const run = geometry.heightCss + spacing;
  for (
    let x = vp.l - geometry.heightCss;
    x < vp.l + vp.width + geometry.heightCss;
    x += spacing
  ) {
    ctx.beginPath();
    ctx.moveTo(x, geometry.topCss + geometry.heightCss);
    ctx.lineTo(x + run, geometry.topCss);
    ctx.stroke();
  }

  ctx.globalAlpha = 0.52;
  ctx.beginPath();
  ctx.moveTo(vp.l, geometry.topCss + 0.5 / dpr);
  ctx.lineTo(vp.l + vp.width, geometry.topCss + 0.5 / dpr);
  ctx.moveTo(
    vp.l,
    geometry.topCss + geometry.heightCss - 0.5 / dpr,
  );
  ctx.lineTo(
    vp.l + vp.width,
    geometry.topCss + geometry.heightCss - 0.5 / dpr,
  );
  ctx.stroke();

  if (outcome) {
    ctx.globalAlpha = 0.9;
    ctx.fillStyle = color;
    ctx.font = "600 10px sans-serif";
    ctx.textBaseline = "middle";
    ctx.textAlign = side === "primary" ? "right" : "left";
    ctx.fillText(
      outcome,
      side === "primary" ? vp.l + vp.width - 7 : vp.l + 7,
      geometry.centerCss,
    );
  }

  ctx.restore();
}


function offsetRowGeometry(
  geometry: RowRasterGeometry,
  offsetCss: number,
): RowRasterGeometry {
  if (offsetCss === 0) return geometry;
  return {
    ...geometry,
    topCss: geometry.topCss + offsetCss,
    centerCss: geometry.centerCss + offsetCss,
  };
}
