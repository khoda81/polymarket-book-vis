import type { PressureFrontierSnapshot } from "../domain/pressure/pressureFrontierSnapshot";
import {
  decodeRecorderStateResponse,
  type RecorderStateResponse,
} from "./recorderCodec";

export interface RecorderHydration {
  readonly recordingSinceMsByToken: Readonly<Record<string, number>>;
  readonly pressureSnapshotsByToken: Readonly<
    Record<string, PressureFrontierSnapshot>
  >;
}

export type RecorderHydrationProgress = (hydration: RecorderHydration) => void;

export interface RecorderNetworkState {
  readonly activeHydrations: number;
  readonly pendingTokens: number;
  readonly activeRequests: number;
  readonly queuedRequests: number;
  readonly retryingHydrations: number;
  readonly maxAttempt: number;
  readonly nextRetryAtMs: number | null;
}

export type RecorderNetworkSubscriber = (state: RecorderNetworkState) => void;

interface HydrationRunNetworkState {
  remaining: readonly string[];
  attempt: number;
  retryAtMs: number | null;
}

const RECORDER_FETCH_TIMEOUT_MS = 5_000;
const MAX_CONCURRENT_RECORDER_REQUESTS = 4;
const HYDRATION_RETRY_DELAYS_MS = [
  100, 250, 500, 1_000, 2_000, 4_000, 8_000,
] as const;

let activeRecorderRequests = 0;
const recorderRequestWaiters: Array<() => void> = [];
let nextHydrationRunId = 0;
const hydrationRuns = new Map<number, HydrationRunNetworkState>();
const recorderNetworkSubscribers = new Set<RecorderNetworkSubscriber>();
const RECORDER_DEBUG =
  new URLSearchParams(window.location.search).get("recorderDebug") === "1";

export async function fetchRecorderHydration(
  tokenIds: readonly string[],
  onProgress: RecorderHydrationProgress = () => undefined,
): Promise<RecorderHydration> {
  const requested = [...new Set(tokenIds.filter(Boolean))];
  if (requested.length === 0) return emptyHydration();

  const recordingSinceMsByToken: Record<string, number> = {};
  const pressureSnapshotsByToken: Record<string, PressureFrontierSnapshot> = {};

  let lastError: unknown = null;
  const runId = ++nextHydrationRunId;
  const run: HydrationRunNetworkState = {
    remaining: requested,
    attempt: 0,
    retryAtMs: null,
  };
  hydrationRuns.set(runId, run);
  emitRecorderNetworkState();

  recorderDebug("hydrate-start", requested.map(shortToken));

  try {
    for (let attempt = 0; ; attempt++) {
      run.attempt = attempt + 1;
      run.retryAtMs = null;
      emitRecorderNetworkState();

      try {
        const body = await fetchRecorderState(run.remaining);
        lastError = null;

        recorderDebug("hydrate-response", {
          attempt: attempt + 1,
          requested: run.remaining.map(shortToken),
          states: Object.keys(body.states).map(shortToken),
          pending: body.pendingTokenIds.map(shortToken),
        });

        const progress = mergeRecorderResponse(
          body,
          recordingSinceMsByToken,
          pressureSnapshotsByToken,
        );
        if (hasHydration(progress)) onProgress(progress);

        const explicitPending = new Set(body.pendingTokenIds);

        run.remaining = run.remaining.filter(
          (tokenId) =>
            pressureSnapshotsByToken[tokenId] === undefined &&
            explicitPending.has(tokenId),
        );
        emitRecorderNetworkState();
        if (run.remaining.length === 0) break;
      } catch (error) {
        lastError = error;
        recorderDebug("hydrate-error", {
          attempt: attempt + 1,
          requested: run.remaining.map(shortToken),
          error: debugError(error),
        });
      }

      const delayMs = HYDRATION_RETRY_DELAYS_MS[attempt];
      if (delayMs === undefined) break;
      run.retryAtMs = Date.now() + delayMs;
      emitRecorderNetworkState();
      await delay(delayMs);
    }

    if (lastError) console.warn("Age recorder unavailable", lastError);

    if (run.remaining.length > 0)
      recorderDebug("hydrate-gave-up", run.remaining.map(shortToken));
    else
      recorderDebug("hydrate-complete", {
        coverage: Object.keys(recordingSinceMsByToken).length,
        states: Object.keys(pressureSnapshotsByToken).length,
      });

    return {
      recordingSinceMsByToken,
      pressureSnapshotsByToken,
    };
  } finally {
    hydrationRuns.delete(runId);
    emitRecorderNetworkState();
  }
}

async function fetchRecorderState(
  tokenIds: readonly string[],
): Promise<RecorderStateResponse> {
  const params = new URLSearchParams();
  for (const tokenId of tokenIds) params.append("tokenId", tokenId);

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
      const body = decodeRecorderStateResponse(
        new Uint8Array(await response.arrayBuffer()),
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
): RecorderHydration {
  const progressRecordingSinceMsByToken: Record<string, number> = {};
  const progressPressureSnapshotsByToken: Record<
    string,
    PressureFrontierSnapshot
  > = {};

  for (const [tokenId, since] of Object.entries(body.recordingSinceMsByToken)) {
    recordingSinceMsByToken[tokenId] = since;
    progressRecordingSinceMsByToken[tokenId] = since;
  }

  for (const [tokenId, state] of Object.entries(body.states)) {
    if (state.pressure === undefined) continue;
    pressureSnapshotsByToken[tokenId] = state.pressure;
    progressPressureSnapshotsByToken[tokenId] = state.pressure;
  }

  return {
    recordingSinceMsByToken: progressRecordingSinceMsByToken,
    pressureSnapshotsByToken: progressPressureSnapshotsByToken,
  };
}

function hasHydration(hydration: RecorderHydration): boolean {
  return (
    Object.keys(hydration.recordingSinceMsByToken).length > 0 ||
    Object.keys(hydration.pressureSnapshotsByToken).length > 0
  );
}

function emptyHydration(): RecorderHydration {
  return {
    recordingSinceMsByToken: {},
    pressureSnapshotsByToken: {},
  };
}

export function subscribeRecorderNetworkState(
  subscriber: RecorderNetworkSubscriber,
): () => void {
  recorderNetworkSubscribers.add(subscriber);
  subscriber(recorderNetworkState());
  return () => {
    recorderNetworkSubscribers.delete(subscriber);
  };
}

function recorderNetworkState(): RecorderNetworkState {
  const pending = new Set<string>();
  let retryingHydrations = 0;
  let maxAttempt = 0;
  let nextRetryAtMs: number | null = null;

  for (const run of hydrationRuns.values()) {
    for (const tokenId of run.remaining) pending.add(tokenId);
    maxAttempt = Math.max(maxAttempt, run.attempt);
    if (run.retryAtMs === null) continue;
    retryingHydrations++;
    nextRetryAtMs =
      nextRetryAtMs === null
        ? run.retryAtMs
        : Math.min(nextRetryAtMs, run.retryAtMs);
  }

  return {
    activeHydrations: hydrationRuns.size,
    pendingTokens: pending.size,
    activeRequests: activeRecorderRequests,
    queuedRequests: recorderRequestWaiters.length,
    retryingHydrations,
    maxAttempt,
    nextRetryAtMs,
  };
}

function emitRecorderNetworkState(): void {
  if (recorderNetworkSubscribers.size === 0) return;
  const state = recorderNetworkState();
  for (const subscriber of [...recorderNetworkSubscribers]) {
    try {
      subscriber(state);
    } catch (error) {
      console.error("Recorder network subscriber failed", error);
    }
  }
}

async function withRecorderRequestSlot<T>(task: () => Promise<T>): Promise<T> {
  if (activeRecorderRequests >= MAX_CONCURRENT_RECORDER_REQUESTS) {
    await new Promise<void>((resolve) => {
      recorderRequestWaiters.push(resolve);
      emitRecorderNetworkState();
    });
  }

  activeRecorderRequests++;
  emitRecorderNetworkState();
  try {
    return await task();
  } finally {
    activeRecorderRequests--;
    recorderRequestWaiters.shift()?.();
    emitRecorderNetworkState();
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
