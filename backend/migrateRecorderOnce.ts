import { Database } from "bun:sqlite";
import { copyFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import { PressureFrontierMemory } from "../src/lib/pressureFrontierMemory";
import { parsePressureFrontierSnapshot } from "../src/lib/pressureFrontierSnapshot";
import { priceFromLegacyNumber, priceFromTicks } from "../src/lib/price";

interface LegacyRow {
  token_id: string;
  status: "watched" | "completed";
  recording_since_ms: number | null;
  cells_json: string | Uint8Array | null;
  saved_at_ms: number;
}

interface MigratedRow {
  tokenId: string;
  status: "watched" | "completed";
  recordingSinceMs: number | null;
  pressure: unknown | null;
}

const DATABASE_PATH = resolve(
  process.env.RECORDER_DB_PATH ?? ".data/age-recorder.sqlite",
);

if (import.meta.main) migrateRecorderDatabase(DATABASE_PATH);

export function migrateRecorderDatabase(path: string): void {
  if (!existsSync(path)) throw new Error(`Recorder database not found: ${path}`);

  let db = openDatabase(path);
  const columns = tableColumns(db, "token_state");

  if (columns.has("pressure") && !columns.has("cells_json")) {
    db.close();
    console.log("Recorder database already uses the new pressure schema.");
    return;
  }
  if (!columns.has("cells_json") || !columns.has("saved_at_ms")) {
    db.close();
    throw new Error(
      `Unsupported token_state schema: ${[...columns].sort().join(", ")}`,
    );
  }

  const rows = db
    .query<LegacyRow, []>(
      `SELECT token_id, status, recording_since_ms, cells_json, saved_at_ms
       FROM token_state`,
    )
    .all();

  const formatCounts = new Map<string, number>();
  const migrated: MigratedRow[] = rows.map((row) => {
    if (row.cells_json === null) {
      increment(formatCounts, "empty");
      return {
        tokenId: row.token_id,
        status: row.status,
        recordingSinceMs: row.recording_since_ms,
        pressure: null,
      };
    }

    const raw = decodeJson(row.cells_json);
    const format = legacyFormat(raw);
    increment(formatCounts, format);

    const pressure = migratePressureSnapshot(raw, Number(row.saved_at_ms));
    // Validate the exact representation and invariants the new recorder loads.
    const parsed = parsePressureFrontierSnapshot(pressure);
    new PressureFrontierMemory().restore(parsed);

    return {
      tokenId: row.token_id,
      status: row.status,
      recordingSinceMs: row.recording_since_ms,
      pressure,
    };
  });

  console.log(
    `Validated ${migrated.length} recorder rows: ${[...formatCounts]
      .map(([format, count]) => `${format}=${count}`)
      .join(", ")}`,
  );

  // Flush WAL pages, close the database, then copy a standalone backup before
  // touching the schema.
  db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  db.close();

  const backupPath = `${path}.pre-valid-through-${Date.now()}.bak`;
  copyFileSync(path, backupPath);
  console.log(`Backup: ${backupPath}`);

  db = openDatabase(path);
  try {
    const migrate = db.transaction((batch: readonly MigratedRow[]) => {
      db.exec(`
        DROP TABLE IF EXISTS token_state_new;
        CREATE TABLE token_state_new (
          token_id TEXT PRIMARY KEY,
          status TEXT NOT NULL CHECK (status IN ('watched', 'completed')),
          recording_since_ms INTEGER,
          pressure BLOB
        ) WITHOUT ROWID;
      `);

      const insert = db.prepare(
        `INSERT INTO token_state_new
         (token_id, status, recording_since_ms, pressure)
         VALUES (?, ?, ?, ?)`,
      );

      for (const row of batch)
        insert.run(
          row.tokenId,
          row.status,
          row.recordingSinceMs,
          row.pressure === null
            ? null
            : gzipSync(JSON.stringify(row.pressure), { level: 1 }),
        );

      db.exec(`
        DROP TABLE token_state;
        ALTER TABLE token_state_new RENAME TO token_state;
        CREATE INDEX token_state_status_idx ON token_state(status);
        PRAGMA user_version = 2;
      `);
    });

    migrate(migrated);
    db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  } finally {
    db.close();
  }

  console.log(`Migrated ${migrated.length} recorder rows successfully.`);
}

function migratePressureSnapshot(value: unknown, savedAtMs: number): unknown {
  if (!Number.isFinite(savedAtMs))
    throw new RangeError("legacy recorder saved_at_ms must be finite");
  if (!isRecord(value))
    throw new TypeError("legacy pressure snapshot must be an object");

  if (value.version === 3)
    return migrateFrontierSnapshot(value, savedAtMs, false);
  if (value.version === 2)
    return migrateFrontierSnapshot(value, savedAtMs, true);

  // Makes the command safely re-runnable if a new-format snapshot happened to
  // be stored under the old column name.
  if (value.version === undefined) return parsePressureFrontierSnapshot(value);

  throw new TypeError(`Unsupported pressure snapshot version: ${String(value.version)}`);
}

function migrateFrontierSnapshot(
  value: Record<string, unknown>,
  savedAtMs: number,
  legacyPrices: boolean,
): unknown {
  const price = legacyPrices
    ? (raw: unknown) =>
        priceFromLegacyNumber(finiteNumber(raw, "legacy price"))
    : (raw: unknown) => priceFromTicks(finiteNumber(raw, "price ticks"));

  return {
    bid: migrateSide(value.bid, price, "bid"),
    ask: migrateSide(value.ask, price, "ask"),
    field: migrateField(value.field, savedAtMs, price),
  };
}

function migrateSide(
  value: unknown,
  price: (value: unknown) => number,
  label: string,
): unknown {
  if (!isRecord(value) || !Array.isArray(value.current))
    throw new TypeError(`legacy ${label} side is malformed`);

  return {
    current: value.current.map((raw, index) => {
      if (!isRecord(raw))
        throw new TypeError(`legacy ${label}.current[${index}] is malformed`);
      return {
        key: price(raw.key),
        weight: positiveNumber(
          raw.weight,
          `legacy ${label}.current[${index}].weight`,
        ),
      };
    }),
  };
}

function migrateField(
  value: unknown,
  savedAtMs: number,
  price: (value: unknown) => number,
): unknown {
  if (!isRecord(value) || !Array.isArray(value.runs))
    throw new TypeError("legacy pressure field is malformed");

  return {
    revision: nonNegativeNumber(value.revision, "legacy field revision"),
    runs: value.runs.map((raw, runIndex) => {
      if (!isRecord(raw) || !Array.isArray(raw.bands))
        throw new TypeError(`legacy field run[${runIndex}] is malformed`);

      return {
        lo: price(raw.lo),
        hi: price(raw.hi),
        bidVolume: nonNegativeNumber(
          raw.bidVolume,
          `run[${runIndex}].bidVolume`,
        ),
        askVolume: nonNegativeNumber(
          raw.askVolume,
          `run[${runIndex}].askVolume`,
        ),
        bidRevision: nonNegativeNumber(
          raw.bidRevision,
          `run[${runIndex}].bidRevision`,
        ),
        askRevision: nonNegativeNumber(
          raw.askRevision,
          `run[${runIndex}].askRevision`,
        ),
        bands: raw.bands.map((band, bandIndex) =>
          migrateBand(
            band,
            savedAtMs,
            `run[${runIndex}].bands[${bandIndex}]`,
          ),
        ),
      };
    }),
  };
}

function migrateBand(
  value: unknown,
  savedAtMs: number,
  label: string,
): unknown {
  if (!isRecord(value) || !isRecord(value.state))
    throw new TypeError(`${label} is malformed`);
  if (value.side !== -1 && value.side !== 1)
    throw new RangeError(`${label}.side must be -1 or 1`);

  const validThroughMs =
    value.state.kind === "live"
      ? savedAtMs
      : value.state.kind === "ghost"
        ? finiteNumber(value.state.sinceMs, `${label}.state.sinceMs`)
        : (() => {
            throw new RangeError(`${label}.state.kind is unsupported`);
          })();

  return {
    loVolume: nonNegativeNumber(value.loVolume, `${label}.loVolume`),
    hiVolume: positiveNumber(value.hiVolume, `${label}.hiVolume`),
    side: value.side,
    validThroughMs,
  };
}

function legacyFormat(value: unknown): string {
  if (!isRecord(value)) return "unknown";
  return value.version === undefined ? "current" : `v${String(value.version)}`;
}

function decodeJson(value: string | Uint8Array): unknown {
  const json =
    typeof value === "string" ? value : gunzipSync(value).toString("utf8");
  return JSON.parse(json);
}

function openDatabase(path: string): Database {
  const db = new Database(path);
  db.exec("PRAGMA busy_timeout = 5000");
  return db;
}

function tableColumns(db: Database, table: string): Set<string> {
  return new Set(
    db
      .query<{ name: string }, []>(`PRAGMA table_info(${table})`)
      .all()
      .map((row) => row.name),
  );
}

function increment(counts: Map<string, number>, key: string): void {
  counts.set(key, (counts.get(key) ?? 0) + 1);
}

function finiteNumber(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value))
    throw new RangeError(`${label} must be finite`);
  return value;
}

function nonNegativeNumber(value: unknown, label: string): number {
  const number = finiteNumber(value, label);
  if (number < 0) throw new RangeError(`${label} must be non-negative`);
  return number;
}

function positiveNumber(value: unknown, label: string): number {
  const number = finiteNumber(value, label);
  if (!(number > 0)) throw new RangeError(`${label} must be positive`);
  return number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
