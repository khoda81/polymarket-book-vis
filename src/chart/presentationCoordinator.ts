export interface PresentationTarget {
  renderFrame(frameTimeMs: DOMHighResTimeStamp): void;
}

/**
 * One display-clock scheduler for a visualization scope.
 *
 * Updates only mark targets dirty. A single requestAnimationFrame callback
 * snapshots the dirty set and asks each target to render its newest retained
 * state once for that physical display opportunity.
 */
export class PresentationCoordinator {
  private readonly dirty = new Set<PresentationTarget>();
  private raf: number | null = null;

  invalidate(target: PresentationTarget): void {
    this.dirty.add(target);
    this.ensureFrame();
  }

  cancel(target: PresentationTarget): void {
    this.dirty.delete(target);
  }

  destroy(): void {
    if (this.raf !== null) cancelAnimationFrame(this.raf);
    this.raf = null;
    this.dirty.clear();
  }

  private ensureFrame(): void {
    if (this.raf !== null || this.dirty.size === 0) return;
    this.raf = requestAnimationFrame(this.flush);
  }

  private readonly flush = (frameTimeMs: DOMHighResTimeStamp): void => {
    this.raf = null;

    // Clear before rendering. If a target invalidates again while this frame is
    // being processed, it enters a fresh dirty set and is guaranteed another
    // frame rather than being lost in the batch we are consuming.
    const batch = [...this.dirty];
    this.dirty.clear();

    for (const target of batch) target.renderFrame(frameTimeMs);

    this.ensureFrame();
  };
}
