import type { FrontierLevel } from "../src/lib/monotoneFrontier";
import {
  PressureFrontierMemory,
  type PressureLevelChange,
} from "../src/lib/pressureFrontierMemory";
import { priceFromTicks } from "../src/lib/price";

const MUTATION_CLEAR = 0;
const MUTATION_REPLACE = 1;
const MUTATION_UPDATE = 2;
const MUTATION_HEADER_BYTES = 11;
const MUTATION_LEVEL_BYTES = 10;

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

export function encodePressureMutation(
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

export function decodePressureMutation(
  value: Uint8Array,
): RecorderPressureMutation {
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

export function replayPressureMutation(
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
  memory.observeThrough(mutation.validThroughMs);
}
