import type { Frame } from "@/lib/renderer";
import {
  signedVolumeColor,
  type SignedVolumeColorScale,
} from "@/lib/signedVolume";
import { rowRasterGeometry, type RowRasterGeometry } from "./ageStripLayout";

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
    const geometry = rowRasterGeometry(frame.toScreenY(0, y), dpr);
    drawAgeRowRails(frame, geometry, colorScaleForToken(tokenId));
  }

  ctx.beginPath();
  ctx.rect(vp.l, vp.t, vp.width, vp.height);
  ctx.clip();
}

export function drawAgeRowRails(
  frame: Frame,
  geometry: RowRasterGeometry,
  colorScale: SignedVolumeColorScale,
): void {
  const { ctx, viewport: vp } = frame;
  const colors = pressureColors(colorScale);

  // Geometry is sourced from the complementary token field. Keep the
  // rails aligned with the semantic token shown on each rendered half.
  ctx.lineWidth = 1;
  ctx.strokeStyle = colors.negative;
  ctx.beginPath();
  ctx.moveTo(vp.l, geometry.topCss);
  ctx.lineTo(vp.l, geometry.topCss + geometry.heightCss);
  ctx.stroke();

  ctx.strokeStyle = colors.positive;
  ctx.beginPath();
  ctx.moveTo(vp.l + vp.width, geometry.topCss);
  ctx.lineTo(vp.l + vp.width, geometry.topCss + geometry.heightCss);
  ctx.stroke();
}

interface PressureColors {
  readonly positive: string;
  readonly negative: string;
}

const PRESSURE_COLOR_CACHE = new WeakMap<
  SignedVolumeColorScale,
  PressureColors
>();

function pressureColors(scale: SignedVolumeColorScale): PressureColors {
  const cached = PRESSURE_COLOR_CACHE.get(scale);
  if (cached) return cached;

  const colors = {
    positive: signedVolumeColor(1, scale),
    negative: signedVolumeColor(-1, scale),
  };
  PRESSURE_COLOR_CACHE.set(scale, colors);
  return colors;
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
  const colors = pressureColors(colorScale);
  const color = side === "primary" ? colors.positive : colors.negative;

  ctx.save();
  ctx.beginPath();
  ctx.rect(vp.l, geometry.topCss, vp.width, geometry.heightCss);
  ctx.clip();

  // Resolution lives behind pressure memory: surviving ghosts remain legible,
  // while the empty book still carries a persistent semantic result.
  ctx.fillStyle = color;
  ctx.globalAlpha = 0.025;
  ctx.fillRect(vp.l, geometry.topCss, vp.width, geometry.heightCss);

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
  ctx.moveTo(vp.l, geometry.topCss + geometry.heightCss - 0.5 / dpr);
  ctx.lineTo(vp.l + vp.width, geometry.topCss + geometry.heightCss - 0.5 / dpr);
  ctx.stroke();

  if (outcome) {
    ctx.globalAlpha = 0.9;
    ctx.fillStyle = color;
    ctx.font = "600 10px sans-serif";
    ctx.textBaseline = "middle";
    ctx.textAlign = side === "primary" ? "left" : "right";
    ctx.fillText(
      outcome,
      side === "primary" ? vp.l + 7 : vp.l + vp.width - 7,
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
