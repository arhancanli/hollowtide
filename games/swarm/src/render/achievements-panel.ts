import { Container, Graphics, Rectangle, Text } from 'pixi.js';
import { ACHIEVEMENTS } from '../content/achievements.js';

const FONT = 'system-ui, -apple-system, Segoe UI, Roboto, sans-serif';

/**
 * The achievements list.
 *
 * Achievements existed but were invisible — they flashed once on the results
 * screen and were never surfaced again. A goal you cannot see cannot direct
 * behaviour, so they were doing nothing for retention despite being built.
 *
 * The whole point is DIRECTION: with only "survive longer" to chase, a player
 * runs out of reasons quickly and never sees the content that already exists.
 * Unearned entries show their requirement in full, because the unmet ones are
 * the ones doing the work.
 */
export class AchievementsPanel {
  readonly container = new Container();

  onClose: (() => void) | null = null;

  private readonly dim = new Graphics();
  private readonly list = new Container();
  private readonly title = new Text({
    text: 'ACHIEVEMENTS',
    style: { fontFamily: FONT, fontSize: 15, fontWeight: '800', fill: 0xffffff, letterSpacing: 2 },
  });
  private readonly closeBtn = new Container();

  private width = 0;
  private height = 0;
  private earned: readonly string[] = [];

  constructor() {
    this.title.anchor.set(0.5);

    const bg = new Graphics();
    bg.label = 'bg';
    const label = new Text({
      text: 'BACK',
      style: { fontFamily: FONT, fontSize: 16, fontWeight: '800', fill: 0x08131f, letterSpacing: 1 },
    });
    label.label = 'label';
    label.anchor.set(0.5);
    this.closeBtn.addChild(bg, label);
    this.closeBtn.eventMode = 'static';
    this.closeBtn.cursor = 'pointer';
    this.closeBtn.on('pointertap', () => this.onClose?.());

    // Swallow taps on the backdrop so they never reach the game underneath.
    this.dim.eventMode = 'static';

    this.container.addChild(this.dim, this.title, this.list, this.closeBtn);
    this.container.visible = false;
  }

  get visible(): boolean {
    return this.container.visible;
  }

  resize(width: number, height: number): void {
    this.width = width;
    this.height = height;
    this.dim.clear();
    this.dim.rect(0, 0, width, height).fill({ color: 0x05070f, alpha: 0.95 });
    this.dim.hitArea = new Rectangle(0, 0, width, height);
    if (this.container.visible) this.draw();
  }

  show(earned: readonly string[]): void {
    this.earned = earned;
    this.container.visible = true;
    this.draw();
  }

  hide(): void {
    this.container.visible = false;
  }

  private draw(): void {
    this.list.removeChildren();
    const held = new Set(this.earned);

    const btnW = Math.min(this.width - 40, 300);
    const btnH = 52;
    const btnY = this.height - 26 - btnH;
    const bg = this.closeBtn.getChildByLabel('bg') as Graphics;
    const label = this.closeBtn.getChildByLabel('label') as Text;
    bg.clear();
    bg.roundRect(0, 0, btnW, btnH, btnH / 2).fill({ color: 0x5cd0ff });
    label.x = btnW / 2;
    label.y = btnH / 2;
    this.closeBtn.x = (this.width - btnW) / 2;
    this.closeBtn.y = btnY;
    this.closeBtn.hitArea = new Rectangle(0, 0, btnW, btnH);

    this.title.x = this.width / 2;
    this.title.y = 34;
    this.title.text = `ACHIEVEMENTS  ${held.size}/${ACHIEVEMENTS.length}`;

    const top = 64;
    const avail = btnY - 16 - top;
    const rowH = Math.min(38, avail / ACHIEVEMENTS.length);
    const rowW = Math.min(this.width - 32, 420);
    const left = (this.width - rowW) / 2;

    for (let i = 0; i < ACHIEVEMENTS.length; i++) {
      const a = ACHIEVEMENTS[i]!;
      const has = held.has(a.id);
      const y = top + i * rowH;

      const row = new Graphics();
      row.roundRect(left, y, rowW, rowH - 4, 6).fill({
        color: has ? 0x152338 : 0x0d1424,
        alpha: has ? 1 : 0.8,
      });
      if (has) row.roundRect(left, y, 4, rowH - 4, 2).fill({ color: 0xffd23a });
      this.list.addChild(row);

      const name = new Text({
        text: a.name,
        style: {
          fontFamily: FONT,
          fontSize: 12,
          fontWeight: '800',
          fill: has ? 0xffd23a : 0x5f7099,
          letterSpacing: 1,
        },
      });
      name.x = left + 14;
      name.y = y + (rowH - 4) / 2 - 6;
      this.list.addChild(name);

      const desc = new Text({
        text: a.desc,
        style: { fontFamily: FONT, fontSize: 11, fontWeight: '500', fill: has ? 0x9db0d4 : 0x46536f },
      });
      desc.anchor.set(1, 0);
      desc.x = left + rowW - 14;
      desc.y = y + (rowH - 4) / 2 - 6;
      this.list.addChild(desc);
    }
  }
}
