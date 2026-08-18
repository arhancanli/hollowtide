/**
 * Deterministic PRNG (mulberry32).
 *
 * The whole simulation must be a pure function of (seed, input sequence).
 * That buys us replay validation for leaderboards, ghost/async multiplayer,
 * reproducible bug reports, and a headless balance runner.
 *
 * Rule: `Math.random()` must never appear inside sim code. Only this.
 */
export class Rng {
  private s: number;

  constructor(seed: number) {
    // Guard against seed 0, which degenerates.
    this.s = (seed >>> 0) || 0x9e3779b9;
  }

  /** Raw state, so a run can be snapshotted / resumed mid-flight. */
  get state(): number {
    return this.s;
  }

  set state(v: number) {
    this.s = v >>> 0;
  }

  /** [0, 1) */
  next(): number {
    this.s = (this.s + 0x6d2b79f5) | 0;
    let t = this.s;
    t = Math.imul(t ^ (t >>> 15), 1 | t);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  /** [min, max) */
  range(min: number, max: number): number {
    return min + this.next() * (max - min);
  }

  /** Integer in [0, n) */
  int(n: number): number {
    return (this.next() * n) | 0;
  }

  /** Radians in [0, 2pi) */
  angle(): number {
    return this.next() * Math.PI * 2;
  }

  pick<T>(arr: readonly T[]): T {
    return arr[this.int(arr.length)]!;
  }

  chance(p: number): boolean {
    return this.next() < p;
  }

  /**
   * Fisher-Yates over a copy. Used for upgrade card draws, where we need
   * distinct picks rather than independent samples.
   */
  sample<T>(arr: readonly T[], count: number): T[] {
    const pool = arr.slice();
    const n = Math.min(count, pool.length);
    for (let i = 0; i < n; i++) {
      const j = i + this.int(pool.length - i);
      const tmp = pool[i]!;
      pool[i] = pool[j]!;
      pool[j] = tmp;
    }
    return pool.slice(0, n);
  }
}
