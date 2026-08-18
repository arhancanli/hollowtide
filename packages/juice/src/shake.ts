/**
 * Trauma-based screen shake.
 *
 * Trauma accumulates from events and decays linearly; the offset uses trauma
 * SQUARED. That squaring is the whole trick — small hits barely register while
 * big ones hit hard, so shake stays expressive instead of turning into
 * permanent background noise once the swarm is dense.
 *
 * Offsets come from layered sines rather than random jitter. Random per-frame
 * offsets read as a broken display; smooth oscillation reads as impact.
 */
export class Shake {
  private trauma = 0;
  private t = 0;

  readonly offset = { x: 0, y: 0 };

  /** Seconds for full trauma to decay to zero. */
  decay = 0.9;

  /**
   * Diminishing returns: an addition claims a share of the headroom left, not a
   * flat amount.
   *
   * Straight summing works only while events are sparse. Late game, MINES at a
   * 0.30s cooldown and SUPERNOVA at 0.67s each add the 0.4 cap, so trauma
   * arrived at ~1.9/sec against a linear decay of 1.111/sec — it clamped at 1.0
   * and never came down. Measured over 7,170 samples: median trauma 0.936, 42.8%
   * pegged above 0.95, and it returned to zero exactly 0.0% of the time. The
   * whole world vibrated at a constant 7.65px on a 480px viewport for the last
   * ten minutes of every run, which is the best single match for the owner's
   * "glitchy".
   *
   * With headroom scaling, an isolated hit still lands at full strength (at
   * trauma 0 this is identical to the old behaviour) while a sustained barrage
   * settles near 0.4 instead of pinning at 1.0 — a rumble under the action
   * rather than a broken display.
   */
  add(amount: number): void {
    this.trauma = Math.min(1, this.trauma + amount * (1 - this.trauma));
  }

  reset(): void {
    this.trauma = 0;
    this.offset.x = 0;
    this.offset.y = 0;
  }

  update(dt: number, maxOffset: number): void {
    this.t += dt;
    if (this.trauma > 0) {
      this.trauma = Math.max(0, this.trauma - dt / this.decay);
    }
    if (this.trauma <= 0) {
      this.offset.x = 0;
      this.offset.y = 0;
      return;
    }
    const power = this.trauma * this.trauma * maxOffset;
    // Two incommensurate frequencies per axis so the motion never visibly loops.
    this.offset.x = power * (Math.sin(this.t * 47.3) * 0.7 + Math.sin(this.t * 23.1) * 0.3);
    this.offset.y = power * (Math.sin(this.t * 41.7 + 1.7) * 0.7 + Math.sin(this.t * 29.9) * 0.3);
  }
}
