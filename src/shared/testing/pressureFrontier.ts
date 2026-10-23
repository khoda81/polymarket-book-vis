import type { PressureBand } from "@/domain/pressure/pressureField";
import type { PressureFrontierMemory } from "@/domain/pressure/pressureFrontierMemory";
import type { PressureRun } from "@/domain/pressure/pressureFrontierSnapshot";
import { PRICE_ONE, PRICE_ZERO, type Price } from "@/domain/books/price";

/** Test inspection of a frontier through its canonical snapshot. */
function observedRuns(memory: PressureFrontierMemory) {
  const { state } = memory.snapshot();
  return state.kind === "observed" ? state : null;
}

export function priceBoundaries(memory: PressureFrontierMemory): Price[] {
  return observedRuns(memory)?.runs.map((run) => run.price) ?? [];
}

export function currentLevels(
  memory: PressureFrontierMemory,
): { price: Price; shares: number }[] {
  return (observedRuns(memory)?.runs ?? []).flatMap((run) =>
    run.shares > 0 ? [{ price: run.price, shares: run.shares }] : [],
  );
}

/** Every band of the run owning `price`, current pressure first. */
export function bandsAtPrice(
  memory: PressureFrontierMemory,
  price: Price,
): PressureBand[] {
  const observed = observedRuns(memory);
  if (!observed || price <= PRICE_ZERO || price > PRICE_ONE) return [];

  const { runs } = observed;
  let index = -1;
  let currentVolume = 0;
  for (let next = 0; next < runs.length && runs[next]!.price <= price; next++) {
    index = next;
    currentVolume += runs[next]!.shares;
  }
  if (index < 0) return [];
  return materializeBands(runs[index]!, currentVolume, observed.validThroughMs);
}

function materializeBands(
  run: PressureRun,
  currentVolume: number,
  currentValidThroughMs: number,
): PressureBand[] {
  const bands: {
    loVolume: number;
    hiVolume: number;
    validThroughMs: number;
  }[] = [];
  const append = (band: (typeof bands)[number]) => {
    const previous = bands.at(-1);
    if (previous && previous.validThroughMs === band.validThroughMs)
      previous.hiVolume = band.hiVolume;
    else bands.push(band);
  };

  if (currentVolume > 0)
    append({
      loVolume: 0,
      hiVolume: currentVolume,
      validThroughMs: currentValidThroughMs,
    });
  let lower = currentVolume;
  for (let index = run.frozenSteps.length - 1; index >= 0; index--) {
    const step = run.frozenSteps[index]!;
    append({
      loVolume: lower,
      hiVolume: step.hiVolume,
      validThroughMs: step.validThroughMs,
    });
    lower = step.hiVolume;
  }
  return bands;
}
