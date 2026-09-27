import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import {
  decodePressureMutation,
  encodePressureMutation,
  replayPressureMutation,
  type RecorderPressureMutation,
} from "./recorderPressureLog";
import { PressureFrontierMemory } from "../src/lib/pressureFrontierMemory";
import {
  parsePressureFrontierSnapshot,
  type PressureFrontierSnapshot,
} from "../src/lib/pressureFrontierSnapshot";

export const RECORDER_DATABASE_VERSION = 5;
export const RECORDER_CHECKPOINT_MUTATIONS = 512;

export type RecorderTokenStatus = "watched" | "completed";

export interface RecorderStoreRecord {
  readonly tokenId: string;
  readonly status: RecorderTokenStatus;
  readonly recordingSinceMs: number | null;
  readonly pressure: PressureFrontierSnapshot | null;
}

export interface RecorderStoreWriteRecord {
  readonly tokenId: string;
  readonly status: RecorderTokenStatus;
  readonly recordingSinceMs: number | null;
  readonly mutations?: readonly RecorderPressureMutation[];
  /**
   * Undefined appends mutations to the existing checkpoint.
   * A snapshot (or null) replaces the checkpoint and clears its mutation tail.
   */
  readonly checkpoint?: PressureFrontierSnapshot | null;
}

interface TokenStateRow {
  token_id: string;
  status: RecorderTokenStatus;
  recording_since_ms: number | null;
  checkpoint: Uint8Array | null;
}

interface PressureLogRow {
  payload: Uint8Array;
}

export type RecorderStoreIndexRecord = Omit<RecorderStoreRecord, "pressure"> & {
  readonly hasPressure: boolean;
};

export interface RecorderStoreWriteStats {
  readonly encodeMs: number;
  readonly sqliteMs: number;
  readonly mutationCount: number;
  readonly mutationBytes: number;
  readonly checkpointCount: number;
  readonly checkpointBytes: number;
}

interface EncodedRecorderStoreWriteRecord {
  readonly tokenId: string;
  readonly status: RecorderTokenStatus;
  readonly recordingSinceMs: number | null;
  readonly mutations: readonly Uint8Array[];
  readonly checkpoint: Uint8Array | null | undefined;
}

/**
 * Durable recorder storage.
 *
 * token_state.pressure is a sparse full checkpoint. The hot path appends
 * compact pressure mutations to pressure_log. Replay stays bounded because
 * mutation tails are periodically compacted back into a checkpoint.
 */
export class RecorderStore {
  private readonly db: Database;
  private readonly mutationCounts = new Map<string, number>();
  private readonly writeBatch: (
    batch: readonly EncodedRecorderStoreWriteRecord[],
  ) => void;

  constructor(readonly path: string) {
    mkdirSync(dirname(path), { recursive: true });
    this.db = new Database(path, { create: true });

    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("PRAGMA synchronous = NORMAL");
    this.db.exec("PRAGMA busy_timeout = 5000");
    this.db.exec("PRAGMA wal_autocheckpoint = 1000");
    this.db.exec("PRAGMA foreign_keys = ON");
    this.initializeDatabase();

    for (const row of this.db
      .query<{ token_id: string; count: number }, []>(
        `SELECT token_id, COUNT(*) AS count
         FROM pressure_log
         GROUP BY token_id`,
      )
      .all())
      this.mutationCounts.set(row.token_id, Number(row.count));

    const upsertMetadata = this.db.prepare(`
      INSERT INTO token_state (
        token_id,
        status,
        recording_since_ms,
        pressure
      ) VALUES (?, ?, ?, NULL)
      ON CONFLICT(token_id) DO UPDATE SET
        status = excluded.status,
        recording_since_ms = excluded.recording_since_ms
    `);
    const replaceCheckpoint = this.db.prepare(
      "UPDATE token_state SET pressure = ? WHERE token_id = ?",
    );
    const deleteMutations = this.db.prepare(
      "DELETE FROM pressure_log WHERE token_id = ?",
    );
    const appendMutation = this.db.prepare(
      "INSERT INTO pressure_log (token_id, payload) VALUES (?, ?)",
    );

    const transaction = this.db.transaction(
      (batch: readonly EncodedRecorderStoreWriteRecord[]) => {
        for (const record of batch) {
          upsertMetadata.run(
            record.tokenId,
            record.status,
            record.recordingSinceMs,
          );

          if (record.checkpoint !== undefined) {
            replaceCheckpoint.run(record.checkpoint, record.tokenId);
            deleteMutations.run(record.tokenId);
            continue;
          }

          for (const mutation of record.mutations)
            appendMutation.run(record.tokenId, mutation);
        }
      },
    );
    this.writeBatch = (batch) => transaction(batch);
  }

  loadIndex(): RecorderStoreIndexRecord[] {
    return this.db
      .query<Omit<TokenStateRow, "checkpoint"> & { has_pressure: number }, []>(
        `SELECT s.token_id, s.status, s.recording_since_ms,
                (
                  s.pressure IS NOT NULL OR
                  EXISTS (
                    SELECT 1 FROM pressure_log l
                    WHERE l.token_id = s.token_id
                  )
                ) AS has_pressure
         FROM token_state s`,
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
      .query<TokenStateRow, [string]>(
        `SELECT token_id, status, recording_since_ms, pressure AS checkpoint
         FROM token_state WHERE token_id = ?`,
      )
      .get(tokenId);
    if (row === null) return null;

    const mutations = this.db
      .query<PressureLogRow, [string]>(
        `SELECT payload
         FROM pressure_log
         WHERE token_id = ?
         ORDER BY seq`,
      )
      .all(tokenId);

    let pressure =
      row.checkpoint === null ? null : decodePressure(row.checkpoint);
    if (mutations.length > 0) {
      const memory = new PressureFrontierMemory();
      if (pressure !== null) memory.restore(pressure);
      for (const mutation of mutations)
        replayPressureMutation(
          memory,
          decodePressureMutation(mutation.payload),
        );
      pressure = memory.snapshot();
    }

    return {
      tokenId: row.token_id,
      status: row.status,
      recordingSinceMs:
        row.recording_since_ms === null ? null : Number(row.recording_since_ms),
      pressure,
    };
  }

  shouldCheckpoint(tokenId: string, additionalMutations: number): boolean {
    return (
      (this.mutationCounts.get(tokenId) ?? 0) + additionalMutations >=
      RECORDER_CHECKPOINT_MUTATIONS
    );
  }

  write(records: readonly RecorderStoreWriteRecord[]): RecorderStoreWriteStats {
    if (records.length === 0) return emptyWriteStats();

    const encodeStartedAt = performance.now();
    let mutationCount = 0;
    let mutationBytes = 0;
    let checkpointCount = 0;
    let checkpointBytes = 0;

    const encoded: EncodedRecorderStoreWriteRecord[] = records.map((record) => {
      const checkpoint =
        record.checkpoint === undefined
          ? undefined
          : record.checkpoint === null
            ? null
            : encodePressure(record.checkpoint);

      if (record.checkpoint !== undefined) {
        checkpointCount++;
        checkpointBytes += checkpoint?.byteLength ?? 0;
        return {
          tokenId: record.tokenId,
          status: record.status,
          recordingSinceMs: record.recordingSinceMs,
          mutations: [],
          checkpoint,
        };
      }

      const mutations = (record.mutations ?? []).map((mutation) => {
        const encodedMutation = encodePressureMutation(mutation);
        mutationCount++;
        mutationBytes += encodedMutation.byteLength;
        return encodedMutation;
      });

      return {
        tokenId: record.tokenId,
        status: record.status,
        recordingSinceMs: record.recordingSinceMs,
        mutations,
        checkpoint: undefined,
      };
    });
    const encodeMs = performance.now() - encodeStartedAt;

    const sqliteStartedAt = performance.now();
    this.writeBatch(encoded);
    const sqliteMs = performance.now() - sqliteStartedAt;

    for (let index = 0; index < records.length; index++) {
      const record = records[index]!;
      const encodedRecord = encoded[index]!;
      if (record.checkpoint !== undefined) {
        this.mutationCounts.delete(record.tokenId);
        continue;
      }

      if (encodedRecord.mutations.length === 0) continue;
      this.mutationCounts.set(
        record.tokenId,
        (this.mutationCounts.get(record.tokenId) ?? 0) +
          encodedRecord.mutations.length,
      );
    }

    return {
      encodeMs,
      sqliteMs,
      mutationCount,
      mutationBytes,
      checkpointCount,
      checkpointBytes,
    };
  }

  checkpoint(): void {
    this.db.exec("PRAGMA wal_checkpoint(PASSIVE)");
  }

  close(): void {
    this.db.close();
  }

  private initializeDatabase(): void {
    const version = Number(
      this.db.query<{ user_version: number }, []>("PRAGMA user_version").get()
        ?.user_version ?? 0,
    );

    if (version === RECORDER_DATABASE_VERSION) return;

    if (version === 0) {
      const existingTables = Number(
        this.db
          .query<{ count: number }, []>(
            `SELECT COUNT(*) AS count
             FROM sqlite_master
             WHERE type = 'table'
               AND name IN ('token_state', 'pressure_log')`,
          )
          .get()?.count ?? 0,
      );

      if (existingTables === 0) {
        this.db.exec(`
          BEGIN;
          CREATE TABLE token_state (
            token_id TEXT PRIMARY KEY,
            status TEXT NOT NULL CHECK (status IN ('watched', 'completed')),
            recording_since_ms INTEGER,
            pressure BLOB
          ) WITHOUT ROWID;
          CREATE INDEX token_state_status_idx ON token_state(status);
          CREATE TABLE pressure_log (
            seq INTEGER PRIMARY KEY,
            token_id TEXT NOT NULL,
            payload BLOB NOT NULL,
            FOREIGN KEY(token_id) REFERENCES token_state(token_id)
              ON DELETE CASCADE
          );
          CREATE INDEX pressure_log_token_seq_idx
            ON pressure_log(token_id, seq);
          PRAGMA user_version = ${RECORDER_DATABASE_VERSION};
          COMMIT;
        `);
        return;
      }
    }

    this.db.close();
    throw new Error(
      `Recorder database version ${version} is unsupported; expected ${RECORDER_DATABASE_VERSION}`,
    );
  }
}

function emptyWriteStats(): RecorderStoreWriteStats {
  return {
    encodeMs: 0,
    sqliteMs: 0,
    mutationCount: 0,
    mutationBytes: 0,
    checkpointCount: 0,
    checkpointBytes: 0,
  };
}

function encodePressure(snapshot: PressureFrontierSnapshot): Uint8Array {
  return gzipSync(JSON.stringify(snapshot), { level: 1 });
}

function decodePressure(value: Uint8Array): PressureFrontierSnapshot {
  const raw = JSON.parse(gunzipSync(value).toString("utf8")) as unknown;
  return parsePressureFrontierSnapshot(raw);
}
