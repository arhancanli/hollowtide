import { Container, Graphics, Text } from 'pixi.js';

/**
 * On-screen performance readout, enabled with `?perf` in the URL.
 *
 * Exists because "does it feel smooth" is not a measurement. On a real phone
 * the interesting failures are ones a frame-time average hides: a GC pause or a
 * spawn spike shows up as one 90ms frame that reads as a hitch and vanishes
 * from the mean. So this reports the WORST frame in the last second alongside
 * the median, because the worst frame is the one the player actually notices.
 *
 * Thermal throttling is the other reason this is a live readout rather than a
 * one-off benchmark — phones frequently run fine for a minute and then degrade.
 */
const SAMPLES = 120;

const STYLE = {
  fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
  fontSize: 11,
  fontWeight: '600' as const,
  fill: 0x7dff9b,
};

export class PerfOverlay {
  readonly container = new Container();

  private readonly bg = new Graphics();
  private readonly text = new Text({ text: '', style: STYLE });
  private readonly samples = new Float32Array(SAMPLES);
  private readonly sorted = new Float32Array(SAMPLES);
  private index = 0;
  private filled = 0;

  private lastNow = 0;
  private worstInWindow = 0;
  private windowTimer = 0;
  private displayWorst = 0;
  private refresh = 0;

  constructor(enabled: boolean) {
    this.container.addChild(this.bg, this.text);
    this.container.visible = enabled;
    this.container.eventMode = 'none';
    this.text.x = 8;
    this.text.y = 6;
  }

  get enabled(): boolean {
    return this.container.visible;
  }

  resize(_width: number, height: number): void {
    // Bottom-left: clear of the HUD, the mute button and the level-up cards.
    this.container.x = 10;
    this.container.y = height - 116;
  }

  update(enemies: number, hitstopped: boolean): void {
    if (!this.container.visible) return;

    const now = performance.now();
    if (this.lastNow === 0) {
      this.lastNow = now;
      return;
    }
    const dt = now - this.lastNow;
    this.lastNow = now;

    // Hit stop deliberately freezes the sim, so those frames are not stalls and
    // counting them would report the juice as a performance problem.
    if (hitstopped) return;

    this.samples[this.index] = dt;
    this.index = (this.index + 1) % SAMPLES;
    if (this.filled < SAMPLES) this.filled++;

    if (dt > this.worstInWindow) this.worstInWindow = dt;
    this.windowTimer += dt;
    if (this.windowTimer >= 1000) {
      this.displayWorst = this.worstInWindow;
      this.worstInWindow = 0;
      this.windowTimer = 0;
    }

    // Recompute the median a few times a second, not every frame.
    this.refresh += dt;
    if (this.refresh < 250 || this.filled < 8) return;
    this.refresh = 0;

    this.sorted.set(this.samples);
    const view = this.sorted.subarray(0, this.filled);
    view.sort();
    const median = view[Math.floor(this.filled / 2)]!;
    const p95 = view[Math.min(this.filled - 1, Math.floor(this.filled * 0.95))]!;
    const fps = 1000 / median;

    this.text.text =
      `${fps.toFixed(0)} fps   ${median.toFixed(1)}ms\n` +
      `p95 ${p95.toFixed(1)}   worst ${this.displayWorst.toFixed(0)}\n` +
      `enemies ${enemies}`;

    // Green while a solid 60, amber once frames are being missed, red when the
    // hitching would be plainly visible.
    this.text.style.fill = median < 18.5 ? 0x7dff9b : median < 26 ? 0xffd23a : 0xff5c6e;

    const w = this.text.width + 16;
    const h = this.text.height + 12;
    this.bg.clear();
    this.bg.roundRect(0, 0, w, h, 6).fill({ color: 0x05070f, alpha: 0.72 });
  }
}
