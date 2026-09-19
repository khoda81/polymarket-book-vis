import {
  parsePressureCells,
  rebasePressureCells,
  type PressureCell,
} from "./pressureMemory";

interface RecorderStateResponse {
  serverNowMs?: number;
  connected?: boolean;
  recordingSinceMsByToken?: Record<string, number>;
  states?: Record<string, { cells?: unknown }>;
  pendingTokenIds?: string[];
}

export interface RecorderHydration {
  /** Individual recorder coverage starts, keyed by token id. */
  readonly recordingSinceMsByToken: Readonly<Record<string, number>>;
  /** Layered pressure memory rebased onto the browser clock. */
  readonly pressureCellsByToken: Readonly<
    Record<string, readonly PressureCell[]>
  >;
}

const RECORDER_FETCH_TIMEOUT_MS = 1_500;
const HYDRATION_RETRY_DELAYS_MS = [100, 200, 400, 800, 1_200] as const;
const RECORDER_DEBUG =
  new URLSearchParams(window.location.search).get("recorderDebug") === "1";

/**
 * Register tokens with the recorder and hydrate ghost state.
 *
 * Registration and the recorder's first websocket snapshot are inherently
 * asynchronous. A successful HTTP response can therefore legitimately contain
 * no state yet. Retry that pending window here while live market startup
 * continues independently; callers intentionally do not await this before
 * opening their own live feed.
 */
export async function fetchRecorderHydration(
  tokenIds: readonly string[],
): Promise<RecorderHydration> {
  const requested = [...new Set(tokenIds.filter(Boolean))];
  if (requested.length === 0)
    return emptyHydration();

  const recordingSinceMsByToken: Record<string, number> = {};
  const pressureCellsByToken: Record<
    string,
    readonly PressureCell[]
  > = {};

  let remaining = requested;
  let lastError: unknown = null;

  recorderDebug(
    "hydrate-start",
    requested.map(shortToken),
  );

  for (let attempt = 0; ; attempt++) {
    try {
      const body = await fetchRecorderState(remaining);
      lastError = null;

      recorderDebug("hydrate-response", {
        attempt: attempt + 1,
        requested: remaining.map(shortToken),
        connected: body.connected,
        states: Object.keys(body.states ?? {}).map(shortToken),
        pending: (body.pendingTokenIds ?? []).map(shortToken),
        debug: body.debug,
      });

      mergeRecorderResponse(
        body,
        recordingSinceMsByToken,
        pressureCellsByToken,
      );

      const explicitPending = new Set(
        Array.isArray(body.pendingTokenIds)
          ? body.pendingTokenIds.map(String)
          : [],
      );

      remaining = remaining.filter((tokenId) => {
        if (pressureCellsByToken[tokenId]) return false;
        if (explicitPending.has(tokenId)) return true;

        // Backward compatibility with an older recorder: a token with claimed
        // coverage but no state is almost always in the registration→snapshot
        // race, so give it the same bounded retry treatment.
        return recordingSinceMsByToken[tokenId] !== undefined;
      });

      if (remaining.length === 0) break;
    } catch (error) {
      lastError = error;
      recorderDebug("hydrate-error", {
        attempt: attempt + 1,
        requested: remaining.map(shortToken),
        error,
      });
    }

    const delayMs = HYDRATION_RETRY_DELAYS_MS[attempt];
    if (delayMs === undefined) break;
    await delay(delayMs);
  }

  if (lastError)
    console.warn("Age recorder unavailable", lastError);

  if (remaining.length > 0)
    recorderDebug(
      "hydrate-gave-up",
      remaining.map(shortToken),
    );
  else
    recorderDebug("hydrate-complete", {
      coverage: Object.keys(recordingSinceMsByToken).length,
      states: Object.keys(pressureCellsByToken).length,
    });

  return {
    recordingSinceMsByToken,
    pressureCellsByToken,
  };
}

async function fetchRecorderState(
  tokenIds: readonly string[],
): Promise<RecorderStateResponse> {
  const params = new URLSearchParams();
  for (const tokenId of tokenIds) params.append("tokenId", tokenId);
  if (RECORDER_DEBUG) params.set("debug", "1");

  const controller = new AbortController();
  const timeout = window.setTimeout(
    () => controller.abort(),
    RECORDER_FETCH_TIMEOUT_MS,
  );

  try {
    const response = await fetch(`/api/recorder/state?${params}`, {
      signal: controller.signal,
    });
    if (!response.ok)
      throw new Error(`recorder returned ${response.status}`);
    return (await response.json()) as RecorderStateResponse;
  } finally {
    clearTimeout(timeout);
  }
}

function mergeRecorderResponse(
  body: RecorderStateResponse,
  recordingSinceMsByToken: Record<string, number>,
  pressureCellsByToken: Record<string, readonly PressureCell[]>,
): void {
  for (const [tokenId, since] of Object.entries(
    body.recordingSinceMsByToken ?? {},
  )) {
    if (typeof since === "number" && Number.isFinite(since))
      recordingSinceMsByToken[tokenId] = since;
  }

  const sourceNowMs =
    typeof body.serverNowMs === "number" &&
    Number.isFinite(body.serverNowMs)
      ? body.serverNowMs
      : Date.now();
  const targetNowMs = Date.now();

  for (const [tokenId, state] of Object.entries(body.states ?? {})) {
    try {
      pressureCellsByToken[tokenId] = rebasePressureCells(
        parsePressureCells(state.cells),
        sourceNowMs,
        targetNowMs,
      );
    } catch (error) {
      console.warn(
        `Ignoring malformed recorder pressure state for ${tokenId}`,
        error,
      );
    }
  }
}

function emptyHydration(): RecorderHydration {
  return {
    recordingSinceMsByToken: {},
    pressureCellsByToken: {},
  };
}

function recorderDebug(...args: unknown[]): void {
  if (RECORDER_DEBUG)
    console.debug("[recorder:frontend]", ...args);
}

function shortToken(tokenId: string): string {
  return tokenId.length <= 12
    ? tokenId
    : `${tokenId.slice(0, 6)}…${tokenId.slice(-4)}`;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}
