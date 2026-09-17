import {
  diffusionSigmaCss,
  pressureInkProfile,
} from "./pressureInk";
import type { SignedVolumeColorScale } from "./signedVolume";
import type { StaleSignedVolumeSegment } from "./staleSignedVolume";

const MAX_SIGMA_PER_PASS_DEVICE_PX = 4;
const MAX_BLUR_PASSES = 8;
const MAX_SHADER_RADIUS = 16;

const shareReferenceListeners = new Set<(shares: number) => void>();
let globalShareReferenceShares = 0;

export function getGlobalShareReferenceShares(): number {
  return globalShareReferenceShares;
}

export function subscribeGlobalShareReferenceShares(
  listener: (shares: number) => void,
): () => void {
  shareReferenceListeners.add(listener);
  return () => shareReferenceListeners.delete(listener);
}

export interface WebGLPressureRow {
  readonly tokenId: string;
  readonly segments: readonly StaleSignedVolumeSegment[];
}

export interface WebGLPressureRenderInput {
  /** Stable identity for one chart. */
  readonly key: object;
  /** Rows ordered top-to-bottom, matching the visible age-strip layout. */
  readonly rows: readonly WebGLPressureRow[];
  /** Rows whose authoritative CPU state changed since the previous render. */
  readonly dirtyTokens: ReadonlySet<string>;
  /** Plot-area dimensions only; axes/padding are composed by Canvas2D. */
  readonly widthCss: number;
  readonly heightCss: number;
  readonly dpr: number;
  readonly nowMs: number;
  readonly ageScaleSeconds: number;
  /** Legacy tuning unit; one row multiplies this into reserve shares C. */
  readonly volumePerCssPixel: number;
  readonly colorScale: SignedVolumeColorScale;
  readonly requestRedraw: () => void;
}

interface PressureState {
  readonly textures: [WebGLTexture, WebGLTexture];
  front: 0 | 1;
  width: number;
  height: number;
  layoutSignature: string;
  ageScaleSeconds: number;
  volumePerCssPixel: number;
  shareReferenceShares: number;
  lastTimeMs: number;
  generation: number;
  requestRedraw: () => void;
}

interface GlResources {
  readonly gl: WebGL2RenderingContext;
  readonly framebuffer: WebGLFramebuffer;
  readonly blurProgram: WebGLProgram;
  readonly presentProgram: WebGLProgram;
  readonly blurTexture: WebGLUniformLocation;
  readonly blurSize: WebGLUniformLocation;
  readonly blurSigma: WebGLUniformLocation;
  readonly blurRadius: WebGLUniformLocation;
  readonly blurRowCount: WebGLUniformLocation;
  readonly presentTexture: WebGLUniformLocation;
  readonly presentPositive: WebGLUniformLocation;
  readonly presentNegative: WebGLUniformLocation;
}

/**
 * Shared, disposable GPU cache for age-pressure fields.
 *
 * CPU/backend sample-and-hold state remains authoritative. Browser resources
 * are created lazily so importing this module is harmless in tests/SSR, and
 * any WebGL failure can fall back to the Canvas2D reference renderer.
 *
 * Fresh vertical occupancy is linear in cumulative shares. Every chart uses
 * the same dashboard-wide reference V, while the tuning contributes reserve
 * shares C. Thus height = |Q|/(V+C): the whole shape gets the v/(v+c) softness
 * at its observed maximum without destroying the additive share×price area.
 * Age diffusion is still the legacy temporal treatment on this branch.
 */
class SharedWebGLPressureRenderer {
  private readonly states = new Map<object, PressureState>();
  private readonly sharePeaks = new Map<object, number>();
  private canvas: HTMLCanvasElement | undefined;
  private resources: GlResources | undefined;
  private contextLost = false;
  private permanentlyDisabled = false;
  private generation = 0;

  render(input: WebGLPressureRenderInput): HTMLCanvasElement | null {
    if (
      input.rows.length === 0 ||
      !(input.widthCss > 0) ||
      !(input.heightCss > 0) ||
      !(input.dpr > 0) ||
      !(input.volumePerCssPixel > 0) ||
      !Number.isFinite(input.volumePerCssPixel)
    )
      return null;

    this.setSharePeak(input.key, pressureSharePeak(input.rows));
    const shareReferenceShares = globalShareReferenceShares;

    const resources = this.ensureResources();
    const canvas = this.canvas;
    if (!resources || !canvas || resources.gl.isContextLost()) return null;
    const { gl } = resources;

    const width = Math.max(1, Math.round(input.widthCss * input.dpr));
    const height = Math.max(1, Math.round(input.heightCss * input.dpr));
    if (canvas.width !== width) canvas.width = width;
    if (canvas.height !== height) canvas.height = height;

    try {
      const layoutSignature = input.rows.map((row) => row.tokenId).join("\u0000");
      const previous = this.states.get(input.key);
      const mustRebuild =
        !previous ||
        previous.generation !== this.generation ||
        previous.width !== width ||
        previous.height !== height ||
        previous.layoutSignature !== layoutSignature ||
        previous.ageScaleSeconds !== input.ageScaleSeconds ||
        previous.volumePerCssPixel !== input.volumePerCssPixel ||
        previous.shareReferenceShares !== shareReferenceShares;

      let state: PressureState;
      if (mustRebuild) {
        if (previous) this.deleteStateTextures(gl, previous);
        state = this.createState(
          gl,
          input,
          width,
          height,
          layoutSignature,
          shareReferenceShares,
        );
        this.states.set(input.key, state);
        this.rebuildAll(gl, state, input);
      } else {
        state = previous;
        state.requestRedraw = input.requestRedraw;

        const dtMs = Math.max(0, input.nowMs - state.lastTimeMs);
        const sigmaDevicePx =
          diffusionSigmaCss(dtMs, input.ageScaleSeconds) * input.dpr;

        if (!this.advance(resources, state, sigmaDevicePx)) {
          this.rebuildAll(gl, state, input);
        } else {
          this.rebuildDirtyRows(gl, state, input);
          // If advance skipped a subpixel step, leave lastTime untouched so the
          // variance accumulates instead of silently disappearing.
          if (sigmaDevicePx >= 0.05) state.lastTimeMs = input.nowMs;
        }
      }

      this.present(resources, state, input.colorScale);
      const error = gl.getError();
      if (error !== gl.NO_ERROR)
        throw new Error(`WebGL error 0x${error.toString(16)}`);
      return canvas;
    } catch (error) {
      console.warn("WebGL pressure renderer disabled for this session:", error);
      this.permanentlyDisabled = true;
      this.resources = undefined;
      this.requestAllRedraws();
      return null;
    }
  }

  release(key: object): void {
    const state = this.states.get(key);
    const gl = this.resources?.gl;
    if (state && gl && !gl.isContextLost()) this.deleteStateTextures(gl, state);
    this.states.delete(key);
    this.sharePeaks.delete(key);
    this.refreshGlobalShareReference();
  }

  private setSharePeak(key: object, shares: number): void {
    this.sharePeaks.set(key, shares);
    this.refreshGlobalShareReference();
  }

  private refreshGlobalShareReference(): void {
    let next = 0;
    for (const shares of this.sharePeaks.values()) next = Math.max(next, shares);
    if (next === globalShareReferenceShares) return;

    globalShareReferenceShares = next;
    for (const listener of shareReferenceListeners) listener(next);
    this.requestAllRedraws();
  }

  private ensureCanvas(): HTMLCanvasElement | undefined {
    if (this.canvas) return this.canvas;
    if (typeof document === "undefined") return undefined;

    const canvas = document.createElement("canvas");
    canvas.addEventListener("webglcontextlost", (event) => {
      event.preventDefault();
      this.contextLost = true;
      this.resources = undefined;
      this.generation++;
      this.requestAllRedraws();
    });
    canvas.addEventListener("webglcontextrestored", () => {
      this.contextLost = false;
      this.resources = undefined;
      this.generation++;
      this.requestAllRedraws();
    });
    this.canvas = canvas;
    return canvas;
  }

  private ensureResources(): GlResources | undefined {
    if (this.permanentlyDisabled || this.contextLost) return undefined;
    if (this.resources) return this.resources;

    const canvas = this.ensureCanvas();
    if (!canvas) return undefined;

    try {
      const gl = canvas.getContext("webgl2", {
        alpha: true,
        antialias: false,
        depth: false,
        stencil: false,
        premultipliedAlpha: false,
        preserveDrawingBuffer: true,
        powerPreference: "default",
      });
      if (!gl) {
        this.permanentlyDisabled = true;
        return undefined;
      }

      const framebuffer = gl.createFramebuffer();
      if (!framebuffer) throw new Error("Could not create WebGL framebuffer");

      const blurProgram = createProgram(gl, VERTEX_SHADER, BLUR_SHADER);
      const presentProgram = createProgram(gl, VERTEX_SHADER, PRESENT_SHADER);
      const resources: GlResources = {
        gl,
        framebuffer,
        blurProgram,
        presentProgram,
        blurTexture: requiredUniform(gl, blurProgram, "u_texture"),
        blurSize: requiredUniform(gl, blurProgram, "u_size"),
        blurSigma: requiredUniform(gl, blurProgram, "u_sigma"),
        blurRadius: requiredUniform(gl, blurProgram, "u_radius"),
        blurRowCount: requiredUniform(gl, blurProgram, "u_row_count"),
        presentTexture: requiredUniform(gl, presentProgram, "u_texture"),
        presentPositive: requiredUniform(gl, presentProgram, "u_positive"),
        presentNegative: requiredUniform(gl, presentProgram, "u_negative"),
      };

      // Tiny framebuffer self-test: fail early rather than ever blanking a card.
      const probe = createTexture(gl, 2, 2);
      gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
      gl.framebufferTexture2D(
        gl.FRAMEBUFFER,
        gl.COLOR_ATTACHMENT0,
        gl.TEXTURE_2D,
        probe,
        0,
      );
      if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE)
        throw new Error("WebGL framebuffer self-test failed");
      gl.deleteTexture(probe);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);

      this.resources = resources;
      return resources;
    } catch (error) {
      console.warn("WebGL2 pressure renderer unavailable; using Canvas2D:", error);
      this.permanentlyDisabled = true;
      return undefined;
    }
  }

  private createState(
    gl: WebGL2RenderingContext,
    input: WebGLPressureRenderInput,
    width: number,
    height: number,
    layoutSignature: string,
    shareReferenceShares: number,
  ): PressureState {
    return {
      textures: [createTexture(gl, width, height), createTexture(gl, width, height)],
      front: 0,
      width,
      height,
      layoutSignature,
      ageScaleSeconds: input.ageScaleSeconds,
      volumePerCssPixel: input.volumePerCssPixel,
      shareReferenceShares,
      lastTimeMs: input.nowMs,
      generation: this.generation,
      requestRedraw: input.requestRedraw,
    };
  }

  private rebuildAll(
    gl: WebGL2RenderingContext,
    state: PressureState,
    input: WebGLPressureRenderInput,
  ): void {
    const pixels = buildPressurePixels(
      input.rows,
      state.width,
      state.height,
      input.dpr,
      input.ageScaleSeconds,
      input.volumePerCssPixel,
      state.shareReferenceShares,
    );
    uploadWholeTexture(gl, state.textures[0], state.width, state.height, pixels);
    uploadWholeTexture(
      gl,
      state.textures[1],
      state.width,
      state.height,
      new Uint8Array(state.width * state.height * 4),
    );
    state.front = 0;
    state.lastTimeMs = input.nowMs;
    state.ageScaleSeconds = input.ageScaleSeconds;
    state.volumePerCssPixel = input.volumePerCssPixel;
    state.shareReferenceShares = globalShareReferenceShares;
    state.generation = this.generation;
  }

  private rebuildDirtyRows(
    gl: WebGL2RenderingContext,
    state: PressureState,
    input: WebGLPressureRenderInput,
  ): void {
    if (input.dirtyTokens.size === 0) return;
    gl.bindTexture(gl.TEXTURE_2D, state.textures[state.front]);

    for (const [rowIndex, row] of input.rows.entries()) {
      if (!input.dirtyTokens.has(row.tokenId)) continue;
      const bounds = deviceRowBounds(rowIndex, input.rows.length, state.height);
      const rowHeight = bounds.top - bounds.bottom;
      const pixels = buildPressureRowPixels(
        row.segments,
        state.width,
        rowHeight,
        input.dpr,
        input.ageScaleSeconds,
        input.volumePerCssPixel,
        state.shareReferenceShares,
      );
      gl.texSubImage2D(
        gl.TEXTURE_2D,
        0,
        0,
        bounds.bottom,
        state.width,
        rowHeight,
        gl.RGBA,
        gl.UNSIGNED_BYTE,
        pixels,
      );
    }
  }

  /** Return false when reconstructing from CPU state is cheaper than many passes. */
  private advance(
    resources: GlResources,
    state: PressureState,
    sigmaDevicePx: number,
  ): boolean {
    if (!(sigmaDevicePx >= 0.05)) return true;

    const passes = Math.max(
      1,
      Math.ceil(
        (sigmaDevicePx * sigmaDevicePx) /
          (MAX_SIGMA_PER_PASS_DEVICE_PX ** 2),
      ),
    );
    if (passes > MAX_BLUR_PASSES) return false;

    const sigmaPerPass = sigmaDevicePx / Math.sqrt(passes);
    for (let i = 0; i < passes; i++)
      this.blurOnce(resources, state, sigmaPerPass);
    return true;
  }

  private blurOnce(
    resources: GlResources,
    state: PressureState,
    sigmaDevicePx: number,
  ): void {
    const { gl } = resources;
    const destination: 0 | 1 = state.front === 0 ? 1 : 0;
    gl.bindFramebuffer(gl.FRAMEBUFFER, resources.framebuffer);
    gl.framebufferTexture2D(
      gl.FRAMEBUFFER,
      gl.COLOR_ATTACHMENT0,
      gl.TEXTURE_2D,
      state.textures[destination],
      0,
    );
    gl.viewport(0, 0, state.width, state.height);
    gl.disable(gl.SCISSOR_TEST);
    gl.useProgram(resources.blurProgram);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, state.textures[state.front]);
    gl.uniform1i(resources.blurTexture, 0);
    gl.uniform2i(resources.blurSize, state.width, state.height);
    gl.uniform1f(resources.blurSigma, sigmaDevicePx);
    gl.uniform1i(
      resources.blurRadius,
      Math.min(MAX_SHADER_RADIUS, Math.max(1, Math.ceil(3 * sigmaDevicePx))),
    );
    gl.uniform1i(
      resources.blurRowCount,
      state.layoutSignature.split("\u0000").length,
    );
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    state.front = destination;
  }

  private present(
    resources: GlResources,
    state: PressureState,
    scale: SignedVolumeColorScale,
  ): void {
    const { gl } = resources;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, state.width, state.height);
    gl.disable(gl.SCISSOR_TEST);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.useProgram(resources.presentProgram);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, state.textures[state.front]);
    gl.uniform1i(resources.presentTexture, 0);

    const positive = cssColorToRgb(
      `oklch(${scale.luminance} ${scale.chroma} ${scale.positiveHue})`,
    );
    const negative = cssColorToRgb(
      `oklch(${scale.luminance} ${scale.chroma} ${scale.negativeHue})`,
    );
    gl.uniform3f(resources.presentPositive, ...positive);
    gl.uniform3f(resources.presentNegative, ...negative);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  private deleteStateTextures(gl: WebGL2RenderingContext, state: PressureState): void {
    gl.deleteTexture(state.textures[0]);
    gl.deleteTexture(state.textures[1]);
  }

  private requestAllRedraws(): void {
    for (const state of this.states.values()) state.requestRedraw();
  }
}

export const sharedWebGLPressureRenderer = new SharedWebGLPressureRenderer();

function pressureSharePeak(rows: readonly WebGLPressureRow[]): number {
  let peak = 0;
  for (const row of rows) {
    for (const segment of row.segments) {
      const magnitude = Math.abs(segment.volume);
      if (Number.isFinite(magnitude)) peak = Math.max(peak, magnitude);
    }
  }
  return peak;
}

function buildPressurePixels(
  rows: readonly WebGLPressureRow[],
  width: number,
  height: number,
  dpr: number,
  ageScaleSeconds: number,
  volumePerCssPixel: number,
  shareReferenceShares: number,
): Uint8Array {
  const pixels = new Uint8Array(width * height * 4);
  for (const [rowIndex, row] of rows.entries()) {
    const bounds = deviceRowBounds(rowIndex, rows.length, height);
    const rowPixels = buildPressureRowPixels(
      row.segments,
      width,
      bounds.top - bounds.bottom,
      dpr,
      ageScaleSeconds,
      volumePerCssPixel,
      shareReferenceShares,
    );
    pixels.set(rowPixels, bounds.bottom * width * 4);
  }
  return pixels;
}

function buildPressureRowPixels(
  segments: readonly StaleSignedVolumeSegment[],
  width: number,
  height: number,
  dpr: number,
  ageScaleSeconds: number,
  volumePerCssPixel: number,
  shareReferenceShares: number,
): Uint8Array {
  const pixels = new Uint8Array(width * height * 4);
  const reserveShares = volumePerCssPixel * (height / dpr);

  for (const segment of segments) {
    if (segment.ageMs === Infinity || segment.volume === 0) continue;
    const profile = pressureInkProfile(
      segment.volume,
      segment.ageMs,
      shareReferenceShares,
      reserveShares,
      ageScaleSeconds,
      dpr,
      height,
    );
    const x0 = clampInt(Math.round(clamp01(segment.lo) * width), 0, width);
    const x1 = clampInt(Math.round(clamp01(segment.hi) * width), 0, width);
    if (!(x1 > x0)) continue;
    const channel = segment.volume > 0 ? 0 : 1;

    for (let y = 0; y < height; y++) {
      const value = Math.round(255 * profile[y]!);
      if (value <= 0) continue;
      let offset = (y * width + x0) * 4 + channel;
      for (let x = x0; x < x1; x++, offset += 4)
        pixels[offset] = value;
    }
  }
  return pixels;
}

function uploadWholeTexture(
  gl: WebGL2RenderingContext,
  texture: WebGLTexture,
  width: number,
  height: number,
  pixels: Uint8Array,
): void {
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.texSubImage2D(
    gl.TEXTURE_2D,
    0,
    0,
    0,
    width,
    height,
    gl.RGBA,
    gl.UNSIGNED_BYTE,
    pixels,
  );
}

function deviceRowBounds(
  rowIndex: number,
  rowCount: number,
  height: number,
): { bottom: number; top: number } {
  const topFromTop = Math.round((rowIndex / rowCount) * height);
  const bottomFromTop = Math.round(((rowIndex + 1) / rowCount) * height);
  return { bottom: height - bottomFromTop, top: height - topFromTop };
}

function createTexture(
  gl: WebGL2RenderingContext,
  width: number,
  height: number,
): WebGLTexture {
  const texture = gl.createTexture();
  if (!texture) throw new Error("Could not create WebGL texture");
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
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
  return texture;
}

function createProgram(
  gl: WebGL2RenderingContext,
  vertexSource: string,
  fragmentSource: string,
): WebGLProgram {
  const vertex = compileShader(gl, gl.VERTEX_SHADER, vertexSource);
  const fragment = compileShader(gl, gl.FRAGMENT_SHADER, fragmentSource);
  const program = gl.createProgram();
  if (!program) throw new Error("Could not create WebGL program");
  gl.attachShader(program, vertex);
  gl.attachShader(program, fragment);
  gl.linkProgram(program);
  gl.deleteShader(vertex);
  gl.deleteShader(fragment);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    const log = gl.getProgramInfoLog(program) ?? "unknown link error";
    gl.deleteProgram(program);
    throw new Error(`WebGL program link failed: ${log}`);
  }
  return program;
}

function compileShader(
  gl: WebGL2RenderingContext,
  type: number,
  source: string,
): WebGLShader {
  const shader = gl.createShader(type);
  if (!shader) throw new Error("Could not create WebGL shader");
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(shader) ?? "unknown compile error";
    gl.deleteShader(shader);
    throw new Error(`WebGL shader compile failed: ${log}`);
  }
  return shader;
}

function requiredUniform(
  gl: WebGL2RenderingContext,
  program: WebGLProgram,
  name: string,
): WebGLUniformLocation {
  const location = gl.getUniformLocation(program, name);
  if (location === null) throw new Error(`Missing WebGL uniform ${name}`);
  return location;
}

let colorProbeCtx: CanvasRenderingContext2D | null | undefined;
const rgbCache = new Map<string, [number, number, number]>();

function cssColorToRgb(css: string): [number, number, number] {
  const cached = rgbCache.get(css);
  if (cached) return cached;

  if (colorProbeCtx === undefined) {
    if (typeof document === "undefined") colorProbeCtx = null;
    else {
      const probe = document.createElement("canvas");
      probe.width = probe.height = 1;
      colorProbeCtx = probe.getContext("2d", { willReadFrequently: true });
    }
  }
  if (!colorProbeCtx) return [1, 1, 1];

  colorProbeCtx.clearRect(0, 0, 1, 1);
  colorProbeCtx.fillStyle = css;
  colorProbeCtx.fillRect(0, 0, 1, 1);
  const [r, g, b] = colorProbeCtx.getImageData(0, 0, 1, 1).data;
  const rgb: [number, number, number] = [r / 255, g / 255, b / 255];
  rgbCache.set(css, rgb);
  return rgb;
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function clampInt(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

const VERTEX_SHADER = `#version 300 es
precision highp float;
const vec2 positions[3] = vec2[3](
  vec2(-1.0, -1.0),
  vec2( 3.0, -1.0),
  vec2(-1.0,  3.0)
);
void main() {
  gl_Position = vec4(positions[gl_VertexID], 0.0, 1.0);
}`;

const BLUR_SHADER = `#version 300 es
precision highp float;
precision highp int;
uniform sampler2D u_texture;
uniform ivec2 u_size;
uniform float u_sigma;
uniform int u_radius;
uniform int u_row_count;
out vec4 outColor;
void main() {
  ivec2 pixel = ivec2(gl_FragCoord.xy);
  float rowHeight = float(u_size.y) / float(u_row_count);
  float row = floor(gl_FragCoord.y / rowHeight);
  float rowBottom = row * rowHeight;
  float rowTop = rowBottom + rowHeight;
  vec2 sum = vec2(0.0);
  float norm = 0.0;

  for (int i = -${MAX_SHADER_RADIUS}; i <= ${MAX_SHADER_RADIUS}; ++i) {
    if (abs(i) > u_radius) continue;
    float offset = float(i);
    float weight = exp(-0.5 * offset * offset / (u_sigma * u_sigma));
    norm += weight;
    float sampleY = gl_FragCoord.y + offset;
    if (sampleY < rowBottom || sampleY >= rowTop) continue;
    int sy = pixel.y + i;
    if (sy < 0 || sy >= u_size.y) continue;
    sum += texelFetch(u_texture, ivec2(pixel.x, sy), 0).rg * weight;
  }

  outColor = vec4(norm > 0.0 ? sum / norm : vec2(0.0), 0.0, 1.0);
}`;

const PRESENT_SHADER = `#version 300 es
precision highp float;
uniform sampler2D u_texture;
uniform vec3 u_positive;
uniform vec3 u_negative;
out vec4 outColor;
void main() {
  ivec2 pixel = ivec2(gl_FragCoord.xy);
  vec2 pressure = texelFetch(u_texture, pixel, 0).rg;
  float mass = pressure.r + pressure.g;
  if (mass <= 0.00001) {
    outColor = vec4(0.0);
    return;
  }
  float alpha = clamp(mass, 0.0, 1.0);
  vec3 color = (pressure.r * u_positive + pressure.g * u_negative) / mass;
  outColor = vec4(color, alpha);
}`;
