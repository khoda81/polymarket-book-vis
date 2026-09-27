import type { PressureFieldSnapshot } from "./materializedPressureField";
import {
  buildFrontier,
  frontierLevels,
  type FrontierLevel,
  type FrontierRoot,
} from "./monotoneFrontier";
import type { PressureBand } from "./pressureField";
import { priceFromTicks } from "./price";

export const PRESSURE_FRONTIER_SNAPSHOT_VERSION = 3 as const;

export interface PressureEdgeSnapshot {
  readonly current: readonly FrontierLevel[];
  readonly field: PressureFieldSnapshot;
}

export interface PressureFrontierSnapshot {
  readonly version: typeof PRESSURE_FRONTIER_SNAPSHOT_VERSION;
  readonly primaryToCollateral: PressureEdgeSnapshot;
  readonly oppositeToCollateral: PressureEdgeSnapshot;
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

  return {
    version: PRESSURE_FRONTIER_SNAPSHOT_VERSION,
    primaryToCollateral: parseEdge(
      value.primaryToCollateral,
      "primaryToCollateral",
    ),
    oppositeToCollateral: parseEdge(
      value.oppositeToCollateral,
      "oppositeToCollateral",
    ),
  };
}

export function snapshotEdge(
  current: FrontierRoot,
  field: PressureFieldSnapshot,
): PressureEdgeSnapshot {
  return { current: frontierLevels(current), field };
}

export function restoreEdgeCurrent(edge: PressureEdgeSnapshot): FrontierRoot {
  return buildFrontier(edge.current);
}

function parseEdge(value: unknown, label: string): PressureEdgeSnapshot {
  if (!isRecord(value))
    throw new TypeError(`pressure edge ${label} must be an object`);
  if (!Array.isArray(value.current))
    throw new TypeError(`pressure edge ${label}.current must be an array`);

  return {
    current: parseLevels(value.current, `${label}.current`),
    field: parseField(value.field, label),
  };
}

function parseField(value: unknown, label: string): PressureFieldSnapshot {
  if (!isRecord(value))
    throw new TypeError(`pressure edge ${label}.field must be an object`);
  if (!Array.isArray(value.runs))
    throw new TypeError(`pressure edge ${label}.field.runs must be an array`);

  return {
    currentValidThroughMs:
      value.currentValidThroughMs === null
        ? null
        : finiteNumber(
            value.currentValidThroughMs,
            `${label}.field.currentValidThroughMs`,
          ),
    runs: value.runs.map((run, index) => parseRun(run, label, index)),
  };
}

function parseRun(
  value: unknown,
  label: string,
  index: number,
): PressureFieldSnapshot["runs"][number] {
  if (!isRecord(value))
    throw new TypeError(`${label}.field.run[${index}] must be an object`);
  if (!Array.isArray(value.bands))
    throw new TypeError(`${label}.field.run[${index}].bands must be an array`);

  return {
    lo: priceFromTicks(
      finiteNumber(value.lo, `${label}.field.run[${index}].lo`),
    ),
    hi: priceFromTicks(
      finiteNumber(value.hi, `${label}.field.run[${index}].hi`),
    ),
    volume: finiteNumber(value.volume, `${label}.field.run[${index}].volume`),
    bands: value.bands.map((band, bandIndex) =>
      parseBand(band, `${label}.field.run[${index}].bands[${bandIndex}]`),
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
