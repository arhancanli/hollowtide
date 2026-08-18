import { Container, Graphics, Rectangle, Text } from 'pixi.js';

export type GameMode = 'solo' | 'multiplayer';

const FONT = 'system-ui, -apple-system, Segoe UI, Roboto, sans-serif';

/**
 * The front door. Hollowtide used to silently start Solo and hide Arena behind
 * a three-state control on the death screen. A mode nobody can find is not a
 * mode, so the first decision is now explicit and contains exactly two doors.
 */
export class ModeSelectScreen {
  readonly container = new Container();
  onSelect: ((mode: GameMode) => void) | null = null;

  private readonly veil = new Graphics();
  private readonly tide = new Graphics();
  private readonly eyebrow = text('CHOOSE YOUR TIDE', 11, 0x7792bd, 2.8);
  private readonly title = text('HOLLOWTIDE', 48, 0xf2f7ff, 3.5, '900');
  private readonly promise = text('GROW  ·  HUNT  ·  TAKE THE CROWN', 12, 0x76e8ff, 2.2, '800');
  /**
   * The two doors, described as the two different games they are.
   *
   * This copy used to sell multiplayer as "8 survivors, shared prey" — the same
   * game with more bodies in it. It is not: solo is one life against the tide,
   * multiplayer is a five-minute match where you respawn and the most mass at
   * the clock wins. A player who picks the wrong door because the sign was
   * wrong is a player who bounces, and the sign is the cheapest thing here to
   * get right.
   */
  private readonly solo = this.makeCard(
    'SOLO',
    'ONE LIFE  ·  MASTER THE TIDE',
    'Build impossible weapons.\nSurvive as long as you can.',
    0x55d7ff,
    'solo',
  );
  private readonly multi = this.makeCard(
    'MULTIPLAYER',
    '5 MINUTES  ·  TAKE THE CROWN',
    'Eat what the fallen drop.\nYou respawn. Most mass wins.',
    0xff647d,
    'multiplayer',
  );
  private readonly status = text('', 10, 0x8ba0c4, 1.4, '700');
  private width = 0;
  private height = 0;
  private online = false;

  constructor() {
    for (const label of [this.eyebrow, this.title, this.promise, this.status]) label.anchor.set(0.5);
    this.container.addChild(
      this.veil,
      this.tide,
      this.eyebrow,
      this.title,
      this.promise,
      this.solo,
      this.multi,
      this.status,
    );
  }

  setOnline(online: boolean): void {
    this.online = online;
    this.status.text = online
      ? 'LIVE MATCHMAKING  ·  EMPTY SEATS BECOME AI RIVALS'
      : 'MULTIPLAYER vs 7 AI RIVALS  ·  LIVE MATCHES COMING';
  }

  show(): void {
    this.container.visible = true;
    this.layout();
  }

  hide(): void {
    this.container.visible = false;
  }

  select(mode: GameMode): void {
    if (!this.container.visible) return;
    this.onSelect?.(mode);
  }

  resize(width: number, height: number): void {
    this.width = width;
    this.height = height;
    this.layout();
  }

  private makeCard(
    name: string,
    hook: string,
    description: string,
    accent: number,
    mode: GameMode,
  ): Container {
    const card = new Container();
    const bg = new Graphics();
    bg.label = 'bg';
    const nameText = text(name, 26, 0xffffff, 1.8, '900');
    nameText.label = 'name';
    const hookText = text(hook, 10, accent, 2, '900');
    hookText.label = 'hook';
    const descText = new Text({
      text: description,
      style: {
        fontFamily: FONT,
        fontSize: 13,
        fontWeight: '600',
        fill: 0xaebbd2,
        align: 'center',
        lineHeight: 19,
      },
    });
    descText.label = 'desc';
    const action = text(mode === 'solo' ? 'PLAY SOLO  →' : 'FIND A MATCH  →', 12, 0x07111e, 1.2, '900');
    action.label = 'action';
    for (const item of [nameText, hookText, descText, action]) item.anchor.set(0.5);
    card.addChild(bg, nameText, hookText, descText, action);
    card.eventMode = 'static';
    card.cursor = 'pointer';
    card.on('pointertap', () => this.select(mode));
    (card as Container & { _accent: number })._accent = accent;
    return card;
  }

  private drawCard(card: Container, x: number, y: number, w: number, h: number): void {
    const accent = (card as Container & { _accent: number })._accent;
    const bg = card.getChildByLabel('bg') as Graphics;
    bg.clear();
    bg.roundRect(0, 0, w, h, 18).fill({ color: 0x0b1425, alpha: 0.96 });
    bg.roundRect(0, 0, w, h, 18).stroke({ width: 1.5, color: accent, alpha: 0.8 });
    bg.rect(0, 0, 5, h).fill({ color: accent, alpha: 0.95 });
    bg.roundRect(w * 0.18, h - 45, w * 0.64, 32, 16).fill({ color: accent });
    card.x = x;
    card.y = y;
    card.hitArea = new Rectangle(0, 0, w, h);
    const name = card.getChildByLabel('name') as Text;
    const hook = card.getChildByLabel('hook') as Text;
    const desc = card.getChildByLabel('desc') as Text;
    const action = card.getChildByLabel('action') as Text;
    name.x = hook.x = desc.x = action.x = w / 2;
    name.y = 38;
    hook.y = 72;
    desc.y = 112;
    action.y = h - 29;
  }

  private layout(): void {
    if (this.width <= 0 || this.height <= 0) return;
    const w = this.width;
    const h = this.height;
    const portrait = w < 720;
    const tight = h < 600;
    this.veil.clear().rect(0, 0, w, h).fill({ color: 0x030713, alpha: 0.92 });
    this.tide.clear();
    const ring = Math.min(w, h) * 0.44;
    this.tide.circle(w / 2, h * 0.44, ring).stroke({ width: 2, color: 0x1a6382, alpha: 0.22 });
    this.tide.circle(w / 2, h * 0.44, ring * 0.72).stroke({ width: 1, color: 0xff647d, alpha: 0.12 });

    this.eyebrow.x = this.title.x = this.promise.x = this.status.x = w / 2;
    const headY = tight ? 28 : Math.max(42, h * 0.09);
    this.eyebrow.y = headY;
    this.title.y = headY + (tight ? 34 : 45);
    this.title.style.fontSize = portrait ? (tight ? 34 : 42) : 52;
    this.promise.y = this.title.y + (tight ? 34 : 46);

    if (portrait) {
      const cardW = Math.min(w - 32, 430);
      const cardH = tight ? 150 : Math.min(184, (h - this.promise.y - 80) / 2 - 8);
      const top = this.promise.y + (tight ? 22 : 34);
      this.drawCard(this.solo, (w - cardW) / 2, top, cardW, cardH);
      this.drawCard(this.multi, (w - cardW) / 2, top + cardH + 10, cardW, cardH);
      this.status.y = Math.min(h - 18, top + cardH * 2 + 24);
    } else {
      const gap = 16;
      const cardW = Math.min(340, (w - 56 - gap) / 2);
      const cardH = Math.min(210, h - this.promise.y - 84);
      const left = (w - cardW * 2 - gap) / 2;
      const top = this.promise.y + 34;
      this.drawCard(this.solo, left, top, cardW, cardH);
      this.drawCard(this.multi, left + cardW + gap, top, cardW, cardH);
      this.status.y = Math.min(h - 24, top + cardH + 28);
    }
    this.status.style.fontSize = w < 410 ? 9 : 10;
  }
}

function text(
  value: string,
  size: number,
  fill: number,
  spacing = 0,
  weight: '600' | '700' | '800' | '900' = '800',
): Text {
  return new Text({
    text: value,
    style: { fontFamily: FONT, fontSize: size, fontWeight: weight, fill, letterSpacing: spacing },
  });
}
