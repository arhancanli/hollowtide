/**
 * Hit stop — freeze the simulation for a few frames on impact.
 *
 * The single cheapest way to make a hit land. Rendering continues, so the
 * frozen frame is visible; only the sim stops advancing.
 *
 * Determinism is unaffected: the sim receives the same steps in the same order,
 * it just receives them slightly later in wall-clock terms. Replays and the
 * headless balance runner never invoke this at all.
 *
 * Use it sparingly. On every hit it stops reading as impact and starts reading
 * as lag, which is why Swarm only triggers it on elites and on death.
 */
export class Hitstop {
  private remaining = 0;

  /**
   * Seconds of freeze still affordable. Refills with real time, so the class
   * enforces "sparingly" itself instead of trusting every call site to.
   *
   * The doc above was right and the game violated it. `ELITE_HITSTOP` re-armed
   * on every non-killing hit on an elite, elite waves grow to seven concurrent
   * from t=138, and the result was measured at 39.3% of frames frozen inside a
   * single second, with the simulation advancing at 0.400-0.614x wall speed for
   * seconds at a time. That is not impact, it is the lag this class was written
   * to avoid — and because the perf overlay skipped frozen frames it reported a
   * flat 120fps straight through every lurch, which is why seven independent
   * playtests found "no frame drop" while the game visibly stuttered.
   */
  private budget: number;

  /** Fraction of wall-clock time that may be spent frozen. */
  readonly dutyCycle: number;
  /** Most freeze that can be banked, so quiet stretches don't buy a long stall. */
  readonly maxBudget: number;

  /** Total seconds frozen this run — so a diagnostic can report the truth. */
  frozenTime = 0;

  constructor(dutyCycle = 0.1, maxBudget = 0.13) {
    this.dutyCycle = dutyCycle;
    this.maxBudget = maxBudget;
    this.budget = maxBudget;
  }

  get active(): boolean {
    return this.remaining > 0;
  }

  /** Longest pending freeze wins; they never queue up, and none exceeds budget. */
  add(seconds: number): void {
    if (this.budget <= 0) return;
    const grant = Math.min(seconds, this.budget);
    if (grant > this.remaining) this.remaining = grant;
  }

  clear(): void {
    this.remaining = 0;
  }

  reset(): void {
    this.remaining = 0;
    this.budget = this.maxBudget;
    this.frozenTime = 0;
  }

  /** Returns true if the sim should be held still for this step. */
  consume(dt: number): boolean {
    // Refill on real time, whether or not we are frozen.
    this.budget = Math.min(this.maxBudget, this.budget + dt * this.dutyCycle);
    if (this.remaining <= 0) return false;
    // Bill in WHOLE steps. The caller skips an entire step on a true, so
    // charging a fraction of one lets a sliver of remaining budget buy a full
    // frame of freeze — which is how a correct-looking 10% duty cycle still
    // froze 100% of frames in the first measurement of this fix.
    if (this.budget < dt) {
      this.remaining = 0;
      return false;
    }
    this.remaining -= dt;
    this.budget -= dt;
    this.frozenTime += dt;
    return true;
  }
}
