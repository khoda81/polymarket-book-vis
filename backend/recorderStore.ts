import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import type { FrontierLevel } from "../src/lib/monotoneFrontier";
import {
  PressureFrontierMemory,
  type PressureLevelChange,
} from "../src/lib/pressureFrontierMemory";
import {
  parsePressureFrontierSnapshot,
  type PressureFrontierSnapshot,
} from "../src/lib/pressureFrontierSnapshot";
import { priceFromTicks } from "../src/lib/price";

export const RECORDER_DATABASE_VERSION = 5;
export const RECORDER_CHECKPOINT_MUTATIONS = 512;

const PREVIOUS_INCREMENTAL_DATABASE_VERSION = 4;
const MUTATION_CLEAR = 0;
const MUTATION_REPLACE = 1;
const MUTATION_UPDATE = 2;
const MUTATION_HEADER_BYTES = 11;
const MUTATION_LEVEL_BYTES = 10;

export type RecorderTokenStatus = "watched" | "completed";

export interface RecorderStoreRecord {
  readonly tokenId: string;
  readonly status: RecorderTokenStatus;
  readonly recordingSinceMs: number | null;
  readonly pressure: PressureFrontierSnapshot | null;
}

export type RecorderPressureMutation =
  | {
      readonly kind: "replace";
      readonly validThroughMs: number;
      readonly levels: readonly FrontierLevel[];
    }
  | {
      readonly kind: "update";
      readonly validThroughMs: number;
      readonly changes: readonly PressureLevelChange[];
    }
  | {
      readonly kind: "clear";
    };

export interface RecorderStoreWriteRecord {
  readonly tokenId: string;
  readonly status: RecorderTokenStatus;
  readonly recordingSinceMs: number | null;
  readonly mutations?: readonly RecorderPressureMutation[];
  /**
   * Undefined keeps the existing checkpoint and appends mutations.
   * A snapshot (or null) replaces the checkpoint and clears the mutation log.
   */
  readonly checkpoint?: PressureFrontierSnapshot | null;
}

interface DatabaseRow {
  token_id: string;
  status: RecorderTokenStatus;
  recording_since_ms: number | null;
  pressure: string | Uint8Array | null;
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
  readonly checkpointRawBytes: number;
  readonly checkpointStoredBytes: number;
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
 * token_state holds sparse full checkpoints. The hot path appends compact
 * pressure mutations to pressure_log instead of rewriting the complete
 * historical snapshot on every observation. Replay is bounded by periodically
 * compacting the log back into a checkpoint.
 */
export class RecorderStore {
  private readonly db: Database;
  private readonly opCounts = new Map<string, number>();
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
    this.ensureIncrementalSchema();

    for (const row of this.db
      .query<{ token_id: string; count: number }, []>(
        `SELECT token_id, COUNT(*) AS count
         FROM pressure_log
         GROUP BY token_id`,
      )
      .all())
      this.opCounts.set(row.token_id, Number(row.count));

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
      .query<DatabaseRow & { has_pressure: number }, []>(
        `SELECT s.token_id, s.status, s.recording_since_ms, s.pressure,
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
      .query<DatabaseRow, [string]>(
        `SELECT token_id, status, recording_since_ms, pressure
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

    let pressure = row.pressure === null ? null : decodePressure(row.pressure);
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

  needsCheckpoint(tokenId: string, additionalMutations: number): boolean {
    return (
      (this.opCounts.get(tokenId) ?? 0) + additionalMutations >=
      RECORDER_CHECKPOINT_MUTATIONS
    );
  }

  write(records: readonly RecorderStoreWriteRecord[]): RecorderStoreWriteStats {
    if (records.length === 0) return emptyWriteStats();

    const encodeStartedAt = performance.now();
    let mutationCount = 0;
    let mutationBytes = 0;
    let checkpointCount = 0;
    let checkpointRawBytes = 0;
    let checkpointStoredBytes = 0;

    const encoded: EncodedRecorderStoreWriteRecord[] = records.map((record) => {
      const checkpoint =
        record.checkpoint === undefined
          ? undefined
          : record.checkpoint === null
            ? null
            : encodePressure(record.checkpoint);

      if (record.checkpoint !== undefined) {
        checkpointCount++;
        if (record.checkpoint !== null) {
          const json = JSON.stringify(record.checkpoint);
          checkpointRawBytes += Buffer.byteLength(json);
          checkpointStoredBytes += checkpoint!.byteLength;
        }
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
        this.opCounts.delete(record.tokenId);
        continue;
      }

      if (encodedRecord.mutations.length === 0) continue;
      this.opCounts.set(
        record.tokenId,
        (this.opCounts.get(record.tokenId) ?? 0) +
          encodedRecord.mutations.length,
      );
    }

    return {
      encodeMs,
      sqliteMs,
      mutationCount,
      mutationBytes,
      checkpointCount,
      checkpointRawBytes,
      checkpointStoredBytes,
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

    if (
      version === PREVIOUS_INCREMENTAL_DATABASE_VERSION ||
      (version === 0 && count === 0)
    ) {
      this.db.exec(`
        BEGIN;
        CREATE TABLE IF NOT EXISTS pressure_log (
          seq INTEGER PRIMARY KEY,
          token_id TEXT NOT NULL,
          payload BLOB NOT NULL,
          FOREIGN KEY(token_id) REFERENCES token_state(token_id) ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS pressure_log_token_seq_idx
          ON pressure_log(token_id, seq);
        PRAGMA user_version = ${RECORDER_DATABASE_VERSION};
        COMMIT;
      `);
      return;
    }

    this.db.close();
    throw new Error(
      `Recorder database version ${version} requires migration to ${RECORDER_DATABASE_VERSION}`,
    );
  }

  private ensureIncrementalSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS pressure_log (
        seq INTEGER PRIMARY KEY,
        token_id TEXT NOT NULL,
        payload BLOB NOT NULL,
        FOREIGN KEY(token_id) REFERENCES token_state(token_id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS pressure_log_token_seq_idx
        ON pressure_log(token_id, seq);
    `);
  }
}

function emptyWriteStats(): RecorderStoreWriteStats {
  return {
    encodeMs: 0,
    sqliteMs: 0,
    mutationCount: 0,
    mutationBytes: 0,
    checkpointCount: 0,
    checkpointRawBytes: 0,
    checkpointStoredBytes: 0,
  };
}

function encodePressure(snapshot: PressureFrontierSnapshot): Uint8Array {
  return gzipSync(JSON.stringify(snapshot), { level: 1 });
}

function decodePressure(value: string | Uint8Array): PressureFrontierSnapshot {
  const raw = JSON.parse(
    typeof value === "string" ? value : gunzipSync(value).toString("utf8"),
  ) as unknown;
  return parsePressureFrontierSnapshot(raw);
}

function encodePressureMutation(
  mutation: RecorderPressureMutation,
): Uint8Array {
  if (mutation.kind === "clear") return Uint8Array.of(MUTATION_CLEAR);

  if (!Number.isFinite(mutation.validThroughMs))
    throw new RangeError("pressure mutation timestamp must be finite");

  const entries =
    mutation.kind === "replace"
      ? mutation.levels.map(({ key, weight }) => ({
          price: key,
          shares: weight,
        }))
      : mutation.changes;

  if (entries.length > 0xffff)
    throw new RangeError("too many pressure levels in one mutation");

  const bytes = new Uint8Array(
    MUTATION_HEADER_BYTES + entries.length * MUTATION_LEVEL_BYTES,
  );
  const view = new DataView(bytes.buffer);
  view.setUint8(
    0,
    mutation.kind === "replace" ? MUTATION_REPLACE : MUTATION_UPDATE,
  );
  view.setFloat64(1, mutation.validThroughMs, true);
  view.setUint16(9, entries.length, true);

  let offset = MUTATION_HEADER_BYTES;
  for (const entry of entries) {
    const price = priceFromTicks(entry.price);
    if (
      !Number.isFinite(entry.shares) ||
      entry.shares < 0 ||
      (mutation.kind === "replace" && !(entry.shares > 0))
    )
      throw new RangeError("invalid pressure mutation shares");

    view.setUint16(offset, price, true);
    view.setFloat64(offset + 2, entry.shares, true);
    offset += MUTATION_LEVEL_BYTES;
  }

  return bytes;
}

function decodePressureMutation(value: Uint8Array): RecorderPressureMutation {
  if (value.byteLength === 0) throw new RangeError("empty pressure mutation");

  const view = new DataView(value.buffer, value.byteOffset, value.byteLength);
  const kind = view.getUint8(0);
  if (kind === MUTATION_CLEAR) {
    if (value.byteLength !== 1)
      throw new RangeError("malformed clear pressure mutation");
    return { kind: "clear" };
  }

  if (kind !== MUTATION_REPLACE && kind !== MUTATION_UPDATE)
    throw new RangeError(`unsupported pressure mutation kind: ${kind}`);
  if (value.byteLength < MUTATION_HEADER_BYTES)
    throw new RangeError("truncated pressure mutation");

  const validThroughMs = view.getFloat64(1, true);
  if (!Number.isFinite(validThroughMs))
    throw new RangeError("pressure mutation timestamp must be finite");

  const count = view.getUint16(9, true);
  const expectedBytes = MUTATION_HEADER_BYTES + count * MUTATION_LEVEL_BYTES;
  if (value.byteLength !== expectedBytes)
    throw new RangeError("pressure mutation has invalid length");

  const entries: Array<{
    price: ReturnType<typeof priceFromTicks>;
    shares: number;
  }> = [];
  let offset = MUTATION_HEADER_BYTES;
  for (let index = 0; index < count; index++) {
    const price = priceFromTicks(view.getUint16(offset, true));
    const shares = view.getFloat64(offset + 2, true);
    if (
      !Number.isFinite(shares) ||
      shares < 0 ||
      (kind === MUTATION_REPLACE && !(shares > 0))
    )
      throw new RangeError("invalid pressure mutation shares");
    entries.push({ price, shares });
    offset += MUTATION_LEVEL_BYTES;
  }

  return kind === MUTATION_REPLACE
    ? {
        kind: "replace",
        validThroughMs,
        levels: entries.map(({ price, shares }) => ({
          key: price,
          weight: shares,
        })),
      }
    : {
        kind: "update",
        validThroughMs,
        changes: entries,
      };
}

function replayPressureMutation(
  memory: PressureFrontierMemory,
  mutation: RecorderPressureMutation,
): void {
  if (mutation.kind === "clear") {
    memory.clear();
    return;
  }
  if (mutation.kind === "replace") {
    memory.observeLevels(mutation.levels, mutation.validThroughMs);
    return;
  }
  memory.updateLevels(mutation.changes, mutation.validThroughMs);
}
