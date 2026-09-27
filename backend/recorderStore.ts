import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import {
  parsePressureFrontierSnapshot,
  type PressureFrontierSnapshot,
} from "../src/lib/pressureFrontierSnapshot";

export const RECORDER_DATABASE_VERSION = 3;

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

export interface RecorderStoreWriteStats {
  readonly encodeMs: number;
  readonly sqliteMs: number;
  readonly rawPressureBytes: number;
  readonly storedPressureBytes: number;
}

interface EncodedRecorderStoreRecord {
  readonly tokenId: string;
  readonly status: RecorderTokenStatus;
  readonly recordingSinceMs: number | null;
  readonly pressure: Uint8Array | null;
}

/**
 * Durable recorder storage. One SQLite row owns one token's compressed pressure
 * snapshot. Snapshot timestamps are source timestamps and need no load-time
 * rebasing or stale-state conversion.
 */
export class RecorderStore {
  private readonly db: Database;
  private readonly writeBatch: (
    batch: readonly EncodedRecorderStoreRecord[],
  ) => void;

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
    this.ensureDatabaseVersion();

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
    const transaction = this.db.transaction(
      (batch: readonly EncodedRecorderStoreRecord[]) => {
        for (const record of batch)
          statement.run(
            record.tokenId,
            record.status,
            record.recordingSinceMs,
            record.pressure,
          );
      },
    );
    this.writeBatch = (batch) => transaction(batch);
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

  write(records: readonly RecorderStoreRecord[]): RecorderStoreWriteStats {
    if (records.length === 0)
      return {
        encodeMs: 0,
        sqliteMs: 0,
        rawPressureBytes: 0,
        storedPressureBytes: 0,
      };

    const encodeStartedAt = performance.now();
    let rawPressureBytes = 0;
    let storedPressureBytes = 0;

    const encoded: EncodedRecorderStoreRecord[] = records.map((record) => {
      if (record.pressure === null) return { ...record, pressure: null };

      const json = JSON.stringify(record.pressure);
      rawPressureBytes += Buffer.byteLength(json);
      const pressure = gzipSync(json, { level: 1 });
      storedPressureBytes += pressure.byteLength;
      return {
        tokenId: record.tokenId,
        status: record.status,
        recordingSinceMs: record.recordingSinceMs,
        pressure,
      };
    });
    const encodeMs = performance.now() - encodeStartedAt;

    const sqliteStartedAt = performance.now();
    this.writeBatch(encoded);
    const sqliteMs = performance.now() - sqliteStartedAt;

    return {
      encodeMs,
      sqliteMs,
      rawPressureBytes,
      storedPressureBytes,
    };
  }

  checkpoint(): void {
    this.db.exec("PRAGMA wal_checkpoint(PASSIVE)");
  }

  close(): void {
    this.db.close();
  }

  private ensureDatabaseVersion(): void {
    const row = this.db
      .query<{ user_version: number }, []>("PRAGMA user_version")
      .get();
    const version = Number(row?.user_version ?? 0);

    if (version === RECORDER_DATABASE_VERSION) return;

    const count = Number(
      this.db
        .query<{ count: number }, []>(
          "SELECT COUNT(*) AS count FROM token_state",
        )
        .get()?.count ?? 0,
    );
    if (version === 0 && count === 0) {
      this.db.exec(`PRAGMA user_version = ${RECORDER_DATABASE_VERSION}`);
      return;
    }

    this.db.close();
    throw new Error(
      `Recorder database version ${version} requires migration to ${RECORDER_DATABASE_VERSION}`,
    );
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

function decodePressure(value: string | Uint8Array): PressureFrontierSnapshot {
  const raw = JSON.parse(
    typeof value === "string" ? value : gunzipSync(value).toString("utf8"),
  ) as unknown;
  return parsePressureFrontierSnapshot(raw);
}
