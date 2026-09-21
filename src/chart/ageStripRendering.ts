import { ghostVisibleSinceMs } from "@/lib/pressureField";
import type { PressureFrontierMemory } from "@/lib/pressureFrontierMemory";
import type { Frame } from "@/lib/renderer";
import {
  rasterizePressureBandsInto,
  type RgbColor,
} from "./pressureFieldRaster";
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
  memory: PressureFrontierMemory,
  colorScale: SignedVolumeColorScale,
  volumePerCssPixel: number,
  ghostHalfLifeMs: number,
  nowMs: number,
  rowOffsetCss = 0,
): void {
  const boundaries = memory.priceBoundaries();
  if (boundaries.length < 2) return;

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

  const rowTopDevice = Math.floor(
    (geometry.centerCss - geometry.heightCss / 2) * dpr,
  );
  const rowBottomDevice = Math.ceil(
    (geometry.centerCss + geometry.heightCss / 2) * dpr,
  );
  const rowHeightDevice = Math.max(1, rowBottomDevice - rowTopDevice);
  const centerDevice = geometry.centerCss * dpr;

  const rowLeftDevice = Math.round(vp.l * dpr);
  const rowRightDevice = Math.round((vp.l + vp.width) * dpr);
  const rowWidthDevice = Math.max(1, rowRightDevice - rowLeftDevice);
  const raster = pressureRowRasterCanvas(rowWidthDevice, rowHeightDevice);
  raster.image.data.fill(0);

  const packed = new Uint32Array(
    raster.image.data.buffer,
    raster.image.data.byteOffset,
    raster.image.data.byteLength / 4,
  );

  for (let index = 0; index + 1 < boundaries.length; index++) {
    const lo = boundaries[index]!;
    const hi = boundaries[index + 1]!;
    if (!(hi > lo)) continue;

    const bands = memory.shellsAtPrice((lo + hi) / 2, visibleGhostSinceMs);
    if (bands.length === 0) continue;

    rasterizePressureBandsInto(
      bands,
      {
        positiveColor: rgbColors.positive,
        negativeColor: rgbColors.negative,
        reserveShares,
        rowHeightCss: geometry.heightCss,
        dpr,
        ghostHalfLifeMs,
        nowMs,
        visibleGhostSinceMs,
        centerDevice,
        topDevice: rowTopDevice,
        heightDevice: rowHeightDevice,
      },
      raster.column,
    );

    // Age view mirrors canonical YES price horizontally.
    const x0Device = Math.round((vp.l + (1 - hi) * vp.width) * dpr);
    const x1Device = Math.round((vp.l + (1 - lo) * vp.width) * dpr);
    const x0 = clamp(x0Device - rowLeftDevice, 0, rowWidthDevice);
    const x1 = clamp(x1Device - rowLeftDevice, 0, rowWidthDevice);
    if (!(x1 > x0)) continue;

    for (let row = 0; row < rowHeightDevice; row++) {
      const offset = row * 4;
      const rgba = packRgba(
        raster.column[offset]!,
        raster.column[offset + 1]!,
        raster.column[offset + 2]!,
        raster.column[offset + 3]!,
      );
      if (rgba >>> 24 === 0 && LITTLE_ENDIAN) continue;
      if (!LITTLE_ENDIAN && (rgba & 0xff) === 0) continue;
      packed.fill(rgba, row * rowWidthDevice + x0, row * rowWidthDevice + x1);
    }
  }

  raster.ctx.putImageData(raster.image, 0, 0);
  ctx.save();
  ctx.globalAlpha = 1;
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(
    raster.canvas,
    rowLeftDevice / dpr,
    rowTopDevice / dpr,
    rowWidthDevice / dpr,
    rowHeightDevice / dpr,
  );
  ctx.restore();
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

let pressureRowRaster: {
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
  image: ImageData;
  column: Uint8ClampedArray;
} | null = null;

function pressureRowRasterCanvas(width: number, height: number) {
  if (!pressureRowRaster) {
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("2D canvas context is not available");
    pressureRowRaster = {
      canvas,
      ctx,
      image: ctx.createImageData(width, height),
      column: new Uint8ClampedArray(height * 4),
    };
  } else if (
    pressureRowRaster.canvas.width !== width ||
    pressureRowRaster.canvas.height !== height
  ) {
    pressureRowRaster.canvas.width = width;
    pressureRowRaster.canvas.height = height;
    pressureRowRaster.image = pressureRowRaster.ctx.createImageData(
      width,
      height,
    );
    pressureRowRaster.column = new Uint8ClampedArray(height * 4);
  }
  return pressureRowRaster;
}

const LITTLE_ENDIAN =
  new Uint8Array(new Uint32Array([0x01020304]).buffer)[0] === 0x04;

function packRgba(r: number, g: number, b: number, a: number): number {
  return LITTLE_ENDIAN
    ? (r | (g << 8) | (b << 16) | (a << 24)) >>> 0
    : ((r << 24) | (g << 16) | (b << 8) | a) >>> 0;
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
