export type WallClockUpdate = (nowMs: number) => number | null;

export interface WallClockWatch {
  refresh(): void;
  destroy(): void;
}

interface ClockJob {
  readonly update: WallClockUpdate;
  nextAtMs: number | null;
}

/** Wall-time displays retain absolute deadlines, independent of browser timers. */
export class WallClock {
  private readonly jobs = new Set<ClockJob>();
  private nextAtMs = Infinity;

  constructor(private currentMs = Date.now()) {}

  get nowMs(): number {
    return this.currentMs;
  }

  /** The callback renders once and returns its next absolute deadline, or null. */
  watch(update: WallClockUpdate): WallClockWatch {
    const job: ClockJob = { update, nextAtMs: null };
    this.jobs.add(job);
    this.refresh(job);
    return {
      refresh: () => this.refresh(job),
      destroy: () => this.jobs.delete(job),
    };
  }

  tick(nowMs: number): void {
    const movedBackwards = nowMs < this.currentMs;
    this.currentMs = nowMs;
    if (!movedBackwards && nowMs < this.nextAtMs) return;

    this.nextAtMs = Infinity;
    // Snapshot membership: newly registered jobs have already rendered, and a
    // job removed by an earlier callback must not run from this batch.
    for (const job of [...this.jobs]) {
      if (!this.jobs.has(job)) continue;
      if (movedBackwards || (job.nextAtMs !== null && job.nextAtMs <= nowMs))
        this.refresh(job);
      this.retainDeadline(job);
    }
  }

  private refresh(job: ClockJob): void {
    if (!this.jobs.has(job)) return;
    job.nextAtMs = null;
    try {
      job.nextAtMs = job.update(this.currentMs);
    } catch (error) {
      console.error("Wall-clock display update failed", error);
    }
    this.retainDeadline(job);
  }

  private retainDeadline(job: ClockJob): void {
    if (this.jobs.has(job) && job.nextAtMs !== null)
      this.nextAtMs = Math.min(this.nextAtMs, job.nextAtMs);
  }
}

export interface WallClockFrames {
  readonly now: () => number;
  readonly request: (callback: FrameRequestCallback) => number;
  readonly cancel: (id: number) => void;
}

/** One wall-time sample per visible frame; hidden tabs pause the browser's rAF. */
export function startWallClock(
  clock: WallClock,
  frames: WallClockFrames = {
    now: Date.now,
    request: (callback) => requestAnimationFrame(callback),
    cancel: (id) => cancelAnimationFrame(id),
  },
): () => void {
  let stopped = false;
  let pending: number | null = null;
  const frame = () => {
    pending = null;
    clock.tick(frames.now());
    if (!stopped) pending = frames.request(frame);
  };
  pending = frames.request(frame);
  return () => {
    stopped = true;
    if (pending !== null) frames.cancel(pending);
  };
}
