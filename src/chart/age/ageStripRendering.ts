import type { Frame } from "@/rendering/renderer";
import {
  signedVolumeColor,
  type SignedVolumeColorScale,
} from "@/rendering/colors/signedVolume";
import type { RowRasterGeometry } from "./ageStripLayout";

/** Draw per-row probability rails using each market's semantic token colors. */
export function drawAgeAxes(
  frame: Frame,
  labels: readonly HTMLLabelElement[],
  rows: readonly RowRasterGeometry[],
  colorScaleForToken: (tokenId: string) => SignedVolumeColorScale,
): void {
  const { ctx, viewport: vp } = frame;

  ctx.lineWidth = 1;
  for (const [index, label] of labels.entries()) {
    const tokenId = label.dataset.tokenId;
    const row = rows[index];
    if (!tokenId || !row) continue;

    drawAgeRowRails(frame, row, colorScaleForToken(tokenId));
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
  ctx.lineTo(vp.l, geometry.bottomCss);
  ctx.stroke();

  ctx.strokeStyle = colors.positive;
  ctx.beginPath();
  ctx.moveTo(vp.l + vp.width, geometry.topCss);
  ctx.lineTo(vp.l + vp.width, geometry.bottomCss);
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
