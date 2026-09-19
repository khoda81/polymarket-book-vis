<script lang="ts">
  import { onMount } from "svelte";
  import {
    AGE_ROW_BAND_PX,
    getAgeStripTuning,
    subscribeAgeStripTuning,
    type AgeStripTuning,
  } from "../lib/ageStripTuning";
  import { fmtRelativeTime, fmtSI } from "../lib/math";
  import {
    DEFAULT_SIGNED_VOLUME_COLOR_SCALE,
    signedVolumeColor,
  } from "../lib/signedVolume";

  const MIN_TICK_DISTANCE_PX = 48;
  const NICE_TICK_FAMILIES = [1, 5, 2] as const;
  const TICK_EXPONENT_RADIUS = 12;

  let bar: HTMLDivElement;
  let width = 0;
  let tuning: Readonly<AgeStripTuning> = getAgeStripTuning();

  $: reserveShares = tuning.volumePerCssPixel * AGE_ROW_BAND_PX;
  $: ghostHalfLife = fmtRelativeTime(
    tuning.ghostHalfLifeMs / 1000,
  );
  $: ghostTicks = [0, 1, 2, 3, 4].map((halves) => ({
    halves,
    position: (1 - 2 ** -halves) * 100,
    label:
      halves === 0
        ? "now"
        : fmtRelativeTime(
            (tuning.ghostHalfLifeMs * halves) / 1000,
          ),
  }));
  $: values = shareLegendTickValues(reserveShares, width);
  $: negativeColor = signedVolumeColor(
    -1,
    DEFAULT_SIGNED_VOLUME_COLOR_SCALE,
  );
  $: positiveColor = signedVolumeColor(
    1,
    DEFAULT_SIGNED_VOLUME_COLOR_SCALE,
  );

  function shareLegendPosition(value: number, reserve: number): number {
    if (!(reserve > 0) || !Number.isFinite(reserve)) return 0.5;
    if (Number.isNaN(value) || value === 0) return 0.5;
    const signed = Number.isFinite(value)
      ? value / (Math.abs(value) + reserve)
      : Math.sign(value);
    return 0.5 + 0.5 * signed;
  }

  function shareLegendTickValues(
    reserve: number,
    widthPx: number,
  ): number[] {
    if (!(reserve > 0) || !Number.isFinite(reserve)) return [0];
    if (!(widthPx > 0) || !Number.isFinite(widthPx)) return [0];

    const edgePadding = MIN_TICK_DISTANCE_PX / 2;
    const selected: { value: number; x: number }[] = [
      { value: 0, x: widthPx / 2 },
    ];
    const maxSigned = Math.max(
      0,
      Math.min(
        1 - Number.EPSILON,
        1 - (2 * edgePadding) / widthPx,
      ),
    );
    if (!(maxSigned > 0)) return [0];

    const maxMagnitude = (reserve * maxSigned) / (1 - maxSigned);
    const baseExponent = Math.floor(Math.log10(maxMagnitude));

    for (const multiplier of NICE_TICK_FAMILIES) {
      const magnitudes = Array.from(
        { length: TICK_EXPONENT_RADIUS * 2 + 1 },
        (_, index) =>
          multiplier *
          10 ** (baseExponent - TICK_EXPONENT_RADIUS + index),
      )
        .filter((value) => value > 0 && value <= maxMagnitude)
        .sort((a, b) => b - a);

      for (const magnitude of magnitudes) {
        const pair = [-magnitude, magnitude].map((value) => ({
          value,
          x: shareLegendPosition(value, reserve) * widthPx,
        }));

        if (
          pair.some(
            ({ x }) => x < edgePadding || x > widthPx - edgePadding,
          ) ||
          Math.abs(pair[1]!.x - pair[0]!.x) < MIN_TICK_DISTANCE_PX
        )
          continue;

        if (
          pair.every(({ x }) =>
            selected.every(
              (tick) =>
                Math.abs(x - tick.x) >= MIN_TICK_DISTANCE_PX,
            ),
          )
        )
          selected.push(...pair);
      }
    }

    return selected
      .sort((a, b) => a.value - b.value)
      .map(({ value }) => value);
  }

  function formatTick(value: number): string {
    if (Object.is(value, -0) || value === 0) return "0";
    return `${value > 0 ? "+" : "−"}${fmtSI(Math.abs(value))}`;
  }

  onMount(() => {
    const unsubscribe = subscribeAgeStripTuning((next) => {
      tuning = next;
    });
    const observer = new ResizeObserver(() => {
      width = bar.clientWidth;
    });
    observer.observe(bar);
    width = bar.clientWidth;

    return () => {
      observer.disconnect();
      unsubscribe();
    };
  });
</script>

<section class="volume-legend" aria-label="Global signed-share pressure scale">
  <div class="volume-legend-header">
    <span>Share pressure</span>
    <span class="volume-legend-scale">
      reserve {fmtSI(reserveShares)} shares · Q=C → 50% row
    </span>
  </div>
  <div
    class="volume-legend-bar"
    bind:this={bar}
    aria-hidden="true"
    style:--negative-pressure-color={negativeColor}
    style:--positive-pressure-color={positiveColor}
  >
    <span class="volume-legend-wedge volume-legend-wedge--negative"></span>
    <span class="volume-legend-wedge volume-legend-wedge--positive"></span>
  </div>
  <div class="volume-legend-ticks">
    {#each values as value (value)}
      <span
        style:left={`${shareLegendPosition(value, reserveShares) * 100}%`}
      >
        {formatTick(value)}
      </span>
    {/each}
  </div>

  <div class="ghost-legend-header">
    <span>Ghost memory</span>
    <span>half-life {ghostHalfLife} · Shift+wheel</span>
  </div>
  <div class="ghost-legend-bar" aria-hidden="true"></div>
  <div class="ghost-legend-ticks">
    {#each ghostTicks as tick (tick.halves)}
      <span style:left={`${tick.position}%`}>
        {tick.label}
      </span>
    {/each}
  </div>
</section>
