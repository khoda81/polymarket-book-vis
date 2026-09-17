import type { TokenBook } from "./orderBook";
import {
  diffusionSigmaCss,
  pressureInkProfile,
  pressureInkThicknessCss,
} from "./pressureInk";
import { displacedPressureSegments } from "./resinHistory";
import {
  signedVolumeSegments,
  type SignedVolumeColorScale,
  type SignedVolumeSegment,
} from "./signedVolume";
import type { StaleSignedVolumeSegment } from "./staleSignedVolume";

const MIN_DIFFUSION_SIGMA_DEVICE_PX = 0.05;
const MAX_SIGMA_PER_PASS_DEVICE_PX = 8;
const MAX_BLUR_PASSES = 24;
const MAX_SHADER_RADIUS = 32;

export interface WebGLPressureRow {
  readonly tokenId: string;
  /** Legacy sample-and-hold field, used only to seed history after a rebuild. */
  readonly segments: readonly StaleSignedVolumeSegment[];
}

export interface WebGLPressureRenderInput {
  /** Stable identity for one chart. */
  readonly key: object;
  /** Rows ordered top-to-bottom, matching the visible age-strip layout. */
  readonly rows: readonly WebGLPressureRow[];
  /** Rows whose authoritative live book changed since the previous render. */
  readonly dirtyTokens: ReadonlySet<string>;
  /** Read the exact live book used for the sharp foreground. */
  readonly getBook: (tokenId: string) => TokenBook<string> | undefined;
  /** Plot-area dimensions only; axes/padding are composed by Canvas2D. */
  readonly widthCss: number;
  readonly heightCss: number;
  readonly dpr: number;
  readonly nowMs: number;
  readonly ageScaleSeconds: number;
  /** Share scale C is this many shares per CSS pixel times row height. */
  readonly volumePerCssPixel: number;
  readonly colorScale: SignedVolumeColorScale;
  readonly requestRedraw: () => void;
}

interface PressureState {
  readonly historyTextures: [WebGLTexture, WebGLTexture];
  historyFront: 0 | 1;
  readonly currentTexture: WebGLTexture;
  readonly depositTexture: WebGLTexture;
  readonly currentByToken: Map<string, readonly SignedVolumeSegment[]>;
  width: number;
  height: number;
  rowCount: number;
  layoutSignature: string;
  volumePerCssPixel: number;
  lastDiffuseMs: number;
  historyActive: boolean;
  generation: number;
  requestRedraw: () => void;
}

interface GlResources {
  readonly gl: WebGL2RenderingContext;
  readonly framebuffer: WebGLFramebuffer;
  readonly blurProgram: WebGLProgram;
  readonly blurTexture: WebGLUniformLocation;
  readonly blurSize: WebGLUniformLocation;
  readonly blurSigma: WebGLUniformLocation;
  readonly blurRadius: WebGLUniformLocation;
  readonly blurRowCount: WebGLUniformLocation;
  readonly depositProgram: WebGLProgram;
  readonly depositHistory: WebGLUniformLocation;
  readonly depositSource: WebGLUniformLocation;
  readonly presentProgram: WebGLProgram;
  readonly presentHistory: WebGLUniformLocation;
  readonly presentCurrent: WebGLUniformLocation;
  readonly presentSize: WebGLUniformLocation;
  readonly presentRowCount: WebGLUniformLocation;
  readonly presentPositive: WebGLUniformLocation;
  readonly presentNegative: WebGLUniformLocation;
}

/**
 * Shared, disposable GPU renderer for the age view.
 *
 * The live order book is always rendered as a sharp foreground. Time exists in
 * a separate resin texture: whenever live pressure changes, the displaced old
 * silhouette is deposited into history, then history diffuses vertically on
 * the GPU. Presentation suppresses history in every x-column where the live
 * book has pressure, so stale information can never deform the authoritative
 * current outline.
 *
 * CPU sample-and-hold history is consulted only when a GPU state must be
 * reconstructed (first render, resize, row-layout change, context restore).
 * Ordinary diffusion therefore performs no Gaussian/erf work on the CPU.
 */
class SharedWebGLPressureRenderer {
  private readonly states = new Map<object, PressureState>();
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
        previous.layoutSignature !== layoutSignature;

      let state: PressureState;
      if (mustRebuild) {
        if (previous) this.deleteStateTextures(gl, previous);
        state = this.createState(gl, input, width, height, layoutSignature);
        this.states.set(input.key, state);
        this.rebuildAll(gl, state, input);
      } else {
        state = previous;
        state.requestRedraw = input.requestRedraw;

        this.advanceHistory(resources, state, input);
        const displaced = this.captureLiveChanges(state, input);

        if (state.volumePerCssPixel !== input.volumePerCssPixel) {
          // History is intentionally visual residue: changing the share scale
          // rescales the authoritative live book and future deposits, but does
          // not rewind and reinterpret already-cured resin.
          state.volumePerCssPixel = input.volumePerCssPixel;
          this.rebuildCurrentAll(gl, state, input);
        } else {
          this.rebuildDirtyCurrentRows(gl, state, input);
        }

        if (displaced.length > 0)
          this.depositHistory(resources, state, input, displaced);
      }

      this.present(resources, state, input.colorScale);
      return canvas;
    } catch (error) {
      console.warn("WebGL resin pressure renderer disabled for this session:", error);
      this.permanentlyDisabled = true;
      this.resources = undefined;
      this.requestAllRedraws();
      return null;
    }
  }

  hasHistory(key: object): boolean {
    return this.states.get(key)?.historyActive ?? false;
  }

  release(key: object): void {
    const state = this.states.get(key);
    const gl = this.resources?.gl;
    if (state && gl && !gl.isContextLost()) this.deleteStateTextures(gl, state);
    this.states.delete(key);
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
      const depositProgram = createProgram(gl, VERTEX_SHADER, DEPOSIT_SHADER);
      const presentProgram = createProgram(gl, VERTEX_SHADER, PRESENT_SHADER);
      const resources: GlResources = {
        gl,
        framebuffer,
        blurProgram,
        blurTexture: requiredUniform(gl, blurProgram, "u_texture"),
        blurSize: requiredUniform(gl, blurProgram, "u_size"),
        blurSigma: requiredUniform(gl, blurProgram, "u_sigma"),
        blurRadius: requiredUniform(gl, blurProgram, "u_radius"),
        blurRowCount: requiredUniform(gl, blurProgram, "u_row_count"),
        depositProgram,
        depositHistory: requiredUniform(gl, depositProgram, "u_history"),
        depositSource: requiredUniform(gl, depositProgram, "u_deposit"),
        presentProgram,
        presentHistory: requiredUniform(gl, presentProgram, "u_history"),
        presentCurrent: requiredUniform(gl, presentProgram, "u_current"),
        presentSize: requiredUniform(gl, presentProgram, "u_size"),
        presentRowCount: requiredUniform(gl, presentProgram, "u_row_count"),
        presentPositive: requiredUniform(gl, presentProgram, "u_positive"),
        presentNegative: requiredUniform(gl, presentProgram, "u_negative"),
      };

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
      console.warn("WebGL2 resin renderer unavailable; using Canvas2D:", error);
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
      historyTextures: [createTexture(gl, width, height), createTexture(gl, width, height)],
      historyFront: 0,
      currentTexture: createTexture(gl, width, height),
      depositTexture: createTexture(gl, width, height),
      currentByToken: new Map(),
      width,
      height,
      rowCount: input.rows.length,
      layoutSignature,
      volumePerCssPixel: input.volumePerCssPixel,
      lastDiffuseMs: input.nowMs,
      historyActive: false,
      generation: this.generation,
      requestRedraw: input.requestRedraw,
    };
  }

  private rebuildAll(
    gl: WebGL2RenderingContext,
    state: PressureState,
    input: WebGLPressureRenderInput,
  ): void {
    state.currentByToken.clear();
    for (const row of input.rows)
      state.currentByToken.set(row.tokenId, this.readCurrent(row.tokenId, input));

    const seed = buildHistorySeedPixels(
      input.rows,
      state.currentByToken,
      state.width,
      state.height,
      input.dpr,
      input.ageScaleSeconds,
      input.volumePerCssPixel,
    );
    uploadWholeTexture(gl, state.historyTextures[0], state.width, state.height, seed.pixels);
    clearTexture(gl, state.historyTextures[1], state.width, state.height);
    clearTexture(gl, state.depositTexture, state.width, state.height);

    state.historyFront = 0;
    state.historyActive = seed.active;
    state.lastDiffuseMs = input.nowMs;
    state.volumePerCssPixel = input.volumePerCssPixel;
    state.rowCount = input.rows.length;
    state.generation = this.generation;
    this.rebuildCurrentAll(gl, state, input);
  }

  private readCurrent(
    tokenId: string,
    input: WebGLPressureRenderInput,
  ): readonly SignedVolumeSegment[] {
    const book = input.getBook(tokenId);
    return book ? signedVolumeSegments(book) : [];
  }

  private captureLiveChanges(
    state: PressureState,
    input: WebGLPressureRenderInput,
  ): readonly { rowIndex: number; segments: readonly SignedVolumeSegment[] }[] {
    if (input.dirtyTokens.size === 0) return [];

    const displaced: { rowIndex: number; segments: readonly SignedVolumeSegment[] }[] = [];
    for (const [rowIndex, row] of input.rows.entries()) {
      if (!input.dirtyTokens.has(row.tokenId)) continue;
      const next = this.readCurrent(row.tokenId, input);
      const previous = state.currentByToken.get(row.tokenId);
      if (previous) {
        const segments = displacedPressureSegments(previous, next);
        if (segments.length > 0) displaced.push({ rowIndex, segments });
      }
      state.currentByToken.set(row.tokenId, next);
    }
    return displaced;
  }

  private rebuildCurrentAll(
    gl: WebGL2RenderingContext,
    state: PressureState,
    input: WebGLPressureRenderInput,
  ): void {
    const pixels = buildCurrentPixels(
      input.rows,
      state.currentByToken,
      state.width,
      state.height,
      input.dpr,
      input.volumePerCssPixel,
    );
    uploadWholeTexture(gl, state.currentTexture, state.width, state.height, pixels);
  }

  private rebuildDirtyCurrentRows(
    gl: WebGL2RenderingContext,
    state: PressureState,
    input: WebGLPressureRenderInput,
  ): void {
    if (input.dirtyTokens.size === 0) return;
    gl.bindTexture(gl.TEXTURE_2D, state.currentTexture);

    for (const [rowIndex, row] of input.rows.entries()) {
      if (!input.dirtyTokens.has(row.tokenId)) continue;
      const bounds = deviceRowBounds(rowIndex, input.rows.length, state.height);
      const rowHeight = bounds.top - bounds.bottom;
      const pixels = buildSharpRowPixels(
        state.currentByToken.get(row.tokenId) ?? [],
        state.width,
        rowHeight,
        input.dpr,
        input.volumePerCssPixel,
        false,
      );
      uploadRow(gl, state.currentTexture, state.width, bounds.bottom, rowHeight, pixels);
    }
  }

  private advanceHistory(
    resources: GlResources,
    state: PressureState,
    input: WebGLPressureRenderInput,
  ): void {
    if (!state.historyActive) {
      state.lastDiffuseMs = input.nowMs;
      return;
    }

    const dtMs = Math.max(0, input.nowMs - state.lastDiffuseMs);
    const sigmaDevicePx =
      diffusionSigmaCss(dtMs, input.ageScaleSeconds) * input.dpr;
    if (!(sigmaDevicePx >= MIN_DIFFUSION_SIGMA_DEVICE_PX)) return;

    const rowHeight = state.height / Math.max(1, state.rowCount);
    const passes = Math.max(
      1,
      Math.ceil(
        (sigmaDevicePx * sigmaDevicePx) /
          (MAX_SIGMA_PER_PASS_DEVICE_PX * MAX_SIGMA_PER_PASS_DEVICE_PX),
      ),
    );

    // After a long suspension the residue is visually below usefulness anyway.
    // Clearing is preferable to an enormous burst of GPU passes on tab resume.
    if (passes > MAX_BLUR_PASSES || sigmaDevicePx > rowHeight * 2) {
      this.clearHistory(resources.gl, state);
      state.lastDiffuseMs = input.nowMs;
      return;
    }

    const sigmaPerPass = sigmaDevicePx / Math.sqrt(passes);
    for (let pass = 0; pass < passes; pass++)
      this.blurHistoryOnce(resources, state, sigmaPerPass);
    state.lastDiffuseMs = input.nowMs;
  }

  private blurHistoryOnce(
    resources: GlResources,
    state: PressureState,
    sigmaDevicePx: number,
  ): void {
    const { gl } = resources;
    const destination: 0 | 1 = state.historyFront === 0 ? 1 : 0;
    gl.bindFramebuffer(gl.FRAMEBUFFER, resources.framebuffer);
    attachTexture(gl, resources.framebuffer, state.historyTextures[destination]);
    gl.viewport(0, 0, state.width, state.height);
    gl.disable(gl.SCISSOR_TEST);
    gl.useProgram(resources.blurProgram);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, state.historyTextures[state.historyFront]);
    gl.uniform1i(resources.blurTexture, 0);
    gl.uniform2i(resources.blurSize, state.width, state.height);
    gl.uniform1f(resources.blurSigma, sigmaDevicePx);
    gl.uniform1i(
      resources.blurRadius,
      Math.min(MAX_SHADER_RADIUS, Math.max(1, Math.ceil(3 * sigmaDevicePx))),
    );
    gl.uniform1i(resources.blurRowCount, state.rowCount);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    state.historyFront = destination;
  }

  private depositHistory(
    resources: GlResources,
    state: PressureState,
    input: WebGLPressureRenderInput,
    displaced: readonly {
      rowIndex: number;
      segments: readonly SignedVolumeSegment[];
    }[],
  ): void {
    const { gl } = resources;
    clearTextureWithFramebuffer(
      gl,
      resources.framebuffer,
      state.depositTexture,
      state.width,
      state.height,
    );

    for (const { rowIndex, segments } of displaced) {
      const bounds = deviceRowBounds(rowIndex, input.rows.length, state.height);
      const rowHeight = bounds.top - bounds.bottom;
      const pixels = buildSharpRowPixels(
        segments,
        state.width,
        rowHeight,
        input.dpr,
        input.volumePerCssPixel,
        true,
      );
      uploadRow(gl, state.depositTexture, state.width, bounds.bottom, rowHeight, pixels);
    }

    const destination: 0 | 1 = state.historyFront === 0 ? 1 : 0;
    gl.bindFramebuffer(gl.FRAMEBUFFER, resources.framebuffer);
    attachTexture(gl, resources.framebuffer, state.historyTextures[destination]);
    gl.viewport(0, 0, state.width, state.height);
    gl.disable(gl.SCISSOR_TEST);
    gl.useProgram(resources.depositProgram);

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, state.historyTextures[state.historyFront]);
    gl.uniform1i(resources.depositHistory, 0);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, state.depositTexture);
    gl.uniform1i(resources.depositSource, 1);
    gl.drawArrays(gl.TRIANGLES, 0, 3);

    state.historyFront = destination;
    state.historyActive = true;
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
    gl.bindTexture(gl.TEXTURE_2D, state.historyTextures[state.historyFront]);
    gl.uniform1i(resources.presentHistory, 0);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, state.currentTexture);
    gl.uniform1i(resources.presentCurrent, 1);
    gl.uniform2i(resources.presentSize, state.width, state.height);
    gl.uniform1i(resources.presentRowCount, state.rowCount);

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

  private clearHistory(gl: WebGL2RenderingContext, state: PressureState): void {
    clearTexture(gl, state.historyTextures[0], state.width, state.height);
    clearTexture(gl, state.historyTextures[1], state.width, state.height);
    state.historyFront = 0;
    state.historyActive = false;
  }

  private deleteStateTextures(gl: WebGL2RenderingContext, state: PressureState): void {
    gl.deleteTexture(state.historyTextures[0]);
    gl.deleteTexture(state.historyTextures[1]);
    gl.deleteTexture(state.currentTexture);
    gl.deleteTexture(state.depositTexture);
  }

  private requestAllRedraws(): void {
    for (const state of this.states.values()) state.requestRedraw();
  }
}

export const sharedWebGLPressureRenderer = new SharedWebGLPressureRenderer();

function buildCurrentPixels(
  rows: readonly WebGLPressureRow[],
  currentByToken: ReadonlyMap<string, readonly SignedVolumeSegment[]>,
  width: number,
  height: number,
  dpr: number,
  volumePerCssPixel: number,
): Uint8Array {
  const pixels = new Uint8Array(width * height * 4);
  for (const [rowIndex, row] of rows.entries()) {
    const bounds = deviceRowBounds(rowIndex, rows.length, height);
    const rowPixels = buildSharpRowPixels(
      currentByToken.get(row.tokenId) ?? [],
      width,
      bounds.top - bounds.bottom,
      dpr,
      volumePerCssPixel,
      false,
    );
    pixels.set(rowPixels, bounds.bottom * width * 4);
  }
  return pixels;
}

function buildHistorySeedPixels(
  rows: readonly WebGLPressureRow[],
  currentByToken: ReadonlyMap<string, readonly SignedVolumeSegment[]>,
  width: number,
  height: number,
  dpr: number,
  ageScaleSeconds: number,
  volumePerCssPixel: number,
): { pixels: Uint8Array; active: boolean } {
  const pixels = new Uint8Array(width * height * 4);
  let active = false;

  for (const [rowIndex, row] of rows.entries()) {
    const historical = historicalOnlySegments(
      row.segments,
      currentByToken.get(row.tokenId) ?? [],
    );
    if (historical.length === 0) continue;
    active = true;

    const bounds = deviceRowBounds(rowIndex, rows.length, height);
    const rowPixels = buildAgedHistoryRowPixels(
      historical,
      width,
      bounds.top - bounds.bottom,
      dpr,
      ageScaleSeconds,
      volumePerCssPixel,
    );
    pixels.set(rowPixels, bounds.bottom * width * 4);
  }

  return { pixels, active };
}

function historicalOnlySegments(
  stale: readonly StaleSignedVolumeSegment[],
  current: readonly SignedVolumeSegment[],
): StaleSignedVolumeSegment[] {
  if (stale.length === 0) return [];
  if (current.length === 0)
    return stale.filter((segment) => segment.volume !== 0 && segment.ageMs !== Infinity);

  const result: StaleSignedVolumeSegment[] = [];
  let staleIndex = 0;
  let currentIndex = 0;

  while (staleIndex < stale.length && currentIndex < current.length) {
    const remembered = stale[staleIndex]!;
    const live = current[currentIndex]!;
    const lo = Math.max(remembered.lo, live.lo);
    const hi = Math.min(remembered.hi, live.hi);
    if (
      hi > lo &&
      remembered.volume !== 0 &&
      remembered.ageMs !== Infinity &&
      !approximatelyEqual(remembered.volume, live.volume)
    ) {
      result.push({ ...remembered, lo, hi });
    }
    if (remembered.hi <= live.hi) staleIndex++;
    if (live.hi <= remembered.hi) currentIndex++;
  }
  return result;
}

function buildAgedHistoryRowPixels(
  segments: readonly StaleSignedVolumeSegment[],
  width: number,
  height: number,
  dpr: number,
  ageScaleSeconds: number,
  volumePerCssPixel: number,
): Uint8Array {
  const pixels = new Uint8Array(width * height * 4);
  for (const segment of segments) {
    const profile = pressureInkProfile(
      segment.volume,
      segment.ageMs,
      volumePerCssPixel,
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
        pixels[offset] = Math.max(pixels[offset]!, value);
    }
  }
  return pixels;
}

function buildSharpRowPixels(
  segments: readonly SignedVolumeSegment[],
  width: number,
  height: number,
  dpr: number,
  volumePerCssPixel: number,
  composite: boolean,
): Uint8Array {
  const pixels = new Uint8Array(width * height * 4);
  const rowHeightCss = height / dpr;
  const reserveShares = volumePerCssPixel * rowHeightCss;
  const center = Math.floor((height - 1) / 2) + 0.5;

  for (const segment of segments) {
    if (segment.volume === 0 || Number.isNaN(segment.volume)) continue;
    const thicknessCss = pressureInkThicknessCss(
      segment.volume,
      reserveShares,
      rowHeightCss,
    );
    const thickness = Math.min(height, thicknessCss * dpr);
    if (!(thickness > 0)) continue;

    const y0 = center - thickness / 2;
    const y1 = center + thickness / 2;
    const x0 = clampInt(Math.round(clamp01(segment.lo) * width), 0, width);
    const x1 = clampInt(Math.round(clamp01(segment.hi) * width), 0, width);
    if (!(x1 > x0)) continue;
    const channel = segment.volume > 0 ? 0 : 1;

    const firstY = clampInt(Math.floor(y0), 0, height - 1);
    const lastY = clampInt(Math.ceil(y1) - 1, 0, height - 1);
    for (let y = firstY; y <= lastY; y++) {
      const coverage = clamp01(Math.min(y + 1, y1) - Math.max(y, y0));
      const source = Math.round(255 * coverage);
      if (source <= 0) continue;
      let offset = (y * width + x0) * 4 + channel;
      for (let x = x0; x < x1; x++, offset += 4) {
        if (!composite) {
          pixels[offset] = source;
          continue;
        }
        const previous = pixels[offset]!;
        pixels[offset] = Math.round(
          255 - ((255 - previous) * (255 - source)) / 255,
        );
      }
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

function uploadRow(
  gl: WebGL2RenderingContext,
  texture: WebGLTexture,
  width: number,
  bottom: number,
  height: number,
  pixels: Uint8Array,
): void {
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.texSubImage2D(
    gl.TEXTURE_2D,
    0,
    0,
    bottom,
    width,
    height,
    gl.RGBA,
    gl.UNSIGNED_BYTE,
    pixels,
  );
}

function clearTexture(
  gl: WebGL2RenderingContext,
  texture: WebGLTexture,
  width: number,
  height: number,
): void {
  uploadWholeTexture(gl, texture, width, height, new Uint8Array(width * height * 4));
}

function clearTextureWithFramebuffer(
  gl: WebGL2RenderingContext,
  framebuffer: WebGLFramebuffer,
  texture: WebGLTexture,
  width: number,
  height: number,
): void {
  gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
  attachTexture(gl, framebuffer, texture);
  gl.viewport(0, 0, width, height);
  gl.disable(gl.SCISSOR_TEST);
  gl.clearColor(0, 0, 0, 0);
  gl.clear(gl.COLOR_BUFFER_BIT);
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
}

function attachTexture(
  gl: WebGL2RenderingContext,
  framebuffer: WebGLFramebuffer,
  texture: WebGLTexture,
): void {
  gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
  gl.framebufferTexture2D(
    gl.FRAMEBUFFER,
    gl.COLOR_ATTACHMENT0,
    gl.TEXTURE_2D,
    texture,
    0,
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

function approximatelyEqual(a: number, b: number): boolean {
  if (a === b) return true;
  const scale = Math.max(1, Math.abs(a), Math.abs(b));
  return Math.abs(a - b) <= 1e-10 * scale;
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

  outColor = vec4(norm > 0.0 ? sum / norm : vec2(0.0), 0.0, 0.0);
}`;

const DEPOSIT_SHADER = `#version 300 es
precision highp float;
uniform sampler2D u_history;
uniform sampler2D u_deposit;
out vec4 outColor;
void main() {
  ivec2 pixel = ivec2(gl_FragCoord.xy);
  vec2 history = texelFetch(u_history, pixel, 0).rg;
  vec2 deposit = texelFetch(u_deposit, pixel, 0).rg;
  vec2 combined = vec2(1.0) - (vec2(1.0) - history) * (vec2(1.0) - deposit);
  outColor = vec4(combined, 0.0, 0.0);
}`;

const PRESENT_SHADER = `#version 300 es
precision highp float;
precision highp int;
uniform sampler2D u_history;
uniform sampler2D u_current;
uniform ivec2 u_size;
uniform int u_row_count;
uniform vec3 u_positive;
uniform vec3 u_negative;
out vec4 outColor;
void main() {
  ivec2 pixel = ivec2(gl_FragCoord.xy);
  vec2 current = texelFetch(u_current, pixel, 0).rg;

  int row = int(floor(gl_FragCoord.y * float(u_row_count) / float(u_size.y)));
  int rowBottom = int(floor(float(row) * float(u_size.y) / float(u_row_count)));
  int rowTop = int(floor(float(row + 1) * float(u_size.y) / float(u_row_count)));
  int centerY = clamp((rowBottom + rowTop - 1) / 2, 0, u_size.y - 1);
  vec2 currentCenter = texelFetch(u_current, ivec2(pixel.x, centerY), 0).rg;
  bool hasCurrentColumn = currentCenter.r + currentCenter.g > 0.00001;

  vec2 pressure = hasCurrentColumn
    ? current
    : texelFetch(u_history, pixel, 0).rg;
  float mass = pressure.r + pressure.g;
  if (mass <= 0.00001) {
    outColor = vec4(0.0);
    return;
  }

  float alpha = clamp(mass, 0.0, 1.0);
  vec3 color = (pressure.r * u_positive + pressure.g * u_negative) / mass;
  outColor = vec4(color, alpha);
}`;
