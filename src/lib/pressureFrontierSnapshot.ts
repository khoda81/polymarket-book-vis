import type { PressureFieldSnapshot } from "./materializedPressureField";
import {
  buildFrontier,
  frontierLevels,
  type FrontierLevel,
  type FrontierRoot,
} from "./monotoneFrontier";
import type { PressureBand } from "./pressureField";
import { PRICE_ZERO, type Price, priceFromTicks } from "./price";

export const PRESSURE_FRONTIER_SNAPSHOT_VERSION = 5 as const;

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

  if (value.version === 4) return migrateV4(value);

  if (value.version !== PRESSURE_FRONTIER_SNAPSHOT_VERSION)
    throw new RangeError(
      `unsupported pressure frontier snapshot version: ${String(value.version)}`,
    );
  if (!Array.isArray(value.current))
    throw new TypeError("pressure frontier current must be an array");

  const field = parseFieldV5(value.field);
  const current = parseLevels(value.current, "current", field.maxPrice);

  return {
    version: PRESSURE_FRONTIER_SNAPSHOT_VERSION,
    current,
    field,
  };
}

export function snapshotCurrent(
  current: FrontierRoot,
): readonly FrontierLevel[] {
  return frontierLevels(current);
}

export function restoreCurrent(levels: readonly FrontierLevel[]): FrontierRoot {
  return buildFrontier(levels);
}

function parseFieldV5(value: unknown): PressureFieldSnapshot {
  if (!isRecord(value))
    throw new TypeError("pressure field snapshot must be an object");
  if (!Array.isArray(value.runs))
    throw new TypeError("pressure field runs must be an array");

  const maxPrice = priceFromTicks(
    finiteNumber(value.maxPrice, "pressure field max price"),
  );
  if (!(maxPrice > PRICE_ZERO))
    throw new RangeError("pressure field max price must be positive");

  return {
    maxPrice,
    currentValidThroughMs:
      value.currentValidThroughMs === null
        ? null
        : finiteNumber(
            value.currentValidThroughMs,
            "pressure field current valid-through",
          ),
    runs: value.runs.map((run, index) => parseRunV5(run, index, maxPrice)),
  };
}

function parseRunV5(
  value: unknown,
  index: number,
  maxPrice: Price,
): PressureFieldSnapshot["runs"][number] {
  if (!isRecord(value))
    throw new TypeError(`pressure field run[${index}] must be an object`);
  if (!Array.isArray(value.frozenBands))
    throw new TypeError(
      `pressure field run[${index}].frozenBands must be an array`,
    );

  const price = priceFromTicks(
    finiteNumber(value.price, `run[${index}].price`),
  );
  if (!(price > PRICE_ZERO) || price > maxPrice)
    throw new RangeError(`run[${index}].price must be in (0, ${maxPrice}]`);

  return {
    price,
    volume: nonNegativeNumber(value.volume, `run[${index}].volume`),
    frozenBands: value.frozenBands.map((band, bandIndex) =>
      parseBand(band, `run[${index}].frozenBands[${bandIndex}]`),
    ),
  };
}

/**
 * Version 4 stored a complete price partition and a complete volume partition
 * for every run. Canonical v5 drops the implicit price-zero run, stores each
 * price boundary once, and removes the currently resting region from history.
 */
function migrateV4(value: Record<string, unknown>): PressureFrontierSnapshot {
  if (!Array.isArray(value.current))
    throw new TypeError("pressure frontier current must be an array");
  if (!isRecord(value.field))
    throw new TypeError("pressure field snapshot must be an object");
  if (!Array.isArray(value.field.runs))
    throw new TypeError("pressure field runs must be an array");
  if (value.field.runs.length === 0)
    throw new RangeError("v4 pressure field must contain at least one run");

  const currentValidThroughMs =
    value.field.currentValidThroughMs === null
      ? null
      : finiteNumber(
          value.field.currentValidThroughMs,
          "pressure field current valid-through",
        );

  const oldRuns = value.field.runs.map((raw, index) => parseRunV4(raw, index));
  validateV4PricePartition(oldRuns);

  const maxPrice = oldRuns[oldRuns.length - 1]!.hi;
  const first = oldRuns[0]!;
  if (first.lo === PRICE_ZERO && (first.volume > 0 || first.bands.length > 0))
    throw new RangeError(
      "cannot migrate explicit price-zero pressure; price zero is an implicit disposal sentinel",
    );

  const runs: PressureFieldSnapshot["runs"][number][] = [];
  for (const run of oldRuns) {
    if (run.lo === PRICE_ZERO) continue;
    runs.push({
      price: run.lo,
      volume: run.volume,
      frozenBands: frozenFromV4(run.volume, run.bands),
    });
  }

  const current = parseLevels(value.current, "current", maxPrice);
  return {
    version: PRESSURE_FRONTIER_SNAPSHOT_VERSION,
    current,
    field: {
      maxPrice,
      currentValidThroughMs,
      runs,
    },
  };
}

interface V4Run {
  readonly lo: Price;
  readonly hi: Price;
  readonly volume: number;
  readonly bands: readonly PressureBand[];
}

function parseRunV4(value: unknown, index: number): V4Run {
  if (!isRecord(value))
    throw new TypeError(`pressure field run[${index}] must be an object`);
  if (!Array.isArray(value.bands))
    throw new TypeError(`pressure field run[${index}].bands must be an array`);

  return {
    lo: priceFromTicks(finiteNumber(value.lo, `run[${index}].lo`)),
    hi: priceFromTicks(finiteNumber(value.hi, `run[${index}].hi`)),
    volume: nonNegativeNumber(value.volume, `run[${index}].volume`),
    bands: value.bands.map((band, bandIndex) =>
      parseBand(band, `run[${index}].bands[${bandIndex}]`),
    ),
  };
}

function validateV4PricePartition(runs: readonly V4Run[]): void {
  if (runs[0]!.lo !== PRICE_ZERO)
    throw new RangeError("v4 pressure field must start at price zero");

  for (let index = 0; index < runs.length; index++) {
    const run = runs[index]!;
    if (!(run.hi > run.lo))
      throw new RangeError("v4 pressure run interval must be positive");
    if (index > 0 && runs[index - 1]!.hi !== run.lo)
      throw new RangeError("v4 pressure runs must be contiguous");
  }
}

function frozenFromV4(
  currentVolume: number,
  bands: readonly PressureBand[],
): PressureBand[] {
  const ascending: PressureBand[] = [];

  for (const band of bands) {
    const loVolume = Math.max(currentVolume, band.loVolume);
    if (!(band.hiVolume > loVolume)) continue;
    ascending.push({
      loVolume,
      hiVolume: band.hiVolume,
      validThroughMs: band.validThroughMs,
    });
  }

  ascending.reverse();
  return ascending;
}

function parseBand(value: unknown, label: string): PressureBand {
  if (!isRecord(value)) throw new TypeError(`${label} must be an object`);

  const loVolume = nonNegativeNumber(value.loVolume, `${label}.loVolume`);
  const hiVolume = nonNegativeNumber(value.hiVolume, `${label}.hiVolume`);
  if (!(hiVolume > loVolume))
    throw new RangeError(`${label} must have positive width`);

  return {
    loVolume,
    hiVolume,
    validThroughMs: finiteNumber(
      value.validThroughMs,
      `${label}.validThroughMs`,
    ),
  };
}

function parseLevels(
  value: readonly unknown[],
  label: string,
  maxPrice: Price,
): FrontierLevel[] {
  const levels = value.map((raw, index) => {
    if (!isRecord(raw))
      throw new TypeError(`${label}[${index}] must be an object`);
    const key = priceFromTicks(finiteNumber(raw.key, `${label}[${index}].key`));
    const weight = finiteNumber(raw.weight, `${label}[${index}].weight`);
    if (!(key > PRICE_ZERO) || key > maxPrice)
      throw new RangeError(
        `${label}[${index}].key must be in (0, ${maxPrice}]`,
      );
    if (!(weight > 0))
      throw new RangeError(`${label}[${index}].weight must be positive`);
    return { key, weight };
  });

  for (let index = 1; index < levels.length; index++)
    if (!(levels[index]!.key > levels[index - 1]!.key))
      throw new RangeError(`${label} keys must be strictly increasing`);

  return levels;
}

function nonNegativeNumber(value: unknown, label: string): number {
  const result = finiteNumber(value, label);
  if (result < 0) throw new RangeError(`${label} must be non-negative`);
  return result;
}

function finiteNumber(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value))
    throw new RangeError(`${label} must be finite`);
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
