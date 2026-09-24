import {
  type PressureFieldRunSnapshot,
  type PressureFieldSnapshot,
} from "./materializedPressureField";
import {
  buildFrontier,
  frontierLevels,
  type FrontierLevel,
  type FrontierRoot,
} from "./monotoneFrontier";
import type { PressureBand } from "./pressureField";
import { priceFromTicks } from "./price";

export interface PressureFrontierCurrentSideSnapshot {
  readonly current: readonly FrontierLevel[];
}

export interface PressureFrontierSnapshot {
  readonly bid: PressureFrontierCurrentSideSnapshot;
  readonly ask: PressureFrontierCurrentSideSnapshot;
  readonly field: PressureFieldSnapshot;
}

export function parsePressureFrontierSnapshot(
  value: unknown,
): PressureFrontierSnapshot {
  if (!isRecord(value))
    throw new TypeError("pressure frontier snapshot must be an object");

  return {
    bid: parseCurrentSide(value.bid, "bid"),
    ask: parseCurrentSide(value.ask, "ask"),
    field: parseField(value.field),
  };
}

export function snapshotCurrentSide(
  current: FrontierRoot,
): PressureFrontierCurrentSideSnapshot {
  return { current: frontierLevels(current) };
}

export function restoreCurrentSide(
  side: PressureFrontierCurrentSideSnapshot,
): FrontierRoot {
  return buildFrontier(side.current);
}

function parseCurrentSide(
  value: unknown,
  label: string,
): PressureFrontierCurrentSideSnapshot {
  if (!isRecord(value))
    throw new TypeError(`pressure frontier ${label} side must be an object`);
  if (!Array.isArray(value.current))
    throw new TypeError(`pressure frontier ${label} current must be an array`);

  return {
    current: parseLevels(value.current, `${label} current`),
  };
}

function parseField(value: unknown): PressureFieldSnapshot {
  if (!isRecord(value))
    throw new TypeError("pressure field snapshot must be an object");
  const revision = finiteNumber(value.revision, "pressure field revision");
  if (revision < 0)
    throw new RangeError("pressure field revision must be non-negative");
  if (!Array.isArray(value.runs))
    throw new TypeError("pressure field runs must be an array");

  return {
    revision,
    runs: value.runs.map(parseRun),
  };
}

function parseRun(value: unknown, index: number): PressureFieldRunSnapshot {
  if (!isRecord(value))
    throw new TypeError(`pressure field run[${index}] must be an object`);
  if (!Array.isArray(value.bands))
    throw new TypeError(`pressure field run[${index}].bands must be an array`);

  return {
    lo: priceFromTicks(finiteNumber(value.lo, `run[${index}].lo`)),
    hi: priceFromTicks(finiteNumber(value.hi, `run[${index}].hi`)),
    bidVolume: finiteNumber(value.bidVolume, `run[${index}].bidVolume`),
    askVolume: finiteNumber(value.askVolume, `run[${index}].askVolume`),
    bidRevision: finiteNumber(value.bidRevision, `run[${index}].bidRevision`),
    askRevision: finiteNumber(value.askRevision, `run[${index}].askRevision`),
    bands: value.bands.map((band, bandIndex) =>
      parseBand(band, `run[${index}].bands[${bandIndex}]`),
    ),
  };
}

function parseBand(value: unknown, label: string): PressureBand {
  if (!isRecord(value)) throw new TypeError(`${label} must be an object`);
  if (value.side !== -1 && value.side !== 1)
    throw new RangeError(`${label}.side must be -1 or 1`);

  return {
    loVolume: finiteNumber(value.loVolume, `${label}.loVolume`),
    hiVolume: finiteNumber(value.hiVolume, `${label}.hiVolume`),
    side: value.side,
    validThroughMs: finiteNumber(
      value.validThroughMs,
      `${label}.validThroughMs`,
    ),
  };
}

function parseLevels(
  value: readonly unknown[],
  label: string,
): FrontierLevel[] {
  const levels = value.map((raw, index) => {
    if (!isRecord(raw))
      throw new TypeError(`${label}[${index}] must be an object`);
    const key = priceFromTicks(finiteNumber(raw.key, `${label}[${index}].key`));
    const weight = finiteNumber(raw.weight, `${label}[${index}].weight`);
    if (!(weight > 0))
      throw new RangeError(`${label}[${index}].weight must be positive`);
    return { key, weight };
  });

  for (let index = 1; index < levels.length; index++)
    if (!(levels[index]!.key > levels[index - 1]!.key))
      throw new RangeError(`${label} keys must be strictly increasing`);

  return levels;
}

function finiteNumber(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value))
    throw new RangeError(`${label} must be finite`);
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
