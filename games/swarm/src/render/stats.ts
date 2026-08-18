import { Container, Graphics, Text } from 'pixi.js';
import type { LocalFunnel } from '@arcade/analytics';

/**
 * On-device funnel readout, enabled with `?stats` in the URL.
 *
 * The same funnel the soft launch measures, computed from this device's own
 * history. It exists so the instrumentation is useful the moment it ships
 * rather than only after a datastore is wired up — and so it is obvious when a
 * counter is not incrementing, which is the failure mode that silently ruins
 * analytics work.
 *
 * Every row is a percentage of the step above it, because the absolute numbers
 * do not matter. Where the drop is does.
 */
const FONT = 'ui-monospace, SFMono-Regular, Menlo, monospace';

export class StatsOverlay {
  readonly container = new Container();
  private readonly bg = new Graphics();
  private readonly text = new Text({
    text: '',
    style: { fontFamily: FONT, fontSize: 11, fontWeight: '600', fill: 0x9ad6ff, lineHeight: 15 },
  });

  private refresh = 0;

  constructor(enabled: boolean) {
    this.container.addChild(this.bg, this.text);
    this.container.visible = enabled;
    this.container.eventMode = 'none';
    this.text.x = 10;
    this.text.y = 8;
  }

  get enabled(): boolean {
    return this.container.visible;
  }

  resize(_width: number, _height: number): void {
    this.container.x = 10;
    this.container.y = 96;
  }

  update(f: Readonly<LocalFunnel>, dtMs: number, liveSessionMs = 0, liveRuns = 0): void {
    if (!this.container.visible) return;
    this.refresh += dtMs;
    if (this.refresh < 500) return;
    this.refresh = 0;

    const pct = (a: number, b: number): string =>
      b > 0 ? `${((a / b) * 100).toFixed(0)}%`.padStart(4) : '   -';
    const secs = (ms: number): string => `${(ms / 1000).toFixed(0)}s`;
    const avgRun = f.runsEnded > 0 ? f.totalRunMs / f.runsEnded : 0;
    const avgSession = f.sessions > 0 ? f.totalSessionMs / f.sessions : 0;

    this.text.text = [
      `THIS DEVICE  ·  ${f.sessions} sessions`,
      `first input   ${pct(f.firstInputs, f.loads)}  (${f.firstInputs}/${f.loads})`,
      `run 2 started ${pct(f.secondRuns, f.sessions)}  (${f.secondRuns})`,
      `reached 15s   ${pct(f.reached15, f.runsStarted)}  (${f.reached15}/${f.runsStarted})`,
      `reached 60s   ${pct(f.reached60, f.runsStarted)}  (${f.reached60})`,
      `avg run       ${secs(avgRun)}   best ${secs(f.bestRunMs)}`,
      `session now   ${secs(liveSessionMs)}  ${liveRuns} runs`,
      `avg session   ${secs(avgSession)}`,
      `days played   ${f.distinctDays}   returns ${f.returns}`,
      `ads off/acc   ${f.adsOffered}/${f.adsAccepted}  watched ${f.adsWatched}`,
      `revives used  ${f.revives}`,
    ].join('\n');

    const w = this.text.width + 20;
    const h = this.text.height + 16;
    this.bg.clear();
    this.bg.roundRect(0, 0, w, h, 6).fill({ color: 0x05070f, alpha: 0.78 });
  }
}
