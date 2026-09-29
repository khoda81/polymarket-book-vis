<script lang="ts">
  import { onMount } from "svelte";
  import {
    liveBookCoordinator,
    type LiveBookNetworkState,
  } from "../chart/liveBookCoordinator";
  import {
    subscribeRecorderNetworkState,
    type RecorderNetworkState,
  } from "../lib/ageRecorderClient";
  import type { PublicClient } from "@polymarket/client";

  export let client: PublicClient;

  const EMPTY_LIVE_STATE: LiveBookNetworkState = {
    transport: "idle",
    desiredTokens: 0,
    subscribedTokens: 0,
    synchronizedBooks: 0,
    cachedBooks: 0,
    awaitingSnapshots: 0,
    refreshingTokens: 0,
    watchers: 0,
    coveredWatchers: 0,
    activeHandles: 0,
    reconciling: false,
    reconcileScheduled: false,
    revision: 0,
    retryAtMs: null,
  };

  const EMPTY_RECORDER_STATE: RecorderNetworkState = {
    activeHydrations: 0,
    pendingTokens: 0,
    activeRequests: 0,
    queuedRequests: 0,
    retryingHydrations: 0,
    maxAttempt: 0,
    nextRetryAtMs: null,
  };

  let live = EMPTY_LIVE_STATE;
  let recorder = EMPTY_RECORDER_STATE;
  let nowMs = Date.now();

  $: summary = summaryText(live, recorder, nowMs);
  $: tone = summaryTone(live, recorder);
  $: reconcileState = live.reconciling
    ? "running"
    : live.reconcileScheduled
      ? "scheduled"
      : "idle";
  $: liveRetry = retryText(live.retryAtMs, nowMs);
  $: recorderRetry = retryText(recorder.nextRetryAtMs, nowMs);

  onMount(() => {
    const unsubscribeLive = liveBookCoordinator(client).subscribeNetworkState(
      (state) => {
        live = state;
        nowMs = Date.now();
      },
    );
    const unsubscribeRecorder = subscribeRecorderNetworkState((state) => {
      recorder = state;
      nowMs = Date.now();
    });
    const clock = window.setInterval(() => {
      if (live.retryAtMs !== null || recorder.nextRetryAtMs !== null)
        nowMs = Date.now();
    }, 100);

    return () => {
      window.clearInterval(clock);
      unsubscribeLive();
      unsubscribeRecorder();
    };
  });

  function summaryText(
    liveState: LiveBookNetworkState,
    recorderState: RecorderNetworkState,
    now: number,
  ): string {
    const historySuffix =
      recorderState.activeHydrations > 0
        ? ` · history ${recorderState.pendingTokens} pending`
        : "";

    if (liveState.desiredTokens === 0) {
      if (recorderState.activeHydrations > 0)
        return `loading history · ${recorderState.pendingTokens} pending`;
      return liveState.transport === "closing"
        ? "closing stream"
        : "network idle";
    }

    if (liveState.transport === "retrying")
      return `retrying stream${retryText(liveState.retryAtMs, now)} · ${liveState.cachedBooks} cached${historySuffix}`;
    if (liveState.transport === "connecting")
      return `opening stream · ${liveState.desiredTokens} tokens${historySuffix}`;
    if (liveState.transport === "handoff")
      return `replacing stream · ${liveState.subscribedTokens}→${liveState.desiredTokens} tokens${historySuffix}`;
    if (liveState.transport === "closing")
      return `closing stream${historySuffix}`;

    if (liveState.synchronizedBooks < liveState.desiredTokens)
      return `stream open · ${liveState.synchronizedBooks}/${liveState.desiredTokens} books synchronized${historySuffix}`;

    return `stream synchronized · ${liveState.desiredTokens} books${historySuffix}`;
  }

  function summaryTone(
    liveState: LiveBookNetworkState,
    recorderState: RecorderNetworkState,
  ): "idle" | "working" | "good" {
    if (
      liveState.transport === "streaming" &&
      liveState.synchronizedBooks === liveState.desiredTokens &&
      recorderState.activeHydrations === 0
    )
      return "good";
    if (liveState.transport !== "idle" || recorderState.activeHydrations > 0)
      return "working";
    return "idle";
  }

  function retryText(retryAtMs: number | null, now: number): string {
    if (retryAtMs === null) return "";
    const remainingMs = Math.max(0, retryAtMs - now);
    if (remainingMs < 1_000) return ` in ${Math.ceil(remainingMs)}ms`;
    return ` in ${(remainingMs / 1_000).toFixed(1)}s`;
  }
</script>

<details class="network-state">
  <summary
    class:network-state--good={tone === "good"}
    class:network-state--working={tone === "working"}
    aria-label="Global networking state"
    title="Global live-book and recorder networking state"
  >
    <span class="network-state-dot" aria-hidden="true"></span>
    <span class="network-state-summary">{summary}</span>
  </summary>

  <div class="network-state-panel">
    <section>
      <h6>Live books</h6>
      <dl>
        <div>
          <dt>transport</dt>
          <dd>{live.transport}{liveRetry}</dd>
        </div>
        <div>
          <dt>subscription</dt>
          <dd>{live.subscribedTokens}/{live.desiredTokens} tokens</dd>
        </div>
        <div>
          <dt>snapshot barrier</dt>
          <dd>
            {live.synchronizedBooks}/{live.desiredTokens} synchronized · {live.awaitingSnapshots}
            awaiting · {live.cachedBooks} cached
          </dd>
        </div>
        <div>
          <dt>watch coverage</dt>
          <dd>{live.coveredWatchers}/{live.watchers} covered</dd>
        </div>
        <div>
          <dt>REST validation</dt>
          <dd>{live.refreshingTokens} tokens in flight</dd>
        </div>
        <div>
          <dt>stream handles</dt>
          <dd>{live.activeHandles}</dd>
        </div>
        <div>
          <dt>reconcile</dt>
          <dd>{reconcileState} · revision {live.revision}</dd>
        </div>
      </dl>
    </section>

    <section>
      <h6>Recorder history</h6>
      <dl>
        <div>
          <dt>hydrations</dt>
          <dd>{recorder.activeHydrations}</dd>
        </div>
        <div>
          <dt>pending</dt>
          <dd>{recorder.pendingTokens} tokens</dd>
        </div>
        <div>
          <dt>HTTP</dt>
          <dd>
            {recorder.activeRequests} active · {recorder.queuedRequests} queued
          </dd>
        </div>
        <div>
          <dt>retry</dt>
          <dd>
            {#if recorder.retryingHydrations > 0}
              {recorder.retryingHydrations} sleeping{recorderRetry}
              · attempt {recorder.maxAttempt}
            {:else}
              none
            {/if}
          </dd>
        </div>
      </dl>
    </section>
  </div>
</details>
