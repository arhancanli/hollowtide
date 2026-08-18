import { FloatingText, Hitstop, Particles, Shake, Shockwaves } from '@arcade/juice';
import { Container, Graphics } from 'pixi.js';
import { BOSS_KINDS } from '../content/balance.js';
import type { Enemy, SimEvent } from '../sim/types.js';
import type { ArtTextures } from './textures.js';

/**
 * Turns simulation events into feel.
 *
 * This layer is where retention actually lives. Two mechanically identical
 * games, one with hit stop and screen shake and damage numbers and one without,
 * do not retain remotely alike — and it is the part solo developers skip
 * because it looks like decoration. It is not decoration; it is the product.
 *
 * Values here are deliberate, not vibes:
 *   hit stop      60ms, ELITES ONLY — on every hit it reads as lag, not impact
 *   hit flash     80ms white on the enemy sprite (applied in view.ts)
 *   shake         small on player damage, larger on elite death, never on
 *                 ordinary kills, or a dense swarm turns it into permanent noise
 *   damage number rise 30px over 600ms, x-jitter, 1.3 -> 1.0 pop, late fade
 */

const ELITE_HITSTOP = 0.06;
const DEATH_HITSTOP = 0.18;

const SHAKE_PLAYER_HIT = 0.42;
const SHAKE_ELITE_DEATH = 0.34;
const SHAKE_SURGE = 0.3;
const SHAKE_MAX_OFFSET = 13;

const DAMAGE_COLOR = 0xffe9a8;
// 0xffb03a was BYTE-IDENTICAL to the elite body colour, so the number field and
// the elite field merged into one orange mass. Shifted well clear of it.
const CRIT_COLOR = 0xfff0c2;

/**
 * Damage numbers are suppressed within this radius of the player.
 *
 * Measured occlusion: with numbers on, a 50x50 box at screen centre held 104
 * visible player pixels; with them off, 289. The feedback was covering 64% of
 * the one thing the player can never afford to lose track of. Elites and bosses
 * are exempt from the RATE throttle, but nothing is exempt from this — the
 * closer a number is to the player, the less it is worth and the more it costs.
 */
const NUMBER_KEEPOUT = 62;

/**
 * Minimum gap between ordinary damage numbers, in seconds.
 *
 * With six levelled weapons the hit rate is high enough that unthrottled
 * numbers cover the entire screen and the player can no longer see the swarm
 * they are supposed to be reading. Elite and boss hits are never throttled —
 * those are the ones worth knowing the value of. Ordinary chip damage is
 * already conveyed by the hit flash and the spark burst.
 */
const NUMBER_INTERVAL = 0.055;

/** Elite/boss hits get their own, far shorter, throttle. Never unthrottled. */
const ELITE_NUMBER_INTERVAL = 0.022;

/** Must match FloatingText's `rise` — see the keepout test in consume(). */
const NUMBER_RISE = 30;

export class Effects {
  readonly shake = new Shake();
  readonly hitstop = new Hitstop();

  /** World-space layers, added under the camera. */
  readonly belowContainer = new Container();
  readonly aboveContainer = new Container();
  /** Screen-space damage vignette. */
  readonly vignette = new Graphics();

  private readonly particles: Particles;
  private readonly shockwaves: Shockwaves;
  private readonly numbers: FloatingText;
  /** Live lightning arcs: flat point lists with a fading lifetime. */
  private readonly chains = new Graphics();
  private readonly arcs: { points: number[]; color: number; life: number }[] = [];
  /**
   * Ground telegraphs — COLOSSUS slams and BURROWER eruptions.
   *
   * These are the first hazards in the game that hurt without touching, so the
   * whole design rests on the warning being legible: the outline appears at
   * full size instantly (that is the area) and a fill sweeps in over the
   * windup (that is the clock). A player who is out of the circle when it
   * completes takes nothing, which is what makes it a mistake rather than
   * bad luck.
   */
  private readonly telegraphs = new Graphics();
  private readonly tells: {
    x: number;
    y: number;
    radius: number;
    life: number;
    maxLife: number;
    color: number;
  }[] = [];

  private vignetteAlpha = 0;
  private screenW = 0;
  private screenH = 0;
  private numberCooldown = 0;
  private eliteNumberCooldown = 0;
  /** Rotates so co-located damage numbers fan out instead of overprinting. */
  private numberSpread = 0;

  constructor(textures: ArtTextures) {
    this.particles = new Particles(textures.disc, 700);
    this.shockwaves = new Shockwaves(textures.ring, 24);
    this.numbers = new FloatingText({ fontSize: 26, capacity: 110 });

    this.belowContainer.addChild(this.telegraphs);
    this.belowContainer.addChild(this.shockwaves.container);
    this.aboveContainer.addChild(this.chains);
    this.aboveContainer.addChild(this.particles.container);
    this.aboveContainer.addChild(this.numbers.container);
  }

  resize(width: number, height: number): void {
    this.screenW = width;
    this.screenH = height;
  }

  clear(): void {
    this.arcs.length = 0;
    this.chains.clear();
    this.tells.length = 0;
    this.telegraphs.clear();
    this.particles.clear();
    this.shockwaves.clear();
    this.numbers.clear();
    this.shake.reset();
    this.hitstop.clear();
    this.vignetteAlpha = 0;
    this.numberCooldown = 0;
    this.eliteNumberCooldown = 0;
  }

  /** Consume one frame's worth of simulation events. */
  consume(events: readonly SimEvent[], playerX: number, playerY: number): void {
    for (let i = 0; i < events.length; i++) {
      const ev = events[i]!;
      switch (ev.type) {
        case 'enemyHit': {
          const elite = ev.kind === 'elite' || BOSS_KINDS.includes(ev.kind);
          const dx = ev.x - playerX;
          const dy = ev.y - playerY;
          /**
           * The keepout has to cover where the number ENDS, not where it starts.
           *
           * It rises 30px over its life and spawns 10px high, so a label cleared
           * at exactly the keepout edge travels 40px back INTO it and parks on
           * the player — measured with the player at 13 HP under a "191", at the
           * one moment they most need to find themselves. Extending the test
           * upward by the full travel makes the exclusion zone the region the
           * number actually occupies.
           */
          const nearPlayer =
            dx * dx + dy * dy < NUMBER_KEEPOUT * NUMBER_KEEPOUT ||
            (Math.abs(dx) < NUMBER_KEEPOUT && dy > 0 && dy < NUMBER_KEEPOUT + NUMBER_RISE);
          /**
           * Elites are throttled too, just far less.
           *
           * They were exempt outright, so every elite hit in a frame spawned its
           * own label — and elite waves reach seven concurrent from t=138. Six
           * simultaneous "113"s at the same point read as "1133": not emphasis,
           * just an unreadable smudge. A short interval keeps every elite hit
           * legible while still privileging it over chip damage.
           */
          const cd = elite ? this.eliteNumberCooldown : this.numberCooldown;
          if (!nearPlayer && cd <= 0) {
            if (elite) this.eliteNumberCooldown = ELITE_NUMBER_INTERVAL;
            else this.numberCooldown = NUMBER_INTERVAL;
            // Scatter co-located spawns so two numbers never stack into one.
            this.numberSpread = (this.numberSpread + 1) % 6;
            const jitter = (this.numberSpread - 2.5) * 13;
            this.numbers.spawn(
              ev.x + jitter,
              ev.y - 10,
              ev.damage,
              elite ? CRIT_COLOR : DAMAGE_COLOR,
              elite ? 1.25 : 1,
            );
          }
          if (ev.kind === 'elite' && !ev.killed) this.hitstop.add(ELITE_HITSTOP);
          if (!ev.killed) {
            this.particles.burst(ev.x, ev.y, {
              count: 3,
              color: 0xffffff,
              speed: 130,
              speedVariance: 60,
              life: 0.16,
              size: 5,
              drag: 8,
            });
          }
          break;
        }

        case 'enemyKilled': {
          const elite = ev.kind === 'elite';
          this.particles.burst(ev.x, ev.y, {
            count: elite ? 22 : 7,
            color: ev.color,
            speed: elite ? 260 : 150,
            speedVariance: elite ? 120 : 70,
            life: elite ? 0.5 : 0.34,
            size: elite ? 11 : 6,
            gravity: 220,
            drag: 2.2,
          });
          if (elite) {
            this.shake.add(SHAKE_ELITE_DEATH);
            this.hitstop.add(ELITE_HITSTOP);
            this.shockwaves.spawn(ev.x, ev.y, 30, 210, 0.45, ev.color, 0.9);
          }
          break;
        }

        case 'rivalDown': {
          this.hitstop.add(0.1);
          this.shake.add(0.55);
          this.shockwaves.spawn(ev.x, ev.y, 22, 420, 0.62, 0xff647d, 1, true);
          this.particles.burst(ev.x, ev.y, {
            count: 34,
            color: 0xff647d,
            speed: 340,
            speedVariance: 150,
            life: 0.72,
            size: 12,
            drag: 1.9,
          });
          this.numbers.spawn(ev.x, ev.y - 18, ev.bounty, 0xffd166, 1.45);
          break;
        }

        case 'playerHit': {
          this.shake.add(SHAKE_PLAYER_HIT);
          this.vignetteAlpha = 0.55;
          // Fast and short-lived: the burst must clear the player's own
          // silhouette almost immediately, or the feedback for being hit is
          // also what stops you seeing where you are.
          this.particles.burst(playerX, playerY, {
            count: 8,
            color: 0xff5c6e,
            speed: 280,
            speedVariance: 70,
            life: 0.22,
            size: 7,
            drag: 4.5,
          });
          break;
        }

        case 'levelUp': {
          // Radial burst from the player, then the cards slide in. The order
          // matters: the reward lands before the decision is asked for.
          this.shockwaves.spawn(playerX, playerY, 20, 300, 0.5, 0x5cd0ff, 1, true);
          this.particles.burst(playerX, playerY, {
            count: 20,
            color: 0x8ef7ff,
            speed: 230,
            speedVariance: 90,
            life: 0.5,
            size: 8,
            drag: 2.6,
          });
          break;
        }

        case 'eliteSpawned':
        case 'heraldSpawned': {
          this.shake.add(SHAKE_SURGE);
          break;
        }

        case 'revived': {
          this.shockwaves.spawn(playerX, playerY, 20, 660, 0.7, 0x7dff9b, 1, true);
          this.particles.burst(playerX, playerY, {
            count: 34,
            color: 0x7dff9b,
            speed: 340,
            speedVariance: 120,
            life: 0.65,
            size: 10,
            drag: 2.2,
          });
          break;
        }

        case 'chainArc': {
          // Copy the points: the sim reuses its event array every frame.
          this.arcs.push({ points: ev.points.slice(), color: ev.color, life: 0.18 });
          break;
        }

        case 'telegraph': {
          this.tells.push({
            x: ev.x,
            y: ev.y,
            radius: ev.radius,
            life: ev.duration,
            maxLife: ev.duration,
            color: ev.color,
          });
          break;
        }

        case 'healed': {
          // Health arriving is one of only two genuinely good things that
          // happen in a run, and it must not read like an ordinary pickup.
          this.numbers.spawn(playerX, playerY - 34, ev.amount, 0x7dff9b, 1.15);
          this.particles.burst(playerX, playerY, {
            count: 12,
            color: 0xff5c8a,
            speed: 120,
            speedVariance: 60,
            life: 0.5,
            size: 7,
            drag: 3.5,
          });
          break;
        }

        case 'blast': {
          this.shockwaves.spawn(ev.x, ev.y, ev.radius * 0.25, ev.radius * 2, 0.36, ev.color, 0.85);
          this.particles.burst(ev.x, ev.y, {
            count: 14,
            color: ev.color,
            speed: ev.radius * 2.6,
            speedVariance: ev.radius * 0.9,
            life: 0.3,
            size: 9,
            drag: 5,
          });
          this.shake.add(Math.min(0.4, 0.1 + ev.radius / 700));
          break;
        }

        case 'bossSpawned': {
          this.shake.add(0.7);
          this.shockwaves.spawn(playerX, playerY, 900, 120, 0.8, 0xff5c6e, 0.5, true);
          break;
        }

        case 'bossKilled': {
          this.hitstop.add(0.22);
          this.shake.add(1);
          this.shockwaves.spawn(ev.x, ev.y, 40, 700, 0.85, ev.color, 1, true);
          this.particles.burst(ev.x, ev.y, {
            count: 64,
            color: ev.color,
            speed: 480,
            speedVariance: 200,
            life: 1.0,
            size: 16,
            gravity: 160,
            drag: 1.6,
          });
          break;
        }

        case 'evolved': {
          this.hitstop.add(0.12);
          this.shockwaves.spawn(playerX, playerY, 20, 520, 0.7, 0xffd23a, 1, true);
          this.particles.burst(playerX, playerY, {
            count: 40,
            color: 0xffd23a,
            speed: 380,
            speedVariance: 140,
            life: 0.7,
            size: 11,
            drag: 2.2,
          });
          break;
        }

        case 'died': {
          this.hitstop.add(DEATH_HITSTOP);
          this.shake.add(0.85);
          this.particles.burst(playerX, playerY, {
            count: 38,
            color: 0x8ef7ff,
            speed: 300,
            speedVariance: 140,
            life: 0.8,
            size: 11,
            gravity: 120,
            drag: 1.8,
          });
          break;
        }

        default:
          break;
      }
    }
  }

  /**
   * Lightning between chain targets.
   *
   * Drawn as a jagged polyline rather than straight segments — a straight line
   * between two circles reads as a laser, and the jitter is what makes it read
   * as electricity. Offsets come from the segment index so the bolt does not
   * reshuffle every frame and shimmer.
   */
  private drawChains(): void {
    const g = this.chains;
    g.clear();
    for (let i = 0; i < this.arcs.length; i++) {
      const arc = this.arcs[i]!;
      const pts = arc.points;
      const fade = Math.max(0, arc.life / 0.18);
      for (let j = 0; j + 3 < pts.length; j += 2) {
        const x0 = pts[j]!;
        const y0 = pts[j + 1]!;
        const x1 = pts[j + 2]!;
        const y1 = pts[j + 3]!;
        const midX = (x0 + x1) / 2;
        const midY = (y0 + y1) / 2;
        const nx = -(y1 - y0);
        const ny = x1 - x0;
        const len = Math.hypot(nx, ny) || 1;
        const kink = ((j % 3) - 1) * 11;
        g.moveTo(x0, y0)
          .lineTo(midX + (nx / len) * kink, midY + (ny / len) * kink)
          .lineTo(x1, y1)
          .stroke({ width: 3.5, color: arc.color, alpha: 0.85 * fade });
      }
    }
  }

  /**
   * Motion trails for stalkers — the only enemy that outruns the player.
   *
   * A speed cue, not decoration: the one threat you cannot escape has to be
   * identifiable at a glance while it is still at the edge of the screen.
   * Emission is spread across frames by index so twenty stalkers cost the same
   * per frame as one, rather than all emitting together.
   */
  emitTrails(enemies: readonly Enemy[], frame: number): void {
    for (let i = 0; i < enemies.length; i++) {
      const e = enemies[i]!;
      if (e.kind !== 'stalker' || e.hp <= 0) continue;
      if ((frame + i) % 3 !== 0) continue;
      this.particles.burst(e.x, e.y, {
        count: 1,
        color: e.color,
        speed: 8,
        speedVariance: 6,
        life: 0.24,
        size: e.radius * 1.5,
        drag: 3,
      });
    }
  }

  /**
   * Advance visuals. Runs on real frame time, NOT simulation time — effects
   * must keep animating through hit stop, otherwise the freeze looks like the
   * game locked up instead of landing a hit.
   */
  update(dt: number): void {
    if (this.numberCooldown > 0) this.numberCooldown -= dt;
    if (this.eliteNumberCooldown > 0) this.eliteNumberCooldown -= dt;
    // Telegraphs: outline instantly at full size, fill sweeping in over the
    // windup. Redrawn every frame because the fill IS the countdown.
    const tg = this.telegraphs;
    tg.clear();
    for (let i = this.tells.length - 1; i >= 0; i--) {
      const c = this.tells[i]!;
      c.life -= dt;
      if (c.life <= 0) {
        this.tells.splice(i, 1);
        continue;
      }
      const done = 1 - c.life / c.maxLife;
      tg.circle(c.x, c.y, c.radius).fill({ color: c.color, alpha: 0.1 + done * 0.26 });
      tg.circle(c.x, c.y, c.radius).stroke({ width: 2.5, color: c.color, alpha: 0.85 });
      // The closing inner ring: unambiguous about WHEN, not just where.
      if (done > 0.05) {
        tg.circle(c.x, c.y, c.radius * (1 - done)).stroke({
          width: 2,
          color: 0xffffff,
          alpha: 0.5,
        });
      }
    }

    for (let i = this.arcs.length - 1; i >= 0; i--) {
      const a = this.arcs[i]!;
      a.life -= dt;
      if (a.life <= 0) this.arcs.splice(i, 1);
    }
    this.particles.update(dt);
    this.shockwaves.update(dt);
    this.numbers.update(dt);
    this.shake.update(dt, SHAKE_MAX_OFFSET);

    if (this.vignetteAlpha > 0) {
      this.vignetteAlpha = Math.max(0, this.vignetteAlpha - dt * 2.4);
    }
  }

  render(): void {
    this.drawChains();
    this.particles.render();
    this.shockwaves.render();
    this.numbers.render();

    const g = this.vignette;
    g.clear();
    if (this.vignetteAlpha <= 0.001) return;
    // Edge bands rather than a full-screen wash — a tint over the whole play
    // area hides the swarm at exactly the moment the player must read it.
    const a = this.vignetteAlpha;
    const band = Math.min(this.screenW, this.screenH) * 0.16;
    g.rect(0, 0, this.screenW, band).fill({ color: 0xff2d44, alpha: a * 0.5 });
    g.rect(0, this.screenH - band, this.screenW, band).fill({ color: 0xff2d44, alpha: a * 0.5 });
    g.rect(0, 0, band, this.screenH).fill({ color: 0xff2d44, alpha: a * 0.5 });
    g.rect(this.screenW - band, 0, band, this.screenH).fill({ color: 0xff2d44, alpha: a * 0.5 });
  }
}
