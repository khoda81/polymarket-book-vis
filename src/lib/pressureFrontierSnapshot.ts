import {
  buildFrontier,
  frontierLevels,
  type FrontierLevel,
  type FrontierRoot,
} from "./monotoneFrontier";

export interface PressureFrontierLayerSnapshot {
  readonly sinceMs: number;
  readonly levels: readonly FrontierLevel[];
}

export interface PressureFrontierSideSnapshot {
  readonly updatedAtMs: number | null;
  readonly current: readonly FrontierLevel[];
  readonly history: readonly PressureFrontierLayerSnapshot[];
}

export interface PressureFrontierSnapshot {
  readonly version: 1;
  readonly bid: PressureFrontierSideSnapshot;
  readonly ask: PressureFrontierSideSnapshot;
}

export interface RestoredPressureFrontierSide {
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
  if (!isRecord(value) || value.version !== 1)
    throw new TypeError("unsupported pressure frontier snapshot");

  return {
    version: 1,
    bid: parseSide(value.bid, "bid"),
    ask: parseSide(value.ask, "ask"),
  };
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

  const rebaseSide = (
    side: PressureFrontierSideSnapshot,
  ): PressureFrontierSideSnapshot => ({
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

export function snapshotSide(
  updatedAtMs: number,
  current: FrontierRoot,
  history: readonly {
    readonly sinceMs: number;
    readonly root: FrontierRoot;
  }[],
): PressureFrontierSideSnapshot {
  return {
    updatedAtMs: Number.isFinite(updatedAtMs) ? updatedAtMs : null,
    current: frontierLevels(current),
    history: history.map((layer) => ({
      sinceMs: layer.sinceMs,
      levels: frontierLevels(layer.root),
    })),
  };
}

export function restoreSnapshotSide(
  side: PressureFrontierSideSnapshot,
): RestoredPressureFrontierSide {
  return {
    updatedAtMs: side.updatedAtMs ?? Number.NEGATIVE_INFINITY,
    current: buildFrontier(side.current),
    history: side.history.map((layer) => ({
      sinceMs: layer.sinceMs,
      root: buildFrontier(layer.levels),
    })),
  };
}

function parseSide(
  value: unknown,
  label: string,
): PressureFrontierSideSnapshot {
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

  const current = parseLevels(value.current, `${label} current`);
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

function parseLevels(value: readonly unknown[], label: string): FrontierLevel[] {
  const levels = value.map((raw, index) => {
    if (!isRecord(raw))
      throw new TypeError(`${label}[${index}] must be an object`);
    const key = finiteNumber(raw.key, `${label}[${index}].key`);
    const weight = finiteNumber(raw.weight, `${label}[${index}].weight`);
    if (key < 0 || key > 1)
      throw new RangeError(`${label}[${index}].key must be in [0, 1]`);
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
