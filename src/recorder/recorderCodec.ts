import { fromBinary } from "@bufbuild/protobuf";
import {
  RecorderStateResponseSchema,
  type RecorderStateResponse as RecorderStateResponseMessage,
  type PressureFrontierSnapshot as WirePressureFrontierSnapshot,
} from "../gen/polymarket_book_recorder/pressure/v8/recorder_state_pb";
import {
  parsePressureFrontierSnapshot,
  PRESSURE_FRONTIER_SNAPSHOT_VERSION,
  type PressureFrontierSnapshot,
} from "../domain/pressure/pressureFrontierSnapshot";

export interface RecorderStateResponse {
  recordingSinceMsByToken: Record<string, number>;
  states: Record<string, { pressure?: PressureFrontierSnapshot }>;
  pendingTokenIds: string[];
}

function recorderStateFromProto(
  body: RecorderStateResponseMessage,
): RecorderStateResponse {
  const recordingSinceMsByToken: Record<string, number> = {};
  for (const [tokenId, since] of Object.entries(body.recordingSinceMsByToken))
    recordingSinceMsByToken[tokenId] = timestampFromProto(
      since,
      "recordingSinceMsByToken",
    );

  const states: Record<string, { pressure?: PressureFrontierSnapshot }> = {};
  for (const [tokenId, state] of Object.entries(body.states)) {
    if (state.pressure === undefined) {
      states[tokenId] = {};
      continue;
    }
    states[tokenId] = { pressure: pressureSnapshotFromProto(state.pressure) };
  }

  return {
    recordingSinceMsByToken,
    states,
    pendingTokenIds: [...body.pendingTokenIds],
  };
}

export function decodeRecorderStateResponse(
  bytes: Uint8Array,
): RecorderStateResponse {
  return recorderStateFromProto(fromBinary(RecorderStateResponseSchema, bytes));
}

function pressureSnapshotFromProto(
  snapshot: WirePressureFrontierSnapshot,
): PressureFrontierSnapshot {
  const state = snapshot.state;
  if (state.case === "unobserved")
    return {
      version: PRESSURE_FRONTIER_SNAPSHOT_VERSION,
      state: { kind: "unobserved" },
    };

  if (state.case === "resolvedUnbounded")
    return {
      version: PRESSURE_FRONTIER_SNAPSHOT_VERSION,
      state: { kind: "resolvedUnbounded" },
    };

  if (state.case !== "observed")
    throw new RangeError("protobuf pressure snapshot state is missing");

  const observed = state.value;
  if (observed.validThroughMs === undefined)
    throw new RangeError("protobuf observed pressure timestamp is missing");

  return parsePressureFrontierSnapshot({
    version: PRESSURE_FRONTIER_SNAPSHOT_VERSION,
    state: {
      kind: "observed",
      validThroughMs: timestampFromProto(
        observed.validThroughMs,
        "pressure validThroughMs",
      ),
      runs: observed.runs.map((run) => ({
        price: run.price,
        shares: run.shares,
        frozenSteps: run.frozenSteps.map((step) => {
          if (step.validThroughMs === undefined)
            throw new RangeError(
              "protobuf frozen pressure timestamp is missing",
            );
          return {
            hiVolume: step.hiVolume,
            validThroughMs: timestampFromProto(
              step.validThroughMs,
              "frozen pressure validThroughMs",
            ),
          };
        }),
      })),
    },
  });
}

function timestampFromProto(value: bigint, label: string): number {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0)
    throw new RangeError(label + " must be a non-negative safe integer");
  return number;
}
