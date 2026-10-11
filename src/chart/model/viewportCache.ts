/** Bounded, dashboard-local retention of recently viewed CPU chart data. */
export class ViewportCache {
  private readonly entries = new Map<
    object,
    { readonly weight: number; readonly evict: () => void }
  >();
  private weight = 0;

  constructor(
    private readonly maxEntries = 8,
    private readonly maxWeight = 100_000,
  ) {}

  forget(owner: object): void {
    const entry = this.entries.get(owner);
    if (!entry) return;
    this.weight -= entry.weight;
    this.entries.delete(owner);
  }

  retain(owner: object, weight: number, evict: () => void): void {
    this.forget(owner);
    this.entries.set(owner, { weight, evict });
    this.weight += weight;
    while (
      this.entries.size > this.maxEntries ||
      this.weight > this.maxWeight
    ) {
      const oldest = this.entries.entries().next().value!;
      this.forget(oldest[0]);
      oldest[1].evict();
    }
  }
}
