export interface DirtyTokenVersion {
  readonly tokenId: string;
  readonly generation: number;
}

/**
 * Tracks recorder write-back generations.
 *
 * A flush acknowledges exactly the state it serialized. If the token changes
 * before that acknowledgement, the newer generation remains dirty instead of
 * being accidentally cleared or redundantly re-added.
 */
export class DirtyTokenTracker {
  private generation = 0;
  private readonly dirty = new Map<string, number>();

  get size(): number {
    return this.dirty.size;
  }

  mark(tokenIds: Iterable<string>): void {
    for (const tokenId of tokenIds) {
      if (!tokenId) continue;
      this.dirty.set(tokenId, ++this.generation);
    }
  }

  tokenIds(): string[] {
    return [...this.dirty.keys()];
  }

  capture(tokenIds: readonly string[]): DirtyTokenVersion[] {
    return tokenIds.flatMap((tokenId) => {
      const generation = this.dirty.get(tokenId);
      return generation === undefined ? [] : [{ tokenId, generation }];
    });
  }

  acknowledge(versions: readonly DirtyTokenVersion[]): void {
    for (const { tokenId, generation } of versions)
      if (this.dirty.get(tokenId) === generation) this.dirty.delete(tokenId);
  }
}
