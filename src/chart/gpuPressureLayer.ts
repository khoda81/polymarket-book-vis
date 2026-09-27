import { visibleSinceMs } from "@/lib/pressureField";
import type { PressureRenderRun } from "@/lib/materializedPressureField";
import { priceToNumber } from "@/lib/price";

export interface GpuPressureSurface {
  readonly runs: readonly PressureRenderRun[];
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
const MIN_ALPHA = 1 / 255;

const GEOMETRY_VERTEX = `#version 300 es
precision highp float;

layout(location = 0) in float aPriceLo;
layout(location = 1) in float aPriceHi;
layout(location = 2) in float aVolumeLo;
layout(location = 3) in float aVolumeHi;
layout(location = 4) in float aDepth;
layout(location = 5) in float aCenterCss;
layout(location = 6) in float aRowHeightCss;
layout(location = 7) in float aMirrorPrice;
layout(location = 8) in float aYDirection;
layout(location = 9) in vec3 aColor;
layout(location = 10) in float aReserveShares;

uniform vec2 uCanvasCssSize;
uniform vec2 uPriceViewport;

out vec3 vColor;

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
  float price = mix(aPriceLo, aPriceHi, corner.x);
  float volume = mix(aVolumeLo, aVolumeHi, corner.y);
  float pressure = volume <= 0.0 ? 0.0 : volume / (volume + aReserveShares);

  float yCss =
      aCenterCss + aYDirection * 0.5 * aRowHeightCss * pressure;

  // The field itself is perspective-free. Rendering chooses whether an
  // edge-local price is viewed directly or through its complementary axis.
  float displayPrice = aMirrorPrice > 0.5 ? 1.0 - price : price;
  float xCss = uPriceViewport.x + displayPrice * uPriceViewport.y;
  vec2 clip = vec2(
    2.0 * xCss / uCanvasCssSize.x - 1.0,
    1.0 - 2.0 * yCss / uCanvasCssSize.y
  );

  // WebGL maps NDC z [-1, 1] to depth [0, 1].
  gl_Position = vec4(clip, aDepth * 2.0 - 1.0, 1.0);
  vColor = aColor;
}
`;

const GEOMETRY_FRAGMENT = `#version 300 es
precision highp float;

in vec3 vColor;
out vec4 outColor;

void main() {
  outColor = vec4(vColor, 1.0);
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
uniform sampler2D uDepth;
uniform float uNowRelativeMs;
uniform float uTimeSpanMs;
uniform float uHalfLifeMs;

in vec2 vUv;
out vec4 outColor;

void main() {
  vec4 source = texture(uColor, vUv);
  if (source.a <= 0.0) discard;

  float depth = texture(uDepth, vUv).r;
  float ageMs = max(0.0, uNowRelativeMs - depth * uTimeSpanMs);
  float alpha = exp2(-ageMs / uHalfLifeMs);
  if (alpha <= 0.0039215686) discard;

  // The browser expects a premultiplied-alpha WebGL backing store.
  outColor = vec4(source.rgb * alpha, alpha);
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
  private readonly depthTexture: WebGLTexture;

  private targetWidth = 0;
  private targetHeight = 0;
  private geometryKey = "";
  private instanceCount = 0;
  private timeOriginMs = 0;
  private timeSpanMs = 1;
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
    this.depthTexture = required(gl.createTexture(), "depth texture");

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
    configureTexture(gl, this.depthTexture);
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

    const width = Math.max(1, Math.floor(frame.cssWidth * frame.dpr));
    const height = Math.max(1, Math.floor(frame.cssHeight * frame.dpr));
    const resized = this.resizeTargets(width, height);

    const key = geometryKey(frame, width, height);
    const rangeExpired =
      this.timeSpanMs <= 0 ||
      frame.nowMs - this.timeOriginMs > this.timeSpanMs * 0.78;

    if (resized || key !== this.geometryKey || rangeExpired) {
      this.rebuildGeometry(frame);
      this.geometryKey = key;
    }

    this.drawDisplay(frame);
  }

  destroy(): void {
    const gl = this.gl;
    gl.deleteTexture(this.colorTexture);
    gl.deleteTexture(this.depthTexture);
    gl.deleteFramebuffer(this.framebuffer);
    gl.deleteBuffer(this.instanceBuffer);
    gl.deleteVertexArray(this.geometryVao);
    gl.deleteVertexArray(this.displayVao);
    gl.deleteProgram(this.geometryProgram);
    gl.deleteProgram(this.displayProgram);
  }

  private resizeTargets(width: number, height: number): boolean {
    if (width === this.targetWidth && height === this.targetHeight)
      return false;

    this.targetWidth = width;
    this.targetHeight = height;
    this.canvas.width = width;
    this.canvas.height = height;

    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, this.colorTexture);
    gl.texImage2D(
      gl.TEXTURE_2D,
      0,
      gl.RGBA8,
      width,
      height,
      0,
      gl.RGBA,
      gl.UNSIGNED_BYTE,
      null,
    );

    gl.bindTexture(gl.TEXTURE_2D, this.depthTexture);
    gl.texImage2D(
      gl.TEXTURE_2D,
      0,
      gl.DEPTH_COMPONENT24,
      width,
      height,
      0,
      gl.DEPTH_COMPONENT,
      gl.UNSIGNED_INT,
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
    gl.framebufferTexture2D(
      gl.FRAMEBUFFER,
      gl.DEPTH_ATTACHMENT,
      gl.TEXTURE_2D,
      this.depthTexture,
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
      MIN_ALPHA,
    );
    const visibleWindowMs = Math.max(
      frame.ghostHalfLifeMs,
      frame.nowMs - oldestVisibleMs,
    );

    // Keep the depth mapping fixed across many display-only decay frames.
    // New book geometry or an expired headroom window recenters it.
    this.timeOriginMs = frame.nowMs - visibleWindowMs * 1.5;
    this.timeSpanMs = visibleWindowMs * 3;

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
          oldestVisibleMs,
          this.timeOriginMs,
          this.timeSpanMs,
        );
    }

    const instances = new Float32Array(values);
    this.instanceCount = instances.length / INSTANCE_FLOATS;

    gl.bindBuffer(gl.ARRAY_BUFFER, this.instanceBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, instances, gl.DYNAMIC_DRAW);
    gl.bindBuffer(gl.ARRAY_BUFFER, null);

    gl.bindFramebuffer(gl.FRAMEBUFFER, this.framebuffer);
    gl.viewport(0, 0, this.targetWidth, this.targetHeight);
    gl.disable(gl.BLEND);
    gl.enable(gl.DEPTH_TEST);
    gl.depthMask(true);
    gl.depthFunc(gl.GREATER);
    gl.clearColor(0, 0, 0, 0);
    gl.clearDepth(0);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);

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

      gl.bindVertexArray(this.geometryVao);
      gl.drawArraysInstanced(gl.TRIANGLES, 0, 6, this.instanceCount);
      gl.bindVertexArray(null);
    }

    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }

  private drawDisplay(frame: GpuPressureFrame): void {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, this.targetWidth, this.targetHeight);
    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.BLEND);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);

    if (this.instanceCount === 0) return;

    gl.useProgram(this.displayProgram);

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.colorTexture);
    uniform1i(gl, this.displayProgram, "uColor", 0);

    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.depthTexture);
    uniform1i(gl, this.displayProgram, "uDepth", 1);

    uniform1f(
      gl,
      this.displayProgram,
      "uNowRelativeMs",
      frame.nowMs - this.timeOriginMs,
    );
    uniform1f(gl, this.displayProgram, "uTimeSpanMs", this.timeSpanMs);
    uniform1f(gl, this.displayProgram, "uHalfLifeMs", frame.ghostHalfLifeMs);

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
  oldestVisibleMs: number,
  timeOriginMs: number,
  timeSpanMs: number,
): void {
  for (const run of runs) {
    const priceLo = priceToNumber(run.lo);
    const priceHi = priceToNumber(run.hi);
    if (!(priceHi > priceLo)) continue;

    for (const band of run.bands) {
      if (
        !(band.hiVolume > band.loVolume) ||
        band.validThroughMs <= oldestVisibleMs
      )
        continue;

      const depth = clamp01((band.validThroughMs - timeOriginMs) / timeSpanMs);
      if (!(depth > 0)) continue;

      values.push(
        priceLo,
        priceHi,
        band.loVolume,
        band.hiVolume,
        depth,
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

function uniform2f(
  gl: WebGL2RenderingContext,
  program: WebGLProgram,
  name: string,
  x: number,
  y: number,
): void {
  gl.uniform2f(required(gl.getUniformLocation(program, name), name), x, y);
}

function required<T>(value: T | null, label: string): T {
  if (value === null) throw new Error(`Could not create/find ${label}`);
  return value;
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}
