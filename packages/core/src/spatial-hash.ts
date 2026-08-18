/**
 * Uniform spatial hash for broad-phase overlap queries.
 *
 * Cleared and rebuilt every frame — that is cheaper than incremental updates
 * when nearly every entity moves, which in a swarm game they do. Turns the
 * naive O(n^2) enemy/projectile check into roughly O(n).
 *
 * Buckets are open-hashed into a flat power-of-two array rather than a Map,
 * to keep the hot path free of Map overhead and allocation. Two distinct
 * cells can therefore collide into one bucket: `query` may return candidates
 * that are not actually in range. Callers MUST do an exact distance check on
 * every candidate. That is true of any broad phase, so it costs nothing.
 */
export class SpatialHash {
  private readonly cellSize: number;
  private readonly invCell: number;
  private readonly mask: number;
  private readonly buckets: number[][];
  /** Buckets touched since the last clear, so we only reset what we used. */
  private readonly dirty: number[] = [];

  constructor(cellSize: number, bucketCount = 4096) {
    this.cellSize = cellSize;
    this.invCell = 1 / cellSize;
    // Round bucketCount up to a power of two so we can mask instead of modulo.
    let n = 1;
    while (n < bucketCount) n <<= 1;
    this.mask = n - 1;
    this.buckets = new Array(n);
    for (let i = 0; i < n; i++) this.buckets[i] = [];
  }

  private bucketIndex(cx: number, cy: number): number {
    // Two large primes keep neighbouring cells from clustering into one bucket.
    return (Math.imul(cx, 73856093) ^ Math.imul(cy, 19349663)) & this.mask;
  }

  clear(): void {
    for (let i = 0; i < this.dirty.length; i++) {
      this.buckets[this.dirty[i]!]!.length = 0;
    }
    this.dirty.length = 0;
  }

  insert(id: number, x: number, y: number): void {
    const cx = Math.floor(x * this.invCell);
    const cy = Math.floor(y * this.invCell);
    const b = this.bucketIndex(cx, cy);
    const bucket = this.buckets[b]!;
    if (bucket.length === 0) this.dirty.push(b);
    bucket.push(id);
  }

  /**
   * Collect candidate ids whose cell overlaps the circle (x, y, radius).
   * Writes into `out` and returns the count, so the caller can reuse one
   * scratch array forever and never allocate.
   */
  query(x: number, y: number, radius: number, out: number[]): number {
    const minX = Math.floor((x - radius) * this.invCell);
    const maxX = Math.floor((x + radius) * this.invCell);
    const minY = Math.floor((y - radius) * this.invCell);
    const maxY = Math.floor((y + radius) * this.invCell);

    let n = 0;
    for (let cy = minY; cy <= maxY; cy++) {
      for (let cx = minX; cx <= maxX; cx++) {
        const bucket = this.buckets[this.bucketIndex(cx, cy)]!;
        for (let i = 0; i < bucket.length; i++) {
          out[n++] = bucket[i]!;
        }
      }
    }
    return n;
  }
}
