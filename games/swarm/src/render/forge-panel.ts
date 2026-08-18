import { Container, Graphics, Rectangle, Text } from 'pixi.js';
import { FORGE_TRACKS, forgeCost, type ForgeLevels } from '../content/forge.js';

const FONT = 'system-ui, -apple-system, Segoe UI, Roboto, sans-serif';

/**
 * The Forge — where gold is spent.
 *
 * Reached from the results screen, which is the only moment a player is already
 * stopped and already looking at a gold number. Deliberately NOT a pre-run menu:
 * `main.ts` has no title screen or character select on purpose, because every
 * screen between the click and playing is a drop-off gate, and that decision is
 * worth protecting.
 *
 * One row per track, and the row IS the button. Each row states the effect, the
 * levels bought as pips, and the price — so the decision needs no second screen
 * and no tooltip. Rows the player cannot afford stay legible rather than being
 * greyed into invisibility: an unaffordable upgrade is a goal, and hiding the
 * price hides the reason to play another run.
 */
export class ForgePanel {
  readonly container = new Container();
  private readonly bg = new Graphics();
  private readonly rows = new Container();
  private readonly title = new Text({
    text: 'THE FORGE',
    style: { fontFamily: FONT, fontSize: 20, fontWeight: '800', fill: 0xffffff, letterSpacing: 3 },
  });
  private readonly goldText = new Text({
    text: '',
    style: { fontFamily: FONT, fontSize: 16, fontWeight: '800', fill: 0xffd23a },
  });
  private readonly hint = new Text({
    text: 'PERMANENT · APPLIES TO EVERY RUN',
    style: { fontFamily: FONT, fontSize: 10, fontWeight: '700', fill: 0x5f7099, letterSpacing: 1.5 },
  });
  private readonly backBtn = new Container();
  private readonly backG = new Graphics();
  private readonly backLabel = new Text({
    text: 'BACK',
    style: { fontFamily: FONT, fontSize: 13, fontWeight: '800', fill: 0x9db0d4, letterSpacing: 2 },
  });

  /** Called with a track id when the player taps an affordable row. */
  onBuy: ((trackId: string) => void) | null = null;
  onClose: (() => void) | null = null;

  private width = 0;
  private height = 0;
  private gold = 0;
  private levels: ForgeLevels = {};

  constructor() {
    this.title.anchor.set(0.5, 0);
    this.goldText.anchor.set(0.5, 0);
    this.hint.anchor.set(0.5, 0);

    this.backBtn.addChild(this.backG);
    this.backBtn.addChild(this.backLabel);
    this.backBtn.eventMode = 'static';
    this.backBtn.cursor = 'pointer';
    this.backBtn.on('pointertap', (e) => {
      e.stopPropagation();
      this.onClose?.();
    });

    this.container.addChild(this.bg);
    this.container.addChild(this.title);
    this.container.addChild(this.goldText);
    this.container.addChild(this.hint);
    this.container.addChild(this.rows);
    this.container.addChild(this.backBtn);
    this.container.visible = false;
    // Swallow taps so nothing behind the panel can be hit through it — the
    // achievements panel shipped without this and the results board underneath
    // stayed live.
    this.container.eventMode = 'static';
  }

  resize(width: number, height: number): void {
    this.width = width;
    this.height = height;
    if (this.container.visible) this.layout();
  }

  show(gold: number, levels: ForgeLevels): void {
    this.gold = gold;
    this.levels = levels;
    this.container.visible = true;
    this.layout();
  }

  hide(): void {
    this.container.visible = false;
  }

  get visible(): boolean {
    return this.container.visible;
  }

  private layout(): void {
    const w = this.width;
    const h = this.height;
    this.container.hitArea = new Rectangle(0, 0, w, h);

    const g = this.bg;
    g.clear();
    g.rect(0, 0, w, h).fill({ color: 0x05070f, alpha: 0.94 });

    this.title.x = w / 2;
    this.title.y = 26;
    this.goldText.text = `${Math.floor(this.gold)} GOLD`;
    this.goldText.x = w / 2;
    this.goldText.y = 52;
    this.hint.x = w / 2;
    this.hint.y = 76;

    this.rows.removeChildren();

    // Fit every track on screen without scrolling. A scrollable list inside a
    // canvas is a bad control on a phone and a worse one inside a portal iframe.
    const top = 100;
    const bottom = h - 66;
    const avail = bottom - top;
    const gap = 6;
    const rowH = Math.max(38, Math.min(56, (avail - gap * (FORGE_TRACKS.length - 1)) / FORGE_TRACKS.length));
    const rowW = Math.min(w - 28, 460);
    const x = (w - rowW) / 2;

    for (let i = 0; i < FORGE_TRACKS.length; i++) {
      const t = FORGE_TRACKS[i]!;
      const lv = this.levels[t.id] ?? 0;
      const cost = forgeCost(t, lv);
      const y = top + i * (rowH + gap);
      this.rows.addChild(this.buildRow(t.id, t.name, t.desc, t.color, lv, t.maxLevel, cost, x, y, rowW, rowH));
    }

    const bw = 120;
    const bh = 38;
    const bx = (w - bw) / 2;
    const by = h - 52;
    this.backG.clear();
    this.backG.roundRect(bx, by, bw, bh, 19).fill({ color: 0x141c30 });
    this.backG.roundRect(bx, by, bw, bh, 19).stroke({ width: 1.5, color: 0x2b3a5c });
    this.backLabel.anchor.set(0.5);
    this.backLabel.x = bx + bw / 2;
    this.backLabel.y = by + bh / 2;
    this.backBtn.hitArea = new Rectangle(bx, by, bw, bh);
  }

  private buildRow(
    id: string,
    name: string,
    desc: string,
    color: number,
    level: number,
    maxLevel: number,
    cost: number | null,
    x: number,
    y: number,
    w: number,
    h: number,
  ): Container {
    const row = new Container();
    const maxed = cost === null;
    const affordable = cost !== null && this.gold >= cost;

    const g = new Graphics();
    g.roundRect(x, y, w, h, 10).fill({ color: maxed ? 0x101a14 : 0x141c30 });
    g.roundRect(x, y, w, h, 10).stroke({
      width: 1.5,
      color: maxed ? 0x2f6f4a : affordable ? color : 0x24304a,
      alpha: affordable || maxed ? 0.95 : 0.5,
    });
    g.roundRect(x, y, 4, h, 2).fill({ color, alpha: maxed ? 0.5 : 1 });
    row.addChild(g);

    const nameText = new Text({
      text: name,
      style: { fontFamily: FONT, fontSize: 13, fontWeight: '800', fill: 0xffffff, letterSpacing: 1 },
    });
    nameText.x = x + 14;
    nameText.y = y + 7;
    row.addChild(nameText);

    const descText = new Text({
      text: desc,
      style: { fontFamily: FONT, fontSize: 10, fontWeight: '500', fill: 0x7c8db3 },
    });
    descText.x = x + 14;
    descText.y = y + h - 17;
    row.addChild(descText);

    // Level pips: how far along this track is, readable without counting.
    const pipR = 3.5;
    const pipGap = 10;
    const pipsW = maxLevel * pipGap;
    const pipX = x + w - 76 - pipsW;
    for (let i = 0; i < maxLevel; i++) {
      g.circle(pipX + i * pipGap, y + h / 2, pipR).fill({
        color: i < level ? color : 0x2b3a5c,
      });
    }

    const priceText = new Text({
      text: maxed ? 'MAX' : `${cost}`,
      style: {
        fontFamily: FONT,
        fontSize: maxed ? 11 : 14,
        fontWeight: '800',
        fill: maxed ? 0x5fbf8a : affordable ? 0xffd23a : 0x5f7099,
      },
    });
    priceText.anchor.set(1, 0.5);
    priceText.x = x + w - 14;
    priceText.y = y + h / 2;
    row.addChild(priceText);

    if (affordable) {
      row.eventMode = 'static';
      row.cursor = 'pointer';
      row.hitArea = new Rectangle(x, y, w, h);
      row.on('pointertap', (e) => {
        e.stopPropagation();
        this.onBuy?.(id);
      });
    }
    return row;
  }
}
