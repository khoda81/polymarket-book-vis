import type { ObservationTime } from "@/domain/pressure/observationClock";
import {
  PRESSURE_MIN_VISIBLE_ALPHA,
  type PressureExtent,
} from "@/domain/pressure/pressureField";
import type { PressureRun } from "@/domain/pressure/pressureFrontierSnapshot";
import { priceToNumber, type Price } from "@/domain/books/price";

export interface GpuPressureSurface {
  readonly key: string;
  readonly dataRevision: number;
  readonly maxPrice: Price;
  readonly runs: readonly PressureRun[];
  readonly cumulativeShares: readonly number[];
  readonly firstChangedRunSince: (revision: number) => number;
  /** O(1) validity timestamp for the currently resting portion of every run. */
  readonly currentValidThroughMs: number | undefined;
  readonly extents: readonly PressureExtent[];
  readonly extentRevision: number;
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
  readonly opacityTimeMs: ObservationTime;
  readonly background: string;
}

const INSTANCE_FLOATS = 7;
const INSTANCE_STRIDE = INSTANCE_FLOATS * Float32Array.BYTES_PER_ELEMENT;
const MAX_TIME_ORIGIN_AGE_MS = 60 * 60 * 1_000;
const PRESSURE_UPLOAD_DEBUG =
  typeof window !== "undefined" &&
  new URLSearchParams(window.location.search).get("pressureDebug") === "1";
const PRESSURE_UPLOAD_REPORT_INTERVAL_MS = 5_000;
const pressureUploadStats = {
  startedAtMs: 0,
  uploadCount: 0,
  fullUploadCount: 0,
  serializedRunCount: 0,
  uploadedBytes: 0,
};

const GEOMETRY_VERTEX = `#version 300 es
precision highp float;

layout(location = 0) in float aPriceLo;
layout(location = 1) in float aPriceHi;
layout(location = 2) in float aVolumeLo;
layout(location = 3) in float aVolumeHi;
layout(location = 4) in float aVolumeHiUnbounded;
layout(location = 5) in float aBandValidThroughSec;
layout(location = 6) in float aValidityMode;

uniform vec2 uCanvasCssSize;
uniform vec2 uPriceViewport;
uniform vec2 uRasterScale;
uniform float uVolumePerCssPixel;
uniform float uNowOffsetSec;
uniform float uGhostHalfLifeSec;
uniform bool uHasCurrentValidThrough;
uniform float uCurrentValidThroughSec;
uniform float uCenterCss;
uniform float uRowHeightCss;
uniform float uMirrorPrice;
uniform float uYDirection;
uniform vec3 uColor;

out vec3 vColor;
flat out vec4 vRectPx;
flat out float vReferenceAlpha;
flat out float vPersistent;

const float MIN_ALPHA = ${PRESSURE_MIN_VISIBLE_ALPHA};

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

  bool usesCurrentValidity = aValidityMode > 0.5 && aValidityMode < 1.5;
  bool persistent = aValidityMode > 1.5;
  if (usesCurrentValidity && !uHasCurrentValidThrough) {
    gl_Position = vec4(2.0, 2.0, 0.0, 1.0);
    return;
  }

  float referenceAlpha = 1.0;
  if (!persistent) {
    float validThroughSec =
        usesCurrentValidity ? uCurrentValidThroughSec : aBandValidThroughSec;
    float halfLifeSec = max(uGhostHalfLifeSec, 1e-6);
    float ageSec = max(0.0, uNowOffsetSec - validThroughSec);
    referenceAlpha = exp2(-ageSec / halfLifeSec);
  }

  float reserveShares = uVolumePerCssPixel * uRowHeightCss;
  float reserveSharesSq = reserveShares * reserveShares;
  float pressureLo =
      aVolumeLo <= 0.0
        ? 0.0
        : aVolumeLo / sqrt(aVolumeLo * aVolumeLo + reserveSharesSq);
  float pressureHi =
      aVolumeHiUnbounded > 0.5
        ? 1.0
        : (aVolumeHi <= 0.0
            ? 0.0
            : aVolumeHi / sqrt(aVolumeHi * aVolumeHi + reserveSharesSq));

  float y0Css =
      uCenterCss + uYDirection * 0.5 * uRowHeightCss * pressureLo;
  float y1Css =
      uCenterCss + uYDirection * 0.5 * uRowHeightCss * pressureHi;
  float yMinCss = min(y0Css, y1Css);
  float yMaxCss = max(y0Css, y1Css);

  float p0 = uMirrorPrice > 0.5 ? 1.0 - aPriceLo : aPriceLo;
  float p1 = uMirrorPrice > 0.5 ? 1.0 - aPriceHi : aPriceHi;
  float x0Css = uPriceViewport.x + p0 * uPriceViewport.y;
  float x1Css = uPriceViewport.x + p1 * uPriceViewport.y;
  float xMinCss = min(x0Css, x1Css);
  float xMaxCss = max(x0Css, x1Css);

  vRectPx = vec4(
    xMinCss * uRasterScale.x,
    (uCanvasCssSize.y - yMaxCss) * uRasterScale.y,
    xMaxCss * uRasterScale.x,
    (uCanvasCssSize.y - yMinCss) * uRasterScale.y
  );
  vColor = uColor;
  vReferenceAlpha = referenceAlpha;
  vPersistent = persistent ? 1.0 : 0.0;

  if (referenceAlpha <= MIN_ALPHA) {
    gl_Position = vec4(2.0, 2.0, 0.0, 1.0);
    return;
  }

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
}
`;

const GEOMETRY_FRAGMENT = `#version 300 es
precision highp float;

in vec3 vColor;
flat in vec4 vRectPx;
flat in float vReferenceAlpha;
flat in float vPersistent;
layout(location = 0) out vec4 outDecaying;
layout(location = 1) out vec4 outPersistent;

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
  vec4 value = vec4(vColor * alpha, alpha);
  if (vPersistent > 0.5) {
    outDecaying = vec4(0.0);
    outPersistent = value;
  } else {
    outDecaying = value;
    outPersistent = vec4(0.0);
  }
}
`;

const DISPLAY_VERTEX = `#version 300 es
precision highp float;

const vec2 POSITIONS[3] = vec2[3](
  vec2(-1.0, -1.0),
  vec2(3.0, -1.0),
  vec2(-1.0, 3.0)
);

void main() {
  gl_Position = vec4(POSITIONS[gl_VertexID], 0.0, 1.0);
}
`;

const DISPLAY_FRAGMENT = `#version 300 es
precision highp float;

uniform sampler2D uDecayingColor;
uniform sampler2D uPersistentColor;
uniform float uGlobalDecay;

out vec4 outColor;

void main() {
  ivec2 pixel = ivec2(gl_FragCoord.xy);
  vec4 decaying = texelFetch(uDecayingColor, pixel, 0) * uGlobalDecay;
  vec4 persistent = texelFetch(uPersistentColor, pixel, 0);
  vec4 resolved = persistent + decaying * (1.0 - persistent.a);

  // Write transparent pixels instead of discarding them. The display pass
  // covers the entire canvas, so this makes an explicit full-canvas clear
  // unnecessary on opacity-only refreshes.
  outColor = resolved.a <= 0.0039215686 ? vec4(0.0) : resolved;
}
`;

interface CachedPressureSurface {
  readonly buffer: WebGLBuffer;
  readonly vao: WebGLVertexArrayObject;
  readonly resident: PressureResidentBuffer;
  dataRevision: number;
  extentRevision: number;
  instanceCount: number;
  timeOriginMs: number;
  gpuCapacityFloats: number;
}

export class GpuPressureLayer {
  private readonly gl: WebGL2RenderingContext;
  private readonly geometryProgram: WebGLProgram;
  private readonly displayProgram: WebGLProgram;
  private readonly displayVao: WebGLVertexArrayObject;
  private readonly framebuffer: WebGLFramebuffer;
  private readonly colorTexture: WebGLTexture;
  private readonly persistentTexture: WebGLTexture;
  private readonly surfaceBuffers = new Map<string, CachedPressureSurface>();
  private totalCachedInstanceCount = 0;

  private displayWidth = 0;
  private displayHeight = 0;
  private rasterKey = "";
  private referenceTimeMs = 0;
  private referenceHalfLifeMs = 0;
  private displayedOpacityTimeMs = 0;
  private displayedHalfLifeMs = 0;
  private displayStateReady = false;
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
    this.displayVao = required(gl.createVertexArray(), "display VAO");
    this.framebuffer = required(gl.createFramebuffer(), "framebuffer");
    this.colorTexture = required(gl.createTexture(), "color texture");
    this.persistentTexture = required(
      gl.createTexture(),
      "persistent pressure texture",
    );

    configureTexture(gl, this.colorTexture);
    configureTexture(gl, this.persistentTexture);
  }

  setVisible(visible: boolean): void {
    if (visible === this.visible) return;
    this.visible = visible;
    this.canvas.style.display = visible ? "block" : "none";
  }

  invalidate(): void {
    this.clearSurfaceBuffers();
    this.rasterKey = "";
    this.referenceTimeMs = 0;
    this.displayedOpacityTimeMs = 0;
    this.displayStateReady = false;
  }

  render(frame: GpuPressureFrame): void {
    this.setVisible(true);
    this.canvas.style.background = frame.background;

    const displayWidth = Math.max(1, Math.floor(frame.cssWidth * frame.dpr));
    const displayHeight = Math.max(1, Math.floor(frame.cssHeight * frame.dpr));
    const resized = this.resizeTargets(displayWidth, displayHeight);

    const buffersChanged = this.syncSurfaceBuffers(frame);

    const nextRasterKey = rasterProjectionKey(
      frame,
      displayWidth,
      displayHeight,
    );
    let rasterized = false;
    if (
      resized ||
      buffersChanged ||
      nextRasterKey !== this.rasterKey ||
      frame.opacityTimeMs < this.referenceTimeMs
    ) {
      this.rasterize(frame);
      this.rasterKey = nextRasterKey;
      rasterized = true;
    }

    this.drawDisplay(
      frame.opacityTimeMs,
      frame.ghostHalfLifeMs,
      rasterized || resized || buffersChanged,
    );
  }

  /**
   * Advance only the display-time decay of an already-rasterized pressure
   * field. Returns false when the cached geometry cannot represent the new
   * reference and the owner must do a full render.
   */
  refreshOpacity(
    opacityTimeMs: ObservationTime,
    ghostHalfLifeMs: number,
  ): boolean {
    if (
      !this.visible ||
      this.displayWidth === 0 ||
      this.referenceTimeMs === 0 ||
      ghostHalfLifeMs !== this.referenceHalfLifeMs ||
      opacityTimeMs < this.referenceTimeMs
    )
      return false;

    if (
      opacityTimeMs === this.displayedOpacityTimeMs &&
      ghostHalfLifeMs === this.displayedHalfLifeMs
    )
      return true;

    this.drawDisplay(opacityTimeMs, ghostHalfLifeMs);
    return true;
  }

  destroy(): void {
    const gl = this.gl;
    this.clearSurfaceBuffers();
    gl.deleteTexture(this.colorTexture);
    gl.deleteTexture(this.persistentTexture);
    gl.deleteFramebuffer(this.framebuffer);
    gl.deleteVertexArray(this.displayVao);
    gl.deleteProgram(this.geometryProgram);
    gl.deleteProgram(this.displayProgram);
  }

  private syncSurfaceBuffers(frame: GpuPressureFrame): boolean {
    const active = new Set<string>();
    let changed = false;
    let totalInstances = 0;

    for (const row of frame.rows) {
      for (const surface of row.surfaces) {
        active.add(surface.key);
        let cached = this.surfaceBuffers.get(surface.key);
        if (!cached) {
          cached = this.createSurfaceBuffer();
          this.surfaceBuffers.set(surface.key, cached);
          changed = true;
        }

        if (
          cached.dataRevision !== surface.dataRevision ||
          cached.extentRevision !== surface.extentRevision
        ) {
          const extentsChanged =
            cached.extentRevision !== surface.extentRevision;
          const firstChangedRun =
            cached.dataRevision < 0 || extentsChanged
              ? 0
              : surface.firstChangedRunSince(cached.dataRevision);
          this.uploadSurfaceBuffer(
            cached,
            surface,
            frame.opacityTimeMs,
            firstChangedRun,
          );
          cached.dataRevision = surface.dataRevision;
          cached.extentRevision = surface.extentRevision;
          changed = true;
        }
        totalInstances += cached.instanceCount;
      }
    }

    for (const [key, cached] of this.surfaceBuffers) {
      if (active.has(key)) continue;
      this.deleteSurfaceBuffer(cached);
      this.surfaceBuffers.delete(key);
      changed = true;
    }

    this.totalCachedInstanceCount = totalInstances;
    return changed;
  }

  private createSurfaceBuffer(): CachedPressureSurface {
    const gl = this.gl;
    const buffer = required(gl.createBuffer(), "pressure surface buffer");
    const vao = required(gl.createVertexArray(), "pressure surface VAO");

    gl.bindVertexArray(vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);

    for (let location = 0; location < INSTANCE_FLOATS; location++) {
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

    gl.bindVertexArray(null);
    gl.bindBuffer(gl.ARRAY_BUFFER, null);

    return {
      buffer,
      vao,
      resident: new PressureResidentBuffer(),
      dataRevision: -1,
      extentRevision: -1,
      instanceCount: 0,
      timeOriginMs: 0,
      gpuCapacityFloats: 0,
    };
  }

  private uploadSurfaceBuffer(
    cached: CachedPressureSurface,
    surface: GpuPressureSurface,
    nowMs: number,
    requestedFirstRun: number,
  ): void {
    let firstRun = Math.max(
      0,
      Math.min(surface.runs.length, requestedFirstRun),
    );
    if (
      cached.timeOriginMs === 0 ||
      nowMs - cached.timeOriginMs > MAX_TIME_ORIGIN_AGE_MS
    ) {
      cached.timeOriginMs = nowMs;
      firstRun = 0;
    }

    const firstFloat = cached.resident.rebuildFrom(
      surface.runs,
      surface.cumulativeShares,
      surface.maxPrice,
      surface.extents,
      cached.timeOriginMs,
      firstRun,
    );
    cached.instanceCount = cached.resident.instanceCount;
    const serializedRuns = surface.runs.length - firstRun;

    const gl = this.gl;
    gl.bindBuffer(gl.ARRAY_BUFFER, cached.buffer);
    let uploadedFloats = 0;
    let fullUpload = false;
    if (cached.resident.capacityFloats > cached.gpuCapacityFloats) {
      cached.gpuCapacityFloats = cached.resident.capacityFloats;
      gl.bufferData(
        gl.ARRAY_BUFFER,
        cached.gpuCapacityFloats * Float32Array.BYTES_PER_ELEMENT,
        gl.DYNAMIC_DRAW,
      );
      if (cached.resident.usedFloats > 0) {
        gl.bufferSubData(gl.ARRAY_BUFFER, 0, cached.resident.usedData());
        uploadedFloats = cached.resident.usedFloats;
      }
      fullUpload = true;
    } else if (firstFloat < cached.resident.usedFloats) {
      gl.bufferSubData(
        gl.ARRAY_BUFFER,
        firstFloat * Float32Array.BYTES_PER_ELEMENT,
        cached.resident.dataFrom(firstFloat),
      );
      uploadedFloats = cached.resident.usedFloats - firstFloat;
      fullUpload = firstFloat === 0;
    }
    gl.bindBuffer(gl.ARRAY_BUFFER, null);
    this.recordUploadStats(
      serializedRuns,
      uploadedFloats * Float32Array.BYTES_PER_ELEMENT,
      fullUpload,
    );
  }

  private recordUploadStats(
    serializedRuns: number,
    uploadedBytes: number,
    fullUpload: boolean,
  ): void {
    if (!PRESSURE_UPLOAD_DEBUG) return;

    const nowMs = performance.now();
    if (pressureUploadStats.startedAtMs === 0)
      pressureUploadStats.startedAtMs = nowMs;
    pressureUploadStats.uploadCount++;
    pressureUploadStats.fullUploadCount += fullUpload ? 1 : 0;
    pressureUploadStats.serializedRunCount += serializedRuns;
    pressureUploadStats.uploadedBytes += uploadedBytes;

    const elapsedMs = nowMs - pressureUploadStats.startedAtMs;
    if (elapsedMs < PRESSURE_UPLOAD_REPORT_INTERVAL_MS) return;

    console.debug(
      `[pressure:uploads] ${JSON.stringify({
        seconds: elapsedMs / 1_000,
        uploadsPerSecond: (pressureUploadStats.uploadCount * 1_000) / elapsedMs,
        fullUploadShare:
          pressureUploadStats.fullUploadCount / pressureUploadStats.uploadCount,
        averageRunsSerialized:
          pressureUploadStats.serializedRunCount /
          pressureUploadStats.uploadCount,
        bytesPerSecond: (pressureUploadStats.uploadedBytes * 1_000) / elapsedMs,
      })}`,
    );
    pressureUploadStats.startedAtMs = nowMs;
    pressureUploadStats.uploadCount = 0;
    pressureUploadStats.fullUploadCount = 0;
    pressureUploadStats.serializedRunCount = 0;
    pressureUploadStats.uploadedBytes = 0;
  }

  private deleteSurfaceBuffer(cached: CachedPressureSurface): void {
    this.gl.deleteBuffer(cached.buffer);
    this.gl.deleteVertexArray(cached.vao);
  }

  private clearSurfaceBuffers(): void {
    for (const cached of this.surfaceBuffers.values())
      this.deleteSurfaceBuffer(cached);
    this.surfaceBuffers.clear();
    this.totalCachedInstanceCount = 0;
  }

  private resizeTargets(displayWidth: number, displayHeight: number): boolean {
    if (
      displayWidth === this.displayWidth &&
      displayHeight === this.displayHeight
    )
      return false;

    this.displayWidth = displayWidth;
    this.displayHeight = displayHeight;
    this.displayStateReady = false;
    this.canvas.width = displayWidth;
    this.canvas.height = displayHeight;

    const gl = this.gl;
    for (const texture of [this.colorTexture, this.persistentTexture]) {
      gl.bindTexture(gl.TEXTURE_2D, texture);
      gl.texImage2D(
        gl.TEXTURE_2D,
        0,
        gl.RGBA8,
        displayWidth,
        displayHeight,
        0,
        gl.RGBA,
        gl.UNSIGNED_BYTE,
        null,
      );
    }

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
      gl.COLOR_ATTACHMENT1,
      gl.TEXTURE_2D,
      this.persistentTexture,
      0,
    );
    gl.drawBuffers([gl.COLOR_ATTACHMENT0, gl.COLOR_ATTACHMENT1]);
    const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    if (status !== gl.FRAMEBUFFER_COMPLETE)
      throw new Error(`pressure framebuffer is incomplete: ${status}`);

    return true;
  }

  private rasterize(frame: GpuPressureFrame): void {
    const gl = this.gl;
    this.displayStateReady = false;
    this.referenceTimeMs = frame.opacityTimeMs;
    this.referenceHalfLifeMs = frame.ghostHalfLifeMs;

    gl.bindFramebuffer(gl.FRAMEBUFFER, this.framebuffer);
    gl.viewport(0, 0, this.displayWidth, this.displayHeight);
    gl.disable(gl.DEPTH_TEST);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);

    if (this.totalCachedInstanceCount > 0) {
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
        this.displayWidth / frame.cssWidth,
        this.displayHeight / frame.cssHeight,
      );
      uniform1f(
        gl,
        this.geometryProgram,
        "uVolumePerCssPixel",
        frame.volumePerCssPixel,
      );
      uniform1f(
        gl,
        this.geometryProgram,
        "uGhostHalfLifeSec",
        frame.ghostHalfLifeMs / 1_000,
      );

      gl.enable(gl.BLEND);
      gl.blendEquation(gl.FUNC_ADD);
      gl.blendFunc(gl.ONE, gl.ONE);

      for (const row of frame.rows) {
        for (const surface of row.surfaces) {
          const cached = this.surfaceBuffers.get(surface.key);
          if (!cached || cached.instanceCount === 0) continue;

          uniform1f(
            gl,
            this.geometryProgram,
            "uNowOffsetSec",
            (frame.opacityTimeMs - cached.timeOriginMs) / 1_000,
          );

          const hasCurrent = surface.currentValidThroughMs !== undefined;
          uniform1i(
            gl,
            this.geometryProgram,
            "uHasCurrentValidThrough",
            hasCurrent ? 1 : 0,
          );
          uniform1f(
            gl,
            this.geometryProgram,
            "uCurrentValidThroughSec",
            hasCurrent
              ? (surface.currentValidThroughMs! - cached.timeOriginMs) / 1_000
              : 0,
          );
          uniform1f(gl, this.geometryProgram, "uCenterCss", row.centerCss);
          uniform1f(gl, this.geometryProgram, "uRowHeightCss", row.heightCss);
          uniform1f(
            gl,
            this.geometryProgram,
            "uMirrorPrice",
            surface.mirrorPrice ? 1 : 0,
          );
          uniform1f(
            gl,
            this.geometryProgram,
            "uYDirection",
            surface.yDirection,
          );
          uniform3f(
            gl,
            this.geometryProgram,
            "uColor",
            resolveCssColor(surface.color),
          );

          gl.bindVertexArray(cached.vao);
          gl.drawArraysInstanced(gl.TRIANGLES, 0, 6, cached.instanceCount);
        }
      }

      gl.bindVertexArray(null);
      gl.disable(gl.BLEND);
    }

    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }

  private drawDisplay(
    opacityTimeMs: ObservationTime,
    ghostHalfLifeMs: number,
    forceState = false,
  ): void {
    const gl = this.gl;
    if (forceState || !this.displayStateReady) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.viewport(0, 0, this.displayWidth, this.displayHeight);
      gl.disable(gl.DEPTH_TEST);
      gl.disable(gl.BLEND);
      gl.useProgram(this.displayProgram);

      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, this.colorTexture);
      uniform1i(gl, this.displayProgram, "uDecayingColor", 0);
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, this.persistentTexture);
      uniform1i(gl, this.displayProgram, "uPersistentColor", 1);

      gl.bindVertexArray(this.displayVao);
      this.displayStateReady = true;
    }

    this.displayedOpacityTimeMs = opacityTimeMs;
    this.displayedHalfLifeMs = ghostHalfLifeMs;

    const elapsedMs = Math.max(0, opacityTimeMs - this.referenceTimeMs);
    uniform1f(
      gl,
      this.displayProgram,
      "uGlobalDecay",
      2 ** (-elapsedMs / ghostHalfLifeMs),
    );
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }
}

export class PressureResidentBuffer {
  private values = new Float32Array(0);
  private readonly runInstanceOffsets: number[] = [];
  usedFloats = 0;

  get capacityFloats(): number {
    return this.values.length;
  }

  get instanceCount(): number {
    return this.usedFloats / INSTANCE_FLOATS;
  }

  usedData(): Float32Array {
    return this.values.subarray(0, this.usedFloats);
  }

  dataFrom(firstFloat: number): Float32Array {
    return this.values.subarray(firstFloat, this.usedFloats);
  }

  /**
   * Rewrite the flattened resident representation from one canonical run
   * onward. Prefix bytes and run offsets stay intact.
   *
   * Returns the first float whose GPU copy may have changed.
   */
  rebuildFrom(
    runs: readonly PressureRun[],
    cumulativeShares: readonly number[],
    maxPrice: Price,
    extents: readonly PressureExtent[],
    timeOriginMs: number,
    requestedFirstRun: number,
  ): number {
    let firstRun = Math.max(0, Math.min(runs.length, requestedFirstRun));
    if (
      cumulativeShares.length !== runs.length ||
      firstRun >= this.runInstanceOffsets.length
    )
      firstRun = 0;

    let writeFloat =
      firstRun === 0 ? 0 : this.runInstanceOffsets[firstRun]! * INSTANCE_FLOATS;
    const firstFloat = writeFloat;
    this.runInstanceOffsets.length = runs.length + 1;
    for (let index = firstRun; index < runs.length; index++) {
      const run = runs[index]!;
      const currentVolume = cumulativeShares[index]!;
      this.runInstanceOffsets[index] = writeFloat / INSTANCE_FLOATS;

      const nextPrice = runs[index + 1]?.price ?? maxPrice;
      const priceLo = priceToNumber(run.price);
      const priceHi = priceToNumber(nextPrice);
      if (!(priceHi > priceLo)) continue;

      if (currentVolume > 0)
        writeFloat = this.appendInstance(
          writeFloat,
          priceLo,
          priceHi,
          0,
          currentVolume,
          0,
          0,
          1,
        );

      let lower = currentVolume;
      for (
        let stepIndex = run.frozenSteps.length - 1;
        stepIndex >= 0;
        stepIndex--
      ) {
        const step = run.frozenSteps[stepIndex]!;
        writeFloat = this.appendInstance(
          writeFloat,
          priceLo,
          priceHi,
          lower,
          step.hiVolume,
          0,
          (step.validThroughMs - timeOriginMs) / 1_000,
          0,
        );
        lower = step.hiVolume;
      }
    }

    this.runInstanceOffsets[runs.length] = writeFloat / INSTANCE_FLOATS;

    for (const extent of extents) {
      writeFloat = this.appendInstance(
        writeFloat,
        priceToNumber(extent.priceLo),
        priceToNumber(extent.priceHi),
        extent.loVolume,
        extent.hiVolume.kind === "finite" ? extent.hiVolume.shares : 0,
        extent.hiVolume.kind === "unbounded" ? 1 : 0,
        extent.validity.kind === "through"
          ? (extent.validity.validThroughMs - timeOriginMs) / 1_000
          : 0,
        extent.validity.kind === "persistent" ? 2 : 0,
      );
    }

    this.usedFloats = writeFloat;
    return firstFloat;
  }

  private appendInstance(
    writeFloat: number,
    priceLo: number,
    priceHi: number,
    volumeLo: number,
    volumeHi: number,
    volumeHiUnbounded: number,
    validThroughSec: number,
    validityMode: number,
  ): number {
    this.ensureCapacity(writeFloat + INSTANCE_FLOATS, writeFloat);
    this.values[writeFloat] = priceLo;
    this.values[writeFloat + 1] = priceHi;
    this.values[writeFloat + 2] = volumeLo;
    this.values[writeFloat + 3] = volumeHi;
    this.values[writeFloat + 4] = volumeHiUnbounded;
    this.values[writeFloat + 5] = validThroughSec;
    this.values[writeFloat + 6] = validityMode;
    return writeFloat + INSTANCE_FLOATS;
  }

  private ensureCapacity(requiredFloats: number, preserveFloats: number): void {
    if (requiredFloats <= this.values.length) return;

    let capacity = Math.max(INSTANCE_FLOATS * 16, this.values.length * 2);
    while (capacity < requiredFloats) capacity *= 2;
    const next = new Float32Array(capacity);
    next.set(this.values.subarray(0, preserveFloats));
    this.values = next;
  }
}

function rasterProjectionKey(
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
              `${surface.key}:${surface.dataRevision}:${surface.extentRevision}:${surface.currentValidThroughMs ?? ""}:${surface.color}:${surface.mirrorPrice ? 1 : 0}:${surface.yDirection}`,
          )
          .join(",")}`,
    )
    .join("|");

  return [
    width,
    height,
    frame.cssWidth,
    frame.cssHeight,
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

const UNIFORM_LOCATION_CACHE = new WeakMap<
  WebGLProgram,
  Map<string, WebGLUniformLocation>
>();

function uniformLocation(
  gl: WebGL2RenderingContext,
  program: WebGLProgram,
  name: string,
): WebGLUniformLocation {
  let locations = UNIFORM_LOCATION_CACHE.get(program);
  if (!locations) {
    locations = new Map();
    UNIFORM_LOCATION_CACHE.set(program, locations);
  }

  const cached = locations.get(name);
  if (cached) return cached;

  const location = required(gl.getUniformLocation(program, name), name);
  locations.set(name, location);
  return location;
}

function uniform1f(
  gl: WebGL2RenderingContext,
  program: WebGLProgram,
  name: string,
  value: number,
): void {
  gl.uniform1f(uniformLocation(gl, program, name), value);
}

function uniform1i(
  gl: WebGL2RenderingContext,
  program: WebGLProgram,
  name: string,
  value: number,
): void {
  gl.uniform1i(uniformLocation(gl, program, name), value);
}

function uniform2f(
  gl: WebGL2RenderingContext,
  program: WebGLProgram,
  name: string,
  x: number,
  y: number,
): void {
  gl.uniform2f(uniformLocation(gl, program, name), x, y);
}

function uniform3f(
  gl: WebGL2RenderingContext,
  program: WebGLProgram,
  name: string,
  value: readonly [number, number, number],
): void {
  gl.uniform3f(
    uniformLocation(gl, program, name),
    value[0],
    value[1],
    value[2],
  );
}

function required<T>(value: T | null, label: string): T {
  if (value === null) throw new Error(`Could not create/find ${label}`);
  return value;
}
