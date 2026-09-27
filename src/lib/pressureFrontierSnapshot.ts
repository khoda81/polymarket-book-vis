import { PRICE_ONE, PRICE_ZERO, type Price, priceFromTicks } from "./price";

export const PRESSURE_FRONTIER_SNAPSHOT_VERSION = 6 as const;

export interface FrozenStep {
  readonly hiVolume: number;
  /** Latest instant through which this historical rectangle was current. */
  readonly validThroughMs: number;
}

export interface PressureRun {
  readonly price: Price;
  /** Exact resting shares at this price boundary. */
  readonly shares: number;
  /** Historical upper edges, ordered high -> low. Lower edges are implicit. */
  readonly frozenSteps: readonly FrozenStep[];
}

export type PressureFrontierState =
  | {
      readonly kind: "unobserved";
    }
  | {
      readonly kind: "observed";
      readonly validThroughMs: number;
      readonly runs: readonly PressureRun[];
    };

export interface PressureFrontierSnapshot {
  readonly version: typeof PRESSURE_FRONTIER_SNAPSHOT_VERSION;
  readonly state: PressureFrontierState;
}

export function parsePressureFrontierSnapshot(
  value: unknown,
): PressureFrontierSnapshot {
  if (!isRecord(value))
    throw new TypeError("pressure frontier snapshot must be an object");
  assertOnlyKeys(value, ["version", "state"], "pressure frontier snapshot");

  if (value.version !== PRESSURE_FRONTIER_SNAPSHOT_VERSION)
    throw new RangeError(
      "unsupported pressure frontier snapshot version: " +
        String(value.version),
    );

  return {
    version: PRESSURE_FRONTIER_SNAPSHOT_VERSION,
    state: parseState(value.state),
  };
}

function parseState(value: unknown): PressureFrontierState {
  if (!isRecord(value))
    throw new TypeError("pressure frontier state must be an object");

  if (value.kind === "unobserved") {
    assertOnlyKeys(value, ["kind"], "unobserved pressure frontier state");
    return { kind: "unobserved" };
  }

  if (value.kind !== "observed")
    throw new RangeError(
      "pressure frontier state kind must be observed or unobserved",
    );

  assertOnlyKeys(
    value,
    ["kind", "validThroughMs", "runs"],
    "observed pressure frontier state",
  );
  if (!Array.isArray(value.runs))
    throw new TypeError("observed pressure frontier runs must be an array");

  const validThroughMs = finiteNumber(
    value.validThroughMs,
    "pressure frontier valid-through",
  );
  const runs: PressureRun[] = [];
  let previousPrice = PRICE_ZERO;
  let cumulativeVolume = 0;

  for (let index = 0; index < value.runs.length; index++) {
    const run = parseRun(value.runs[index], index);
    if (!(run.price > previousPrice))
      throw new RangeError("pressure run prices must be strictly increasing");

    cumulativeVolume += run.shares;
    validateFrozenSteps(run, cumulativeVolume, validThroughMs, index);

    const previous = runs[runs.length - 1];
    if (
      previous &&
      run.shares === 0 &&
      frozenStepsEqual(previous.frozenSteps, run.frozenSteps)
    )
      throw new RangeError("adjacent identical pressure runs must be merged");

    runs.push(run);
    previousPrice = run.price;
  }

  const first = runs[0];
  if (first && first.shares === 0 && first.frozenSteps.length === 0)
    throw new RangeError("pressure state must not store a leading empty run");

  return {
    kind: "observed",
    validThroughMs,
    runs,
  };
}

function parseRun(value: unknown, index: number): PressureRun {
  const label = "pressure run[" + index + "]";
  if (!isRecord(value)) throw new TypeError(label + " must be an object");
  assertOnlyKeys(value, ["price", "shares", "frozenSteps"], label);
  if (!Array.isArray(value.frozenSteps))
    throw new TypeError(label + ".frozenSteps must be an array");

  const price = priceFromTicks(finiteNumber(value.price, label + ".price"));
  if (!(price > PRICE_ZERO) || price > PRICE_ONE)
    throw new RangeError(label + ".price must be in (0, PRICE_ONE]");

  const shares = nonNegativeNumber(value.shares, label + ".shares");
  const frozenSteps = value.frozenSteps.map((step, stepIndex) =>
    parseFrozenStep(step, label + ".frozenSteps[" + stepIndex + "]"),
  );

  return { price, shares, frozenSteps };
}

function parseFrozenStep(value: unknown, label: string): FrozenStep {
  if (!isRecord(value)) throw new TypeError(label + " must be an object");
  assertOnlyKeys(value, ["hiVolume", "validThroughMs"], label);

  const hiVolume = nonNegativeNumber(value.hiVolume, label + ".hiVolume");
  if (!(hiVolume > 0))
    throw new RangeError(label + ".hiVolume must be positive");

  return {
    hiVolume,
    validThroughMs: finiteNumber(
      value.validThroughMs,
      label + ".validThroughMs",
    ),
  };
}

function validateFrozenSteps(
  run: PressureRun,
  currentVolume: number,
  currentValidThroughMs: number,
  runIndex: number,
): void {
  let previousHi = Number.POSITIVE_INFINITY;
  let previousValidThrough = Number.NEGATIVE_INFINITY;

  for (let index = 0; index < run.frozenSteps.length; index++) {
    const step = run.frozenSteps[index]!;
    if (!(step.hiVolume > currentVolume))
      throw new RangeError(
        "pressure run[" +
          runIndex +
          "] frozen steps must stay above current pressure",
      );
    if (!(step.hiVolume < previousHi))
      throw new RangeError(
        "pressure run[" +
          runIndex +
          "] frozen upper edges must decrease high -> low",
      );
    if (!(step.validThroughMs > previousValidThrough))
      throw new RangeError(
        "pressure run[" +
          runIndex +
          "] frozen timestamps must increase high -> low",
      );
    if (step.validThroughMs > currentValidThroughMs)
      throw new RangeError(
        "pressure run[" +
          runIndex +
          "] frozen timestamp exceeds current validity",
      );

    previousHi = step.hiVolume;
    previousValidThrough = step.validThroughMs;
  }
}

function frozenStepsEqual(
  a: readonly FrozenStep[],
  b: readonly FrozenStep[],
): boolean {
  return (
    a.length === b.length &&
    a.every(
      (step, index) =>
        step.hiVolume === b[index]!.hiVolume &&
        step.validThroughMs === b[index]!.validThroughMs,
    )
  );
}

function nonNegativeNumber(value: unknown, label: string): number {
  const result = finiteNumber(value, label);
  if (result < 0) throw new RangeError(label + " must be non-negative");
  return result;
}

function finiteNumber(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value))
    throw new RangeError(label + " must be finite");
  return value;
}

function assertOnlyKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  label: string,
): void {
  const allowedKeys = new Set(allowed);
  const unexpected = Object.keys(value).filter((key) => !allowedKeys.has(key));
  if (unexpected.length > 0)
    throw new TypeError(label + " has unexpected field " + unexpected[0]);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
