import { type PressureBand, type PressureBandState } from "./pressureField";

export interface PressureCell {
  readonly lo: number;
  readonly hi: number;
  readonly bands: readonly PressureBand[];
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

      const loVolume = finiteNumber(rawBand.loVolume, "band loVolume");
      const hiVolume = finiteNumber(rawBand.hiVolume, "band hiVolume");
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
          sinceMs: finiteNumber(rawBand.state.sinceMs, "ghost sinceMs"),
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

    assertContiguousBands(bands);
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
                targetNowMs - Math.max(0, sourceNowMs - band.state.sinceMs),
            },
    })),
  }));
}

function mergeAdjacentBands(bands: readonly PressureBand[]): PressureBand[] {
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

function statesEqual(a: PressureBandState, b: PressureBandState): boolean {
  return (
    a.kind === b.kind &&
    (a.kind === "live" || (b.kind === "ghost" && a.sinceMs === b.sinceMs))
  );
}

function assertContiguousBands(bands: readonly PressureBand[]): void {
  if (bands.length === 0) return;

  const ordered = [...bands].sort((a, b) => a.loVolume - b.loVolume);
  if (ordered[0]!.loVolume !== 0)
    throw new RangeError("pressure bands must start at zero volume");

  for (let i = 1; i < ordered.length; i++) {
    const previous = ordered[i - 1]!;
    const current = ordered[i]!;
    if (previous.hiVolume !== current.loVolume)
      throw new RangeError(
        "pressure bands must form a contiguous volume prefix",
      );
  }
}

function finiteNumber(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value))
    throw new RangeError(`${label} must be finite`);
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
