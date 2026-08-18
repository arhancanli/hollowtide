import { Container, Graphics, Rectangle, Text } from 'pixi.js';
import type { Card } from '../content/upgrades.js';
import { BOONS, type BoonId } from '../content/boons.js';

const FONT = 'system-ui, -apple-system, Segoe UI, Roboto, sans-serif';

/**
 * Level-up card overlay.
 *
 * Cards sit at the BOTTOM of the screen, in thumb reach — never centred, and
 * never at the top. On a phone a centred dialog means stretching, and the
 * whole point is that the choice costs the player nothing but a tap.
 *
 * On narrow screens the cards stack vertically. Three columns at 400px wide
 * gives ~120px targets, which is under the comfortable thumb target size.
 */
export class CardOverlay {
  readonly container = new Container();
  private readonly dim = new Graphics();
  private readonly cards = new Container();
  private width = 0;
  private height = 0;

  /** Slide-in animation state. */
  private anim = 0;
  private readonly targets: { card: Container; y: number }[] = [];

  onPick: ((id: string) => void) | null = null;
  /**
   * Reroll the draw for a rewarded ad.
   *
   * Highest natural opt-in of any surface in this genre, because it is offered
   * at the one moment the player already wants something they did not get.
   * Null means no ad is available — the button is then not drawn at all rather
   * than drawn dead.
   */
  onReroll: (() => void) | null = null;
  /** Remove a card from the run's pool. Never offered on an evolution. */
  onBanish: ((id: string) => void) | null = null;
  /** Take nothing this level. */
  onSkip: (() => void) | null = null;
  private banishesLeft = 0;
  private readonly skipBtn = new Container();
  private readonly skipG = new Graphics();
  private readonly skipLabel = new Text({
    text: 'SKIP',
    style: { fontFamily: FONT, fontSize: 11, fontWeight: '800', fill: 0x6f80a6, letterSpacing: 1.5 },
  });
  private readonly rerollBtn = new Container();
  private readonly rerollG = new Graphics();
  private readonly rerollLabel = new Text({
    text: 'REROLL',
    style: { fontFamily: FONT, fontSize: 12, fontWeight: '800', fill: 0xffd23a, letterSpacing: 1.5 },
  });
  private rerollUsed = false;

  /** Ids currently on screen, in order, for keyboard selection (1/2/3). */
  private shownIds: string[] = [];

  constructor() {
    this.container.addChild(this.dim);
    this.container.addChild(this.cards);

    this.rerollBtn.addChild(this.rerollG);
    this.rerollBtn.addChild(this.rerollLabel);
    this.rerollBtn.eventMode = 'static';
    this.rerollBtn.cursor = 'pointer';
    this.rerollBtn.visible = false;
    this.rerollBtn.on('pointertap', (e) => {
      e.stopPropagation();
      if (this.rerollUsed) return;
      // Latch immediately. The ad is async, and a double-tap would otherwise
      // spend two ads on one draw.
      this.rerollUsed = true;
      this.rerollBtn.visible = false;
      this.onReroll?.();
    });
    this.container.addChild(this.rerollBtn);

    this.skipBtn.addChild(this.skipG);
    this.skipBtn.addChild(this.skipLabel);
    this.skipBtn.eventMode = 'static';
    this.skipBtn.cursor = 'pointer';
    this.skipBtn.visible = false;
    this.skipBtn.on('pointertap', (e) => {
      e.stopPropagation();
      this.onSkip?.();
    });
    this.container.addChild(this.skipBtn);

    this.container.visible = false;
  }

  resize(width: number, height: number): void {
    this.width = width;
    this.height = height;
    this.dim.clear();
    // 0.5, not 0.72. The card overlay is up for a large share of every run, and a
    // heavy dim made the whole game look far darker and flatter than it is —
    // including in the screenshots I was using to judge the art direction.
    this.dim.rect(0, 0, width, height).fill({ color: 0x05070f, alpha: 0.5 });
  }

  hide(): void {
    this.container.visible = false;
    this.rerollBtn.visible = false;
    this.cards.removeChildren();
    this.targets.length = 0;
    this.shownIds.length = 0;
  }

  /**
   * Pick by index. Wired to the 1/2/3 keys.
   *
   * Without this a keyboard-only desktop player was permanently locked: the
   * card overlay has no focusable DOM at all, so the sim froze at the first
   * level-up with no way forward, and it recurred at revive and PLAY AGAIN.
   */
  pickByIndex(i: number): void {
    const id = this.shownIds[i];
    if (this.container.visible && id) this.onPick?.(id);
  }

  /**
   * Cards slide up from the bottom, staggered.
   *
   * They previously appeared instantly, which reads as a screenshot rather than
   * a moment. The motion is short — the level-up freeze is already a pause in a
   * game about pressure, and a slow entrance turns a reward into a wait.
   */
  update(dt: number): void {
    if (!this.container.visible || this.anim >= 1) return;
    this.anim = Math.min(1, this.anim + dt * 5.5);
    for (let i = 0; i < this.targets.length; i++) {
      const { card, y } = this.targets[i]!;
      const local = Math.max(0, Math.min(1, this.anim * 1.4 - i * 0.16));
      const eased = 1 - (1 - local) * (1 - local) * (1 - local);
      card.y = y + (1 - eased) * 46;
      card.alpha = eased;
    }
  }

  /** @param allowReroll false once this draw has already been rerolled. */
  show(upgrades: readonly Card[], allowReroll = true, banishesLeft = 0): void {
    if (allowReroll) this.rerollUsed = false;
    this.banishesLeft = banishesLeft;
    this.cards.removeChildren();
    this.targets.length = 0;
    this.shownIds.length = 0;
    this.anim = 0;
    this.container.visible = true;

    const stacked = this.width < 560;
    const n = upgrades.length;
    const pad = stacked ? 16 : 14;
    const gap = stacked ? 12 : pad;

    const cardW = stacked
      ? Math.min(this.width - pad * 2, 440)
      : Math.min((this.width - pad * (n + 1)) / n, 240);

    /**
     * Cards are MEASURED, not assumed.
     *
     * They used to be a fixed 82px tall while the description word-wrapped to
     * whatever length it needed — so a three-line evolution rule rendered
     * straight out through the bottom edge of the card, in the exact place the
     * player is being asked to make the run's key decision. Building each card
     * first and reading its real height back means the layout can never
     * disagree with its contents again, whatever text a future weapon carries.
     */
    const built = upgrades.map((u) => this.buildCard(u, cardW, stacked));
    const heights = built.map((c) => c.contentHeight);
    const tallest = Math.max(...heights);
    // On desktop the three sit side by side, so they share the tallest height
    // and the row reads as one object rather than three ragged ones.
    const totalH = stacked
      ? heights.reduce((a, b) => a + b, 0) + gap * (n - 1)
      : tallest;
    const startY = this.height - totalH - (stacked ? 24 : 28);

    let y = startY;
    for (let i = 0; i < n; i++) {
      const { container, contentHeight, redraw } = built[i]!;
      redraw(stacked ? contentHeight : tallest);
      const x = stacked
        ? (this.width - cardW) / 2
        : pad + i * (cardW + pad) + (this.width - (n * cardW + (n + 1) * pad)) / 2;
      container.x = x;
      container.y = y;
      container.alpha = 0;
      this.cards.addChild(container);
      this.targets.push({ card: container, y });
      this.shownIds.push(upgrades[i]!.id);
      // Only the stacked layout advances down the screen. Side by side, every
      // card shares one row — incrementing here pushed the second and third
      // cards straight off the bottom edge on desktop.
      if (stacked) y += contentHeight + gap;
    }
    this.layoutReroll(startY);
    this.layoutSkip(startY);
    this.update(0);
  }

  /**
   * One reroll per level-up, sitting just above the cards.
   *
   * Deliberately small and quiet: it must be findable by a player who wants it
   * and invisible to one who does not. Placed ABOVE the card stack because the
   * cards occupy the thumb-rest zone, and a mis-tap there costs the player a
   * pick they did not choose.
   */
  private layoutReroll(cardsTop: number): void {
    const g = this.rerollG;
    g.clear();
    const show = !!this.onReroll && !this.rerollUsed;
    this.rerollBtn.visible = show;
    if (!show) return;

    const w = 138;
    const h = 32;
    const x = (this.width - w) / 2;
    const y = cardsTop - h - 14;
    g.roundRect(x, y, w, h, 16).fill({ color: 0x111a2c, alpha: 0.95 });
    g.roundRect(x, y, w, h, 16).stroke({ width: 1.5, color: 0xffd23a, alpha: 0.7 });
    // The play glyph reads as "watch", which is what is actually being asked.
    const cx = x + 24;
    const cy = y + h / 2;
    g.moveTo(cx - 4, cy - 6).lineTo(cx + 6, cy).lineTo(cx - 4, cy + 6).closePath()
      .fill({ color: 0xffd23a });
    this.rerollLabel.x = x + 46;
    this.rerollLabel.y = cy - 6;
    this.rerollBtn.hitArea = new Rectangle(x, y, w, h);
  }

  /**
   * SKIP, deliberately small and to one side.
   *
   * It is the right move surprisingly often — once you have banished the noise
   * out of your pool, taking nothing beats taking a card that dilutes it — but
   * it must never compete with the three cards for attention, because for most
   * players most of the time it is the wrong move.
   */
  private layoutSkip(cardsTop: number): void {
    const g = this.skipG;
    g.clear();
    const on = !!this.onSkip;
    this.skipBtn.visible = on;
    if (!on) return;
    const w = 74;
    const h = 30;
    const x = this.width - w - 16;
    const y = cardsTop - h - 14;
    g.roundRect(x, y, w, h, 15).fill({ color: 0x0d1424, alpha: 0.85 });
    g.roundRect(x, y, w, h, 15).stroke({ width: 1, color: 0x2b3a5c });
    this.skipLabel.anchor.set(0.5);
    this.skipLabel.x = x + w / 2;
    this.skipLabel.y = y + h / 2;
    this.skipBtn.hitArea = new Rectangle(x - 4, y - 7, w + 8, h + 14);
  }

  /**
   * Hand the reroll back when the ad never ran.
   *
   * The button latches on tap so a double-tap cannot spend two ads on one draw,
   * but an ad that comes back 'unavailable' or 'skipped' has cost the player
   * their reroll for nothing. Charging for a thing that did not happen is the
   * exact shape of the dark pattern this project refuses to ship.
   */
  restoreReroll(): void {
    if (!this.container.visible) return;
    this.rerollUsed = false;
    this.rerollBtn.visible = !!this.onReroll;
  }

  /**
   * One card.
   *
   * Three tiers of information, given three different weights, because they are
   * read at three different moments:
   *   NAME    what this is                    — glanced at
   *   EFFECT  what it does right now          — read
   *   PATH    what it can still become        — considered
   *
   * Packing all three into one string is what produced a line long enough to
   * overflow the card. Separating them also lets the evolution path carry its
   * own colour and its own "you already have the other half" tick, which is the
   * single most decision-relevant fact on the screen.
   */
  private buildCard(u: Card, w: number, stacked: boolean): { container: Container; contentHeight: number; redraw: (h: number) => void } {
    const card = new Container();
    const bg = new Graphics();
    card.addChild(bg);
    let banishDot: Container | null = null;

    const padX = stacked ? 24 : 20;
    const padY = stacked ? 20 : 22;
    const textW = w - padX * 2 - (stacked ? 46 : 0);

    const name = new Text({
      text: u.name,
      style: {
        fontFamily: FONT,
        fontSize: stacked ? 21 : 19,
        fontWeight: '800',
        fill: 0xffffff,
        letterSpacing: 1.2,
      },
    });
    const desc = new Text({
      text: u.desc,
      style: {
        fontFamily: FONT,
        fontSize: 13.5,
        fontWeight: '500',
        fill: 0xa8bad8,
        wordWrap: true,
        wordWrapWidth: textW,
        lineHeight: 19,
      },
    });

    let path: Text | null = null;
    let tick: Text | null = null;
    if (u.note) {
      path = new Text({
        text: `→  ${u.note}`,
        style: {
          fontFamily: FONT,
          fontSize: 11.5,
          fontWeight: '700',
          // The path is tinted by the weapon it leads to, so the eye can follow
          // a build across draws without reading a word.
          fill: u.noteMet ? 0x7dff9b : 0x6f80a6,
          letterSpacing: 0.6,
          wordWrap: true,
          wordWrapWidth: textW - 18,
          lineHeight: 15,
        },
      });
      if (u.noteMet) {
        tick = new Text({
          text: '✓',
          style: { fontFamily: FONT, fontSize: 12, fontWeight: '800', fill: 0x7dff9b },
        });
      }
    }

    const level = new Text({
      text: u.levelLabel,
      style: { fontFamily: FONT, fontSize: 12, fontWeight: '800', fill: u.color, letterSpacing: 1 },
    });

    // Vertical rhythm, measured from the real text boxes.
    const nameH = name.height;
    const descH = desc.height;
    const pathH = path ? path.height + 12 : 0;
    const contentHeight = Math.max(
      stacked ? 84 : 132,
      padY * 2 + nameH + 6 + descH + pathH,
    );

    if (stacked) {
      name.x = padX;
      desc.x = padX;
      level.anchor.set(1, 0);
      level.x = w - padX;
    } else {
      name.anchor.set(0.5, 0);
      desc.anchor.set(0.5, 0);
      name.x = w / 2;
      desc.x = w / 2;
      level.anchor.set(1, 0);
      level.x = w - 14;
      level.y = 14;
    }
    card.addChild(name, desc, level);
    if (path) {
      if (stacked) path.x = padX + (tick ? 16 : 0);
      else {
        path.anchor.set(0.5, 0);
        path.x = w / 2;
      }
      card.addChild(path);
      if (tick) {
        tick.x = stacked ? padX : w / 2 - path.width / 2 - 16;
        card.addChild(tick);
      }
    }

    const redraw = (h: number): void => {
      bg.clear();
      // A deeper, slightly cooler body than before, with a hairline inner edge.
      // Flat fills read as placeholder; one inset line is most of what separates
      // a panel that looks designed from one that looks drawn.
      bg.roundRect(0, 0, w, h, 16).fill({ color: 0x111a2c });
      bg.roundRect(0.5, 0.5, w - 1, h - 1, 15.5).stroke({ width: 1, color: 0x243352, alpha: 0.9 });
      bg.roundRect(0, 0, w, h, 16).stroke({ width: 2, color: u.color, alpha: 0.55 });
      // Accent slab: the three options read as different in KIND before a single
      // word is processed.
      if (stacked) bg.roundRect(0, 0, 5, h, 2.5).fill({ color: u.color });
      else bg.roundRect(0, 0, w, 5, 2.5).fill({ color: u.color });

      /**
       * Centre the block when there is no evolution path.
       *
       * A card with a path is taller and reads top-down: name, effect, divider,
       * path. A card without one keeps the same minimum height so the row is not
       * ragged — but top-aligning its two lines inside that height leaves a band
       * of dead space underneath and makes the shorter cards look unfinished
       * next to the taller ones.
       */
      const blockH = nameH + 6 + descH;
      const y0 = path ? padY : Math.round((h - blockH) / 2);
      if (stacked) {
        name.y = y0;
        desc.y = y0 + nameH + 6;
        level.y = path ? y0 + 2 : Math.round((h - level.height) / 2);
        if (path) {
          const py = y0 + nameH + 6 + descH + 11;
          // A hairline divider before the path, so "what it becomes" is visibly
          // a different statement from "what it does".
          bg.moveTo(padX, py - 7).lineTo(w - padX, py - 7)
            .stroke({ width: 1, color: 0x243352, alpha: 0.85 });
          path.y = py;
          if (tick) tick.y = py;
        }
      } else {
        const top = path ? 22 : Math.round((h - blockH) / 2) - 4;
        name.y = top;
        desc.y = top + nameH + 6;
        if (path) {
          const py = h - path.height - 16;
          bg.moveTo(16, py - 9).lineTo(w - 16, py - 9)
            .stroke({ width: 1, color: 0x243352, alpha: 0.85 });
          path.y = py;
          if (tick) tick.y = py;
        }
      }
      card.hitArea = new Rectangle(0, 0, w, h);
      if (banishDot) {
        banishDot.x = w - 24;
        banishDot.y = stacked ? 22 : h - 22;
      }
    };

    card.eventMode = 'static';
    card.cursor = 'pointer';
    card.on('pointertap', () => this.onPick?.(u.id));

    /**
     * Banish. A small x on the card's trailing edge.
     *
     * Never on an evolution — banishing your own build's payoff is never what
     * a player means, and a mis-tap doing it would be unrecoverable. It sits
     * clear of the card's own tap target so choosing and removing cannot be
     * confused, and it disappears entirely once the run's three are spent.
     */
    if (this.onBanish && this.banishesLeft > 0 && u.kind !== 'evolution') {
      const bx = new Container();
      const bg2 = new Graphics();
      const size = 30;
      bg2.circle(0, 0, size / 2).fill({ color: 0x0d1424, alpha: 0.92 });
      bg2.circle(0, 0, size / 2).stroke({ width: 1, color: 0x39476b });
      const k = 6;
      bg2.moveTo(-k, -k).lineTo(k, k).stroke({ width: 2, color: 0x8093b8 });
      bg2.moveTo(k, -k).lineTo(-k, k).stroke({ width: 2, color: 0x8093b8 });
      bx.addChild(bg2);
      bx.eventMode = 'static';
      bx.cursor = 'pointer';
      bx.hitArea = new Rectangle(-22, -22, 44, 44);
      bx.on('pointertap', (e) => {
        e.stopPropagation();
        this.onBanish?.(u.id);
      });
      card.addChild(bx);
      banishDot = bx;
    }

    return { container: card, contentHeight, redraw };
  }
}


/**
 * The boon offer — the reward for killing a boss.
 *
 * Deliberately NOT the card overlay with different text. A card is a small,
 * frequent, additive choice; a boon is rare, permanent for the run, and always
 * costs something. It gets the centre of the screen rather than the thumb rest,
 * a heavier frame, and the gain and the cost on separate lines with different
 * weights — because the cost is the part players will otherwise skip, and the
 * whole design depends on them reading it.
 */
export class BoonOverlay {
  readonly container = new Container();
  private readonly dim = new Graphics();
  private readonly cards = new Container();
  private readonly title = new Text({
    text: 'THE BOSS FALLS',
    style: { fontFamily: FONT, fontSize: 13, fontWeight: '800', fill: 0xffd23a, letterSpacing: 4 },
  });
  private readonly sub = new Text({
    text: 'TAKE ONE — EACH HAS A PRICE',
    style: { fontFamily: FONT, fontSize: 10, fontWeight: '700', fill: 0x7c8db3, letterSpacing: 2 },
  });

  onPick: ((id: string) => void) | null = null;
  private width = 0;
  private height = 0;
  private shown: BoonId[] = [];

  constructor() {
    this.title.anchor.set(0.5, 0);
    this.sub.anchor.set(0.5, 0);
    this.container.addChild(this.dim, this.title, this.sub, this.cards);
    this.container.visible = false;
  }

  resize(width: number, height: number): void {
    this.width = width;
    this.height = height;
    this.dim.clear();
    this.dim.rect(0, 0, width, height).fill({ color: 0x05070f, alpha: 0.72 });
    if (this.container.visible) this.layout();
  }

  hide(): void {
    this.container.visible = false;
    this.cards.removeChildren();
  }

  /** Pick by index, so 1/2/3 work here exactly as they do on the card screen. */
  pickByIndex(i: number): void {
    const id = this.shown[i];
    if (this.container.visible && id) this.onPick?.(id);
  }

  show(ids: readonly BoonId[]): void {
    this.shown = [...ids];
    this.container.visible = true;
    this.layout();
  }

  private layout(): void {
    this.cards.removeChildren();
    const w = this.width;
    const h = this.height;
    const n = this.shown.length;
    const cw = Math.min(w - 36, 430);
    const ch = 92;
    const gap = 12;
    const totalH = n * ch + (n - 1) * gap;
    const top = Math.max(96, (h - totalH) / 2 + 14);

    this.title.x = w / 2;
    this.title.y = top - 58;
    this.sub.x = w / 2;
    this.sub.y = top - 36;

    for (let i = 0; i < n; i++) {
      const b = BOONS[this.shown[i]!];
      const y = top + i * (ch + gap);
      const x = (w - cw) / 2;
      const card = new Container();

      const g = new Graphics();
      g.roundRect(x, y, cw, ch, 16).fill({ color: 0x121a2c });
      g.roundRect(x + 0.5, y + 0.5, cw - 1, ch - 1, 15.5).stroke({ width: 1, color: 0x2b3a5c });
      g.roundRect(x, y, cw, ch, 16).stroke({ width: 2, color: b.color, alpha: 0.75 });
      g.roundRect(x, y, 5, ch, 2.5).fill({ color: b.color });
      card.addChild(g);

      const name = new Text({
        text: b.name,
        style: { fontFamily: FONT, fontSize: 18, fontWeight: '800', fill: b.color, letterSpacing: 1.4 },
      });
      name.x = x + 22;
      name.y = y + 14;
      card.addChild(name);

      const gain = new Text({
        text: b.gain,
        style: { fontFamily: FONT, fontSize: 13, fontWeight: '600', fill: 0xdce6f7,
                 wordWrap: true, wordWrapWidth: cw - 44, lineHeight: 17 },
      });
      gain.x = x + 22;
      gain.y = y + 40;
      card.addChild(gain);

      // The cost gets its own colour and its own line. It is the half players
      // skim past, and every one of these is a real trade.
      const cost = new Text({
        text: `\u2212  ${b.cost}`,
        style: { fontFamily: FONT, fontSize: 11.5, fontWeight: '700', fill: 0xff7a8a,
                 wordWrap: true, wordWrapWidth: cw - 44, lineHeight: 15 },
      });
      cost.x = x + 22;
      cost.y = y + ch - 26;
      card.addChild(cost);

      card.eventMode = 'static';
      card.cursor = 'pointer';
      card.hitArea = new Rectangle(x, y, cw, ch);
      card.on('pointertap', () => this.onPick?.(b.id));
      this.cards.addChild(card);
    }
  }
}
