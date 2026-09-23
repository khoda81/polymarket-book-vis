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
import { type PressureBand } from "./pressureField";
import { type Price, priceFromLegacyNumber, priceFromTicks } from "./price";

export interface LegacyFrontierLevel {
  readonly key: number;
  readonly weight: number;
}

export interface LegacyPressureFieldRunSnapshot {
  readonly lo: number;
  readonly hi: number;
  readonly bidVolume: number;
  readonly askVolume: number;
  readonly bidRevision: number;
  readonly askRevision: number;
  readonly bands: readonly PressureBand[];
}

export interface LegacyPressureFieldSnapshot {
  readonly revision: number;
  readonly runs: readonly LegacyPressureFieldRunSnapshot[];
}

export interface PressureFrontierLayerSnapshotV1 {
  readonly sinceMs: number;
  readonly levels: readonly LegacyFrontierLevel[];
}

export interface PressureFrontierSideSnapshotV1 {
  readonly updatedAtMs: number | null;
  readonly current: readonly LegacyFrontierLevel[];
  readonly history: readonly PressureFrontierLayerSnapshotV1[];
}

export interface PressureFrontierSnapshotV1 {
  readonly version: 1;
  readonly bid: PressureFrontierSideSnapshotV1;
  readonly ask: PressureFrontierSideSnapshotV1;
}

export interface LegacyPressureFrontierCurrentSideSnapshot {
  readonly current: readonly LegacyFrontierLevel[];
}

export interface PressureFrontierCurrentSideSnapshot {
  readonly current: readonly FrontierLevel[];
}

export interface PressureFrontierSnapshotV2 {
  readonly version: 2;
  readonly bid: LegacyPressureFrontierCurrentSideSnapshot;
  readonly ask: LegacyPressureFrontierCurrentSideSnapshot;
  readonly field: LegacyPressureFieldSnapshot;
}

export interface PressureFrontierSnapshotV3 {
  readonly version: 3;
  readonly bid: PressureFrontierCurrentSideSnapshot;
  readonly ask: PressureFrontierCurrentSideSnapshot;
  readonly field: PressureFieldSnapshot;
}

export type PressureFrontierSnapshot =
  | PressureFrontierSnapshotV1
  | PressureFrontierSnapshotV2
  | PressureFrontierSnapshotV3;

export interface RestoredPressureFrontierSideV1 {
  readonly updatedAtMs: number;
  readonly current: FrontierRoot;
  readonly history: readonly {
    readonly sinceMs: number;
    readonly root: FrontierRoot;
  }[];
}

export function parsePressureFrontierSnapshot(
  value: unknown,
): PressureFrontierSnapshot {
  if (!isRecord(value))
    throw new TypeError("pressure frontier snapshot must be an object");

  if (value.version === 1) {
    return {
      version: 1,
      bid: parseSideV1(value.bid, "bid"),
      ask: parseSideV1(value.ask, "ask"),
    };
  }

  if (value.version === 2) {
    return {
      version: 2,
      bid: parseLegacyCurrentSide(value.bid, "bid"),
      ask: parseLegacyCurrentSide(value.ask, "ask"),
      field: parseLegacyField(value.field),
    };
  }

  if (value.version === 3) {
    return {
      version: 3,
      bid: parseCurrentSide(value.bid, "bid"),
      ask: parseCurrentSide(value.ask, "ask"),
      field: parseField(value.field),
    };
  }

  throw new TypeError("unsupported pressure frontier snapshot");
}

export function rebasePressureFrontierSnapshot(
  snapshot: PressureFrontierSnapshot,
  sourceNowMs: number,
  targetNowMs: number,
): PressureFrontierSnapshot {
  if (!Number.isFinite(sourceNowMs) || !Number.isFinite(targetNowMs))
    throw new RangeError("pressure frontier clocks must be finite");

  const rebaseTime = (time: number): number =>
    targetNowMs - Math.max(0, sourceNowMs - time);

  if (snapshot.version === 1) {
    const rebaseSide = (
      side: PressureFrontierSideSnapshotV1,
    ): PressureFrontierSideSnapshotV1 => ({
      updatedAtMs:
        side.updatedAtMs === null ? null : rebaseTime(side.updatedAtMs),
      current: side.current,
      history: side.history.map((layer) => ({
        sinceMs: rebaseTime(layer.sinceMs),
        levels: layer.levels,
      })),
    });

    return {
      version: 1,
      bid: rebaseSide(snapshot.bid),
      ask: rebaseSide(snapshot.ask),
    };
  }

  return {
    version: snapshot.version,
    bid: snapshot.bid,
    ask: snapshot.ask,
    field: {
      revision: snapshot.field.revision,
      runs: snapshot.field.runs.map((run) => ({
        ...run,
        bands: run.bands.map((band) => ({
          ...band,
          state:
            band.state.kind === "live"
              ? band.state
              : {
                  kind: "ghost" as const,
                  sinceMs: rebaseTime(band.state.sinceMs),
                },
        })),
      })),
    },
  } as PressureFrontierSnapshot;
}

export function stalePressureFrontierSnapshot(
  snapshot: PressureFrontierSnapshot,
  staleSinceMs: number,
): PressureFrontierSnapshot {
  if (!Number.isFinite(staleSinceMs))
    throw new RangeError("stale pressure timestamp must be finite");

  if (snapshot.version === 1) {
    const staleSide = (
      side: PressureFrontierSideSnapshotV1,
    ): PressureFrontierSideSnapshotV1 => ({
      updatedAtMs: null,
      current: [],
      history:
        side.current.length === 0
          ? side.history
          : [
              {
                sinceMs: staleSinceMs,
                levels: side.current,
              },
              ...side.history,
            ],
    });

    return {
      version: 1,
      bid: staleSide(snapshot.bid),
      ask: staleSide(snapshot.ask),
    };
  }

  return {
    version: snapshot.version,
    bid: { current: [] },
    ask: { current: [] },
    field: {
      revision: 0,
      runs: snapshot.field.runs.map((run) => ({
        ...run,
        bidVolume: 0,
        askVolume: 0,
        bidRevision: 0,
        askRevision: 0,
        bands: run.bands.map((band) => ({
          ...band,
          state:
            band.state.kind === "live"
              ? {
                  kind: "ghost" as const,
                  sinceMs: staleSinceMs,
                }
              : band.state,
        })),
      })),
    },
  } as PressureFrontierSnapshot;
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

export function restoreSnapshotSideV1(
  side: PressureFrontierSideSnapshotV1,
): RestoredPressureFrontierSideV1 {
  return {
    updatedAtMs: side.updatedAtMs ?? Number.NEGATIVE_INFINITY,
    current: buildFrontier(migrateLegacyLevels(side.current)),
    history: side.history.map((layer) => ({
      sinceMs: layer.sinceMs,
      root: buildFrontier(migrateLegacyLevels(layer.levels)),
    })),
  };
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
    current: parseLevels(value.current, `${label} current`, false),
  };
}

function parseLegacyCurrentSide(
  value: unknown,
  label: string,
): LegacyPressureFrontierCurrentSideSnapshot {
  if (!isRecord(value))
    throw new TypeError(`pressure frontier ${label} side must be an object`);
  if (!Array.isArray(value.current))
    throw new TypeError(`pressure frontier ${label} current must be an array`);
  return {
    current: parseLevels(value.current, `${label} current`, true),
  };
}

function parseSideV1(
  value: unknown,
  label: string,
): PressureFrontierSideSnapshotV1 {
  if (!isRecord(value))
    throw new TypeError(`pressure frontier ${label} side must be an object`);

  const updatedAtMs =
    value.updatedAtMs === null
      ? null
      : finiteNumber(value.updatedAtMs, `${label} updatedAtMs`);
  if (!Array.isArray(value.current))
    throw new TypeError(`pressure frontier ${label} current must be an array`);
  if (!Array.isArray(value.history))
    throw new TypeError(`pressure frontier ${label} history must be an array`);

  const current = parseLevels(value.current, `${label} current`, true);
  const history = value.history.map((rawLayer, index) => {
    if (!isRecord(rawLayer))
      throw new TypeError(`${label} history[${index}] must be an object`);
    if (!Array.isArray(rawLayer.levels))
      throw new TypeError(`${label} history[${index}].levels must be an array`);
    return {
      sinceMs: finiteNumber(
        rawLayer.sinceMs,
        `${label} history[${index}].sinceMs`,
      ),
      levels: parseLevels(
        rawLayer.levels,
        `${label} history[${index}].levels`,
        true,
      ),
    };
  });

  for (let index = 1; index < history.length; index++)
    if (history[index]!.sinceMs > history[index - 1]!.sinceMs)
      throw new RangeError(
        `pressure frontier ${label} history must be newest-first`,
      );

  return { updatedAtMs, current, history };
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
    runs: value.runs.map(parseExactRun),
  };
}

function parseLegacyField(value: unknown): LegacyPressureFieldSnapshot {
  if (!isRecord(value))
    throw new TypeError("pressure field snapshot must be an object");
  const revision = finiteNumber(value.revision, "pressure field revision");
  if (revision < 0)
    throw new RangeError("pressure field revision must be non-negative");
  if (!Array.isArray(value.runs))
    throw new TypeError("pressure field runs must be an array");
  return {
    revision,
    runs: value.runs.map(parseLegacyRun),
  };
}

function parseExactRun(
  value: unknown,
  index: number,
): PressureFieldRunSnapshot {
  return parseRun(value, index, false) as PressureFieldRunSnapshot;
}

function parseLegacyRun(
  value: unknown,
  index: number,
): LegacyPressureFieldRunSnapshot {
  return parseRun(value, index, true) as LegacyPressureFieldRunSnapshot;
}

function parseRun(value: unknown, index: number, legacy: boolean) {
  if (!isRecord(value))
    throw new TypeError(`pressure field run[${index}] must be an object`);
  if (!Array.isArray(value.bands))
    throw new TypeError(`pressure field run[${index}].bands must be an array`);

  return {
    lo: parseSnapshotPrice(value.lo, `run[${index}].lo`, legacy),
    hi: parseSnapshotPrice(value.hi, `run[${index}].hi`, legacy),
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
  if (!isRecord(value.state))
    throw new TypeError(`${label}.state must be an object`);

  const state =
    value.state.kind === "live"
      ? ({ kind: "live" } as const)
      : value.state.kind === "ghost"
        ? ({
            kind: "ghost",
            sinceMs: finiteNumber(value.state.sinceMs, `${label}.sinceMs`),
          } as const)
        : (() => {
            throw new RangeError(`${label}.state kind is invalid`);
          })();

  return {
    loVolume: finiteNumber(value.loVolume, `${label}.loVolume`),
    hiVolume: finiteNumber(value.hiVolume, `${label}.hiVolume`),
    side: value.side,
    state,
  };
}

function parseLevels(
  value: readonly unknown[],
  label: string,
  legacy: false,
): FrontierLevel[];
function parseLevels(
  value: readonly unknown[],
  label: string,
  legacy: true,
): LegacyFrontierLevel[];
function parseLevels(
  value: readonly unknown[],
  label: string,
  legacy: boolean,
) {
  const levels = value.map((raw, index) => {
    if (!isRecord(raw))
      throw new TypeError(`${label}[${index}] must be an object`);
    const key = parseSnapshotPrice(raw.key, `${label}[${index}].key`, legacy);
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

export function migrateLegacyField(
  field: LegacyPressureFieldSnapshot,
): PressureFieldSnapshot {
  const runs: PressureFieldRunSnapshot[] = [];
  for (const run of field.runs) {
    const lo = priceFromLegacyNumber(run.lo);
    const hi = priceFromLegacyNumber(run.hi);
    if (lo === hi) continue;
    runs.push({ ...run, lo, hi });
  }
  return { revision: field.revision, runs };
}

export function migrateLegacyCurrentSide(
  side: LegacyPressureFrontierCurrentSideSnapshot,
): PressureFrontierCurrentSideSnapshot {
  return { current: migrateLegacyLevels(side.current) };
}

function migrateLegacyLevels(
  levels: readonly LegacyFrontierLevel[],
): FrontierLevel[] {
  return levels.map(({ key, weight }) => ({
    key: priceFromLegacyNumber(key),
    weight,
  }));
}

function parseSnapshotPrice(
  value: unknown,
  label: string,
  legacy: boolean,
): number | Price {
  const number = finiteNumber(value, label);
  if (legacy) {
    if (number < 0 || number > 1)
      throw new RangeError(`${label} must be in [0, 1]`);
    return number;
  }
  return priceFromTicks(number);
}

function finiteNumber(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value))
    throw new RangeError(`${label} must be finite`);
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
