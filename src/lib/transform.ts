/**
 * Plain affine transform: `screen = T(data)` with 6 numbers, no allocations
 * in hot paths. Replaces DOMMatrix/DOMPoint to avoid GC pressure on the draw
 * loop. The transform is always axis-aligned (b = c = 0) for our charts, but
 * the general form is kept so composition/inversion stay correct and obvious.
 */
export interface Transform {
  readonly a: number;
  readonly b: number;
  readonly c: number;
  readonly d: number;
  readonly e: number;
  readonly f: number;
}

export interface Domain {
  readonly xMin: number;
  readonly xMax: number;
  readonly yMin: number;
  readonly yMax: number;
}

export interface Viewport {
  readonly l: number;
  readonly t: number;
  readonly width: number;
  readonly height: number;
}

/** Map a data point to screen coordinates. */
export const toScreenX = (t: Transform, x: number, y: number): number =>
  t.a * x + t.c * y + t.e;
export const toScreenY = (t: Transform, x: number, y: number): number =>
  t.b * x + t.d * y + t.f;

// TODO: Is there a reason these are functions and not methods? Is there a performance difference?
/** Map a screen point to data coordinates using the inverse of `t`. */
export const toDataX = (t: Transform, sx: number, sy: number): number =>
  t.a * sx + t.c * sy + t.e;
export const toDataY = (t: Transform, sx: number, sy: number): number =>
  t.b * sx + t.d * sy + t.f;

/** Compose two transforms: `apply(A, apply(B, p)) === apply(compose(A, B), p)`. */
export function compose(a: Transform, b: Transform): Transform {
  return {
    a: a.a * b.a + a.c * b.b,
    b: a.b * b.a + a.d * b.b,
    c: a.a * b.c + a.c * b.d,
    d: a.b * b.c + a.d * b.d,
    e: a.a * b.e + a.c * b.f + a.e,
    f: a.b * b.e + a.d * b.f + a.f,
  };
}

export function invert(t: Transform): Transform {
  const det = t.a * t.d - t.b * t.c;
  if (det === 0) throw new Error("Transform is not invertible (singular)");
  const inv = 1 / det;
  return {
    a: t.d * inv,
    b: -t.b * inv,
    c: -t.c * inv,
    d: t.a * inv,
    e: (t.c * t.f - t.d * t.e) * inv,
    f: (t.b * t.e - t.a * t.f) * inv,
  };
}

/**
 * Build the data→screen transform for a viewport/domain pair.
 * y is flipped (screen y grows downward), xMin→left, xMax→right,
 * yMin→bottom, yMax→top.
 */
export function fromDomainViewport(domain: Domain, vp: Viewport): Transform {
  const sx = vp.width / (domain.xMax - domain.xMin);
  const sy = -vp.height / (domain.yMax - domain.yMin);
  return {
    a: sx,
    b: 0,
    c: 0,
    d: sy,
    e: vp.l - sx * domain.xMin,
    f: vp.t + vp.height - sy * domain.yMin,
  };
}
