import type { PressureFieldSnapshot } from "./materializedPressureField";
import {
  buildFrontier,
  frontierLevels,
  type FrontierLevel,
  type FrontierRoot,
} from "./monotoneFrontier";
import type { PressureBand } from "../../src/domain/pressure/pressureField";
import {
  PRICE_ZERO,
  type Price,
  priceFromTicks,
} from "../../src/domain/books/price";

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
