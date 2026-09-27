import {
  PRESSURE_MIN_VISIBLE_ALPHA,
  visibleSinceMs,
} from "@/lib/pressureField";
import type { PressureRenderRun } from "@/lib/materializedPressureField";
import { priceToNumber } from "@/lib/price";

export interface GpuPressureSurface {
  readonly runs: readonly PressureRenderRun[];
  /** O(1) validity timestamp for the currently resting portion of every run. */
  readonly currentValidThroughMs: number | undefined;
  readonly color: string;
  /** Mirror edge-local price p to display coordinate 1-p. */
  readonly mirrorPrice: boolean;
  /** CSS-space direction away from the row centerline. */
  readonly yDirection: -1 | 1;
}

export interface GpuPressureRow {
  readonly key: string;
  readonly centerCss: number;
  readonly heightCss: number;
  readonly surfaces: readonly GpuPressureSurface[];
}

export interface GpuPressureFrame {
  readonly rows: readonly GpuPressureRow[];
  readonly viewport: {
    readonly l: number;
    readonly width: number;
  };
  readonly cssWidth: number;
  readonly cssHeight: number;
  readonly dpr: number;
  readonly volumePerCssPixel: number;
  readonly ghostHalfLifeMs: number;
  readonly nowMs: number;
  readonly revision: number;
  readonly background: string;
}

const INSTANCE_FLOATS = 13;
const INSTANCE_STRIDE = INSTANCE_FLOATS * Float32Array.BYTES_PER_ELEMENT;
const MAX_SUPERSAMPLE_X = 2;
const MAX_SUPERSAMPLE_Y = 4;

const GEOMETRY_VERTEX = `#version 300 es
precision highp float;

layout(location = 0) in float aPriceLo;
layout(location = 1) in float aPriceHi;
layout(location = 2) in float aVolumeLo;
layout(location = 3) in float aVolumeHi;
layout(location = 4) in float aReferenceAlpha;
layout(location = 5) in float aCenterCss;
layout(location = 6) in float aRowHeightCss;
layout(location = 7) in float aMirrorPrice;
layout(location = 8) in float aYDirection;
layout(location = 9) in vec3 aColor;
layout(location = 10) in float aReserveShares;

uniform vec2 uCanvasCssSize;
uniform vec2 uPriceViewport;
uniform vec2 uRasterScale;

out vec3 vColor;
flat out vec4 vRectPx;
flat out float vReferenceAlpha;

const vec2 CORNERS[6] = vec2[6](
  vec2(0.0, 0.0),
  vec2(1.0, 0.0),
  vec2(0.0, 1.0),
  vec2(0.0, 1.0),
  vec2(1.0, 0.0),
  vec2(1.0, 1.0)
);

void main() {
  vec2 corner = CORNERS[gl_VertexID];

  float pressureLo =
      aVolumeLo <= 0.0 ? 0.0 : aVolumeLo / (aVolumeLo + aReserveShares);
  float pressureHi =
      aVolumeHi <= 0.0 ? 0.0 : aVolumeHi / (aVolumeHi + aReserveShares);

  float y0Css =
      aCenterCss + aYDirection * 0.5 * aRowHeightCss * pressureLo;
  float y1Css =
      aCenterCss + aYDirection * 0.5 * aRowHeightCss * pressureHi;
  float yMinCss = min(y0Css, y1Css);
  float yMaxCss = max(y0Css, y1Css);

  float p0 = aMirrorPrice > 0.5 ? 1.0 - aPriceLo : aPriceLo;
  float p1 = aMirrorPrice > 0.5 ? 1.0 - aPriceHi : aPriceHi;
  float x0Css = uPriceViewport.x + p0 * uPriceViewport.y;
  float x1Css = uPriceViewport.x + p1 * uPriceViewport.y;
  float xMinCss = min(x0Css, x1Css);
  float xMaxCss = max(x0Css, x1Css);

  // Exact rectangle in bottom-left-origin raster pixels.
  vRectPx = vec4(
    xMinCss * uRasterScale.x,
    (uCanvasCssSize.y - yMaxCss) * uRasterScale.y,
    xMaxCss * uRasterScale.x,
    (uCanvasCssSize.y - yMinCss) * uRasterScale.y
  );

  // Expand by half a raster pixel so partially covered edge pixels run.
  vec2 halfPixelCss = 0.5 / uRasterScale;
  float xCss = mix(
    xMinCss - halfPixelCss.x,
    xMaxCss + halfPixelCss.x,
    corner.x
  );
  float yCss = mix(
    yMinCss - halfPixelCss.y,
    yMaxCss + halfPixelCss.y,
    corner.y
  );

  vec2 clip = vec2(
    2.0 * xCss / uCanvasCssSize.x - 1.0,
    1.0 - 2.0 * yCss / uCanvasCssSize.y
  );

  gl_Position = vec4(clip, 0.0, 1.0);
  vColor = aColor;
  vReferenceAlpha = aReferenceAlpha;
}
`;

const GEOMETRY_FRAGMENT = `#version 300 es
precision highp float;

in vec3 vColor;
flat in vec4 vRectPx;
flat in float vReferenceAlpha;
out vec4 outColor;

void main() {
  vec2 pixelMin = gl_FragCoord.xy - 0.5;
  vec2 pixelMax = gl_FragCoord.xy + 0.5;
  vec2 overlap = max(
    vec2(0.0),
    min(vRectPx.zw, pixelMax) - max(vRectPx.xy, pixelMin)
  );
  float coverage = overlap.x * overlap.y;
  if (coverage <= 0.0) discard;

  float alpha = coverage * vReferenceAlpha;
  outColor = vec4(vColor * alpha, alpha);
}
`;

const DISPLAY_VERTEX = `#version 300 es
precision highp float;

out vec2 vUv;

const vec2 POSITIONS[3] = vec2[3](
  vec2(-1.0, -1.0),
  vec2(3.0, -1.0),
  vec2(-1.0, 3.0)
);

void main() {
  vec2 position = POSITIONS[gl_VertexID];
  vUv = position * 0.5 + 0.5;
  gl_Position = vec4(position, 0.0, 1.0);
}
`;

const DISPLAY_FRAGMENT = `#version 300 es
precision highp float;

uniform sampler2D uColor;
uniform float uGlobalDecay;
uniform ivec2 uSupersample;

out vec4 outColor;

void main() {
  ivec2 outputPixel = ivec2(gl_FragCoord.xy);
  ivec2 base = outputPixel * uSupersample;

  vec4 sum = vec4(0.0);
  for (int y = 0; y < 4; ++y) {
    for (int x = 0; x < 2; ++x) {
      if (x >= uSupersample.x || y >= uSupersample.y) continue;
      sum += texelFetch(uColor, base + ivec2(x, y), 0);
    }
  }

  float sampleCount = float(uSupersample.x * uSupersample.y);
  vec4 resolved = (sum / sampleCount) * uGlobalDecay;
  if (resolved.a <= 0.0039215686) discard;

  // Geometry stored premultiplied color at a fixed reference time. Exponential
  // decay factorizes, so advancing wall-clock time is one scalar multiply.
  outColor = resolved;
}
`;

export class GpuPressureLayer {
  private readonly gl: WebGL2RenderingContext;
  private readonly geometryProgram: WebGLProgram;
  private readonly displayProgram: WebGLProgram;
  private readonly geometryVao: WebGLVertexArrayObject;
  private readonly displayVao: WebGLVertexArrayObject;
  private readonly instanceBuffer: WebGLBuffer;
  private readonly framebuffer: WebGLFramebuffer;
  private readonly colorTexture: WebGLTexture;

  private displayWidth = 0;
  private displayHeight = 0;
  private targetWidth = 0;
  private targetHeight = 0;
  private supersampleX = 1;
  private supersampleY = 1;
  private geometryKey = "";
  private instanceCount = 0;
  private referenceTimeMs = 0;
  private visible = true;

  constructor(private readonly canvas: HTMLCanvasElement) {
    const gl = canvas.getContext("webgl2", {
      alpha: true,
      antialias: false,
      depth: true,
      premultipliedAlpha: true,
      preserveDrawingBuffer: false,
    });
    if (!gl) throw new Error("WebGL2 is required for pressure rendering");
    this.gl = gl;

    this.geometryProgram = createProgram(
      gl,
      GEOMETRY_VERTEX,
      GEOMETRY_FRAGMENT,
    );
    this.displayProgram = createProgram(gl, DISPLAY_VERTEX, DISPLAY_FRAGMENT);
    this.geometryVao = required(gl.createVertexArray(), "geometry VAO");
    this.displayVao = required(gl.createVertexArray(), "display VAO");
    this.instanceBuffer = required(gl.createBuffer(), "instance buffer");
    this.framebuffer = required(gl.createFramebuffer(), "framebuffer");
    this.colorTexture = required(gl.createTexture(), "color texture");

    gl.bindVertexArray(this.geometryVao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.instanceBuffer);

    for (let location = 0; location <= 8; location++) {
      gl.enableVertexAttribArray(location);
      gl.vertexAttribPointer(
        location,
        1,
        gl.FLOAT,
        false,
        INSTANCE_STRIDE,
        location * Float32Array.BYTES_PER_ELEMENT,
      );
      gl.vertexAttribDivisor(location, 1);
    }

    gl.enableVertexAttribArray(9);
    gl.vertexAttribPointer(
      9,
      3,
      gl.FLOAT,
      false,
      INSTANCE_STRIDE,
      9 * Float32Array.BYTES_PER_ELEMENT,
    );
    gl.vertexAttribDivisor(9, 1);

    gl.enableVertexAttribArray(10);
    gl.vertexAttribPointer(
      10,
      1,
      gl.FLOAT,
      false,
      INSTANCE_STRIDE,
      12 * Float32Array.BYTES_PER_ELEMENT,
    );
    gl.vertexAttribDivisor(10, 1);

    gl.bindVertexArray(null);
    gl.bindBuffer(gl.ARRAY_BUFFER, null);

    configureTexture(gl, this.colorTexture);
  }

  setVisible(visible: boolean): void {
    if (visible === this.visible) return;
    this.visible = visible;
    this.canvas.style.display = visible ? "block" : "none";
  }

  invalidate(): void {
    this.geometryKey = "";
  }

  render(frame: GpuPressureFrame): void {
    this.setVisible(true);
    this.canvas.style.background = frame.background;

    const displayWidth = Math.max(1, Math.floor(frame.cssWidth * frame.dpr));
    const displayHeight = Math.max(1, Math.floor(frame.cssHeight * frame.dpr));
    const [supersampleX, supersampleY] = supersampleFactors(frame.dpr);
    const targetWidth = displayWidth * supersampleX;
    const targetHeight = displayHeight * supersampleY;
    const resized = this.resizeTargets(
      displayWidth,
      displayHeight,
      targetWidth,
      targetHeight,
      supersampleX,
      supersampleY,
    );

    const key = geometryKey(frame, targetWidth, targetHeight);

    if (resized || key !== this.geometryKey) {
      this.rebuildGeometry(frame);
      this.geometryKey = key;
    }

    this.drawDisplay(frame);
  }

  destroy(): void {
    const gl = this.gl;
    gl.deleteTexture(this.colorTexture);
    gl.deleteFramebuffer(this.framebuffer);
    gl.deleteBuffer(this.instanceBuffer);
    gl.deleteVertexArray(this.geometryVao);
    gl.deleteVertexArray(this.displayVao);
    gl.deleteProgram(this.geometryProgram);
    gl.deleteProgram(this.displayProgram);
  }

  private resizeTargets(
    displayWidth: number,
    displayHeight: number,
    targetWidth: number,
    targetHeight: number,
    supersampleX: number,
    supersampleY: number,
  ): boolean {
    if (
      displayWidth === this.displayWidth &&
      displayHeight === this.displayHeight &&
      targetWidth === this.targetWidth &&
      targetHeight === this.targetHeight
    )
      return false;

    this.displayWidth = displayWidth;
    this.displayHeight = displayHeight;
    this.targetWidth = targetWidth;
    this.targetHeight = targetHeight;
    this.supersampleX = supersampleX;
    this.supersampleY = supersampleY;
    this.canvas.width = displayWidth;
    this.canvas.height = displayHeight;

    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, this.colorTexture);
    gl.texImage2D(
      gl.TEXTURE_2D,
      0,
      gl.RGBA8,
      targetWidth,
      targetHeight,
      0,
      gl.RGBA,
      gl.UNSIGNED_BYTE,
      null,
    );

    gl.bindFramebuffer(gl.FRAMEBUFFER, this.framebuffer);
    gl.framebufferTexture2D(
      gl.FRAMEBUFFER,
      gl.COLOR_ATTACHMENT0,
      gl.TEXTURE_2D,
      this.colorTexture,
      0,
    );
    const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    if (status !== gl.FRAMEBUFFER_COMPLETE)
      throw new Error(`pressure framebuffer is incomplete: ${status}`);

    return true;
  }

  private rebuildGeometry(frame: GpuPressureFrame): void {
    const gl = this.gl;
    const oldestVisibleMs = visibleSinceMs(
      frame.nowMs,
      frame.ghostHalfLifeMs,
      PRESSURE_MIN_VISIBLE_ALPHA,
    );
    this.referenceTimeMs = frame.nowMs;

    const values: number[] = [];
    for (const row of frame.rows) {
      const reserveShares = frame.volumePerCssPixel * row.heightCss;
      for (const surface of row.surfaces)
        appendRuns(
          values,
          surface.runs,
          row.centerCss,
          row.heightCss,
          reserveShares,
          resolveCssColor(surface.color),
          surface.mirrorPrice,
          surface.yDirection,
          surface.currentValidThroughMs,
          oldestVisibleMs,
          this.referenceTimeMs,
          frame.ghostHalfLifeMs,
        );
    }

    const instances = new Float32Array(values);
    this.instanceCount = instances.length / INSTANCE_FLOATS;

    gl.bindBuffer(gl.ARRAY_BUFFER, this.instanceBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, instances, gl.DYNAMIC_DRAW);
    gl.bindBuffer(gl.ARRAY_BUFFER, null);

    gl.bindFramebuffer(gl.FRAMEBUFFER, this.framebuffer);
    gl.viewport(0, 0, this.targetWidth, this.targetHeight);
    gl.disable(gl.DEPTH_TEST);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);

    if (this.instanceCount > 0) {
      gl.useProgram(this.geometryProgram);
      uniform2f(
        gl,
        this.geometryProgram,
        "uCanvasCssSize",
        frame.cssWidth,
        frame.cssHeight,
      );
      uniform2f(
        gl,
        this.geometryProgram,
        "uPriceViewport",
        frame.viewport.l,
        frame.viewport.width,
      );
      uniform2f(
        gl,
        this.geometryProgram,
        "uRasterScale",
        this.targetWidth / frame.cssWidth,
        this.targetHeight / frame.cssHeight,
      );

      // Materialized pressure runs already partition the price×volume surface:
      // every continuous point has exactly one timestamp. Additive
      // premultiplied blending therefore computes the exact box-filter integral
      // across cell boundaries, including boundaries between different ages.
      gl.enable(gl.BLEND);
      gl.blendEquation(gl.FUNC_ADD);
      gl.blendFunc(gl.ONE, gl.ONE);
      gl.bindVertexArray(this.geometryVao);
      gl.drawArraysInstanced(gl.TRIANGLES, 0, 6, this.instanceCount);
      gl.bindVertexArray(null);
      gl.disable(gl.BLEND);
    }

    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }

  private drawDisplay(frame: GpuPressureFrame): void {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, this.displayWidth, this.displayHeight);
    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.BLEND);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);

    if (this.instanceCount === 0) return;

    gl.useProgram(this.displayProgram);

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.colorTexture);
    uniform1i(gl, this.displayProgram, "uColor", 0);

    const elapsedMs = Math.max(0, frame.nowMs - this.referenceTimeMs);
    uniform1f(
      gl,
      this.displayProgram,
      "uGlobalDecay",
      2 ** (-elapsedMs / frame.ghostHalfLifeMs),
    );
    uniform2i(
      gl,
      this.displayProgram,
      "uSupersample",
      this.supersampleX,
      this.supersampleY,
    );

    gl.bindVertexArray(this.displayVao);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.bindVertexArray(null);
  }
}

function appendRuns(
  values: number[],
  runs: readonly PressureRenderRun[],
  centerCss: number,
  rowHeightCss: number,
  reserveShares: number,
  color: readonly [number, number, number],
  mirrorPrice: boolean,
  yDirection: -1 | 1,
  currentValidThroughMs: number | undefined,
  oldestVisibleMs: number,
  referenceTimeMs: number,
  halfLifeMs: number,
): void {
  for (const run of runs) {
    const priceLo = priceToNumber(run.lo);
    const priceHi = priceToNumber(run.hi);
    if (!(priceHi > priceLo)) continue;

    for (const band of run.bands) {
      const validThroughMs =
        currentValidThroughMs !== undefined && band.loVolume < run.volume
          ? Math.max(band.validThroughMs, currentValidThroughMs)
          : band.validThroughMs;

      if (!(band.hiVolume > band.loVolume) || validThroughMs <= oldestVisibleMs)
        continue;

      const referenceAlpha =
        2 ** (-Math.max(0, referenceTimeMs - validThroughMs) / halfLifeMs);
      if (!(referenceAlpha > 0)) continue;

      values.push(
        priceLo,
        priceHi,
        band.loVolume,
        band.hiVolume,
        referenceAlpha,
        centerCss,
        rowHeightCss,
        mirrorPrice ? 1 : 0,
        yDirection,
        color[0],
        color[1],
        color[2],
        reserveShares,
      );
    }
  }
}

function geometryKey(
  frame: GpuPressureFrame,
  width: number,
  height: number,
): string {
  const rows = frame.rows
    .map(
      (row) =>
        `${row.key}@${row.centerCss}:${row.heightCss}:${row.surfaces
          .map(
            (surface) =>
              `${surface.color}:${surface.mirrorPrice ? 1 : 0}:${surface.yDirection}`,
          )
          .join(",")}`,
    )
    .join("|");

  return [
    frame.revision,
    width,
    height,
    frame.viewport.l,
    frame.viewport.width,
    frame.volumePerCssPixel,
    frame.ghostHalfLifeMs,
    rows,
  ].join(";");
}

const CSS_COLOR_CACHE = new Map<string, readonly [number, number, number]>();
let colorContext: CanvasRenderingContext2D | null | undefined;

function resolveCssColor(css: string): readonly [number, number, number] {
  const cached = CSS_COLOR_CACHE.get(css);
  if (cached) return cached;

  if (colorContext === undefined) {
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = 1;
    colorContext = canvas.getContext("2d", { willReadFrequently: true });
  }
  if (!colorContext) throw new Error("2D canvas is required to resolve colors");

  colorContext.clearRect(0, 0, 1, 1);
  colorContext.fillStyle = css;
  colorContext.fillRect(0, 0, 1, 1);
  const pixel = colorContext.getImageData(0, 0, 1, 1).data;
  const rgb = [pixel[0]! / 255, pixel[1]! / 255, pixel[2]! / 255] as const;
  CSS_COLOR_CACHE.set(css, rgb);
  return rgb;
}

function configureTexture(
  gl: WebGL2RenderingContext,
  texture: WebGLTexture,
): void {
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.bindTexture(gl.TEXTURE_2D, null);
}

function createProgram(
  gl: WebGL2RenderingContext,
  vertexSource: string,
  fragmentSource: string,
): WebGLProgram {
  const vertex = compileShader(gl, gl.VERTEX_SHADER, vertexSource);
  const fragment = compileShader(gl, gl.FRAGMENT_SHADER, fragmentSource);
  const program = required(gl.createProgram(), "shader program");
  gl.attachShader(program, vertex);
  gl.attachShader(program, fragment);
  gl.linkProgram(program);
  gl.deleteShader(vertex);
  gl.deleteShader(fragment);

  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    const log = gl.getProgramInfoLog(program) ?? "unknown link error";
    gl.deleteProgram(program);
    throw new Error(`Could not link pressure shader: ${log}`);
  }
  return program;
}

function compileShader(
  gl: WebGL2RenderingContext,
  type: number,
  source: string,
): WebGLShader {
  const shader = required(gl.createShader(type), "shader");
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(shader) ?? "unknown compile error";
    gl.deleteShader(shader);
    throw new Error(`Could not compile pressure shader: ${log}`);
  }
  return shader;
}

function uniform1f(
  gl: WebGL2RenderingContext,
  program: WebGLProgram,
  name: string,
  value: number,
): void {
  gl.uniform1f(required(gl.getUniformLocation(program, name), name), value);
}

function uniform1i(
  gl: WebGL2RenderingContext,
  program: WebGLProgram,
  name: string,
  value: number,
): void {
  gl.uniform1i(required(gl.getUniformLocation(program, name), name), value);
}

function uniform2i(
  gl: WebGL2RenderingContext,
  program: WebGLProgram,
  name: string,
  x: number,
  y: number,
): void {
  gl.uniform2i(required(gl.getUniformLocation(program, name), name), x, y);
}

function uniform2f(
  gl: WebGL2RenderingContext,
  program: WebGLProgram,
  name: string,
  x: number,
  y: number,
): void {
  gl.uniform2f(required(gl.getUniformLocation(program, name), name), x, y);
}

function supersampleFactors(dpr: number): readonly [number, number] {
  // Target at least ~2 horizontal and ~4 vertical raster samples per CSS
  // pixel. HiDPI displays already supply some or all of that density.
  const x = dpr < 2 ? 2 : 1;
  const y = dpr < 2 ? 4 : dpr < 4 ? 2 : 1;
  return [x, y];
}

function required<T>(value: T | null, label: string): T {
  if (value === null) throw new Error(`Could not create/find ${label}`);
  return value;
}
