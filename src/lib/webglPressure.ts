import type { SignedVolumeColorScale } from "./signedVolume";
import type {
  StaleSignedVolumeSegment,
  StaleSignedVolumeSpread,
} from "./staleSignedVolume";

const BASE_SIGMA_CSS_PX = 0.85;
const VARIANCE_PER_TIME_SCALE = 8;
const MAX_BLUR_SIGMA_PER_PASS_DEVICE_PX = 6;
const MAX_BLUR_PASSES = 4;
const MAX_SHADER_RADIUS = 24;

export interface WebGLPressureRow {
  readonly tokenId: string;
  readonly segments: readonly StaleSignedVolumeSegment[];
  readonly spread?: StaleSignedVolumeSpread;
}

export interface WebGLPressureRenderInput {
  readonly key: object;
  readonly rows: readonly WebGLPressureRow[];
  readonly dirtyTokens: ReadonlySet<string>;
  readonly widthCss: number;
  readonly heightCss: number;
  readonly dpr: number;
  readonly nowMs: number;
  readonly ageScaleSeconds: number;
  readonly colorScale: SignedVolumeColorScale;
  readonly requestRedraw: () => void;
}

interface PressureState {
  textures: [WebGLTexture, WebGLTexture];
  front: 0 | 1;
  width: number;
  height: number;
  layoutSignature: string;
  ageScaleSeconds: number;
  softLimit: number;
  lastTimeMs: number;
  generation: number;
  requestRedraw: () => void;
}

interface GlResources {
  readonly gl: WebGL2RenderingContext;
  readonly framebuffer: WebGLFramebuffer;
  readonly blurProgram: WebGLProgram;
  readonly presentProgram: WebGLProgram;
  readonly blurTextureLocation: WebGLUniformLocation;
  readonly blurTexelLocation: WebGLUniformLocation;
  readonly blurSigmaLocation: WebGLUniformLocation;
  readonly blurRadiusLocation: WebGLUniformLocation;
  readonly presentTextureLocation: WebGLUniformLocation;
  readonly presentPositiveLocation: WebGLUniformLocation;
  readonly presentNegativeLocation: WebGLUniformLocation;
}

/**
 * Shared WebGL2 cache for the age-strip pressure field.
 *
 * CPU/backend sample-and-hold state remains authoritative. The GPU only stores
 * a disposable derived field that advances by vertical Gaussian convolution.
 * Any initialization/runtime/context-loss failure simply returns null, letting
 * the caller use its existing Canvas2D renderer.
 */
class SharedWebGLPressureRenderer {
  private readonly canvas = document.createElement("canvas");
  private readonly states = new Map<object, PressureState>();
  private resources: GlResources | undefined;
  private permanentlyDisabled = false;
  private contextLost = false;
  private generation = 0;

  constructor() {
    this.canvas.addEventListener("webglcontextlost", (event) => {
      event.preventDefault();
      this.contextLost = true;
      this.resources = undefined;
      this.generation++;
      this.requestAllRedraws();
    });

    this.canvas.addEventListener("webglcontextrestored", () => {
      this.contextLost = false;
      this.resources = undefined;
      this.generation++;
      this.requestAllRedraws();
    });
  }

  render(input: WebGLPressureRenderInput): HTMLCanvasElement | null {
    if (
      input.rows.length === 0 ||
      !(input.widthCss > 0) ||
      !(input.heightCss > 0) ||
      !(input.dpr > 0)
    )
      return null;

    const resources = this.ensureResources();
    if (!resources) return null;
    const { gl } = resources;
    if (gl.isContextLost()) return null;

    const width = Math.max(1, Math.round(input.widthCss * input.dpr));
    const height = Math.max(1, Math.round(input.heightCss * input.dpr));
    if (this.canvas.width !== width) this.canvas.width = width;
    if (this.canvas.height !== height) this.canvas.height = height;

    try {
      let state = this.states.get(input.key);
      const layoutSignature = input.rows.map((row) => row.tokenId).join("\u0000");
      const needsRebuild =
        !state ||
        state.generation !== this.generation ||
        state.width !== width ||
        state.height !== height ||
        state.layoutSignature !== layoutSignature ||
        state.ageScaleSeconds !== input.ageScaleSeconds ||
        state.softLimit !== input.colorScale.softLimit;

      if (needsRebuild) {
        if (state) this.deleteStateTextures(gl, state);
        state = this.createState(gl, input, width, height, layoutSignature);
        this.states.set(input.key, state);
        this.rebuild(resources, state, input);
      } else {
        state.requestRedraw = input.requestRedraw;
        const dtMs = Math.max(0, input.nowMs - state.lastTimeMs);
        const sigmaDevicePx =
          Math.sqrt(
            VARIANCE_PER_TIME_SCALE *
              (dtMs / 1000) /
              input.ageScaleSeconds,
          ) * input.dpr;

        if (!this.advance(resources, state, sigmaDevicePx)) {
          // A very long gap would require too many blur passes. Reconstructing
          // once from authoritative ages is both cheaper and exact enough.
          this.rebuild(resources, state, input);
        } else {
          this.applyFreshObservations(resources, state, input);
          state.lastTimeMs = input.nowMs;
        }
      }

      this.present(resources, state, input.colorScale);
      const error = gl.getError();
      if (error !== gl.NO_ERROR)
        throw new Error(`WebGL pressure renderer error 0x${error.toString(16)}`);
      return this.canvas;
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
  }

  private ensureResources(): GlResources | undefined {
    if (this.permanentlyDisabled || this.contextLost) return undefined;
    if (this.resources) return this.resources;

    try {
      const gl = this.canvas.getContext("webgl2", {
        alpha: true,
        antialias: false,
        depth: false,
        stencil: false,
        premultipliedAlpha: false,
        preserveDrawingBuffer: true,
      });
      if (!gl) {
        this.permanentlyDisabled = true;
        return undefined;
      }

      const framebuffer = gl.createFramebuffer();
      if (!framebuffer) throw new Error("Could not create WebGL framebuffer");

      const vertexSource = `#version 300 es
        precision highp float;
        out vec2 v_uv;
        void main() {
          vec2 p = gl_VertexID == 0 ? vec2(-1.0, -1.0)
            : gl_VertexID == 1 ? vec2(3.0, -1.0)
            : vec2(-1.0, 3.0);
          gl_Position = vec4(p, 0.0, 1.0);
          v_uv = 0.5 * (p + 1.0);
        }
      `;

      const blurSource = `#version 300 es
        precision highp float;
        uniform sampler2D u_texture;
        uniform vec2 u_texel;
        uniform float u_sigma;
        uniform int u_radius;
        in vec2 v_uv;
        out vec4 outColor;
        void main() {
          vec4 sum = vec4(0.0);
          float total = 0.0;
          float sigma2 = max(u_sigma * u_sigma, 0.0001);
          for (int i = -${MAX_SHADER_RADIUS}; i <= ${MAX_SHADER_RADIUS}; ++i) {
            if (abs(i) > u_radius) continue;
            float fi = float(i);
            float weight = exp(-0.5 * fi * fi / sigma2);
            vec2 uv = clamp(
              v_uv + vec2(0.0, fi * u_texel.y),
              0.5 * u_texel,
              vec2(1.0) - 0.5 * u_texel
            );
            sum += texture(u_texture, uv) * weight;
            total += weight;
          }
          outColor = sum / max(total, 0.0001);
        }
      `;

      const presentSource = `#version 300 es
        precision highp float;
        uniform sampler2D u_texture;
        uniform vec3 u_positive;
        uniform vec3 u_negative;
        in vec2 v_uv;
        out vec4 outColor;
        void main() {
          vec2 pressure = texture(u_texture, v_uv).rg;
          float mass = pressure.r + pressure.g;
          if (mass <= 0.00001) {
            outColor = vec4(0.0);
            return;
          }
          float alpha = clamp(mass, 0.0, 1.0);
          vec3 color =
            (pressure.r * u_positive + pressure.g * u_negative) / mass;
          outColor = vec4(color, alpha);
        }
      `;

      const blurProgram = createProgram(gl, vertexSource, blurSource);
      const presentProgram = createProgram(gl, vertexSource, presentSource);
      const blurTextureLocation = requiredUniform(gl, blurProgram, "u_texture");
      const blurTexelLocation = requiredUniform(gl, blurProgram, "u_texel");
      const blurSigmaLocation = requiredUniform(gl, blurProgram, "u_sigma");
      const blurRadiusLocation = requiredUniform(gl, blurProgram, "u_radius");
      const presentTextureLocation = requiredUniform(
        gl,
        presentProgram,
        "u_texture",
      );
      const presentPositiveLocation = requiredUniform(
        gl,
        presentProgram,
        "u_positive",
      );
      const presentNegativeLocation = requiredUniform(
        gl,
        presentProgram,
        "u_negative",
      );

      // Tiny FBO completeness test catches a surprising number of broken or
      // policy-disabled WebGL configurations before they can blank the UI.
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

      this.resources = {
        gl,
        framebuffer,
        blurProgram,
        presentProgram,
        blurTextureLocation,
        blurTexelLocation,
        blurSigmaLocation,
        blurRadiusLocation,
        presentTextureLocation,
        presentPositiveLocation,
        presentNegativeLocation,
      };
      return this.resources;
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
  ): PressureState {
    return {
      textures: [createTexture(gl, width, height), createTexture(gl, width, height)],
      front: 0,
      width,
      height,
      layoutSignature,
      ageScaleSeconds: input.ageScaleSeconds,
      softLimit: input.colorScale.softLimit,
      lastTimeMs: input.nowMs,
      generation: this.generation,
      requestRedraw: input.requestRedraw,
    };
  }

  private rebuild(
    resources: GlResources,
    state: PressureState,
    input: WebGLPressureRenderInput,
  ): void {
    const { gl } = resources;
    const pixels = buildPressurePixels(
      input.rows,
      state.width,
      state.height,
      input.dpr,
      input.ageScaleSeconds,
      input.colorScale.softLimit,
    );

    gl.bindTexture(gl.TEXTURE_2D, state.textures[0]);
    gl.texSubImage2D(
      gl.TEXTURE_2D,
      0,
      0,
      0,
      state.width,
      state.height,
      gl.RGBA,
      gl.UNSIGNED_BYTE,
      pixels,
    );
    gl.bindTexture(gl.TEXTURE_2D, state.textures[1]);
    gl.texSubImage2D(
      gl.TEXTURE_2D,
      0,
      0,
      0,
      state.width,
      state.height,
      gl.RGBA,
      gl.UNSIGNED_BYTE,
      new Uint8Array(state.width * state.height * 4),
    );
    state.front = 0;
    state.lastTimeMs = input.nowMs;
    state.ageScaleSeconds = input.ageScaleSeconds;
    state.softLimit = input.colorScale.softLimit;
    state.generation = this.generation;
  }

  /** Return false when a rebuild is cheaper than the number of needed passes. */
  private advance(
    resources: GlResources,
    state: PressureState,
    sigmaDevicePx: number,
  ): boolean {
    if (!(sigmaDevicePx > 0.05)) return true;

    const variance = sigmaDevicePx * sigmaDevicePx;
    const maxVariancePerPass =
      MAX_BLUR_SIGMA_PER_PASS_DEVICE_PX * MAX_BLUR_SIGMA_PER_PASS_DEVICE_PX;
    const passes = Math.ceil(variance / maxVariancePerPass);
    if (passes > MAX_BLUR_PASSES) return false;

    const sigmaPerPass = sigmaDevicePx / Math.sqrt(passes);
    for (let i = 0; i < passes; i++)
      this.blurPass(resources, state, sigmaPerPass);
    return true;
  }

  private blurPass(
    resources: GlResources,
    state: PressureState,
    sigmaDevicePx: number,
  ): void {
    const { gl } = resources;
    const source = state.textures[state.front];
    const nextFront: 0 | 1 = state.front === 0 ? 1 : 0;
    const target = state.textures[nextFront];

    gl.bindFramebuffer(gl.FRAMEBUFFER, resources.framebuffer);
    gl.framebufferTexture2D(
      gl.FRAMEBUFFER,
      gl.COLOR_ATTACHMENT0,
      gl.TEXTURE_2D,
      target,
      0,
    );
    gl.viewport(0, 0, state.width, state.height);
    gl.disable(gl.SCISSOR_TEST);
    gl.useProgram(resources.blurProgram);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, source);
    gl.uniform1i(resources.blurTextureLocation, 0);
    gl.uniform2f(
      resources.blurTexelLocation,
      1 / state.width,
      1 / state.height,
    );
    gl.uniform1f(resources.blurSigmaLocation, sigmaDevicePx);
    gl.uniform1i(
      resources.blurRadiusLocation,
      Math.min(MAX_SHADER_RADIUS, Math.ceil(3 * sigmaDevicePx)),
    );
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    state.front = nextFront;
  }

  private applyFreshObservations(
    resources: GlResources,
    state: PressureState,
    input: WebGLPressureRenderInput,
  ): void {
    if (input.dirtyTokens.size === 0) return;
    const { gl } = resources;
    gl.bindFramebuffer(gl.FRAMEBUFFER, resources.framebuffer);
    gl.framebufferTexture2D(
      gl.FRAMEBUFFER,
      gl.COLOR_ATTACHMENT0,
      gl.TEXTURE_2D,
      state.textures[state.front],
      0,
    );
    gl.viewport(0, 0, state.width, state.height);
    gl.enable(gl.SCISSOR_TEST);

    for (const [rowIndex, row] of input.rows.entries()) {
      if (!input.dirtyTokens.has(row.tokenId) || !row.spread) continue;
      const rowBounds = deviceRowBounds(rowIndex, input.rows.length, state.height);
      const centerY = deviceRowCenter(rowIndex, input.rows.length, state.height);

      for (const segment of row.segments) {
        const bidHi = Math.min(segment.hi, row.spread.bid);
        if (bidHi > segment.lo)
          this.resetRange(
            gl,
            state,
            rowBounds,
            centerY,
            segment.lo,
            bidHi,
            segment.volume,
            input.dpr,
            input.colorScale.softLimit,
          );

        const askLo = Math.max(segment.lo, row.spread.ask);
        if (segment.hi > askLo)
          this.resetRange(
            gl,
            state,
            rowBounds,
            centerY,
            askLo,
            segment.hi,
            segment.volume,
            input.dpr,
            input.colorScale.softLimit,
          );
      }
    }

    gl.disable(gl.SCISSOR_TEST);
  }

  private resetRange(
    gl: WebGL2RenderingContext,
    state: PressureState,
    rowBounds: { bottom: number; top: number },
    centerY: number,
    lo: number,
    hi: number,
    volume: number,
    dpr: number,
    softLimit: number,
  ): void {
    const x0 = clampInt(Math.round(clamp01(lo) * state.width), 0, state.width);
    const x1 = clampInt(Math.round(clamp01(hi) * state.width), 0, state.width);
    if (x1 <= x0) return;

    gl.scissor(x0, rowBounds.bottom, x1 - x0, rowBounds.top - rowBounds.bottom);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);

    const intensity = signedMagnitude(volume, softLimit);
    if (!(intensity > 0)) return;
    const sigma = Math.max(0.01, BASE_SIGMA_CSS_PX * dpr);
    const radius = Math.ceil(3 * sigma);
    const positive = volume > 0;
    for (let dy = -radius; dy <= radius; dy++) {
      const y = centerY + dy;
      if (y < rowBounds.bottom || y >= rowBounds.top) continue;
      const weight = Math.exp(-0.5 * (dy / sigma) ** 2);
      const value = intensity * weight;
      gl.scissor(x0, y, x1 - x0, 1);
      gl.clearColor(positive ? value : 0, positive ? 0 : value, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
    }
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
    gl.uniform1i(resources.presentTextureLocation, 0);

    const positive = cssColorToRgb(
      `oklch(${scale.luminance} ${scale.chroma} ${scale.positiveHue})`,
    );
    const negative = cssColorToRgb(
      `oklch(${scale.luminance} ${scale.chroma} ${scale.negativeHue})`,
    );
    gl.uniform3f(resources.presentPositiveLocation, ...positive);
    gl.uniform3f(resources.presentNegativeLocation, ...negative);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  private deleteStateTextures(gl: WebGL2RenderingContext, state: PressureState) {
    gl.deleteTexture(state.textures[0]);
    gl.deleteTexture(state.textures[1]);
  }

  private requestAllRedraws() {
    for (const state of this.states.values()) state.requestRedraw();
  }
}

export const sharedWebGLPressureRenderer = new SharedWebGLPressureRenderer();

function buildPressurePixels(
  rows: readonly WebGLPressureRow[],
  width: number,
  height: number,
  dpr: number,
  ageScaleSeconds: number,
  softLimit: number,
): Uint8Array {
  const pixels = new Uint8Array(width * height * 4);
  for (const [rowIndex, row] of rows.entries()) {
    const centerY = deviceRowCenter(rowIndex, rows.length, height);
    for (const segment of row.segments) {
      if (segment.ageMs === Infinity || segment.volume === 0) continue;
      const intensity = signedMagnitude(segment.volume, softLimit);
      if (!(intensity > 0)) continue;

      const sigmaCss = Math.sqrt(
        BASE_SIGMA_CSS_PX * BASE_SIGMA_CSS_PX +
          VARIANCE_PER_TIME_SCALE *
            (segment.ageMs / 1000) /
            ageScaleSeconds,
      );
      const sigmaDevice = Math.max(0.01, sigmaCss * dpr);
      const peak = Math.min(1, (BASE_SIGMA_CSS_PX * dpr) / sigmaDevice);
      const radius = Math.ceil(3 * sigmaDevice);
      const x0 = clampInt(Math.round(clamp01(segment.lo) * width), 0, width);
      const x1 = clampInt(Math.round(clamp01(segment.hi) * width), 0, width);
      const channel = segment.volume > 0 ? 0 : 1;

      for (let dy = -radius; dy <= radius; dy++) {
        const y = centerY + dy;
        if (y < 0 || y >= height) continue;
        const value = Math.round(
          255 * intensity * peak * Math.exp(-0.5 * (dy / sigmaDevice) ** 2),
        );
        if (value <= 0) continue;
        let offset = (y * width + x0) * 4 + channel;
        for (let x = x0; x < x1; x++, offset += 4)
          pixels[offset] = Math.min(255, pixels[offset] + value);
      }
    }
  }
  return pixels;
}

function deviceRowBounds(
  rowIndex: number,
  rowCount: number,
  height: number,
): { bottom: number; top: number } {
  const topFromTop = Math.round((rowIndex / rowCount) * height);
  const bottomFromTop = Math.round(((rowIndex + 1) / rowCount) * height);
  return {
    bottom: height - bottomFromTop,
    top: height - topFromTop,
  };
}

function deviceRowCenter(
  rowIndex: number,
  rowCount: number,
  height: number,
): number {
  const { bottom, top } = deviceRowBounds(rowIndex, rowCount, height);
  return clampInt(Math.floor((bottom + top - 1) / 2), 0, height - 1);
}

function signedMagnitude(volume: number, softLimit: number): number {
  if (volume === 0 || Number.isNaN(volume)) return 0;
  if (!Number.isFinite(volume)) return 1;
  return Math.abs(volume) / (Math.abs(volume) + softLimit);
}

function createTexture(
  gl: WebGL2RenderingContext,
  width: number,
  height: number,
): WebGLTexture {
  const texture = gl.createTexture();
  if (!texture) throw new Error("Could not create WebGL texture");
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
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
  if (!location) throw new Error(`Missing WebGL uniform ${name}`);
  return location;
}

const colorProbe = document.createElement("canvas");
colorProbe.width = colorProbe.height = 1;
const colorProbeCtx = colorProbe.getContext("2d", { willReadFrequently: true });
const rgbCache = new Map<string, [number, number, number]>();

function cssColorToRgb(css: string): [number, number, number] {
  const cached = rgbCache.get(css);
  if (cached) return cached;
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
