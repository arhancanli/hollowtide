import { Container, Graphics, Rectangle, Text } from 'pixi.js';
import { TAU, clamp } from '@arcade/core';
import { ABILITIES } from '../content/abilities.js';
import type { InputController } from '@arcade/core';
import type { World } from '../sim/world.js';
import { threatTierAt } from '../content/waves.js';
import { ARENA } from '../content/balance.js';

/**
 * Screen-space HUD. Three elements and no more — XP, time, and the health ring
 * (which lives in the world layer, on the player). Level and kills are small
 * and secondary. Anything else is clutter competing with the swarm.
 */
const LABEL_STYLE = {
  fontFamily: 'system-ui, -apple-system, Segoe UI, Roboto, sans-serif',
  fontSize: 13,
  fontWeight: '600' as const,
  fill: 0x8fa3c8,
};

const TIME_STYLE = {
  fontFamily: 'system-ui, -apple-system, Segoe UI, Roboto, sans-serif',
  fontSize: 26,
  fontWeight: '700' as const,
  fill: 0xe8f0ff,
};

/** 1 -> "1ST". Short enough for a phone HUD, and unambiguous at a glance. */
function ordinal(n: number): string {
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

function formatTime(t: number): string {
  const total = Math.floor(t);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${s.toString().padStart(2, '0')}`;
}

export class Hud {
  readonly container = new Container();

  private readonly xpBar = new Graphics();
  private readonly timeText = new Text({ text: '0:00', style: TIME_STYLE });
  private readonly levelText = new Text({ text: 'LV 1', style: LABEL_STYLE });
  private readonly killsText = new Text({ text: '0', style: LABEL_STYLE });
  /**
   * Standing in the lobby, e.g. "3rd of 8". Blank in a solo run.
   *
   * A place, not a scoreboard. Eight names down the side of a phone screen is
   * the whole screen; one line telling you whether you are winning is the
   * information a player actually acts on, and it costs a single row.
   */
  private readonly placeText = new Text({ text: '', style: LABEL_STYLE });
  private readonly leaderboard = new Container();
  private readonly leaderboardBg = new Graphics();
  private readonly leaderboardTitle = new Text({
    text: 'DOMINANCE',
    style: { ...LABEL_STYLE, fontSize: 9, fontWeight: '800', fill: 0xff7188, letterSpacing: 1.8 },
  });
  private readonly leaderboardRows = Array.from({ length: 4 }, () => new Text({
    text: '',
    style: { ...LABEL_STYLE, fontSize: 10, fontWeight: '700', fill: 0xa8b8d3 },
  }));
  private lastBoard = '';
  private lastLeader = -1;
  private readonly arenaEvent = new Text({
    text: '',
    style: { ...LABEL_STYLE, fontSize: 12, fontWeight: '900', fill: 0xffd166, letterSpacing: 1.1 },
  });
  private arenaEventT = 0;
  private arenaEventPriority = 0;
  private lastPlace = '';
  private livePlayers = 0;
  private reconnecting = false;
  /** Seconds left in the match, or -1 in a solo run. */
  private matchLeft = -1;

  /** Number of real people in the arena, including this client. */
  setArenaNetwork(
    status: 'idle' | 'matching' | 'live' | 'rejoining' | 'offline',
    players: number,
  ): void {
    this.livePlayers = status === 'live' ? Math.max(1, players) : 0;
    this.reconnecting = status === 'rejoining';
    this.lastPlace = '';
    // A player whose connection just dropped is owed the truth immediately;
    // silently turning their opponents into bots is how a competitive mode
    // loses trust in one round.
    if (this.reconnecting) this.announceArena('CONNECTION LOST  ·  REJOINING…', 2);
  }
  /**
   * Numeric health.
   *
   * Three independent review lenses reported never noticing they were dying —
   * the only health cue was a thin coloured arc on a 40px ring under a player
   * who is usually buried in a crowd. A number is unambiguous.
   */
  private readonly hpText = new Text({
    text: '',
    style: { ...LABEL_STYLE, fontSize: 15, fontWeight: '800', fill: 0x7dff9b },
  });
  private readonly stick = new Graphics();
  /**
   * First-run control hint.
   *
   * There was no hint anywhere in the build and drag-to-move was never shown.
   * Deliberately shown ONLY on a player's very first run and dismissed on the
   * first touch — a permanent hint is clutter, and a hint nobody needs is worse
   * than none. It also appears where the thumb should land, so the gesture is
   * demonstrated rather than described.
   */
  private readonly hint = new Graphics();
  private hintOn = false;
  private hintT = 0;
  /**
   * Boss health bar.
   *
   * Top of screen, full width, distinct from the XP bar. A boss with no bar is
   * just a big enemy — the bar is what turns it into an encounter with a
   * beginning and an end the player can feel themselves progressing through.
   */
  private readonly bossBar = new Graphics();
  private readonly bossName = new Text({
    text: '',
    style: { ...LABEL_STYLE, fontSize: 12, fill: 0xffd9d9, letterSpacing: 2 },
  });

  /**
   * Mute toggle. Not optional once a web game has sound — a large share of
   * portal traffic is played somewhere the player cannot have audio, and with
   * no way to silence it they close the tab rather than turn it down.
   */
  /**
   * The ability button and its cooldown ring.
   *
   * Bottom-RIGHT, deliberately opposite the thumb-rest zone the joystick spawns
   * in. It is a visible affordance for players who never discover the
   * second-finger gesture, and the ring is the only place the cooldown is
   * shown — a timer the player cannot see is a mechanic they cannot plan
   * around.
   */
  private readonly abilityButton = new Container();
  private readonly abilityG = new Graphics();
  private readonly abilityLabel = new Text({
    text: '',
    style: { ...LABEL_STYLE, fontSize: 10, fontWeight: '800', fill: 0xe8f0ff, letterSpacing: 1 },
  });
  private abilityName = '';
  /**
   * What the ability DOES. Written in abilities.ts, and until now drawn
   * absolutely nowhere.
   *
   * Two independent reviewers found the same failure: the button is the only
   * pressable thing on screen, so a newcomer's first hypothesis is that it is
   * the attack button. Acting on that hypothesis teleports them into a crowd
   * and then locks the control for nine seconds. An unexplained control that
   * punishes the most natural guess is worse than no control at all — and six
   * mechanically distinct abilities are invisible to most portal traffic.
   */
  private abilityDesc = '';
  private abilityColor = 0xffffff;
  private abilityReady = true;
  /** True until the player has ever used an ability. Drives the teaching beat. */
  private teachAbility = false;
  private teachT = 0;
  private readonly abilityHint = new Text({
    text: '',
    style: {
      fontFamily: LABEL_STYLE.fontFamily,
      fontSize: 12,
      fontWeight: '700',
      fill: 0xe8f0ff,
      align: 'center',
      wordWrap: true,
      wordWrapWidth: 168,
      lineHeight: 16,
    },
  });

  onAbility: (() => void) | null = null;

  private readonly muteButton = new Container();
  private readonly muteIcon = new Graphics();
  private muted = false;

  onToggleMute: (() => void) | null = null;

  private width = 0;
  private height = 0;
  /** World-to-screen scale, mirrored from the View so markers land correctly. */
  private viewScale = 1;
  private lastTime = '';
  private lastLevel = -1;
  private lastThreatTier = -1;
  private lastKills = -1;

  constructor() {
    this.timeText.anchor.set(0.5, 0);
    this.killsText.anchor.set(1, 0);
    // Right-aligned with the kill counter above it, or the two numbers read
    // as two unrelated things rather than one column.
    this.placeText.anchor.set(1, 0);

    this.muteButton.addChild(this.muteIcon);
    this.muteButton.eventMode = 'static';
    this.muteButton.cursor = 'pointer';
    this.muteButton.hitArea = new Rectangle(-22, -22, 44, 44);
    this.muteButton.on('pointertap', (e) => {
      e.stopPropagation();
      this.onToggleMute?.();
    });

    this.container.addChild(this.hint);
    this.container.addChild(this.stick);
    this.container.addChild(this.xpBar);
    this.container.addChild(this.timeText);
    this.container.addChild(this.levelText);
    this.container.addChild(this.killsText);
    this.container.addChild(this.placeText);
    this.leaderboard.addChild(this.leaderboardBg, this.leaderboardTitle, ...this.leaderboardRows);
    this.container.addChild(this.leaderboard);
    this.arenaEvent.anchor.set(0.5, 0);
    this.container.addChild(this.arenaEvent);
    this.hpText.anchor.set(0, 0.5);
    this.container.addChild(this.bossBar);
    this.container.addChild(this.bossName);
    // HP is added AFTER the boss bar so it can never be painted over. It was
    // added before, and bosses are on screen for most of the back half of every
    // run — so the number built precisely because reviewers "never noticed they
    // were dying" was hidden at exactly the moments it existed for. 12 of 13
    // evaluators reported it independently.
    this.container.addChild(this.hpText);
    this.abilityButton.addChild(this.abilityG);
    this.abilityButton.addChild(this.abilityLabel);
    this.abilityButton.eventMode = 'static';
    this.abilityButton.cursor = 'pointer';
    this.abilityButton.on('pointerdown', (e) => {
      // pointerdown, not pointertap: the ability has to fire the instant the
      // finger lands. A tap waits for the release, which in a game where the
      // button exists to escape a surround is a fatal amount of latency.
      e.stopPropagation();
      this.onAbility?.();
    });
    this.abilityHint.anchor.set(0.5, 1);
    this.abilityHint.visible = false;
    this.container.addChild(this.abilityHint);
    this.container.addChild(this.abilityButton);
    this.container.addChild(this.muteButton);
    this.bossName.anchor.set(0.5, 0);
  }

  setHint(on: boolean): void {
    this.hintOn = on;
    if (!on) this.hint.clear();
  }

  setMuted(muted: boolean): void {
    this.muted = muted;
    this.drawMute();
  }

  /**
   * Hide the live readouts while a panel owns the screen, but KEEP the mute
   * button. Hiding the whole HUD took mute away on every death — the one moment
   * a player is most likely to reach for it.
   */
  /** Called once per run — the ability is fixed for the character. */
  setAbility(name: string, desc: string, color: number): void {
    this.abilityName = name;
    this.abilityDesc = desc;
    this.abilityColor = color;
  }

  /**
   * Teach the second verb, once.
   *
   * Same rule as the movement hint: shown only until the player demonstrates
   * they know, then never again. A permanent tutorial is clutter; a tutorial
   * nobody needs is worse than none.
   */
  setTeachAbility(on: boolean): void {
    this.teachAbility = on;
    if (!on) {
      this.abilityHint.text = '';
      this.abilityHint.visible = false;
    }
  }

  setPlayVisible(visible: boolean): void {
    this.abilityButton.visible = visible;
    this.abilityHint.visible = visible && this.teachAbility;
    this.xpBar.visible = visible;
    this.timeText.visible = visible;
    this.levelText.visible = visible;
    this.killsText.visible = visible;
    this.placeText.visible = visible;
    this.leaderboard.visible = visible;
    this.arenaEvent.visible = visible && this.arenaEventT > 0;
    this.hpText.visible = visible;
    this.stick.visible = visible;
    this.bossBar.visible = visible;
    this.bossName.visible = visible;
  }

  private drawMute(): void {
    const g = this.muteIcon;
    g.clear();
    g.circle(0, 0, 15).fill({ color: 0x0d1424, alpha: 0.55 });
    const c = this.muted ? 0x5a6b8c : 0x9db0d4;
    // Speaker body.
    g.rect(-6, -3.5, 4, 7).fill({ color: c });
    g.moveTo(-2, -3.5).lineTo(3, -8).lineTo(3, 8).lineTo(-2, 3.5).closePath().fill({ color: c });
    if (this.muted) {
      g.moveTo(5, -5).lineTo(11, 5).stroke({ width: 2, color: 0xff5c6e });
      g.moveTo(11, -5).lineTo(5, 5).stroke({ width: 2, color: 0xff5c6e });
    } else {
      g.moveTo(6, -4).arc(6, 0, 4.5, -0.9, 0.9).stroke({ width: 1.8, color: c });
    }
  }

  resize(width: number, height: number): void {
    this.width = width;
    this.height = height;
    this.timeText.x = width / 2;
    this.timeText.y = 16;
    this.levelText.x = 14;
    this.levelText.y = 22;
    this.killsText.x = width - 14;
    this.killsText.y = 22;
    // Directly under the kill counter, sharing its right edge, so the two
    // numbers that say "how am I doing" read as one column.
    this.placeText.x = width - 14;
    this.placeText.y = 40;
    this.hpText.x = 14;
    this.hpText.y = 52;
    // Top-right, under the kill counter. NOT bottom-right: the joystick spawns
    // wherever the thumb lands, so a control parked in the thumb's resting zone
    // gets hit every time the player starts moving.
    this.muteButton.x = width - 30;
    this.muteButton.y = 68;
    this.leaderboard.x = width - 174;
    this.leaderboard.y = 92;
    this.arenaEvent.x = width / 2;
    this.arenaEvent.y = 62;
    // A rotation can shrink the screen under a banner that is already up.
    this.fitAnnounce();
    // Bottom-right, clear of the joystick's usual home and clear of the card
    // stack, which owns the bottom-centre.
    this.abilityButton.x = width - 62;
    this.abilityButton.y = height - 96;
    this.drawMute();
  }

  setViewScale(s: number): void {
    this.viewScale = s;
  }

  update(world: World, input: InputController, frameDt = 0): void {
    this.teachT += frameDt;
    if (this.arenaEventT > 0) {
      this.arenaEventT = Math.max(0, this.arenaEventT - frameDt);
      this.arenaEvent.visible = this.arenaEventT > 0;
      this.arenaEvent.alpha = Math.min(1, this.arenaEventT * 1.5);
    }
    // Only touch Text when the value actually changed — every assignment
    // retriggers layout, and this runs every frame.
    /**
     * The arena counts DOWN.
     *
     * A survival run asks how long you lasted, so it counts up. A match has an
     * end everybody shares, and the last thirty seconds are the tensest part
     * of it — which only works if the player can see them coming. It also
     * turns red inside the final call, because a number that changes colour is
     * read by people who are not reading numbers.
     */
    const arena = world.players.length > 1;
    const left = arena ? Math.max(0, ARENA.matchSeconds - world.time) : 0;
    const t = arena ? formatTime(left) : formatTime(world.time);
    if (t !== this.lastTime) {
      this.lastTime = t;
      this.timeText.text = t;
    }
    if (arena) {
      const urgent = left <= ARENA.finalCall;
      const fill = urgent ? 0xff6b7f : 0xe8f0ff;
      if (this.timeText.style.fill !== fill) this.timeText.style.fill = fill;
      this.matchLeft = left;
    } else if (this.matchLeft >= 0) {
      this.matchLeft = -1;
      this.timeText.style.fill = 0xe8f0ff;
    }

    /**
     * Death is a three-second cost, so it needs a three-second clock.
     *
     * Without it the screen simply stops responding and the player assumes the
     * game has broken — which is what "you are dead but the match continues"
     * looks like when nothing says so.
     */
    const downFor = world.player.respawnIn;
    if (downFor > 0) {
      this.announceArena(`DOWN  ·  BACK IN ${Math.ceil(downFor)}`, 3);
    }
    const threatTier = threatTierAt(world.time);
    if (world.level !== this.lastLevel || threatTier !== this.lastThreatTier) {
      this.lastLevel = world.level;
      this.lastThreatTier = threatTier;
      this.levelText.text = `LV ${world.level}  ·  TIDE ${threatTier}`;
    }
    if (world.players.length > 1) {
      // Rank by who is still standing, then by level — the same order the
      // results panel uses, so the number on screen and the number you finish
      // on cannot disagree.
      let ahead = 0;
      const me = world.player;
      for (const q of world.players) {
        if (q.index === 0) continue;
        if (q.alive !== me.alive) {
          if (q.alive) ahead++;
          continue;
        }
        if (q.arenaScore > me.arenaScore) ahead++;
      }
      const alive = world.players.reduce((n, q) => n + (q.alive ? 1 : 0), 0);
      const live = this.livePlayers > 1 ? `   LIVE ${this.livePlayers}` : '';
      const place = `${ordinal(ahead + 1)} / ${world.players.length}   ${alive} LEFT${live}`;
      if (place !== this.lastPlace) {
        this.lastPlace = place;
        this.placeText.text = place;
      }
      this.drawLeaderboard(world);
    } else {
      if (this.lastPlace !== '') {
        this.lastPlace = '';
        this.placeText.text = '';
      }
      this.leaderboard.visible = false;
    }
    const scoreKey = world.players.length > 1 ? Math.floor(world.player.arenaScore) : world.kills;
    if (scoreKey !== this.lastKills) {
      this.lastKills = scoreKey;
      this.killsText.text = world.players.length > 1 ? `MASS ${scoreKey}` : `${scoreKey}`;
    }

    const frac = clamp(world.xp / world.xpNeeded, 0, 1);
    const g = this.xpBar;
    g.clear();
    // The track needs to be visible when empty — it is one of only three HUD
    // elements, and an invisible one teaches the player nothing.
    g.rect(0, 0, this.width, 6).fill({ color: 0x243154 });
    if (frac > 0) {
      g.rect(0, 0, this.width * frac, 6).fill({ color: 0x5cd0ff });
      // Near-full cue: a bloom just under the bar so an imminent level-up is
      // felt peripherally. The player's eyes are on the swarm, never up here.
      if (frac > 0.82) {
        const heat = (frac - 0.82) / 0.18;
        g.rect(0, 0, this.width * frac, 10).fill({ color: 0x8ef7ff, alpha: 0.16 + heat * 0.3 });
      }
    }

    const hp = Math.max(0, Math.ceil(world.player.hp));
    const hpFrac = clamp(world.player.hp / world.player.maxHp, 0, 1);
    const hpStr = `${hp} HP`;
    if (this.hpText.text !== hpStr) this.hpText.text = hpStr;
    this.hpText.style.fill = hpFrac > 0.5 ? 0x7dff9b : hpFrac > 0.25 ? 0xffd23a : 0xff5c6e;

    this.drawStick(input);
    this.drawHint();
    this.drawBossBar(world);
    this.drawAbility(world);
  }

  /**
   * The one line of text the arena speaks with.
   *
   * Priority exists because of a screenshot. A player who joins a running match
   * is told why they are sixth at ten seconds — and one second later a rival
   * took the crown, the banner was overwritten, and the only explanation of the
   * strangest moment in the mode was gone. A message that explains the player's
   * own situation outranks routine commentary about somebody else's.
   */
  announceArena(message: string, priority = 0): void {
    // Priority 3 is the respawn clock, which is re-issued every frame while it
    // is counting; letting it block itself would freeze the count on screen.
    if (priority === 3 && this.arenaEventPriority === 3) this.arenaEventT = 0;
    if (priority < this.arenaEventPriority && this.arenaEventT > 0) return;
    this.arenaEvent.text = message;
    this.arenaEventT = priority > 0 ? 4.2 : 2.4;
    this.arenaEventPriority = priority;
    this.arenaEvent.visible = true;
    this.arenaEvent.alpha = 1;
    this.fitAnnounce();
  }

  /**
   * Shrink the banner until it fits the screen it is on.
   *
   * These lines are centre-anchored, so a message wider than the viewport loses
   * BOTH ends — on a 390px phone the sentence explaining why a late joiner is
   * fifth read "…ED IN PROGRESS · 0:11 IN · YOU TOOK A SEAT…". Every announcement
   * is a sentence of variable length in a variable-width viewport, so the fit
   * has to be measured rather than guessed at authoring time.
   */
  private fitAnnounce(): void {
    if (this.width <= 0) return;
    const room = this.width - 24;
    let size = 12;
    this.arenaEvent.style.fontSize = size;
    while (size > 8 && this.arenaEvent.width > room) {
      size -= 0.5;
      this.arenaEvent.style.fontSize = size;
    }
  }

  beginRun(multiplayer: boolean): void {
    this.lastLeader = -1;
    this.lastBoard = '';
    if (multiplayer) this.announceArena('COLLECT MASS  ·  HUNT RIVALS  ·  TAKE #1');
  }

  private drawLeaderboard(world: World): void {
    this.leaderboard.visible = true;
    const leaders = world.standings().slice(0, 4);
    const leader = leaders[0];
    if (leader && this.lastLeader >= 0 && leader.index !== this.lastLeader) {
      this.announceArena(leader.index === 0 ? 'YOU TOOK THE CROWN' : `${leader.name.toUpperCase()} TOOK THE CROWN`);
    }
    if (leader) this.lastLeader = leader.index;
    const key = leaders
      .map((p) => `${p.index}:${p.name}:${Math.floor(p.arenaScore)}:${p.pvpKills}:${p.live ? 1 : 0}`)
      .join('|');
    if (key === this.lastBoard) return;
    this.lastBoard = key;
    const w = 162;
    const rowH = 18;
    const h = 29 + rowH * leaders.length;
    this.leaderboardBg.clear();
    this.leaderboardBg.roundRect(0, 0, w, h, 9).fill({ color: 0x07101d, alpha: 0.78 });
    this.leaderboardBg.roundRect(0, 0, w, h, 9).stroke({ width: 1, color: 0x263a58, alpha: 0.8 });
    this.leaderboardTitle.x = 10;
    this.leaderboardTitle.y = 7;
    for (let i = 0; i < this.leaderboardRows.length; i++) {
      const row = this.leaderboardRows[i]!;
      const p = leaders[i];
      row.visible = !!p;
      if (!p) continue;
      const mine = p.index === 0;
      const rank = i === 0 ? '◆' : `${i + 1}`;
      // A dot in front of a name means a person is holding that seat. The one
      // fact worth the most in a multiplayer round was previously invisible:
      // nothing on screen distinguished a live opponent from the AI backfill,
      // so beating a person felt exactly like beating a bot.
      const name = (mine ? 'YOU' : `${p.live ? '•' : ''}${p.name || `RIVAL ${p.index}`}`).slice(0, 11);
      row.text = `${rank}  ${name.padEnd(11)} ${Math.floor(p.arenaScore)}`;
      row.style.fill = mine ? 0x76e8ff : p.live ? 0x8affc1 : i === 0 ? 0xff7188 : 0xa8b8d3;
      row.x = 10;
      row.y = 25 + i * rowH;
    }
  }

  /**
   * The button, drawn as a filling ring.
   *
   * Ready reads as a solid coloured ring with the name inside; on cooldown the
   * ring drains anticlockwise and the fill dims. One glance, no numbers.
   */
  private drawAbility(world: World): void {
    const g = this.abilityG;
    g.clear();
    const p = world.player;
    const def = ABILITIES[world.character.ability];
    const ready = p.abilityCd <= 0;
    if (ready !== this.abilityReady) {
      this.abilityReady = ready;
    }
    const r = 30;
    /**
     * Until the player has ever used it, the button BREATHES and names what it
     * does. Both stop permanently on first use.
     *
     * The pulse is the part that gets it noticed at all; the caption is the
     * part that stops the natural guess ("this is the attack button") from
     * being punished. Neither is clutter for an experienced player because
     * neither survives their first press.
     */
    const teaching = this.teachAbility && ready;
    const pulse = teaching ? 1 + 0.075 * Math.sin(this.teachT * 3.4) : 1;
    const rr = r * pulse;

    if (teaching) {
      // A soft halo behind the button, so the eye finds it without a tooltip.
      g.circle(0, 0, rr + 12).fill({ color: this.abilityColor, alpha: 0.10 });
      g.circle(0, 0, rr + 6).stroke({ width: 2, color: this.abilityColor, alpha: 0.35 });
    }
    g.circle(0, 0, rr).fill({ color: 0x0d1424, alpha: ready ? 0.82 : 0.6 });
    // Track.
    g.circle(0, 0, rr).stroke({ width: 3, color: 0x24304a, alpha: 0.9 });
    if (ready) {
      g.circle(0, 0, rr).stroke({ width: 3, color: this.abilityColor, alpha: 0.95 });
      // A soft inner glow so "ready" is visible in peripheral vision, which is
      // where it will actually be noticed mid-fight.
      g.circle(0, 0, rr - 7).fill({ color: this.abilityColor, alpha: 0.14 });
    } else {
      const frac = 1 - p.abilityCd / def.cooldown;
      if (frac > 0.001) {
        g.arc(0, 0, r, -Math.PI / 2, -Math.PI / 2 + frac * TAU).stroke({
          width: 3,
          color: this.abilityColor,
          alpha: 0.7,
        });
      }
    }
    this.abilityLabel.text = this.abilityName;
    this.abilityLabel.anchor.set(0.5);
    this.abilityLabel.style.fill = ready ? 0xe8f0ff : 0x5f7099;
    this.abilityLabel.x = 0;
    this.abilityLabel.y = 0;
    // Generous hit area — this is the control a player reaches for while being
    // surrounded, and a miss costs them the escape.
    this.abilityButton.hitArea = new Rectangle(-r - 12, -r - 12, (r + 12) * 2, (r + 12) * 2);

    if (this.teachAbility) {
      this.abilityHint.text = `${this.abilityName}\n${this.abilityDesc}`;
      this.abilityHint.visible = this.abilityButton.visible;
      // The button sits 62px from the right edge, while the teaching caption
      // is 168px wide. Centering the caption on the button clipped its final
      // words in every viewport. Keep the button in thumb reach and clamp the
      // caption itself inside a small screen-edge gutter.
      const hintHalfW = 84;
      this.abilityHint.x = clamp(this.abilityButton.x, hintHalfW + 10, this.width - hintHalfW - 10);
      this.abilityHint.y = this.abilityButton.y - r - 20;
      this.abilityHint.style.fill = ready ? 0xe8f0ff : 0x7c8db3;
    }
  }

  private drawBossBar(world: World): void {
    const g = this.bossBar;
    g.clear();
    const boss = world.activeBoss;
    if (!boss || boss.hp <= 0) {
      this.bossName.text = '';
      return;
    }
    const frac = clamp(boss.hp / boss.maxHp, 0, 1);
    // Inset from the left so it cannot sit on top of the HP readout even at
    // the narrowest supported width.
    const x = 104;
    const w = this.width - x - 30;
    const y = 44;
    g.roundRect(x, y, w, 9, 4).fill({ color: 0x2a1420 });
    if (frac > 0) g.roundRect(x, y, w * frac, 9, 4).fill({ color: 0xff5c6e });
    if (this.bossName.text !== world.activeBossName) {
      this.bossName.text = world.activeBossName;
    }
    this.bossName.x = this.width / 2;
    this.bossName.y = y + 14;

    this.drawBossMarker(boss, world);
  }

  /**
   * Direction marker for a boss that is off screen.
   *
   * The bar alone was measured up as the boss sat outside the viewport for
   * 9.7-30.3% of every encounter — the HUD announcing a fight with nothing on
   * screen to fight, which reads as the bar being broken. A boss that leaves
   * frame is legitimate in this genre; a boss you cannot LOCATE is not.
   *
   * Pinned just inside the edge on the line from the player to the boss, so it
   * doubles as "turn this way".
   */
  private drawBossMarker(boss: { x: number; y: number }, world: World): void {
    const g = this.bossBar;
    const p = world.player;
    const s = this.viewScale;
    // Boss position in screen space, relative to the player at screen centre.
    const sx = this.width / 2 + (boss.x - p.x) * s;
    const sy = this.height / 2 + (boss.y - p.y) * s;

    const pad = 30;
    const inside = sx > pad && sx < this.width - pad && sy > pad && sy < this.height - pad;
    if (inside) return;

    const cx = this.width / 2;
    const cy = this.height / 2;
    const dx = sx - cx;
    const dy = sy - cy;
    const len = Math.hypot(dx, dy) || 1;
    // Clamp to the edge rectangle along the same heading.
    const halfW = this.width / 2 - pad;
    const halfH = this.height / 2 - pad;
    const scale = Math.min(halfW / Math.abs(dx || 1e-6), halfH / Math.abs(dy || 1e-6));
    const mx = cx + dx * scale;
    const my = cy + dy * scale;

    const ux = dx / len;
    const uy = dy / len;
    const size = 16;
    // Dark backing first, so it reads against both the pale ground and a crowd.
    g.circle(mx, my, size * 0.82).fill({ color: 0x140a10, alpha: 0.5 });
    g.moveTo(mx + ux * size, my + uy * size)
      .lineTo(mx - uy * size * 0.62 - ux * size * 0.4, my + ux * size * 0.62 - uy * size * 0.4)
      .lineTo(mx + uy * size * 0.62 - ux * size * 0.4, my - ux * size * 0.62 - uy * size * 0.4)
      .closePath()
      .fill({ color: 0xff5c6e, alpha: 0.95 });
  }

  private drawHint(): void {
    const g = this.hint;
    g.clear();
    if (!this.hintOn) return;
    this.hintT += 1 / 60;

    const cx = this.width / 2;
    const cy = this.height * 0.74;
    // A repeating 2.4s gesture: press, drag out, release, pause.
    const loop = (this.hintT % 2.4) / 2.4;
    const travel = loop < 0.62 ? Math.min(1, loop / 0.62) : 1;
    const eased = 1 - (1 - travel) * (1 - travel);
    const fade = loop < 0.78 ? 1 : 1 - (loop - 0.78) / 0.22;

    const reach = 52 * eased;
    const kx = cx + reach * 0.92;
    const ky = cy - reach * 0.5;

    // Joystick base.
    g.circle(cx, cy, 30).stroke({ width: 2, color: 0xffffff, alpha: 0.26 * fade });
    // The path the thumb travels, so the gesture is legible as a DRAG rather
    // than as two unrelated circles sitting on the ground.
    g.moveTo(cx, cy).lineTo(kx, ky).stroke({ width: 2, color: 0xffffff, alpha: 0.16 * fade });
    // The thumb.
    g.circle(kx, ky, 15).fill({ color: 0xffffff, alpha: 0.3 * fade });
    g.circle(kx, ky, 15).stroke({ width: 2, color: 0xffffff, alpha: 0.5 * fade });
  }

  private drawStick(input: InputController): void {
    const g = this.stick;
    g.clear();
    const o = input.origin;
    const k = input.knob;
    if (!o || !k) return;
    // Raised from alpha 0.16/0.20 — measured at 1.88:1 contrast, which is below
    // any usable threshold on a dark field with a swarm moving over it.
    g.circle(o.x, o.y, 58).stroke({ width: 2.5, color: 0xffffff, alpha: 0.34 });
    g.circle(k.x, k.y, 22).fill({ color: 0xffffff, alpha: 0.42 });
  }
}
