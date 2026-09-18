import { pressureInkThicknessCss } from "@/lib/pressureInk";
import type { TokenBook } from "@/lib/orderBook";
import type { Frame } from "@/lib/renderer";
import {
  signedVolumeColor,
  signedVolumeSegments,
  type SignedVolumeColorScale,
} from "@/lib/signedVolume";
import { rowRasterGeometry } from "./ageStripLayout";

/** Draw per-row probability rails using each market's semantic token colors. */
export function drawAgeAxes(
  frame: Frame,
  rowCount: number,
  labels: readonly HTMLLabelElement[],
  colorScaleForToken: (tokenId: string) => SignedVolumeColorScale,
): void {
  const { ctx, viewport: vp, theme } = frame;
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

  ctx.fillStyle = theme.text;
  if (ctx.font !== "11px sans-serif") ctx.font = "11px sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "top";
  ctx.fillText("0", vp.l, vp.t + vp.height + 8);
  ctx.fillText("1", vp.l + vp.width, vp.t + vp.height + 8);

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
): void {
  const { ctx, viewport: vp } = frame;
  const dpr = window.devicePixelRatio || 1;
  const geometry = rowRasterGeometry(frame.toScreenY(0, y), dpr);
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
    ctx.fillRect(
      x0,
      geometry.centerCss - thickness / 2,
      x1 - x0,
      thickness,
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
