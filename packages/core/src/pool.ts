/**
 * Fixed-capacity object pool with a dense active list.
 *
 * The whole point is zero allocation during a frame. Every enemy, projectile,
 * gem, damage number and particle comes from one of these. GC stutter is the
 * number one cause of jank on mobile web, and jank in the first fifteen
 * seconds is what kills retention.
 *
 * Removal is swap-with-last (O(1)), so `active` order is not stable. Iterate
 * backwards when despawning mid-loop.
 */
export class Pool<T> {
  /** Dense array of live objects. Read directly in hot loops. */
  readonly active: T[] = [];
  private readonly free: T[] = [];
  private readonly reset: (item: T) => void;

  readonly capacity: number;

  /** Count of spawn() calls that failed because the pool was exhausted. */
  overflow = 0;

  constructor(capacity: number, factory: () => T, reset: (item: T) => void) {
    this.capacity = capacity;
    this.reset = reset;
    for (let i = 0; i < capacity; i++) this.free.push(factory());
  }

  get count(): number {
    return this.active.length;
  }

  /** Returns null when exhausted — callers must handle it, never allocate. */
  spawn(): T | null {
    const item = this.free.pop();
    if (item === undefined) {
      this.overflow++;
      return null;
    }
    this.reset(item);
    this.active.push(item);
    return item;
  }

  /** Despawn by index into `active`. Swap-remove, O(1). */
  despawnAt(index: number): void {
    const last = this.active.length - 1;
    const item = this.active[index]!;
    this.active[index] = this.active[last]!;
    this.active.pop();
    this.free.push(item);
  }

  clear(): void {
    for (let i = this.active.length - 1; i >= 0; i--) {
      this.free.push(this.active[i]!);
    }
    this.active.length = 0;
    this.overflow = 0;
  }
}
