import { Container, Graphics, Rectangle, Text } from 'pixi.js';
import { clamp } from '@arcade/core';
import { CHARACTERS, type Character } from '../content/characters.js';
import type { Achievement } from '../content/achievements.js';
import { ASCENSIONS, MAX_ASCENSION } from '../content/ascension.js';
import { MASTERY_MAX } from '../content/mastery.js';

const FONT = 'system-ui, -apple-system, Segoe UI, Roboto, sans-serif';

/** Clear space between any tappable control and the rewarded-ad button. */
const AD_KEEPOUT = 28;

/** Minimum touch target. Below this a control is a coin flip on a phone. */
const MIN_TOUCH = 44;

/**
 * Bottom safe-area inset, read once from the platform.
 *
 * On a notched phone the home indicator sits over roughly the bottom 34px, and
 * PLAY AGAIN was anchored 14px from the bottom edge — i.e. underneath it. The
 * page already sets viewport-fit=cover, which is what makes the inset readable
 * at all; nothing was reading it.
 */
function safeBottom(): number {
  if (typeof document === 'undefined') return 0;
  const probe = document.createElement('div');
  probe.style.cssText =
    'position:fixed;bottom:0;left:0;width:0;height:env(safe-area-inset-bottom,0px);';
  document.body.appendChild(probe);
  const v = probe.getBoundingClientRect().height || 0;
  probe.remove();
  return Math.min(48, v);
}
let SAFE_BOTTOM = -1;

export interface ResultsData {
  time: number;
  level: number;
  kills: number;
  bestTime: number;
  isBest: boolean;
  goldEarned: number;
  totalGoldBefore: number;
  totalGoldAfter: number;
  canDoubleGold: boolean;
  /** Characters this run's gold pushed past. */
  crossed: Character[];
  /** Achievements earned by this run. */
  earned: Achievement[];
  selectedCharacter: string;
  totalGold: number;
  achievementsHeld: number;
  achievementsTotal: number;
  /** Whether the next run shares the tide with seven others. */
  arenaMode: boolean;
  /** Finishing place in the lobby, 1-based. Zero in a solo run. */
  arenaPlace: number;
  arenaSeats: number;
  /** Who was leading when the run ended. Empty in a solo run. */
  arenaLeader: string;
  arenaScore: number;
  pvpKills: number;
  arenaStreak: number;
  deathCause: string;
  arenaBestMass: number;
  arenaWins: number;
  arenaMassBest: boolean;
}

/** 1 -> "1ST". Matches the HUD's live standing so the two cannot disagree. */
function ordinalOf(n: number): string {
  const tens = n % 100;
  if (tens >= 11 && tens <= 13) return `${n}TH`;
  switch (n % 10) {
    case 1:
      return `${n}ST`;
    case 2:
      return `${n}ND`;
    case 3:
      return `${n}RD`;
    default:
      return `${n}TH`;
  }
}

function mmss(t: number): string {
  const m = Math.floor(t / 60);
  const s = Math.floor(t % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

/**
 * The results screen — the single most important retention surface in the game.
 *
 * Ordering is the design:
 *   1. what you just did (time vs best, achievements earned)
 *   2. what you gained (gold animating into a bar toward a named character)
 *   3. WHAT YOU COULD DO NEXT (the character strip)
 *   4. one enormous PLAY AGAIN in thumb reach
 *
 * Step 3 is the piece that turns "I died" into "I want to try WARD". Before the
 * strip existed the ladder pointed at nothing and every run opened identically,
 * which is what caps a survivor-like at a handful of sessions. Locked characters
 * are shown too, greyed with their price — the target has to be visible to pull.
 *
 * DOUBLE GOLD sits beside PLAY AGAIN, never in front of it. The moment a player
 * feels taxed rather than given to, retention drops and traffic follows.
 */
export class ResultsScreen {
  readonly container = new Container();

  onRestart: (() => void) | null = null;
  onDoubleGold: (() => void) | null = null;
  onSelectCharacter: ((id: string) => void) | null = null;
  onOpenAchievements: (() => void) | null = null;
  onOpenForge: (() => void) | null = null;
  /**
   * Sign in to save progress. Null when the host has no account system, in
   * which case the control is never drawn — a dead button is worse than none.
   */
  onSignIn: (() => void) | null = null;
  /** Step the chosen difficulty tier by +1 or -1. */
  onAscension: ((delta: number) => void) | null = null;
  /** Mastery of the character just played — shown as a bar under its chip. */
  private masteryFor: { id: string; level: number; into: number; need: number } | null = null;
  private ascension = 0;
  private ascensionMax = 0;
  private readonly ascRow = new Container();
  private readonly ascG = new Graphics();
  private readonly ascName = new Text({
    text: '',
    style: { fontFamily: FONT, fontSize: 12, fontWeight: '800', fill: 0xffffff, letterSpacing: 1.5 },
  });
  private readonly ascEffect = new Text({
    text: '',
    style: { fontFamily: FONT, fontSize: 10, fontWeight: '600', fill: 0x7c8db3 },
  });
  private readonly ascLeft = new Container();
  private readonly ascRight = new Container();
  private signedIn = false;
  private readonly signInChip = new Container();
  private readonly signInG = new Graphics();
  private readonly signInLabel = new Text({
    text: '',
    style: { fontFamily: FONT, fontSize: 11, fontWeight: '800', fill: 0x7c8db3, letterSpacing: 1 },
  });
  onSelectSolo: (() => void) | null = null;
  onSelectMultiplayer: (() => void) | null = null;

  private readonly dim = new Graphics();
  private readonly bars = new Graphics();
  private readonly chips = new Container();

  private readonly timeText = new Text({
    text: '0:00',
    style: { fontFamily: FONT, fontSize: 54, fontWeight: '800', fill: 0xffffff },
  });
  private readonly bestText = new Text({
    text: '',
    style: { fontFamily: FONT, fontSize: 13, fontWeight: '700', fill: 0x8fa3c8, letterSpacing: 1 },
  });
  private readonly deathText = new Text({
    text: '',
    style: { fontFamily: FONT, fontSize: 11, fontWeight: '800', fill: 0xff7188, letterSpacing: 1.3, align: 'center' },
  });
  private readonly achieveText = new Text({
    text: '',
    style: { fontFamily: FONT, fontSize: 13, fontWeight: '800', fill: 0xffd23a, letterSpacing: 1, align: 'center' },
  });
  private readonly goldText = new Text({
    text: '',
    style: { fontFamily: FONT, fontSize: 16, fontWeight: '800', fill: 0xffd23a },
  });
  private readonly unlockText = new Text({
    text: '',
    style: { fontFamily: FONT, fontSize: 12, fontWeight: '700', fill: 0x8fa3c8, letterSpacing: 1 },
  });
  private readonly pickLabel = new Text({
    text: 'NEXT RUN',
    style: { fontFamily: FONT, fontSize: 10, fontWeight: '800', fill: 0x5f7099, letterSpacing: 2 },
  });

  /** Tappable counter — the only route to the achievements list. */
  /**
   * The way into the Forge, and the only place gold can be spent.
   *
   * It lives on the results board because that is the one moment a player is
   * already stopped and already looking at the gold they just earned. Putting
   * it before the run instead would add a menu, and the no-menu decision in
   * main.ts is the best acquisition call in the codebase.
   */
  private readonly forgeChip = new Container();
  private readonly forgeG = new Graphics();
  private readonly forgeLabel = new Text({
    text: '',
    style: { fontFamily: FONT, fontSize: 12, fontWeight: '800', fill: 0xffd23a, letterSpacing: 1.5 },
  });
  private forgeAffordable = false;

  private readonly achieveCount = new Text({
    text: '',
    style: { fontFamily: FONT, fontSize: 14, fontWeight: '800', fill: 0x9db0d4, letterSpacing: 1 },
  });

  /** Direct next-run mode choices. */
  private readonly soloChip = new Container();
  private readonly multiplayerChip = new Container();

  private readonly playButton = new Container();
  private readonly doubleButton = new Container();

  private width = 0;
  private height = 0;
  private data: ResultsData | null = null;
  private anim = 0;
  private doubled = false;
  private arenaOnline = false;

  setArenaOnline(online: boolean): void {
    this.arenaOnline = online;
    if (this.container.visible) this.layout();
  }

  constructor() {
    for (const t of [this.timeText, this.bestText, this.deathText, this.achieveText, this.goldText, this.unlockText, this.pickLabel, this.achieveCount]) {
      t.anchor.set(0.5);
    }
    this.ascRow.addChild(this.ascG, this.ascName, this.ascEffect);
    for (const [btn, delta] of [[this.ascLeft, -1], [this.ascRight, 1]] as const) {
      btn.eventMode = 'static';
      btn.cursor = 'pointer';
      btn.on('pointertap', (e) => {
        e.stopPropagation();
        this.onAscension?.(delta);
      });
      this.ascRow.addChild(btn);
    }

    this.signInChip.addChild(this.signInG);
    this.signInChip.addChild(this.signInLabel);
    this.signInChip.eventMode = 'static';
    this.signInChip.cursor = 'pointer';
    this.signInChip.visible = false;
    this.signInChip.on('pointertap', (e) => {
      e.stopPropagation();
      this.onSignIn?.();
    });

    this.forgeChip.addChild(this.forgeG);
    this.forgeChip.addChild(this.forgeLabel);
    this.forgeChip.eventMode = 'static';
    this.forgeChip.cursor = 'pointer';
    this.forgeChip.on('pointertap', (e) => {
      e.stopPropagation();
      this.onOpenForge?.();
    });

    this.achieveCount.eventMode = 'static';
    this.achieveCount.cursor = 'pointer';
    // 44px minimum touch target — it was 36 and it is the only entry point to
    // the meta-progression list.
    this.achieveCount.hitArea = new Rectangle(-110, -24, 220, 48);
    this.achieveCount.on('pointertap', () => this.onOpenAchievements?.());

    const soloBg = new Graphics();
    soloBg.label = 'bg';
    const soloLabel = new Text({
      text: '',
      style: { fontFamily: FONT, fontSize: 11, fontWeight: '800', fill: 0x9db0d4, letterSpacing: 1 },
    });
    soloLabel.label = 'label';
    soloLabel.anchor.set(0.5);
    this.soloChip.addChild(soloBg, soloLabel);
    this.soloChip.eventMode = 'static';
    this.soloChip.cursor = 'pointer';
    this.soloChip.on('pointertap', () => this.onSelectSolo?.());

    // Multiplayer is a direct peer of Solo; neither is hidden behind cycling.
    const arenaBg = new Graphics();
    arenaBg.label = 'bg';
    const arenaLabel = new Text({
      text: '',
      style: { fontFamily: FONT, fontSize: 11, fontWeight: '800', fill: 0x9db0d4, letterSpacing: 1 },
    });
    arenaLabel.label = 'label';
    arenaLabel.anchor.set(0.5);
    this.multiplayerChip.addChild(arenaBg, arenaLabel);
    this.multiplayerChip.eventMode = 'static';
    this.multiplayerChip.cursor = 'pointer';
    this.multiplayerChip.on('pointertap', () => this.onSelectMultiplayer?.());

    this.container.addChild(
      this.dim,
      this.timeText,
      this.bestText,
      this.deathText,
      this.achieveText,
      this.bars,
      this.goldText,
      this.unlockText,
      this.pickLabel,
      this.achieveCount,
      this.forgeChip,
      this.ascRow,
      this.signInChip,
      this.soloChip,
      this.multiplayerChip,
      this.chips,
      this.doubleButton,
      this.playButton,
    );
    this.container.visible = false;

    this.buildButton(this.playButton, 'PLAY AGAIN', 0x5cd0ff, 0x08131f, () => this.onRestart?.());
    // Both rewarded buttons must say so. On our own domain LocalPortal resolves
    // instantly, so undisclosed ads would never surface in our own testing and
    // would surface on the portal. 9 of 13 evaluators flagged it.
    this.buildButton(this.doubleButton, '▶ DOUBLE GOLD · AD', 0xffd23a, 0x1a1405, () => {
      if (!this.doubled) this.onDoubleGold?.();
    });
  }

  private buildButton(
    target: Container,
    label: string,
    color: number,
    textColor: number,
    onTap: () => void,
  ): void {
    const bg = new Graphics();
    bg.label = 'bg';
    const text = new Text({
      text: label,
      style: { fontFamily: FONT, fontSize: 18, fontWeight: '800', fill: textColor, letterSpacing: 1 },
    });
    text.label = 'label';
    text.anchor.set(0.5);
    target.addChild(bg, text);
    target.eventMode = 'static';
    target.cursor = 'pointer';
    // Explicit hitArea: Pixi v8 does not hit-test 'passive' children, so a
    // Container without one is silently untappable.
    target.hitArea = new Rectangle(0, 0, 10, 10);
    // 'pointertap', not 'pointerdown' — same reason as the level-up cards. A
    // press that drags away must not commit, and the results buttons sit in the
    // same thumb zone the player was just steering in.
    target.on('pointertap', onTap);
    (target as Container & { _accent: number })._accent = color;
  }

  private drawButton(target: Container, w: number, h: number, enabled: boolean): void {
    const bg = target.getChildByLabel('bg') as Graphics;
    const text = target.getChildByLabel('label') as Text;
    const accent = (target as Container & { _accent: number })._accent;
    bg.clear();
    bg.roundRect(0, 0, w, h, h / 2).fill({ color: accent, alpha: enabled ? 1 : 0.25 });
    text.x = w / 2;
    text.y = h / 2;
    text.alpha = enabled ? 1 : 0.45;
    target.hitArea = new Rectangle(0, 0, w, h);
    target.eventMode = enabled ? 'static' : 'none';
  }

  resize(width: number, height: number): void {
    this.width = width;
    this.height = height;
    this.dim.clear();
    this.dim.rect(0, 0, width, height).fill({ color: 0x05070f, alpha: 0.88 });
    this.layout();
  }

  private layout(): void {
    const w = this.width;
    const h = this.height;
    const cx = w / 2;
    const tight = h < 560;
    const btnW = Math.min(w - 40, 420);
    const btnH = tight ? 46 : 58;
    if (SAFE_BOTTOM < 0) SAFE_BOTTOM = safeBottom();
    const playY = h - (tight ? 14 : 26) - btnH - SAFE_BOTTOM;
    const dblH = tight ? 36 : 44;
    const dblY = playY - (tight ? 6 : 10) - dblH;

    this.playButton.x = cx - btnW / 2;
    this.playButton.y = playY;
    this.drawButton(this.playButton, btnW, btnH, true);

    this.doubleButton.x = cx - btnW / 2;
    this.doubleButton.y = dblY;
    this.drawButton(this.doubleButton, btnW, dblH, !!this.data?.canDoubleGold && !this.doubled);

    const stripBottom = dblY - AD_KEEPOUT;
    const chipH = tight ? 30 : 34;
    const chipGap = tight ? 4 : 6;
    const chipW = Math.min((Math.min(w - 32, 420) - chipGap * 2) / 3, 138);
    const rows = 2;
    const stripH = rows * chipH + chipGap;
    const stripTop = stripBottom - stripH;

    this.drawChips(cx, stripTop, chipW, chipH, chipGap);
    this.pickLabel.x = cx;
    this.pickLabel.y = stripTop - 14;
    const modeW = Math.min(this.width - 40, 360);
    const modeY = stripTop - (tight ? 54 : 68);
    this.drawMode(cx, modeY, modeW);

    const wrapAt = Math.min(w - 32, 420);
    for (const t of [this.achieveText, this.achieveCount, this.deathText]) {
      t.style.wordWrap = true;
      t.style.wordWrapWidth = wrapAt;
    }

    if (tight) {
      // Short landscape: preserve result, reward, next build and rematch. Meta
      // utilities remain available after the next portrait/desktop death.
      this.timeText.x = this.bestText.x = this.deathText.x = this.goldText.x = this.unlockText.x = cx;
      this.timeText.y = 22;
      this.bestText.y = 63;
      this.deathText.y = 82;
      this.goldText.y = 108;
      this.unlockText.y = 132;
      this.timeText.style.fontSize = 34;
      this.achieveText.visible = false;
      this.achieveCount.visible = false;
      this.forgeChip.visible = false;
      this.signInChip.visible = false;
      this.ascRow.visible = false;
    } else {
      const top = Math.max(78, Math.min(132, h * 0.15));
      this.timeText.x = this.bestText.x = this.deathText.x = this.achieveText.x = cx;
      this.goldText.x = this.unlockText.x = this.achieveCount.x = cx;
      this.timeText.y = top;
      this.bestText.y = top + 60;
      this.deathText.y = top + 84;
      this.achieveText.y = top + 110;
      this.goldText.y = top + 145;
      this.unlockText.y = top + 186;
      this.achieveCount.y = top + 214;
      this.timeText.style.fontSize = 54;
      this.achieveText.visible = true;
      this.achieveCount.visible = true;
      this.forgeChip.visible = true;
      this.layoutForgeChip(cx, top + 214);
      this.layoutSignIn(cx, top + 270);
      this.layoutAscension(cx, Math.min(modeY - 50, top + 310));
    }

    // Interactive controls must remain above the animated gold bar.
    for (const child of [this.soloChip, this.multiplayerChip, this.doubleButton, this.playButton]) {
      this.container.setChildIndex(child, this.container.children.length - 1);
    }
  }

  private drawChips(cx: number, top: number, chipW: number, chipH: number, gap: number): void {
    this.chips.removeChildren();
    const d = this.data;
    const totalGold = d?.totalGold ?? 0;
    const selected = d?.selectedCharacter ?? CHARACTERS[0]!.id;
    const rowW = chipW * 3 + gap * 2;
    const left = cx - rowW / 2;

    for (let i = 0; i < CHARACTERS.length; i++) {
      const c = CHARACTERS[i]!;
      const unlocked = totalGold >= c.unlockGold;
      const isSel = c.id === selected;
      const col = i % 3;
      const row = Math.floor(i / 3);
      const x = left + col * (chipW + gap);
      const y = top + row * (chipH + gap);

      const chip = new Container();
      chip.x = x;
      chip.y = y;
      // Hit area is the TOUCH target, not the drawn box — expanded upward and
      // sideways only, never downward, so growing it cannot reach toward the
      // rewarded-ad button below.
      const padY = Math.max(0, (MIN_TOUCH - chipH) / 2);
      chip.hitArea = new Rectangle(-2, -padY * 2, chipW + 4, chipH + padY * 2);

      const bg = new Graphics();
      if (isSel) {
        bg.roundRect(0, 0, chipW, chipH, 8).fill({ color: c.color, alpha: 0.22 });
        bg.roundRect(0, 0, chipW, chipH, 8).stroke({ width: 2, color: c.color });
      } else {
        bg.roundRect(0, 0, chipW, chipH, 8).fill({ color: 0x121a2c, alpha: unlocked ? 1 : 0.55 });
        bg.roundRect(0, 0, chipW, chipH, 8).stroke({
          width: 1,
          color: unlocked ? 0x2b3a5c : 0x1c2438,
        });
      }
      chip.addChild(bg);

      const label = new Text({
        text: unlocked ? c.name : `${c.name}`,
        style: {
          fontFamily: FONT,
          fontSize: 12,
          fontWeight: '800',
          fill: unlocked ? (isSel ? c.color : 0xc8d6ef) : 0x4a5876,
          letterSpacing: 1,
        },
      });
      label.anchor.set(0.5);
      label.x = chipW / 2;
      label.y = unlocked ? chipH / 2 : chipH / 2 - 6;
      chip.addChild(label);

      if (!unlocked) {
        // The price is the pull. A locked slot with no number is just absence.
        const cost = new Text({
          text: `${c.unlockGold}g`,
          style: { fontFamily: FONT, fontSize: 10, fontWeight: '700', fill: 0xffd23a },
        });
        cost.anchor.set(0.5);
        cost.x = chipW / 2;
        cost.y = chipH / 2 + 8;
        cost.alpha = 0.75;
        chip.addChild(cost);
      } else {
        chip.eventMode = 'static';
        chip.cursor = 'pointer';
        // Deliberately does NOT reassign hitArea — the expanded 44px target is
        // set once where the chip is created. Setting it again here silently
        // shrank every selectable character back to its drawn height, which is
        // the half of the roster a player can actually tap.
        chip.on('pointertap', () => this.onSelectCharacter?.(c.id));
      }

      /**
       * Mastery, drawn on the chip of the character just played.
       *
       * A thin fill along the chip's bottom edge plus the level. It belongs
       * here rather than in a separate panel because this is the exact moment
       * the player is deciding who to take next, and "your WARD is level 3"
       * is the argument for taking WARD again.
       */
      const m = this.masteryFor;
      if (m && m.id === c.id && (m.level > 0 || m.into > 0)) {
        const frac = m.need > 0 ? Math.min(1, m.into / m.need) : 1;
        bg.rect(0, chipH - 3, chipW, 3).fill({ color: 0x1c2438 });
        if (frac > 0) bg.rect(0, chipH - 3, chipW * frac, 3).fill({ color: c.color, alpha: 0.9 });
        if (m.level > 0) {
          const lvl = new Text({
            text: `${m.level}${m.level >= MASTERY_MAX ? '' : ''}`,
            style: { fontFamily: FONT, fontSize: 9, fontWeight: '800', fill: c.color },
          });
          lvl.anchor.set(1, 0);
          lvl.x = chipW - 5;
          lvl.y = 3;
          chip.addChild(lvl);
        }
      }

      this.chips.addChild(chip);
    }
  }

  /**
   * FORGE chip, directly under the achievement counter.
   *
   * It pulses its border when something is affordable. That is the entire
   * notification design — no badge, no red dot, no count. A player who cannot
   * afford anything sees a quiet button; a player who can sees it asking.
   */
  private layoutForgeChip(cx: number, achieveY: number): void {
    const g = this.forgeG;
    g.clear();
    const w = 150;
    const h = 32;
    const x = cx - w / 2;
    const y = achieveY + 20;
    const hot = this.forgeAffordable;
    g.roundRect(x, y, w, h, 16).fill({ color: hot ? 0x1e1a0a : 0x101728 });
    g.roundRect(x, y, w, h, 16).stroke({
      width: 1.5,
      color: hot ? 0xffd23a : 0x24304a,
      alpha: hot ? 0.95 : 0.7,
    });
    this.forgeLabel.text = hot ? '\u2699 THE FORGE  \u00b7  READY' : '\u2699 THE FORGE';
    this.forgeLabel.style.fill = hot ? 0xffd23a : 0x7c8db3;
    this.forgeLabel.anchor.set(0.5);
    this.forgeLabel.x = cx;
    this.forgeLabel.y = y + h / 2;
    const fPad = Math.max(0, (MIN_TOUCH - h) / 2);
    this.forgeChip.hitArea = new Rectangle(x, y - fPad * 2, w, h + fPad * 2);
  }

  setMastery(id: string, m: { level: number; into: number; need: number }): void {
    this.masteryFor = { id, ...m };
    if (this.container.visible) this.layout();
  }

  setAscension(level: number, maxUnlocked: number): void {
    this.ascension = level;
    this.ascensionMax = maxUnlocked;
    if (this.container.visible) this.layout();
  }

  /**
   * The difficulty selector.
   *
   * Sits directly above NEXT RUN because it IS a next-run decision, and it is
   * deliberately quiet at tier 0 — a new player should never be asked to pick a
   * difficulty before they know what the standard one feels like. It only
   * starts advertising itself once they have earned a rung, at which point the
   * gold multiplier is shown, because that is what makes climbing worth it.
   */
  private layoutAscension(cx: number, y: number): void {
    const g = this.ascG;
    g.clear();
    // Nothing to choose until the first rung is earned.
    const show = this.ascensionMax > 0;
    this.ascRow.visible = show;
    if (!show) return;

    const t = ASCENSIONS[Math.min(MAX_ASCENSION, this.ascension)]!;
    const w = Math.min(this.width - 40, 330);
    const h = 40;
    const x = cx - w / 2;
    const hot = this.ascension > 0;

    g.roundRect(x, y, w, h, 10).fill({ color: hot ? 0x1c1224 : 0x101728, alpha: 0.95 });
    g.roundRect(x, y, w, h, 10).stroke({
      width: 1.5,
      color: hot ? 0xb478ff : 0x24304a,
      alpha: hot ? 0.9 : 0.7,
    });

    this.ascName.text = t.gold > 1 ? `${t.name}   ×${t.gold} GOLD` : t.name;
    this.ascName.style.fill = hot ? 0xd9b3ff : 0x9db0d4;
    this.ascName.anchor.set(0.5, 0);
    this.ascName.x = cx;
    this.ascName.y = y + 7;
    this.ascEffect.text = t.effect;
    this.ascEffect.anchor.set(0.5, 0);
    this.ascEffect.x = cx;
    this.ascEffect.y = y + 23;

    // Arrows, drawn only where there is somewhere to go.
    const canDown = this.ascension > 0;
    const canUp = this.ascension < this.ascensionMax;
    for (const [side, on] of [[-1, canDown], [1, canUp]] as const) {
      const ax = side < 0 ? x + 22 : x + w - 22;
      const ay = y + h / 2;
      g.moveTo(ax + side * -5, ay - 7)
        .lineTo(ax + side * 5, ay)
        .lineTo(ax + side * -5, ay + 7)
        .closePath()
        .fill({ color: on ? 0xd9b3ff : 0x2b3a5c, alpha: on ? 0.95 : 0.5 });
    }
    // Full-height targets on each end, comfortably over the 44px minimum.
    this.ascLeft.hitArea = new Rectangle(x, y - 4, 56, h + 8);
    this.ascRight.hitArea = new Rectangle(x + w - 56, y - 4, 56, h + 8);
  }

  setSignedIn(v: boolean): void {
    this.signedIn = v;
    if (this.container.visible) this.layout();
  }

  /**
   * A quiet line under the Forge chip: signed in, or an offer to.
   *
   * Never a modal, never at boot. It has to be findable by a player who has
   * built something worth keeping and invisible to one who has just arrived.
   */
  private layoutSignIn(cx: number, y: number): void {
    const g = this.signInG;
    g.clear();
    const show = !!this.onSignIn || this.signedIn;
    this.signInChip.visible = show;
    if (!show) return;
    const w = 176;
    const h = 26;
    const x = cx - w / 2;
    this.signInLabel.text = this.signedIn ? '\u2601 PROGRESS SAVED' : '\u2601 SAVE PROGRESS';
    this.signInLabel.style.fill = this.signedIn ? 0x5fbf8a : 0x7c8db3;
    if (!this.signedIn) {
      g.roundRect(x, y, w, h, 13).fill({ color: 0x101728, alpha: 0.9 });
      g.roundRect(x, y, w, h, 13).stroke({ width: 1, color: 0x24304a });
    }
    this.signInLabel.anchor.set(0.5);
    this.signInLabel.x = cx;
    this.signInLabel.y = y + h / 2;
    const pad = Math.max(0, (MIN_TOUCH - h) / 2);
    // Expanded upward only, so it never grows toward the ad button below.
    this.signInChip.hitArea = this.signedIn
      ? new Rectangle(0, 0, 0, 0)
      : new Rectangle(x, y - pad * 2, w, h + pad * 2);
  }

  /** Whether anything in the Forge is currently affordable. */
  setForgeAffordable(v: boolean): void {
    this.forgeAffordable = v;
    if (this.container.visible) this.layout();
  }

  /**
   * Exactly two direct choices. No cycling, no hidden third mode, no guessing
   * what a tap will select.
   */
  private drawMode(cx: number, y: number, w: number): void {
    const d = this.data;
    const arena = !!d?.arenaMode;
    const h = 36;
    const gap = 8;
    const half = (w - gap) / 2;
    const draw = (chip: Container, selected: boolean, labelText: string, accent: number): void => {
      const bg = chip.getChildByLabel('bg') as Graphics;
      const label = chip.getChildByLabel('label') as Text;
      bg.clear();
      bg.roundRect(0, 0, half, h, 18).fill({ color: selected ? 0x17283a : 0x0d1422 });
      bg.roundRect(0, 0, half, h, 18).stroke({ width: selected ? 2 : 1, color: selected ? accent : 0x2a3752 });
      label.text = labelText;
      label.style.fill = selected ? accent : 0x7183a3;
      label.x = half / 2;
      label.y = h / 2;
      chip.hitArea = new Rectangle(0, -4, half, h + 8);
      chip.visible = true;
    };
    draw(this.soloChip, !arena, 'SOLO', 0x5cd0ff);
    draw(this.multiplayerChip, arena, this.arenaOnline ? 'MULTIPLAYER' : 'MULTIPLAYER · AI', 0xff647d);
    this.soloChip.x = cx - w / 2;
    this.multiplayerChip.x = this.soloChip.x + half + gap;
    this.soloChip.y = this.multiplayerChip.y = y;
    const pad = Math.max(0, (MIN_TOUCH - h) / 2);
    this.soloChip.hitArea = new Rectangle(0, -pad, half, h + pad * 2);
    this.multiplayerChip.hitArea = new Rectangle(0, -pad, half, h + pad * 2);
  }

  show(data: ResultsData): void {
    this.data = data;
    this.anim = 0;
    this.doubled = false;
    this.container.visible = true;

    this.timeText.text = data.arenaMode ? `#${data.arenaPlace}` : mmss(data.time);
    this.timeText.style.fill = data.arenaMode
      ? data.arenaPlace === 1 ? 0xffd166 : 0xf2f7ff
      : data.isBest ? 0xffd23a : 0xffffff;
    // In the arena the placing IS the result. The personal best still matters,
    // but "3rd of 8" is what a player came for and what they will try to beat,
    // so it takes the line directly under the clock.
    if (data.arenaMode && data.arenaPlace > 0) {
      const won = data.arenaPlace === 1;
      this.bestText.text = `${Math.floor(data.arenaScore)} MASS  ·  ${data.pvpKills} RIVAL${data.pvpKills === 1 ? '' : 'S'} DOWN`;
      this.bestText.style.fill = won ? 0xffd166 : 0xc08cff;
      this.deathText.text = won
        ? `CROWN TAKEN  ·  ${mmss(data.time)}`
        : `${ordinalOf(data.arenaPlace)} OF ${data.arenaSeats}  ·  ${data.deathCause}`;
    } else {
      this.bestText.text = data.isBest ? 'NEW BEST' : `BEST  ${mmss(data.bestTime)}`;
      this.bestText.style.fill = data.isBest ? 0xffd166 : 0x8195ba;
      this.deathText.text = `${data.deathCause}  ·  LV ${data.level}  ·  ${data.kills} KILLS`;
    }

    // Cap the list, then let it wrap.
    //
    // This was every earned name joined into one centred, unwrapped, unclamped
    // Text. With five achievements it overflowed the screen and was clipped
    // mid-word at BOTH edges — the reward for the best run a player had yet
    // produced read as "...CULLING ★ TIDE ★ STANDING ★ GIANT KILLER ★ ASCENDA".
    // Three names plus a count fits every phone, and the full list already
    // lives one tap away in the achievements panel.
    const MAX_NAMES = 3;
    if (data.earned.length === 0) {
      this.achieveText.text = data.arenaMode
        ? data.arenaMassBest
          ? '◆ NEW MASS BEST'
          : `BEST MASS  ${Math.floor(data.arenaBestMass)}  ·  ${data.arenaWins} WIN${data.arenaWins === 1 ? '' : 'S'}`
        : '';
    } else {
      const shown = data.earned.slice(0, MAX_NAMES).map((a) => `★ ${a.name}`);
      const extra = data.earned.length - shown.length;
      this.achieveText.text = shown.join('   ') + (extra > 0 ? `   +${extra} MORE` : '');
    }
    this.achieveCount.text = `★ ACHIEVEMENTS  ${data.achievementsHeld}/${data.achievementsTotal}`;

    const playLabel = this.playButton.getChildByLabel('label') as Text;
    playLabel.text = data.arenaMode
      ? this.arenaOnline ? 'REMATCH ONLINE' : 'REMATCH 7 RIVALS'
      : 'PLAY SOLO AGAIN';

    this.layout();
    this.update(0);
  }

  hide(): void {
    this.container.visible = false;
    this.data = null;
  }

  setMode(arena: boolean): void {
    if (!this.data) return;
    this.data.arenaMode = arena;
    this.layout();
    const label = this.playButton.getChildByLabel('label') as Text;
    label.text = arena
      ? this.arenaOnline ? 'FIND LIVE MATCH' : 'ENTER THE ARENA'
      : 'PLAY SOLO AGAIN';
  }

  /** Reflect a character selection without rebuilding the whole panel. */
  setSelected(id: string): void {
    if (!this.data) return;
    this.data.selectedCharacter = id;
    this.layout();
  }

  applyDoubleGold(newTotal: number, extra: number, crossed: Character[] = []): void {
    if (!this.data) return;
    this.doubled = true;
    this.data.goldEarned += extra;
    this.data.totalGoldAfter = newTotal;
    this.data.totalGold = newTotal;
    this.data.crossed = [...this.data.crossed, ...crossed];
    // Rewind so the bar visibly surges again — watching the number move a
    // second time is the whole reason the ad was worth watching.
    this.anim = 0.35;
    this.layout();
  }

  update(dt: number): void {
    const d = this.data;
    if (!d || !this.container.visible) return;

    this.anim = Math.min(1, this.anim + dt * 0.85);
    const eased = 1 - (1 - this.anim) * (1 - this.anim) * (1 - this.anim);

    const shownGold = Math.floor(d.goldEarned * eased);
    const shownTotal = d.totalGoldBefore + shownGold;
    this.goldText.text = `+${shownGold} GOLD`;

    const g = this.bars;
    g.clear();

    const barW = Math.min(this.width - 60, 400);
    const x = (this.width - barW) / 2;
    const y = this.goldText.y + 20;

    // Next locked character is the bar's target.
    let next: Character | null = null;
    let prevCost = 0;
    for (const c of CHARACTERS) {
      if (shownTotal < c.unlockGold) {
        next = c;
        break;
      }
      prevCost = c.unlockGold;
    }

    const justUnlocked = d.crossed.filter((c) => shownTotal >= c.unlockGold).pop();

    if (next) {
      const span = Math.max(1, next.unlockGold - prevCost);
      const frac = clamp((shownTotal - prevCost) / span, 0, 1);
      g.roundRect(x, y, barW, 9, 4).fill({ color: 0x1c2740 });
      if (frac > 0) g.roundRect(x, y, barW * frac, 9, 4).fill({ color: next.color });
      if (justUnlocked) {
        this.unlockText.text = `UNLOCKED  ${justUnlocked.name}`;
        this.unlockText.style.fill = justUnlocked.color;
      } else {
        this.unlockText.text = `NEXT  ${next.name}  ·  ${Math.max(0, next.unlockGold - shownTotal)} TO GO`;
        this.unlockText.style.fill = next.color;
      }
    } else {
      g.roundRect(x, y, barW, 9, 4).fill({ color: 0xb478ff });
      this.unlockText.text = justUnlocked ? `UNLOCKED  ${justUnlocked.name}` : 'ALL UNLOCKED';
      this.unlockText.style.fill = 0xffd23a;
    }
  }
}

/**
 * The revive offer, shown at the moment of death BEFORE the results screen.
 *
 * A countdown, not a dialog: it expires on its own into the results screen, so
 * a player who wants to get straight back in is never blocked by it. Declining
 * costs one tap and ignoring it costs nothing.
 */
export class ReviveOffer {
  readonly container = new Container();

  onAccept: (() => void) | null = null;
  onDecline: (() => void) | null = null;

  private readonly dim = new Graphics();
  private readonly ring = new Graphics();
  private readonly button = new Container();
  private readonly skip = new Text({
    text: 'no thanks',
    style: { fontFamily: FONT, fontSize: 15, fontWeight: '600', fill: 0x8fa3c8 },
  });

  private width = 0;
  private height = 0;
  private remaining = 0;
  private duration = 5;

  get active(): boolean {
    return this.container.visible;
  }

  constructor() {
    const bg = new Graphics();
    bg.label = 'bg';
    const label = new Text({
      text: '▶ REVIVE · AD',
      style: { fontFamily: FONT, fontSize: 20, fontWeight: '800', fill: 0x07130a, letterSpacing: 1 },
    });
    label.label = 'label';
    label.anchor.set(0.5);
    this.button.addChild(bg, label);
    this.button.eventMode = 'static';
    this.button.cursor = 'pointer';
    this.button.on('pointertap', () => this.onAccept?.());

    this.skip.anchor.set(0.5);
    this.skip.eventMode = 'static';
    this.skip.cursor = 'pointer';
    this.skip.on('pointertap', () => this.onDecline?.());

    this.container.addChild(this.dim, this.ring, this.button, this.skip);
    this.container.visible = false;
  }

  resize(width: number, height: number): void {
    this.width = width;
    this.height = height;
    this.dim.clear();
    this.dim.rect(0, 0, width, height).fill({ color: 0x05070f, alpha: 0.7 });
    this.layout();
  }

  private layout(): void {
    const btnW = Math.min(this.width - 60, 320);
    const btnH = 64;
    const x = (this.width - btnW) / 2;
    const y = this.height - 120 - btnH;

    const bg = this.button.getChildByLabel('bg') as Graphics;
    const label = this.button.getChildByLabel('label') as Text;
    bg.clear();
    bg.roundRect(0, 0, btnW, btnH, btnH / 2).fill({ color: 0x7dff9b });
    label.x = btnW / 2;
    label.y = btnH / 2;

    this.button.x = x;
    this.button.y = y;
    this.button.hitArea = new Rectangle(0, 0, btnW, btnH);

    // Pushed well clear of REVIVE and grown past the 44px minimum: a fat-thumb
    // miss on decline used to launch a rewarded video nobody asked for.
    this.skip.x = this.width / 2;
    this.skip.y = y + btnH + 46;
    this.skip.hitArea = new Rectangle(-90, -26, 180, 52);
  }

  show(seconds = 5): void {
    this.duration = seconds;
    this.remaining = seconds;
    this.container.visible = true;
    this.layout();
    this.update(0);
  }

  hide(): void {
    this.container.visible = false;
  }

  /** Returns true when the countdown just expired. */
  update(dt: number): boolean {
    if (!this.container.visible) return false;
    this.remaining -= dt;

    const frac = clamp(this.remaining / this.duration, 0, 1);
    const g = this.ring;
    const cx = this.width / 2;
    const cy = this.button.y - 78;
    const r = 34;
    g.clear();
    g.circle(cx, cy, r).stroke({ width: 4, color: 0x1c2740 });
    if (frac > 0) {
      const start = -Math.PI / 2;
      g.moveTo(cx + Math.cos(start) * r, cy + Math.sin(start) * r);
      g.arc(cx, cy, r, start, start + Math.PI * 2 * frac).stroke({ width: 4, color: 0x7dff9b });
    }

    return this.remaining <= 0;
  }
}
