import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, readFileSync, renameSync } from "node:fs";
import { dirname } from "node:path";
import {
  parsePressureCells,
  type PressureCell,
} from "../src/lib/legacyPressureCells";
import { PressureFrontierMemory } from "../src/lib/pressureFrontierMemory";
import {
  parsePressureFrontierSnapshot,
  stalePressureFrontierSnapshot,
  type PressureFrontierSnapshot,
} from "../src/lib/pressureFrontierSnapshot";
import {
  StaleSignedVolume,
  type StaleSignedVolumeSnapshot,
} from "../src/lib/staleSignedVolume";

const MAX_CLOCK_SKEW_MS = 60_000;

export type RecorderTokenStatus = "watched" | "completed";

export interface RecorderStoreRecord {
  readonly tokenId: string;
  readonly status: RecorderTokenStatus;
  readonly recordingSinceMs: number | null;
  readonly pressure: PressureFrontierSnapshot | null;
  readonly savedAtMs: number;
}

interface DatabaseRow {
  token_id: string;
  status: RecorderTokenStatus;
  recording_since_ms: number | null;
  cells_json: string | null;
  saved_at_ms: number;
}

interface PersistedRecorderStateV2 {
  version: 2;
  savedAtMs: number;
  watchedTokenIds: string[];
  completedTokenIds: string[];
  recordingSinceMs: Record<string, number>;
  states: Record<string, readonly PressureCell[]>;
}

interface PersistedRecorderStateV1 {
  version: 1;
  watchedTokenIds: string[];
  recordingSinceMs?: Record<string, number>;
  states: Record<string, StaleSignedVolumeSnapshot>;
}

type PersistedRecorderState =
  PersistedRecorderStateV2 | PersistedRecorderStateV1;

/**
 * Durable recorder storage.
 *
 * One SQLite row owns one token's complete compressed pressure-frontier snapshot.
 * Checkpoints therefore serialize and write only tokens that changed instead
 * of rebuilding the recorder's entire history on every flush.
 */
export class RecorderStore {
  private readonly db: Database;

  constructor(
    readonly path: string,
    private readonly debug: (...args: unknown[]) => void = () => undefined,
  ) {
    mkdirSync(dirname(path), { recursive: true });
    this.db = new Database(path, { create: true });

    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("PRAGMA synchronous = NORMAL");
    this.db.exec("PRAGMA busy_timeout = 5000");
    this.db.exec("PRAGMA wal_autocheckpoint = 1000");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS token_state (
        token_id TEXT PRIMARY KEY,
        status TEXT NOT NULL CHECK (status IN ('watched', 'completed')),
        recording_since_ms INTEGER,
        cells_json TEXT,
        saved_at_ms INTEGER NOT NULL
      ) WITHOUT ROWID;
      CREATE INDEX IF NOT EXISTS token_state_status_idx
        ON token_state(status);
      PRAGMA user_version = 1;
    `);
  }

  get count(): number {
    const row = this.db
      .query<{ count: number }, []>("SELECT COUNT(*) AS count FROM token_state")
      .get();
    return Number(row?.count ?? 0);
  }

  loadAll(nowMs = Date.now()): RecorderStoreRecord[] {
    const rows = this.db
      .query<DatabaseRow, []>(
        `
        SELECT
          token_id,
          status,
          recording_since_ms,
          cells_json,
          saved_at_ms
        FROM token_state
      `,
      )
      .all();

    return rows.map((row) => ({
      tokenId: row.token_id,
      status: row.status,
      recordingSinceMs:
        row.recording_since_ms === null ? null : Number(row.recording_since_ms),
      pressure:
        row.cells_json === null
          ? null
          : loadStoredPressure(
              JSON.parse(row.cells_json),
              Math.min(Number(row.saved_at_ms), nowMs),
            ),
      savedAtMs: Number(row.saved_at_ms),
    }));
  }

  write(records: readonly RecorderStoreRecord[]): void {
    if (records.length === 0) return;

    const statement = this.db.prepare(`
      INSERT INTO token_state (
        token_id,
        status,
        recording_since_ms,
        cells_json,
        saved_at_ms
      ) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(token_id) DO UPDATE SET
        status = excluded.status,
        recording_since_ms = excluded.recording_since_ms,
        cells_json = excluded.cells_json,
        saved_at_ms = excluded.saved_at_ms
    `);

    const writeTransaction = this.db.transaction(
      (batch: readonly RecorderStoreRecord[]) => {
        for (const record of batch) {
          statement.run(
            record.tokenId,
            record.status,
            record.recordingSinceMs,
            record.pressure === null ? null : JSON.stringify(record.pressure),
            record.savedAtMs,
          );
        }
      },
    );
    writeTransaction(records);
  }

  /**
   * One-time import of the old monolithic JSON recorder file.
   * Returns true when a migration occurred.
   */
  migrateLegacyJson(legacyPath: string): boolean {
    if (this.count > 0 || !existsSync(legacyPath)) return false;

    const startedAt = performance.now();
    console.log(`Migrating legacy recorder JSON to SQLite: ${legacyPath}`);

    let parsed: PersistedRecorderState;
    try {
      parsed = parsePersistedRecorderState(
        JSON.parse(readFileSync(legacyPath, "utf8")),
      );
    } catch (error) {
      const backup = `${legacyPath}.corrupt-${Date.now()}`;
      try {
        renameSync(legacyPath, backup);
        console.warn(
          `Legacy recorder state was invalid; moved it to ${backup}`,
          error,
        );
      } catch (renameError) {
        throw new Error(
          `Could not read or preserve legacy recorder state: ${String(
            renameError,
          )}`,
        );
      }
      return false;
    }

    const records = legacyRecords(parsed, Date.now());
    this.write(records);

    const backup = `${legacyPath}.migrated-${Date.now()}`;
    try {
      renameSync(legacyPath, backup);
      console.log(`Preserved legacy recorder JSON at ${backup}`);
    } catch (error) {
      // The DB transaction is already durable; retaining the source JSON is
      // harmless and preferable to deleting anything on migration trouble.
      console.warn(
        "SQLite migration succeeded but the legacy JSON could not be renamed",
        error,
      );
    }

    this.debug(
      "sqlite-migration",
      `tokens=${records.length}`,
      `ms=${Math.round(performance.now() - startedAt)}`,
    );
    return true;
  }

  checkpoint(): void {
    // PASSIVE never waits on readers. WAL remains crash-safe even if pages stay
    // in the WAL file until a later checkpoint.
    this.db.exec("PRAGMA wal_checkpoint(PASSIVE)");
  }

  close(): void {
    this.db.close();
  }
}

function legacyRecords(
  parsed: PersistedRecorderState,
  nowMs: number,
): RecorderStoreRecord[] {
  if (parsed.version === 2) {
    const watched = new Set(parsed.watchedTokenIds.filter(Boolean));
    const completed = new Set(parsed.completedTokenIds.filter(Boolean));
    for (const tokenId of completed) watched.delete(tokenId);

    const tokenIds = new Set<string>([
      ...watched,
      ...completed,
      ...Object.keys(parsed.recordingSinceMs),
      ...Object.keys(parsed.states),
    ]);

    return [...tokenIds].map((tokenId) => {
      const rawCells = parsed.states[tokenId];
      const pressure =
        rawCells === undefined
          ? null
          : legacyCellsToSnapshot(
              parsePressureCells(rawCells),
              Math.min(parsed.savedAtMs, nowMs),
            );
      return {
        tokenId,
        status: completed.has(tokenId) ? "completed" : "watched",
        recordingSinceMs:
          validWallClockMs(parsed.recordingSinceMs[tokenId], nowMs) ?? null,
        pressure,
        savedAtMs: nowMs,
      };
    });
  }

  const watched = new Set(parsed.watchedTokenIds.filter(Boolean));
  const tokenIds = new Set<string>([
    ...watched,
    ...Object.keys(parsed.recordingSinceMs ?? {}),
    ...Object.keys(parsed.states),
  ]);

  return [...tokenIds].map((tokenId) => {
    const snapshot = parsed.states[tokenId];
    let pressure: PressureFrontierSnapshot | null = null;

    if (snapshot !== undefined) {
      const legacy = new StaleSignedVolume();
      legacy.restore(snapshot);
      const cells: PressureCell[] = legacy.segments(nowMs).map((segment) => ({
        lo: segment.lo,
        hi: segment.hi,
        bands:
          segment.volume === 0
            ? []
            : [
                {
                  loVolume: 0,
                  hiVolume: Math.abs(segment.volume),
                  side: segment.volume < 0 ? (-1 as const) : (1 as const),
                  state: {
                    kind: "ghost" as const,
                    sinceMs:
                      segment.ageMs === Infinity
                        ? nowMs
                        : nowMs - segment.ageMs,
                  },
                },
              ],
      }));
      pressure = legacyCellsToSnapshot(cells, nowMs);
    }

    const storedStart = validWallClockMs(
      parsed.recordingSinceMs?.[tokenId],
      nowMs,
    );
    const inferredStart = earliestSnapshotObservationMs(snapshot, nowMs);
    const knownStarts = [storedStart, inferredStart].filter(
      (value): value is number => value !== undefined,
    );

    return {
      tokenId,
      status: "watched",
      recordingSinceMs:
        knownStarts.length > 0 ? Math.min(...knownStarts) : null,
      pressure,
      savedAtMs: nowMs,
    };
  });
}

function loadStoredPressure(
  value: unknown,
  staleSinceMs: number,
): PressureFrontierSnapshot {
  if (Array.isArray(value))
    return legacyCellsToSnapshot(parsePressureCells(value), staleSinceMs);

  return stalePressureFrontierSnapshot(
    parsePressureFrontierSnapshot(value),
    staleSinceMs,
  );
}

function legacyCellsToSnapshot(
  cells: readonly PressureCell[],
  staleSinceMs: number,
): PressureFrontierSnapshot {
  const memory = new PressureFrontierMemory();
  memory.restoreLegacyCells(staleLiveBands(cells, staleSinceMs));
  return memory.snapshot();
}

function staleLiveBands(
  cells: readonly PressureCell[],
  staleSinceMs: number,
): readonly PressureCell[] {
  return cells.map((cell) => ({
    ...cell,
    bands: cell.bands.map((band) => ({
      ...band,
      state:
        band.state.kind === "live"
          ? {
              kind: "ghost" as const,
              sinceMs: staleSinceMs,
            }
          : band.state,
    })),
  }));
}

function parsePersistedRecorderState(value: unknown): PersistedRecorderState {
  if (!isRecord(value)) throw new TypeError("Malformed recorder state");

  if (value.version === 2) {
    if (!Array.isArray(value.watchedTokenIds))
      throw new TypeError("Recorder watchedTokenIds must be an array");
    if (!Array.isArray(value.completedTokenIds))
      throw new TypeError("Recorder completedTokenIds must be an array");
    if (!isRecord(value.states))
      throw new TypeError("Recorder states must be an object");
    if (!isRecord(value.recordingSinceMs))
      throw new TypeError("Recorder recordingSinceMs must be an object");
    if (
      typeof value.savedAtMs !== "number" ||
      !Number.isFinite(value.savedAtMs)
    )
      throw new TypeError("Recorder savedAtMs must be finite");

    return {
      version: 2,
      savedAtMs: value.savedAtMs,
      watchedTokenIds: stringArray(value.watchedTokenIds, "watched token ids"),
      completedTokenIds: stringArray(
        value.completedTokenIds,
        "completed token ids",
      ),
      recordingSinceMs: value.recordingSinceMs as Record<string, number>,
      states: value.states as Record<string, readonly PressureCell[]>,
    };
  }

  if (value.version === 1) {
    if (!Array.isArray(value.watchedTokenIds))
      throw new TypeError("Recorder watchedTokenIds must be an array");
    if (!isRecord(value.states))
      throw new TypeError("Recorder states must be an object");
    if (
      value.recordingSinceMs !== undefined &&
      !isRecord(value.recordingSinceMs)
    )
      throw new TypeError("Recorder recordingSinceMs must be an object");

    return {
      version: 1,
      watchedTokenIds: stringArray(value.watchedTokenIds, "watched token ids"),
      recordingSinceMs: value.recordingSinceMs as
        Record<string, number> | undefined,
      states: value.states as Record<string, StaleSignedVolumeSnapshot>,
    };
  }

  throw new TypeError("Unsupported recorder state version");
}

function stringArray(value: unknown[], label: string): string[] {
  return value.map((item) => {
    if (typeof item !== "string")
      throw new TypeError(`Recorder ${label} must be strings`);
    return item;
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function earliestSnapshotObservationMs(
  snapshot: StaleSignedVolumeSnapshot | undefined,
  nowMs: number,
): number | undefined {
  if (!snapshot) return undefined;

  let earliest: number | undefined;
  for (const segment of snapshot.segments ?? []) {
    const observedAt = validWallClockMs(
      segment.observedAtMs ?? segment.staleSinceMs,
      nowMs,
    );
    if (observedAt === undefined) continue;
    earliest =
      earliest === undefined ? observedAt : Math.min(earliest, observedAt);
  }

  return earliest ?? validWallClockMs(snapshot.lastUpdateMs, nowMs);
}

function validWallClockMs(value: unknown, nowMs: number): number | undefined {
  return typeof value === "number" &&
    Number.isFinite(value) &&
    value >= 0 &&
    value <= nowMs + MAX_CLOCK_SKEW_MS
    ? value
    : undefined;
}
