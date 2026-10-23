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

const RECORDER_FETCH_TIMEOUT_MS = 5_000;
const MAX_CONCURRENT_RECORDER_REQUESTS = 4;
const HYDRATION_RETRY_DELAYS_MS = [
  100, 250, 500, 1_000, 2_000, 4_000, 8_000,
] as const;

let activeRecorderRequests = 0;
const recorderRequestWaiters: Array<() => void> = [];
const RECORDER_DEBUG =
  typeof window !== "undefined" &&
  new URLSearchParams(window.location.search).get("recorderDebug") === "1";

/** Report each recorder response through onProgress until no requested token is pending. */
export async function fetchRecorderHydration(
  tokenIds: readonly string[],
  onProgress: RecorderHydrationProgress = () => undefined,
  signal?: AbortSignal,
): Promise<void> {
  let remaining = [...new Set(tokenIds.filter(Boolean))];
  if (remaining.length === 0) return;

  let lastError: unknown = null;
  recorderDebug("hydrate-start", remaining.map(shortToken));

  for (let attempt = 0; ; attempt++) {
    if (signal?.aborted) break;

    try {
      const body = await fetchRecorderState(remaining, signal);
      lastError = null;

      recorderDebug("hydrate-response", {
        attempt: attempt + 1,
        requested: remaining.map(shortToken),
        states: Object.keys(body.states).map(shortToken),
        pending: body.pendingTokenIds.map(shortToken),
      });

      const progress = recorderProgress(body);
      if (hasHydration(progress)) onProgress(progress);

      const explicitPending = new Set(body.pendingTokenIds);
      remaining = remaining.filter(
        (tokenId) =>
          progress.pressureSnapshotsByToken[tokenId] === undefined &&
          explicitPending.has(tokenId),
      );
      if (remaining.length === 0) break;
    } catch (error) {
      if (signal?.aborted) {
        lastError = null;
        break;
      }
      lastError = error;
      recorderDebug("hydrate-error", {
        attempt: attempt + 1,
        requested: remaining.map(shortToken),
        error: debugError(error),
      });
    }

    const delayMs = HYDRATION_RETRY_DELAYS_MS[attempt];
    if (delayMs === undefined) break;
    await delay(delayMs, signal);
  }

  if (lastError) console.warn("Age recorder unavailable", lastError);
  if (remaining.length > 0)
    recorderDebug("hydrate-gave-up", remaining.map(shortToken));
  else recorderDebug("hydrate-complete");
}

async function fetchRecorderState(
  tokenIds: readonly string[],
  signal?: AbortSignal,
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
        signal: signal
          ? AbortSignal.any([signal, controller.signal])
          : controller.signal,
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
  }, signal);
}

function recorderProgress(body: RecorderStateResponse): RecorderHydration {
  const pressureSnapshotsByToken: Record<string, PressureFrontierSnapshot> = {};
  for (const [tokenId, state] of Object.entries(body.states))
    if (state.pressure !== undefined)
      pressureSnapshotsByToken[tokenId] = state.pressure;

  return {
    recordingSinceMsByToken: { ...body.recordingSinceMsByToken },
    pressureSnapshotsByToken,
  };
}

function hasHydration(hydration: RecorderHydration): boolean {
  return (
    Object.keys(hydration.recordingSinceMsByToken).length > 0 ||
    Object.keys(hydration.pressureSnapshotsByToken).length > 0
  );
}

async function withRecorderRequestSlot<T>(
  task: () => Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  signal?.throwIfAborted();
  if (activeRecorderRequests >= MAX_CONCURRENT_RECORDER_REQUESTS) {
    await new Promise<void>((resolve, reject) => {
      const release = () => {
        signal?.removeEventListener("abort", cancel);
        resolve();
      };
      const cancel = () => {
        const index = recorderRequestWaiters.indexOf(release);
        if (index >= 0) recorderRequestWaiters.splice(index, 1);
        reject(signal?.reason);
      };
      recorderRequestWaiters.push(release);
      signal?.addEventListener("abort", cancel, { once: true });
    });
  } else activeRecorderRequests++;
  try {
    signal?.throwIfAborted();
    return await task();
  } finally {
    const next = recorderRequestWaiters.shift();
    if (next) next();
    else activeRecorderRequests--;
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

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const finish = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", finish);
      resolve();
    };
    const timer = setTimeout(finish, ms);
    if (signal?.aborted) finish();
    else signal?.addEventListener("abort", finish, { once: true });
  });
}
