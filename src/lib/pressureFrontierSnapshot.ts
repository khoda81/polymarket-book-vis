import type { PressureFieldSnapshot } from "./materializedPressureField";
import {
  buildFrontier,
  frontierLevels,
  type FrontierLevel,
  type FrontierRoot,
} from "./monotoneFrontier";
import type { PressureBand } from "./pressureField";
import { priceFromTicks } from "./price";

export const PRESSURE_FRONTIER_SNAPSHOT_VERSION = 4 as const;

export interface PressureFrontierSnapshot {
  readonly version: typeof PRESSURE_FRONTIER_SNAPSHOT_VERSION;
  readonly current: readonly FrontierLevel[];
  readonly field: PressureFieldSnapshot;
}

export function parsePressureFrontierSnapshot(
  value: unknown,
): PressureFrontierSnapshot {
  if (!isRecord(value))
    throw new TypeError("pressure frontier snapshot must be an object");
  if (value.version !== PRESSURE_FRONTIER_SNAPSHOT_VERSION)
    throw new RangeError(
      `unsupported pressure frontier snapshot version: ${String(value.version)}`,
    );
  if (!Array.isArray(value.current))
    throw new TypeError("pressure frontier current must be an array");

  return {
    version: PRESSURE_FRONTIER_SNAPSHOT_VERSION,
    current: parseLevels(value.current, "current"),
    field: parseField(value.field),
  };
}

export function snapshotCurrent(current: FrontierRoot): readonly FrontierLevel[] {
  return frontierLevels(current);
}

export function restoreCurrent(
  levels: readonly FrontierLevel[],
): FrontierRoot {
  return buildFrontier(levels);
}

function parseField(value: unknown): PressureFieldSnapshot {
  if (!isRecord(value))
    throw new TypeError("pressure field snapshot must be an object");
  if (!Array.isArray(value.runs))
    throw new TypeError("pressure field runs must be an array");

  return {
    currentValidThroughMs:
      value.currentValidThroughMs === null
        ? null
        : finiteNumber(
            value.currentValidThroughMs,
            "pressure field current valid-through",
          ),
    runs: value.runs.map((run, index) => parseRun(run, index)),
  };
}

function parseRun(
  value: unknown,
  index: number,
): PressureFieldSnapshot["runs"][number] {
  if (!isRecord(value))
    throw new TypeError(`pressure field run[${index}] must be an object`);
  if (!Array.isArray(value.bands))
    throw new TypeError(
      `pressure field run[${index}].bands must be an array`,
    );

  return {
    lo: priceFromTicks(finiteNumber(value.lo, `run[${index}].lo`)),
    hi: priceFromTicks(finiteNumber(value.hi, `run[${index}].hi`)),
    volume: finiteNumber(value.volume, `run[${index}].volume`),
    bands: value.bands.map((band, bandIndex) =>
      parseBand(band, `run[${index}].bands[${bandIndex}]`),
    ),
  };
}

function parseBand(value: unknown, label: string): PressureBand {
  if (!isRecord(value)) throw new TypeError(`${label} must be an object`);

  return {
    loVolume: finiteNumber(value.loVolume, `${label}.loVolume`),
    hiVolume: finiteNumber(value.hiVolume, `${label}.hiVolume`),
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
    const key = priceFromTicks(
      finiteNumber(raw.key, `${label}[${index}].key`),
    );
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
