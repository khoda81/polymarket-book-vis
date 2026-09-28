import { fromBinary } from "@bufbuild/protobuf";
import {
  RecorderStateResponseSchema,
  type PressureFrontierSnapshot as WirePressureFrontierSnapshot,
} from "../gen/polymarket_book_recorder/pressure/v7/recorder_state_pb";
import {
  parsePressureFrontierSnapshot,
  type PressureFrontierSnapshot,
} from "./pressureFrontierSnapshot";

interface RecorderStateResponse {
  recordingSinceMsByToken: Record<string, number>;
  states: Record<string, { pressure?: PressureFrontierSnapshot }>;
  pendingTokenIds: string[];
}

export interface RecorderHydration {
  readonly recordingSinceMsByToken: Readonly<Record<string, number>>;
  readonly pressureSnapshotsByToken: Readonly<
    Record<string, PressureFrontierSnapshot>
  >;
}

const RECORDER_FETCH_TIMEOUT_MS = 5_000;
const MAX_CONCURRENT_RECORDER_REQUESTS = 4;
const HYDRATION_RETRY_DELAYS_MS = [
  100, 250, 500, 1_000, 2_000, 4_000, 8_000,
] as const;

let activeRecorderRequests = 0;
const recorderRequestWaiters: Array<() => void> = [];
const RECORDER_DEBUG =
  new URLSearchParams(window.location.search).get("recorderDebug") === "1";

export async function fetchRecorderHydration(
  tokenIds: readonly string[],
): Promise<RecorderHydration> {
  const requested = [...new Set(tokenIds.filter(Boolean))];
  if (requested.length === 0) return emptyHydration();

  const recordingSinceMsByToken: Record<string, number> = {};
  const pressureSnapshotsByToken: Record<string, PressureFrontierSnapshot> = {};

  let remaining = requested;
  let lastError: unknown = null;

  recorderDebug("hydrate-start", requested.map(shortToken));

  for (let attempt = 0; ; attempt++) {
    try {
      const body = await fetchRecorderState(remaining);
      lastError = null;

      recorderDebug("hydrate-response", {
        attempt: attempt + 1,
        requested: remaining.map(shortToken),
        states: Object.keys(body.states).map(shortToken),
        pending: body.pendingTokenIds.map(shortToken),
        debug: body.debug,
      });

      mergeRecorderResponse(
        body,
        recordingSinceMsByToken,
        pressureSnapshotsByToken,
      );

      const explicitPending = new Set(
        Array.isArray(body.pendingTokenIds)
          ? body.pendingTokenIds.map(String)
          : [],
      );

      remaining = remaining.filter(
        (tokenId) =>
          pressureSnapshotsByToken[tokenId] === undefined &&
          explicitPending.has(tokenId),
      );
      if (remaining.length === 0) break;
    } catch (error) {
      lastError = error;
      recorderDebug("hydrate-error", {
        attempt: attempt + 1,
        requested: remaining.map(shortToken),
        error: debugError(error),
      });
    }

    const delayMs = HYDRATION_RETRY_DELAYS_MS[attempt];
    if (delayMs === undefined) break;
    await delay(delayMs);
  }

  if (lastError) console.warn("Age recorder unavailable", lastError);

  if (remaining.length > 0)
    recorderDebug("hydrate-gave-up", remaining.map(shortToken));
  else
    recorderDebug("hydrate-complete", {
      coverage: Object.keys(recordingSinceMsByToken).length,
      states: Object.keys(pressureSnapshotsByToken).length,
    });

  return {
    recordingSinceMsByToken,
    pressureSnapshotsByToken,
  };
}

async function fetchRecorderState(
  tokenIds: readonly string[],
): Promise<RecorderStateResponse> {
  const params = new URLSearchParams();
  for (const tokenId of tokenIds) params.append("tokenId", tokenId);
  if (RECORDER_DEBUG) params.set("debug", "1");

  return withRecorderRequestSlot(async () => {
    const startedAt = performance.now();
    const controller = new AbortController();
    const timeout = window.setTimeout(
      () => controller.abort(),
      RECORDER_FETCH_TIMEOUT_MS,
    );

    try {
      const response = await fetch(`/api/recorder/state?${params}`, {
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(`recorder returned ${response.status}`);
      const body = recorderStateFromProto(
        decodeRecorderStateResponse(
          new Uint8Array(await response.arrayBuffer()),
        ),
      );
      recorderDebug("state-http", {
        requested: tokenIds.length,
        ms: Math.round(performance.now() - startedAt),
        status: response.status,
      });
      return body;
    } catch (error) {
      recorderDebug("state-http-error", {
        requested: tokenIds.length,
        ms: Math.round(performance.now() - startedAt),
        error: debugError(error),
      });
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  });
}

function mergeRecorderResponse(
  body: RecorderStateResponse,
  recordingSinceMsByToken: Record<string, number>,
  pressureSnapshotsByToken: Record<string, PressureFrontierSnapshot>,
): void {
  for (const [tokenId, since] of Object.entries(body.recordingSinceMsByToken)) {
    if (typeof since === "number" && Number.isFinite(since))
      recordingSinceMsByToken[tokenId] = since;
  }

  for (const [tokenId, state] of Object.entries(body.states)) {
    if (state.pressure === undefined) continue;
    try {
      pressureSnapshotsByToken[tokenId] = parsePressureFrontierSnapshot(
        state.pressure,
      );
    } catch (error) {
      console.warn(
        `Ignoring malformed recorder pressure state for ${tokenId}`,
        error,
      );
    }
  }
}

function recorderStateFromProto(
  body: ReturnType<typeof decodeRecorderStateResponse>,
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

function decodeRecorderStateResponse(bytes: Uint8Array) {
  return fromBinary(RecorderStateResponseSchema, bytes);
}

function pressureSnapshotFromProto(
  snapshot: WirePressureFrontierSnapshot,
): PressureFrontierSnapshot {
  const state = snapshot.state;
  if (state.case === "unobserved")
    return {
      version: 7,
      state: { kind: "unobserved" },
    };

  if (state.case === "resolvedUnbounded")
    return {
      version: 7,
      state: { kind: "resolvedUnbounded" },
    };

  if (state.case !== "observed")
    throw new RangeError("protobuf pressure snapshot state is missing");

  const observed = state.value;
  if (observed.validThroughMs === undefined)
    throw new RangeError("protobuf observed pressure timestamp is missing");

  return parsePressureFrontierSnapshot({
    version: 7,
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

function emptyHydration(): RecorderHydration {
  return {
    recordingSinceMsByToken: {},
    pressureSnapshotsByToken: {},
  };
}

async function withRecorderRequestSlot<T>(task: () => Promise<T>): Promise<T> {
  if (activeRecorderRequests >= MAX_CONCURRENT_RECORDER_REQUESTS) {
    await new Promise<void>((resolve) => {
      recorderRequestWaiters.push(resolve);
    });
  }

  activeRecorderRequests++;
  try {
    return await task();
  } finally {
    activeRecorderRequests--;
    recorderRequestWaiters.shift()?.();
  }
}

function debugError(error: unknown): unknown {
  if (error instanceof DOMException || error instanceof Error)
    return {
      name: error.name,
      message: error.message,
      stack: error.stack,
    };
  return error;
}

function recorderDebug(...args: unknown[]): void {
  if (RECORDER_DEBUG) console.debug("[recorder:frontend]", ...args);
}

function shortToken(tokenId: string): string {
  return tokenId.length <= 12
    ? tokenId
    : `${tokenId.slice(0, 6)}…${tokenId.slice(-4)}`;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}
