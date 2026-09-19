import type { SignedVolumeSegment } from "./signedVolume";

export type PressureSide = -1 | 1;

export type PressureBandState =
  | { readonly kind: "live" }
  | {
      readonly kind: "ghost";
      readonly sinceMs: number;
    };

export interface PressureBand {
  readonly loVolume: number;
  readonly hiVolume: number;
  readonly side: PressureSide;
  readonly state: PressureBandState;
}

export interface PressureCell {
  readonly lo: number;
  readonly hi: number;
  readonly bands: readonly PressureBand[];
}

/**
 * Compressed temporal memory of a signed pressure field.
 *
 * Each probability interval owns non-overlapping cumulative-volume bands.
 * The newest live observation paints [0, |Q|], permanently replacing older
 * history there. Previously-live volume left outside the new live envelope
 * becomes a ghost; already-ghosted outer bands keep their original age.
 *
 * This is not a timeline. Once history is overdrawn it is intentionally lost.
 */
export class PressureMemory {
  private cells: PressureCell[] = [
    { lo: 0, hi: 1, bands: [] },
  ];

  observe(
    segments: readonly Pick<
      SignedVolumeSegment,
      "lo" | "hi" | "volume"
    >[],
    nowMs: number,
  ): void {
    if (!Number.isFinite(nowMs))
      throw new RangeError("observation time must be finite");

    const samples = normalizeSamples(segments);
    const boundaries = uniqueSortedBoundaries(this.cells, samples);
    const next: PressureCell[] = [];

    let oldIndex = 0;
    let sampleIndex = 0;
    for (let i = 0; i + 1 < boundaries.length; i++) {
      const lo = boundaries[i]!;
      const hi = boundaries[i + 1]!;
      if (!(hi > lo)) continue;
      const mid = (lo + hi) / 2;

      while (
        oldIndex + 1 < this.cells.length &&
        this.cells[oldIndex]!.hi <= mid
      )
        oldIndex++;
      while (
        sampleIndex + 1 < samples.length &&
        samples[sampleIndex]!.hi <= mid
      )
        sampleIndex++;

      const oldCell = contains(this.cells[oldIndex], mid)
        ? this.cells[oldIndex]!
        : undefined;
      const sample = contains(samples[sampleIndex], mid)
        ? samples[sampleIndex]!
        : undefined;
      const volume = sample?.volume ?? 0;

      next.push({
        lo,
        hi,
        bands: evolveBands(
          oldCell?.bands ?? [],
          volume,
          nowMs,
        ),
      });
    }

    this.cells = mergeAdjacentCells(next);
  }

  snapshot(): readonly PressureCell[] {
    return this.cells;
  }

  restore(cells: readonly PressureCell[]): void {
    const parsed = parsePressureCells(cells);
    this.cells =
      parsed.length > 0
        ? mergeAdjacentCells(parsed)
        : [{ lo: 0, hi: 1, bands: [] }];
  }

  hasGhosts(): boolean {
    return this.cells.some((cell) =>
      cell.bands.some((band) => band.state.kind === "ghost"),
    );
  }

  prune(
    nowMs: number,
    halfLifeMs: number,
    minAlpha = 0.01,
  ): void {
    validateHalfLife(halfLifeMs);
    if (!(minAlpha >= 0 && minAlpha < 1))
      throw new RangeError("min alpha must be in [0, 1)");

    this.cells = mergeAdjacentCells(
      this.cells.map((cell) => ({
        ...cell,
        bands: mergeAdjacentBands(
          cell.bands.filter(
            (band) =>
              band.state.kind === "live" ||
              ghostAlpha(
                band.state.sinceMs,
                nowMs,
                halfLifeMs,
              ) > minAlpha,
          ),
        ),
      })),
    );
  }
}

export function ghostAlpha(
  sinceMs: number,
  nowMs: number,
  halfLifeMs: number,
): number {
  validateHalfLife(halfLifeMs);
  const ageMs = Math.max(0, nowMs - sinceMs);
  return Math.exp((-Math.LN2 * ageMs) / halfLifeMs);
}

function evolveBands(
  oldBands: readonly PressureBand[],
  signedVolume: number,
  nowMs: number,
): readonly PressureBand[] {
  if (Number.isNaN(signedVolume)) signedVolume = 0;

  const magnitude = Number.isFinite(signedVolume)
    ? Math.abs(signedVolume)
    : Number.POSITIVE_INFINITY;
  const side: PressureSide = signedVolume < 0 ? -1 : 1;
  const survivors: PressureBand[] = [];

  for (const band of oldBands) {
    if (band.hiVolume <= magnitude) continue;

    const loVolume = Math.max(band.loVolume, magnitude);
    if (!(band.hiVolume > loVolume)) continue;

    survivors.push({
      loVolume,
      hiVolume: band.hiVolume,
      side: band.side,
      state:
        band.state.kind === "live"
          ? { kind: "ghost", sinceMs: nowMs }
          : band.state,
    });
  }

  if (magnitude > 0) {
    survivors.unshift({
      loVolume: 0,
      hiVolume: magnitude,
      side,
      state: { kind: "live" },
    });
  }

  return mergeAdjacentBands(survivors);
}

function normalizeSamples(
  segments: readonly Pick<
    SignedVolumeSegment,
    "lo" | "hi" | "volume"
  >[],
): PressureSample[] {
  return segments
    .filter(
      ({ lo, hi }) =>
        Number.isFinite(lo) &&
        Number.isFinite(hi) &&
        hi > lo &&
        hi > 0 &&
        lo < 1,
    )
    .map(({ lo, hi, volume }) => ({
      lo: clamp(lo, 0, 1),
      hi: clamp(hi, 0, 1),
      volume,
    }))
    .filter(({ lo, hi }) => hi > lo)
    .sort((a, b) => a.lo - b.lo || a.hi - b.hi);
}

interface PressureSample {
  readonly lo: number;
  readonly hi: number;
  readonly volume: number;
}

function uniqueSortedBoundaries(
  cells: readonly PressureCell[],
  samples: readonly PressureSample[],
): number[] {
  const boundaries = new Set<number>([0, 1]);
  for (const interval of [...cells, ...samples]) {
    boundaries.add(clamp(interval.lo, 0, 1));
    boundaries.add(clamp(interval.hi, 0, 1));
  }
  return [...boundaries].sort((a, b) => a - b);
}

function mergeAdjacentCells(
  cells: readonly PressureCell[],
): PressureCell[] {
  const result: PressureCell[] = [];
  for (const cell of cells) {
    const previous = result[result.length - 1];
    if (
      previous &&
      previous.hi === cell.lo &&
      bandsEqual(previous.bands, cell.bands)
    ) {
      result[result.length - 1] = {
        lo: previous.lo,
        hi: cell.hi,
        bands: previous.bands,
      };
    } else {
      result.push(cell);
    }
  }
  return result;
}

function mergeAdjacentBands(
  bands: readonly PressureBand[],
): PressureBand[] {
  const result: PressureBand[] = [];
  for (const band of bands) {
    const previous = result[result.length - 1];
    if (
      previous &&
      previous.hiVolume === band.loVolume &&
      previous.side === band.side &&
      statesEqual(previous.state, band.state)
    ) {
      result[result.length - 1] = {
        ...previous,
        hiVolume: band.hiVolume,
      };
    } else {
      result.push(band);
    }
  }
  return result;
}

function bandsEqual(
  a: readonly PressureBand[],
  b: readonly PressureBand[],
): boolean {
  return (
    a.length === b.length &&
    a.every((band, index) => {
      const other = b[index]!;
      return (
        band.loVolume === other.loVolume &&
        band.hiVolume === other.hiVolume &&
        band.side === other.side &&
        statesEqual(band.state, other.state)
      );
    })
  );
}

function statesEqual(
  a: PressureBandState,
  b: PressureBandState,
): boolean {
  return (
    a.kind === b.kind &&
    (a.kind === "live" ||
      (b.kind === "ghost" && a.sinceMs === b.sinceMs))
  );
}

function contains(
  interval:
    | { readonly lo: number; readonly hi: number }
    | undefined,
  value: number,
): boolean {
  return !!interval && interval.lo <= value && value < interval.hi;
}

function validateHalfLife(value: number): void {
  if (!(value > 0) || !Number.isFinite(value))
    throw new RangeError("ghost half-life must be finite and positive");
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}


export function parsePressureCells(value: unknown): PressureCell[] {
  if (!Array.isArray(value))
    throw new TypeError("pressure memory must be an array of cells");

  const cells = value.map((rawCell) => {
    if (!isRecord(rawCell))
      throw new TypeError("pressure cell must be an object");

    const lo = finiteNumber(rawCell.lo, "cell lo");
    const hi = finiteNumber(rawCell.hi, "cell hi");
    if (!(lo >= 0 && hi <= 1 && hi > lo))
      throw new RangeError("invalid pressure cell interval");

    if (!Array.isArray(rawCell.bands))
      throw new TypeError("pressure cell bands must be an array");

    const bands = rawCell.bands.map((rawBand) => {
      if (!isRecord(rawBand))
        throw new TypeError("pressure band must be an object");

      const loVolume = finiteNumber(
        rawBand.loVolume,
        "band loVolume",
      );
      const hiVolume = finiteNumber(
        rawBand.hiVolume,
        "band hiVolume",
      );
      if (!(loVolume >= 0 && hiVolume > loVolume))
        throw new RangeError("invalid pressure band interval");

      if (rawBand.side !== -1 && rawBand.side !== 1)
        throw new RangeError("pressure band side must be -1 or 1");

      if (!isRecord(rawBand.state))
        throw new TypeError("pressure band state must be an object");

      let state: PressureBandState;
      if (rawBand.state.kind === "live") {
        state = { kind: "live" };
      } else if (rawBand.state.kind === "ghost") {
        state = {
          kind: "ghost",
          sinceMs: finiteNumber(
            rawBand.state.sinceMs,
            "ghost sinceMs",
          ),
        };
      } else {
        throw new RangeError("unknown pressure band state");
      }

      return {
        loVolume,
        hiVolume,
        side: rawBand.side,
        state,
      } satisfies PressureBand;
    });

    assertNonOverlappingBands(bands);
    return { lo, hi, bands: mergeAdjacentBands(bands) };
  });

  const ordered = [...cells].sort((a, b) => a.lo - b.lo);
  for (let i = 1; i < ordered.length; i++)
    if (ordered[i - 1]!.hi > ordered[i]!.lo)
      throw new RangeError("pressure cells overlap");

  return ordered;
}

export function rebasePressureCells(
  cells: readonly PressureCell[],
  sourceNowMs: number,
  targetNowMs: number,
): PressureCell[] {
  if (!Number.isFinite(sourceNowMs) || !Number.isFinite(targetNowMs))
    throw new RangeError("pressure memory clocks must be finite");

  return cells.map((cell) => ({
    ...cell,
    bands: cell.bands.map((band) => ({
      ...band,
      state:
        band.state.kind === "live"
          ? band.state
          : {
              kind: "ghost" as const,
              sinceMs:
                targetNowMs -
                Math.max(0, sourceNowMs - band.state.sinceMs),
            },
    })),
  }));
}

function assertNonOverlappingBands(
  bands: readonly PressureBand[],
): void {
  const ordered = [...bands].sort(
    (a, b) => a.loVolume - b.loVolume,
  );
  for (let i = 1; i < ordered.length; i++)
    if (ordered[i - 1]!.hiVolume > ordered[i]!.loVolume)
      throw new RangeError("pressure bands overlap");
}

function finiteNumber(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value))
    throw new RangeError(`${label} must be finite`);
  return value;
}

function isRecord(
  value: unknown,
): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
