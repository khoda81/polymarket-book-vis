import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import {
  PRESSURE_FRONTIER_SNAPSHOT_VERSION,
  parsePressureFrontierSnapshot,
  type PressureFrontierSnapshot,
} from "../src/lib/pressureFrontierSnapshot";
import type { PressureFieldSnapshot } from "../src/lib/materializedPressureField";
import { complementPrice, priceFromTicks } from "../src/lib/price";

export type RecorderTokenStatus = "watched" | "completed";

export interface RecorderStoreRecord {
  readonly tokenId: string;
  readonly status: RecorderTokenStatus;
  readonly recordingSinceMs: number | null;
  readonly pressure: PressureFrontierSnapshot | null;
}

interface DatabaseRow {
  token_id: string;
  status: RecorderTokenStatus;
  recording_since_ms: number | null;
  pressure: string | Uint8Array | null;
}

export type RecorderStoreIndexRecord = Omit<RecorderStoreRecord, "pressure"> & {
  readonly hasPressure: boolean;
};

/**
 * Durable recorder storage. One SQLite row owns one token's compressed pressure
 * snapshot. Snapshot timestamps are source timestamps and need no load-time
 * rebasing or stale-state conversion.
 */
export class RecorderStore {
  private readonly db: Database;

  constructor(readonly path: string) {
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
        pressure BLOB
      ) WITHOUT ROWID;
      CREATE INDEX IF NOT EXISTS token_state_status_idx
        ON token_state(status);
    `);
  }

  loadIndex(): RecorderStoreIndexRecord[] {
    return this.db
      .query<DatabaseRow & { has_pressure: number }, []>(
        `SELECT token_id, status, recording_since_ms,
                pressure IS NOT NULL AS has_pressure
         FROM token_state`,
      )
      .all()
      .map((row) => ({
        tokenId: row.token_id,
        status: row.status,
        recordingSinceMs:
          row.recording_since_ms === null
            ? null
            : Number(row.recording_since_ms),
        hasPressure: Boolean(row.has_pressure),
      }));
  }

  load(tokenId: string): RecorderStoreRecord | null {
    const row = this.db
      .query<DatabaseRow, [string]>(
        `SELECT token_id, status, recording_since_ms, pressure
         FROM token_state WHERE token_id = ?`,
      )
      .get(tokenId);
    return row === null ? null : decodeRow(row);
  }

  write(records: readonly RecorderStoreRecord[]): void {
    if (records.length === 0) return;

    const statement = this.db.prepare(`
      INSERT INTO token_state (
        token_id,
        status,
        recording_since_ms,
        pressure
      ) VALUES (?, ?, ?, ?)
      ON CONFLICT(token_id) DO UPDATE SET
        status = excluded.status,
        recording_since_ms = excluded.recording_since_ms,
        pressure = excluded.pressure
    `);

    const writeTransaction = this.db.transaction(
      (batch: readonly RecorderStoreRecord[]) => {
        for (const record of batch) {
          statement.run(
            record.tokenId,
            record.status,
            record.recordingSinceMs,
            record.pressure === null
              ? null
              : gzipSync(JSON.stringify(record.pressure), { level: 1 }),
          );
        }
      },
    );
    writeTransaction(records);
  }

  checkpoint(): void {
    this.db.exec("PRAGMA wal_checkpoint(PASSIVE)");
  }

  close(): void {
    this.db.close();
  }
}

function decodeRow(row: DatabaseRow): RecorderStoreRecord {
  const value = row.pressure;
  return {
    tokenId: row.token_id,
    status: row.status,
    recordingSinceMs:
      row.recording_since_ms === null ? null : Number(row.recording_since_ms),
    pressure: value === null ? null : decodePressure(value),
  };
}

function decodePressure(
  value: string | Uint8Array,
): PressureFrontierSnapshot | null {
  const raw = JSON.parse(
    typeof value === "string" ? value : gunzipSync(value).toString("utf8"),
  ) as unknown;

  const migrated = migratePressureSnapshot(raw);
  return migrated === null ? null : parsePressureFrontierSnapshot(migrated);
}

function migratePressureSnapshot(
  raw: unknown,
): PressureFrontierSnapshot | null {
  if (!isRecord(raw)) return null;

  if (raw.version === PRESSURE_FRONTIER_SNAPSHOT_VERSION)
    return raw as unknown as PressureFrontierSnapshot;

  // v3 paired two already-generic directed edges in one primary-token row.
  // The primary edge is exactly this token's native token -> collateral field.
  if (raw.version === 3 && isRecord(raw.primaryToCollateral)) {
    const edge = raw.primaryToCollateral;
    if (!Array.isArray(edge.current) || !isRecord(edge.field)) return null;
    return {
      version: PRESSURE_FRONTIER_SNAPSHOT_VERSION,
      current: edge.current as PressureFrontierSnapshot["current"],
      field: edge.field as PressureFieldSnapshot,
    };
  }

  // v2 had independent bid/ask fields but still stored them under one market
  // token. The ask field is this token's native supply edge. Its frontier keys
  // were stored in complemented coordinates, so convert them back.
  if (
    raw.version === 2 &&
    isRecord(raw.ask) &&
    isRecord(raw.field) &&
    isRecord(raw.field.ask)
  ) {
    const current = migrateComplementedCurrent(raw.ask.current);
    if (current === null) return null;
    return {
      version: PRESSURE_FRONTIER_SNAPSHOT_VERSION,
      current,
      field: raw.field.ask as unknown as PressureFieldSnapshot,
    };
  }

  // v1 stored one ownership-compressed radial field. We can recover only the
  // directly observed ask/token->collateral evidence. When an ask-owned shell
  // reached volume v at time t, cumulative supply guarantees [0,v] existed at
  // least through t. Occluded ask history cannot be recovered, so this is a
  // conservative lower bound rather than invented timestamps.
  if (
    raw.version === undefined &&
    isRecord(raw.ask) &&
    isRecord(raw.field) &&
    Array.isArray(raw.field.runs)
  ) {
    const current = migrateComplementedCurrent(raw.ask.current);
    if (current === null) return null;

    const runs = raw.field.runs.flatMap((value) => {
      if (!isRecord(value) || !Array.isArray(value.bands)) return [];
      const lo = numeric(value.lo);
      const hi = numeric(value.hi);
      const volume = numeric(value.askVolume);
      if (lo === null || hi === null || volume === null) return [];

      const evidence = value.bands.flatMap((band) => {
        if (!isRecord(band) || band.side !== -1) return [];
        const extent = numeric(band.hiVolume);
        const validThroughMs = numeric(band.validThroughMs);
        return extent !== null &&
          extent > 0 &&
          validThroughMs !== null
          ? [{ extent, validThroughMs }]
          : [];
      });

      return [{ lo, hi, volume, evidence }];
    });
    if (runs.length !== raw.field.runs.length || runs.length === 0) return null;

    let currentValidThroughMs = Number.NEGATIVE_INFINITY;
    for (const value of raw.field.runs) {
      if (!isRecord(value) || !Array.isArray(value.bands)) continue;
      for (const band of value.bands) {
        if (!isRecord(band)) continue;
        const time = numeric(band.validThroughMs);
        if (time !== null)
          currentValidThroughMs = Math.max(currentValidThroughMs, time);
      }
    }

    const anyCurrent = runs.some((run) => run.volume > 0);
    const currentTime =
      anyCurrent && Number.isFinite(currentValidThroughMs)
        ? currentValidThroughMs
        : null;

    return {
      version: PRESSURE_FRONTIER_SNAPSHOT_VERSION,
      current,
      field: {
        currentValidThroughMs: currentTime,
        runs: runs.map((run) => ({
          lo: priceFromTicks(run.lo),
          hi: priceFromTicks(run.hi),
          volume: run.volume,
          bands: conservativeBands(
            run.volume,
            run.evidence,
            currentTime,
          ),
        })),
      },
    };
  }

  return null;
}

function migrateComplementedCurrent(
  value: unknown,
): PressureFrontierSnapshot["current"] | null {
  if (!isRecord(value) || !Array.isArray(value.current)) return null;

  const result = value.current.flatMap((level) => {
    if (!isRecord(level)) return [];
    const key = numeric(level.key);
    const weight = numeric(level.weight);
    if (key === null || weight === null || !(weight > 0)) return [];
    try {
      return [{ key: complementPrice(priceFromTicks(key)), weight }];
    } catch {
      return [];
    }
  });
  if (result.length !== value.current.length) return null;
  return result.sort((a, b) => a.key - b.key);
}

function conservativeBands(
  currentVolume: number,
  historical: readonly {
    readonly extent: number;
    readonly validThroughMs: number;
  }[],
  currentValidThroughMs: number | null,
): PressureFieldSnapshot["runs"][number]["bands"] {
  const evidence = [...historical];
  if (currentVolume > 0 && currentValidThroughMs !== null)
    evidence.push({
      extent: currentVolume,
      validThroughMs: currentValidThroughMs,
    });

  const extents = [...new Set(evidence.map((item) => item.extent))]
    .filter((extent) => Number.isFinite(extent) && extent > 0)
    .sort((a, b) => a - b);

  const bands: Array<{
    loVolume: number;
    hiVolume: number;
    validThroughMs: number;
  }> = [];
  let loVolume = 0;

  for (const hiVolume of extents) {
    const validThroughMs = evidence.reduce(
      (latest, item) =>
        item.extent >= hiVolume
          ? Math.max(latest, item.validThroughMs)
          : latest,
      Number.NEGATIVE_INFINITY,
    );
    if (!Number.isFinite(validThroughMs)) continue;

    const previous = bands[bands.length - 1];
    if (
      previous &&
      previous.hiVolume === loVolume &&
      previous.validThroughMs === validThroughMs
    )
      previous.hiVolume = hiVolume;
    else bands.push({ loVolume, hiVolume, validThroughMs });

    loVolume = hiVolume;
  }

  return bands;
}

function numeric(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
