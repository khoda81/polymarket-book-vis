import { pressureInkThicknessCss } from "@/lib/pressureInk";
import {
  ghostAlpha,
  ghostVisibleSinceMs,
  type PressureBand,
  type PressureCell,
} from "@/lib/pressureMemory";
import type { Frame } from "@/lib/renderer";
import {
  rasterizeNestedBands,
  type NestedRasterLayer,
  type RgbColor,
} from "./nestedBandRaster";
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

  // Mirrored token orientation: opposite on the left, primary on the right.
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
  if (cells.length === 0) return;
  const { ctx, viewport: vp } = frame;
  const dpr = window.devicePixelRatio || 1;
  const geometry = offsetRowGeometry(
    rowRasterGeometry(frame.toScreenY(0, y), dpr),
    rowOffsetCss,
  );
  const reserveShares = volumePerCssPixel * geometry.heightCss;
  const colors = pressureColors(colorScale);
  const rgbColors = pressureRgbColors(colorScale, colors);
  const visibleGhostSinceMs = ghostVisibleSinceMs(nowMs, ghostHalfLifeMs);

  ctx.save();
  ctx.beginPath();
  ctx.rect(vp.l, geometry.topCss, vp.width, geometry.heightCss);
  ctx.clip();

  for (const cell of cells) {
    const displayLo = 1 - clamp(cell.hi, 0, 1);
    const displayHi = 1 - clamp(cell.lo, 0, 1);
    const x0 = snapToDevicePixel(vp.l + displayLo * vp.width, dpr);
    const x1 = snapToDevicePixel(vp.l + displayHi * vp.width, dpr);
    if (!(x1 > x0)) continue;

    drawMemoryBands(
      ctx,
      geometry.centerCss,
      x0,
      x1,
      cell.bands,
      rgbColors.positive,
      rgbColors.negative,
      reserveShares,
      geometry.heightCss,
      ghostHalfLifeMs,
      nowMs,
      visibleGhostSinceMs,
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
  positiveColor: RgbColor,
  negativeColor: RgbColor,
  reserveShares: number,
  rowHeightCss: number,
  ghostHalfLifeMs: number,
  nowMs: number,
  visibleGhostSinceMs: number,
): void {
  const dpr = window.devicePixelRatio || 1;
  const rowTopDevice = Math.floor((centerY - rowHeightCss / 2) * dpr);
  const rowHeightDevice =
    Math.ceil((centerY + rowHeightCss / 2) * dpr) - rowTopDevice;
  const centerDevice = centerY * dpr;

  // Build the exact nested layer stack first. Opacity belongs to temporal
  // state; subpixel coverage belongs to geometry and is applied later by the
  // rasterizer. Keeping those two concepts separate prevents overlapping
  // anti-aliased rectangles from charging the same device pixel twice.
  const layers: NestedRasterLayer[] = [];
  let coveredAlpha = 0;

  for (let index = bands.length - 1; index >= 0; index--) {
    const band = bands[index]!;
    if (
      band.state.kind === "ghost" &&
      band.state.sinceMs <= visibleGhostSinceMs
    )
      continue;

    const targetAlpha =
      band.state.kind === "live"
        ? 1
        : ghostAlpha(band.state.sinceMs, nowMs, ghostHalfLifeMs);
    if (!(targetAlpha > 1 / 255)) continue;

    const sourceAlpha =
      coveredAlpha >= 1
        ? 0
        : Math.max(
            0,
            Math.min(1, (targetAlpha - coveredAlpha) / (1 - coveredAlpha)),
          );
    coveredAlpha = Math.max(coveredAlpha, targetAlpha);
    if (!(sourceAlpha > 1 / 255)) continue;

    const thickness = pressureInkThicknessCss(
      band.hiVolume,
      reserveShares,
      rowHeightCss,
    );
    if (!(thickness > 0)) continue;

    layers.push({
      halfThickness: (thickness * dpr) / 2,
      alpha: sourceAlpha,
      color: band.side < 0 ? negativeColor : positiveColor,
    });
  }

  if (layers.length === 0) return;
  const pixels = rasterizeNestedBands(
    layers,
    centerDevice,
    rowTopDevice,
    rowHeightDevice,
  );
  const raster = pressureRasterCanvas(rowHeightDevice);
  const image = raster.ctx.createImageData(1, rowHeightDevice);
  image.data.set(pixels);
  raster.ctx.putImageData(image, 0, 0);
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(
    raster.canvas,
    x0,
    rowTopDevice / dpr,
    x1 - x0,
    rowHeightDevice / dpr,
  );
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

interface PressureRgbColors {
  readonly positive: RgbColor;
  readonly negative: RgbColor;
}

const PRESSURE_RGB_CACHE = new WeakMap<
  SignedVolumeColorScale,
  PressureRgbColors
>();

function pressureRgbColors(
  scale: SignedVolumeColorScale,
  colors: PressureColors,
): PressureRgbColors {
  const cached = PRESSURE_RGB_CACHE.get(scale);
  if (cached) return cached;

  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 1;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) throw new Error("2D canvas context is not available");

  const sample = (color: string): RgbColor => {
    ctx.fillStyle = color;
    ctx.fillRect(0, 0, 1, 1);
    const pixel = ctx.getImageData(0, 0, 1, 1).data;
    return {
      r: pixel[0]! / 255,
      g: pixel[1]! / 255,
      b: pixel[2]! / 255,
    };
  };
  const rgb = {
    positive: sample(colors.positive),
    negative: sample(colors.negative),
  };
  PRESSURE_RGB_CACHE.set(scale, rgb);
  return rgb;
}

let pressureRaster: {
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
} | null = null;

function pressureRasterCanvas(height: number) {
  if (!pressureRaster) {
    const canvas = document.createElement("canvas");
    canvas.width = 1;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("2D canvas context is not available");
    pressureRaster = { canvas, ctx };
  }
  if (pressureRaster.canvas.height !== height) {
    pressureRaster.canvas.width = 1;
    pressureRaster.canvas.height = height;
  }
  return pressureRaster;
}

function snapToDevicePixel(value: number, dpr: number): number {
  return Math.round(value * dpr) / dpr;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
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
