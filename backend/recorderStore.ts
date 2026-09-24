import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import {
  parsePressureFrontierSnapshot,
  type PressureFrontierSnapshot,
} from "../src/lib/pressureFrontierSnapshot";

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
    pressure:
      value === null
        ? null
        : parsePressureFrontierSnapshot(
            JSON.parse(
              typeof value === "string"
                ? value
                : gunzipSync(value).toString("utf8"),
            ),
          ),
  };
}
