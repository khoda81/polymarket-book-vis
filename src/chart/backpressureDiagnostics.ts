export const BACKPRESSURE_DEBUG =
  typeof window !== "undefined" &&
  new URLSearchParams(window.location.search).get("backpressureDebug") === "1";

const REPORT_INTERVAL_MS = 1_000;

export class FeedBackpressureDiagnostics {
  private reportStartedAt = performance.now();
  private events = 0;
  private workItems = 0;
  private readonly byType = new Map<string, number>();
  private lagSamples = 0;
  private latestLagMs = 0;
  private totalLagMs = 0;
  private maxLagMs = 0;
  private totalHandlerMs = 0;
  private maxHandlerMs = 0;

  constructor(private readonly label: string) {}

  observe(
    eventType: string,
    sourceLagMs: number | null,
    handlerMs: number,
    workItems = 1,
  ): void {
    if (!BACKPRESSURE_DEBUG) return;

    this.events++;
    this.workItems += workItems;
    this.byType.set(eventType, (this.byType.get(eventType) ?? 0) + 1);
    this.totalHandlerMs += handlerMs;
    this.maxHandlerMs = Math.max(this.maxHandlerMs, handlerMs);

    if (sourceLagMs !== null) {
      this.lagSamples++;
      this.latestLagMs = sourceLagMs;
      this.totalLagMs += sourceLagMs;
      this.maxLagMs = Math.max(this.maxLagMs, sourceLagMs);
    }

    const now = performance.now();
    const elapsedMs = now - this.reportStartedAt;
    if (elapsedMs < REPORT_INTERVAL_MS) return;

    const seconds = elapsedMs / 1_000;
    console.log(
      `[backpressure:feed] ${this.label} ${JSON.stringify({
        eventsPerSecond: round(this.events / seconds),
        workItemsPerSecond: round(this.workItems / seconds),
        byType: Object.fromEntries(
          [...this.byType].sort((a, b) => b[1] - a[1]),
        ),
        sourceLagMs:
          this.lagSamples === 0
            ? null
            : {
                latest: round(this.latestLagMs),
                average: round(this.totalLagMs / this.lagSamples),
                max: round(this.maxLagMs),
              },
        handlerMs: {
          average: round(this.totalHandlerMs / Math.max(1, this.events)),
          max: round(this.maxHandlerMs),
        },
      })}`,
    );

    this.reportStartedAt = now;
    this.events = 0;
    this.workItems = 0;
    this.byType.clear();
    this.lagSamples = 0;
    this.totalLagMs = 0;
    this.maxLagMs = 0;
    this.totalHandlerMs = 0;
    this.maxHandlerMs = 0;
  }
}

export class DrawBackpressureDiagnostics {
  private reportStartedAt = performance.now();
  private frames = 0;
  private totalMs = 0;
  private maxMs = 0;

  constructor(private readonly label: string) {}

  observe(durationMs: number): void {
    if (!BACKPRESSURE_DEBUG) return;

    this.frames++;
    this.totalMs += durationMs;
    this.maxMs = Math.max(this.maxMs, durationMs);

    const now = performance.now();
    const elapsedMs = now - this.reportStartedAt;
    if (elapsedMs < REPORT_INTERVAL_MS) return;

    console.log(
      `[backpressure:draw] ${this.label} ${JSON.stringify({
        framesPerSecond: round(this.frames / (elapsedMs / 1_000)),
        drawMs: {
          average: round(this.totalMs / Math.max(1, this.frames)),
          max: round(this.maxMs),
        },
      })}`,
    );

    this.reportStartedAt = now;
    this.frames = 0;
    this.totalMs = 0;
    this.maxMs = 0;
  }
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}
