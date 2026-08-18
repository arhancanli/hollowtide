/**
 * Fixed-timestep game loop with render interpolation.
 *
 * The simulation advances in exact 1/60s steps regardless of display refresh.
 * This is what makes runs deterministic (same seed + same inputs => same run)
 * and what keeps a 144Hz desktop and a 50Hz phone playing the same game.
 *
 * Render receives `alpha` — how far between the last two sim steps we are —
 * so drawing stays smooth even though the sim is quantised.
 */
export const FIXED_STEP = 1 / 60;

/** Never simulate more than this much wall time in one frame. */
const MAX_FRAME_TIME = 0.25;

export interface LoopHandlers {
  step: (dt: number) => void;
  /**
   * `alpha` interpolates between sim steps; `frameDt` is REAL elapsed seconds,
   * clamped. Overlay timers, juice and audio must use frameDt — driving them
   * from a hardcoded 1/60 makes every animation a frame COUNT, so a "5 second"
   * revive offer becomes 2.5s on a 120Hz phone and 10s on a throttled one.
   */
  render: (alpha: number, frameDt: number) => void;
}

export class Loop {
  private accumulator = 0;
  private lastTime = 0;
  private rafId = 0;
  private running = false;
  private readonly handlers: LoopHandlers;

  /** Sim steps executed in the most recent frame — handy for a perf HUD. */
  stepsLastFrame = 0;

  constructor(handlers: LoopHandlers) {
    this.handlers = handlers;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.lastTime = performance.now();
    this.accumulator = 0;
    this.rafId = requestAnimationFrame(this.tick);
  }

  stop(): void {
    this.running = false;
    cancelAnimationFrame(this.rafId);
  }

  private tick = (now: number): void => {
    if (!this.running) return;
    this.rafId = requestAnimationFrame(this.tick);

    let frameTime = (now - this.lastTime) / 1000;
    this.lastTime = now;

    // Clamp so a backgrounded tab or a GC pause cannot trigger a death spiral
    // where we try to catch up on ten seconds of simulation in one frame.
    if (frameTime > MAX_FRAME_TIME) frameTime = MAX_FRAME_TIME;
    if (frameTime < 0) frameTime = 0;

    this.accumulator += frameTime;

    let steps = 0;
    while (this.accumulator >= FIXED_STEP) {
      this.handlers.step(FIXED_STEP);
      this.accumulator -= FIXED_STEP;
      steps++;
    }
    this.stepsLastFrame = steps;

    this.handlers.render(this.accumulator / FIXED_STEP, frameTime);
  };
}
