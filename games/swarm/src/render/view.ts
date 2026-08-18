import { Container, Graphics, Sprite, Text, TilingSprite, type Renderer, type Texture } from 'pixi.js';
import { FIXED_STEP, TAU, clamp, lerp } from '@arcade/core';
import { PLAYER, seatRadius } from '../content/balance.js';
import { WEAPONS, orbitBladeRadius, orbitRingRadius, weaponStat } from '../content/weapons.js';
import type { EnemyKind } from '../content/balance.js';
import type { World } from '../sim/world.js';
import { createTextures, type ArtTextures } from './textures.js';
import { SpriteLayer } from './sprite-layer.js';
import type { Effects } from './effects.js';

/** World units visible on the shorter screen axis, before clamping. */
const TARGET_SHORT_AXIS = 480;
const MIN_SCALE = 0.75;
const MAX_SCALE = 1.5;

/** Render size as a multiple of the collision radius, per type. */
const VISUAL_SCALE: Record<EnemyKind, number> = {
  drifter: 2.15,
  lantern: 2.4,
  elite: 2.6,
  herald: 2.2,
  stalker: 2.9,
  splitter: 2.15,
  bomber: 2.3,
  warden: 2.5,
  lancer: 3.0,
  brood: 2.4,
  colossus: 2.5,
  harbinger: 2.8,
  bulwark: 2.5,
  weaver: 2.8,
  burrower: 2.5,
};

/**
 * Terrain colour.
 *
 * A LIGHT warm earth, not a dark one.
 *
 * The first attempt kept a dark ground under dark entities and the whole scene
 * turned to mud — nothing popped because everything sat at the same luminance.
 * The games actually on the CrazyGames shelf put saturated sprites on a bright
 * surface, and that contrast is most of what makes them readable at a glance.
 */
const GROUND_TINT = 0x847a66;
const GROUND_TINT_2 = 0x9c9078;

/**
 * SCOUT's colour, and the fallback.
 *
 * The player sprite used this constant unconditionally, so every character
 * rendered identically — you could spend 6,000 gold on ECLIPSE and it looked
 * exactly like the free starter. Each Character already carries its own colour;
 * nothing was reading it. An unlock the player cannot SEE is not a reward.
 */
const PLAYER_COLOR = 0x8ef7ff;

/** Blend two packed RGB colours. `t` of 0 returns `a`, 1 returns `b`. */
function mixColor(a: number, b: number, t: number): number {
  const k = t < 0 ? 0 : t > 1 ? 1 : t;
  const ar = (a >> 16) & 0xff;
  const ag = (a >> 8) & 0xff;
  const ab = a & 0xff;
  const br = (b >> 16) & 0xff;
  const bg = (b >> 8) & 0xff;
  const bb = b & 0xff;
  return (
    (((ar + (br - ar) * k) | 0) << 16) | (((ag + (bg - ag) * k) | 0) << 8) | ((ab + (bb - ab) * k) | 0)
  );
}
const BOLT_COLOR = 0xfff2a8;
const GEM_COLOR = 0x7dff9b;
/** Health drops. Deliberately the warmest thing on a cool field. */
const HEART_COLOR = 0xff5c8a;

/**
 * Motion constants. Deliberately SMALL.
 *
 * The failure mode of procedural animation is a screen that wobbles; the target
 * is a screen that breathes. Every value here should be at the edge of
 * noticeable when you stare at one creature, and unmistakable across a crowd.
 */
const BREATHE_AMOUNT = 0.055;
const BREATHE_RATE = 3.1;
const SURGE_MAX = 0.16;
const SURGE_SCALE = 0.0000085;
const LEAN_RATE = 2.2;
const LEAN_AMOUNT = 0.075;
const LEAN_VELOCITY = 0.0009;

/** Glow radius as a multiple of body radius, per enemy type. */
const GLOW_SCALE: Record<EnemyKind, number> = {
  drifter: 3.0,
  lantern: 4.2,
  elite: 3.4,
  herald: 3.6,
  stalker: 3.8,
  splitter: 3.2,
  bomber: 3.4,
  warden: 3.2,
  lancer: 3.4,
  brood: 3.2,
  colossus: 3.2,
  harbinger: 3.6,
  bulwark: 2.8,
  weaver: 3.8,
  burrower: 3.0,
};

/**
 * Glow strength per type. Drifters get NONE.
 *
 * Two reasons, and they agree. Design: glow is a hierarchy signal, so if the
 * rank-and-file bloom as hard as the threats then the threats stop reading as
 * threats and a dense screen turns to soup. Performance: drifters are ~85% of
 * all enemies, so glowing them roughly doubles the sprite count for the layer
 * that costs the most fill rate — and mid-range phones are the target.
 */
const GLOW_ALPHA: Record<EnemyKind, number> = {
  drifter: 0,
  // Brightest glow in the game. It is the one enemy that can hurt you from
  // across the screen, so it has to be findable at a glance.
  lantern: 0.85,
  elite: 0.5,
  herald: 0.45,
  stalker: 0.55,
  splitter: 0.34,
  bomber: 0.5,
  warden: 0.8,
  lancer: 0.8,
  brood: 0.8,
  colossus: 0.8,
  harbinger: 0.8,
  // Dim. BULWARK's read is its silhouette and its plating, not light — and it
  // arrives in numbers, so a bright one would wash out the crowd behind it.
  bulwark: 0.3,
  // Bright: the whole mechanic is that this is the thing you should be
  // shooting, so it has to win the eye against everything it is shielding.
  weaver: 0.75,
  burrower: 0.45,
};

export class View {
  readonly stage = new Container();
  readonly textures: ArtTextures;

  /** World-space container. Everything gameplay lives under this. */
  private readonly camera = new Container();
  /**
   * The terrain, in three tiling layers.
   *
   * A textured ground the fight happens ON, rather than a black void with a
   * grid over it. Layers tile at different scales so the repeat never resolves
   * into an obvious stamp while the player is moving across it.
   */
  private readonly ground: TilingSprite;
  private readonly groundDetail: TilingSprite;
  private readonly grid: TilingSprite;
  private readonly vignette: Sprite;

  private readonly glow: SpriteLayer;
  private readonly gems: SpriteLayer;
  private readonly enemies: SpriteLayer;
  private readonly projectiles: SpriteLayer;
  private readonly hostileLayer: SpriteLayer;
  private readonly orbs: SpriteLayer;
  private readonly player: SpriteLayer;
  private readonly healthRing = new Graphics();
  /**
   * Rival name plates and health bars.
   *
   * Kept off the player's own ring: a bar under seat zero would duplicate the
   * HUD it already has, and the only thing worth spending screen on for someone
   * else is who they are and how close they are to going down.
   */
  private readonly rivalPlates = new Graphics();
  /**
   * One name label per rival seat, allocated once and reused.
   *
   * Pooled rather than created per frame for the ordinary reason — text objects
   * are the most expensive thing on this screen — but also because a name that
   * flickers as it is rebuilt reads as a glitch, and the whole point of showing
   * a name is that the thing wearing it looks like a person.
   */
  private readonly rivalNames: Text[] = [];
  private readonly rivalNameLayer = new Container();
  private readonly auraRing = new Graphics();
  /**
   * WEAVER tethers and BURROWER mounds.
   *
   * Both mechanics are invisible without this. A shield the player cannot see
   * is the game feeling arbitrarily spongy, and an enemy tunnelling toward you
   * with no surface tell is an ambush rather than a threat you failed to read.
   */
  private readonly worldFx = new Graphics();

  private readonly enemyTexture: Record<EnemyKind, Texture>;

  /** Last tint applied to the player sprite. Exposed so a probe can assert it. */
  playerTint = PLAYER_COLOR;

  /** Free-running clock for procedural motion. Real frame time, not sim time. */
  private animT = 0;

  /** First live enemy's drawn width. Exposed so a probe can assert it moves. */
  sampleEnemySize(): number | null {
    const s = this.enemies.container.children[0];
    return s ? s.width : null;
  }

  private scale = 1;
  private screenW = 0;
  private screenH = 0;

  constructor(renderer: Renderer) {
    this.textures = createTextures(renderer);

    this.enemyTexture = {
      drifter: this.textures.drifter,
      lantern: this.textures.lantern,
      elite: this.textures.elite,
      herald: this.textures.herald,
      stalker: this.textures.stalker,
      splitter: this.textures.splitter,
      bomber: this.textures.bomber,
      warden: this.textures.warden,
      colossus: this.textures.colossus,
      harbinger: this.textures.harbinger,
      bulwark: this.textures.bulwark,
      weaver: this.textures.weaver,
      burrower: this.textures.burrower,
      lancer: this.textures.lancer,
      brood: this.textures.brood,
    };

    this.ground = new TilingSprite({ texture: this.textures.ground, width: 10, height: 10 });
    this.ground.tint = GROUND_TINT;
    this.stage.addChild(this.ground);

    // A second pass at a different scale breaks up the tiling rhythm.
    this.groundDetail = new TilingSprite({ texture: this.textures.ground, width: 10, height: 10 });
    this.groundDetail.tint = GROUND_TINT_2;
    this.groundDetail.alpha = 0.5;
    this.stage.addChild(this.groundDetail);

    this.grid = new TilingSprite({ texture: this.textures.grid, width: 10, height: 10 });
    this.grid.tint = 0x3a3228;
    // Much fainter now — the terrain carries the motion reference the grid used
    // to be solely responsible for.
    this.grid.alpha = 0.13;
    this.stage.addChild(this.grid);

    // Additive so overlapping glows build light instead of stacking opacity.
    this.glow = new SpriteLayer(this.textures.glow, 256, 'add');
    this.gems = new SpriteLayer(this.textures.gem, 128);
    this.enemies = new SpriteLayer(this.textures.drifter, 256);
    this.projectiles = new SpriteLayer(this.textures.bolt, 64);
    this.hostileLayer = new SpriteLayer(this.textures.disc, 48);
    this.orbs = new SpriteLayer(this.textures.ring, 8);
    this.player = new SpriteLayer(this.textures.player, 1);

    // Draw order: light under everything, then pickups, swarm, player on top.
    this.camera.addChild(this.glow.container);
    this.camera.addChild(this.auraRing);
    this.camera.addChild(this.gems.container);
    this.camera.addChild(this.worldFx);
    this.camera.addChild(this.enemies.container);
    this.camera.addChild(this.projectiles.container);
    this.camera.addChild(this.hostileLayer.container);
    this.camera.addChild(this.orbs.container);
    this.camera.addChild(this.player.container);
    this.camera.addChild(this.rivalPlates);
    this.camera.addChild(this.rivalNameLayer);
    this.camera.addChild(this.healthRing);

    this.stage.addChild(this.camera);

    // Restrained depth: darkens the edges so the eye settles on the player.
    // Deliberately not a starfield or particles — the grid already supplies the
    // motion reference, and anything more is decoration competing with a screen
    // the player has to read under pressure.
    this.vignette = new Sprite(this.textures.vignette);
    this.vignette.alpha = 0.4;
    this.stage.addChild(this.vignette);
  }

  /**
   * Slot the juice layers into the world.
   *
   * Shockwaves go UNDER the swarm and particles/numbers go over it. A level-up
   * burst drawn on top of the enemies would hide the exact thing the player has
   * to keep reading during the one moment the game freezes.
   */
  attachEffects(effects: Effects): void {
    this.camera.addChildAt(effects.belowContainer, 1);
    this.camera.addChild(effects.aboveContainer);
    this.stage.addChild(effects.vignette);
  }

  resize(width: number, height: number): void {
    this.screenW = width;
    this.screenH = height;
    this.scale = clamp(Math.min(width, height) / TARGET_SHORT_AXIS, MIN_SCALE, MAX_SCALE);
    this.camera.scale.set(this.scale);
    for (const layer of [this.ground, this.groundDetail, this.grid]) {
      layer.width = width;
      layer.height = height;
    }
    this.vignette.width = width;
    this.vignette.height = height;
  }

  /** World units to screen pixels. The HUD needs it to place off-screen markers. */
  get worldScale(): number {
    return this.scale;
  }

  /** Half-extents of the visible world, for the sim's spawn ring. */
  get viewHalfW(): number {
    return this.screenW / this.scale / 2;
  }

  get viewHalfH(): number {
    return this.screenH / this.scale / 2;
  }

  render(world: World, alpha: number, shakeX = 0, shakeY = 0, frameDt = 0): void {
    // Real frame time, so the motion runs at the same rate whether the sim is
    // hitstopped, the tab is throttled, or the display is 120Hz.
    this.animT += frameDt;
    const p = world.player;
    const camX = lerp(p.px, p.x, alpha);
    const camY = lerp(p.py, p.y, alpha);

    // Shake is applied in SCREEN pixels, after the world transform — so its
    // magnitude does not change with zoom level or device.
    this.camera.x = this.screenW / 2 - camX * this.scale + shakeX;
    this.camera.y = this.screenH / 2 - camY * this.scale + shakeY;

    // The grid is screen-space and scrolls by the camera remainder, so it tiles
    // forever without ever growing a huge container. It shakes with the world,
    // or the shake reads as the player sliding rather than the screen jolting.
    const ox = -camX * this.scale + shakeX;
    const oy = -camY * this.scale + shakeY;
    this.ground.tilePosition.set(ox, oy);
    this.ground.tileScale.set(this.scale * 0.85);
    // Offset and counter-scaled so the two ground passes never line up.
    this.groundDetail.tilePosition.set(ox * 1.0 + 96, oy * 1.0 - 61);
    this.groundDetail.tileScale.set(this.scale * 0.41);
    this.grid.tilePosition.set(ox, oy);
    this.grid.tileScale.set(this.scale);

    this.glow.begin();
    this.drawGems(world, alpha);
    this.drawEnemies(world, alpha);
    this.drawProjectiles(world, alpha);
    this.drawHostiles(world, alpha);
    this.drawPlayer(world, alpha, camX, camY);
    this.glow.end();
  }

  private addGlow(x: number, y: number, size: number, color: number, alpha: number): void {
    const g = this.glow.take();
    g.x = x;
    g.y = y;
    g.width = size;
    g.height = size;
    g.tint = color;
    g.alpha = alpha;
  }

  private drawGems(world: World, alpha: number): void {
    const layer = this.gems;
    layer.begin();
    const list = world.gems.active;
    for (let i = 0; i < list.length; i++) {
      const g = list[i]!;
      const s = layer.take();
      const x = lerp(g.px, g.x, alpha);
      const y = lerp(g.py, g.y, alpha);
      s.x = x;
      s.y = y;
      /**
       * Hearts read as a different KIND of thing, not a bigger gem.
       *
       * Bigger and pink-red against the field's green, with a brighter glow, so
       * "there is health over there" is legible from across a crowded screen —
       * which is the entire decision the drop exists to create.
       */
      if (g.heal > 0) {
        const size = 27;
        s.width = size;
        s.height = size;
        s.tint = HEART_COLOR;
        this.addGlow(x, y, size * 3.6, HEART_COLOR, 0.55);
      } else {
        const size = g.value > 4 ? 22 : 15;
        s.width = size;
        s.height = size;
        s.tint = GEM_COLOR;
        this.addGlow(x, y, size * 3.2, GEM_COLOR, 0.3);
      }
    }
    layer.end();
  }

  private drawEnemies(world: World, alpha: number): void {
    const fx = this.worldFx;
    fx.clear();

    /**
     * THE TIDE — the safe circle.
     *
     * Drawn as a bright boundary with the DANGER shaded outside it rather than
     * the safety shaded inside: the player needs to read "not there" instantly
     * and from the corner of their eye, and a filled safe zone hides the swarm
     * they are standing in. The line pulses so a closing ring is legible as
     * closing rather than as scenery.
     */
    if (world.tideRadius > 0) {
      const r = world.tideRadius;
      const pulse = 0.55 + 0.25 * Math.sin(this.animT * 2.2);
      // A wide, soft band OUTSIDE the boundary reads as "here be harm" without
      // painting over the whole field.
      fx.circle(world.tideX, world.tideY, r + 260).stroke({
        width: 520,
        color: 0x3a0a16,
        alpha: 0.3,
      });
      fx.circle(world.tideX, world.tideY, r).stroke({
        width: 4,
        color: 0xff5c6e,
        alpha: pulse,
      });
      fx.circle(world.tideX, world.tideY, r - 6).stroke({
        width: 1.5,
        color: 0xffd9d9,
        alpha: pulse * 0.5,
      });
    }

    // Tethers, drawn first so bodies sit on top of them. The line runs from the
    // weaver to each enemy it is protecting, which makes "kill that one" a
    // thing you can see rather than a thing you have to be told.
    const t = world.tethers;
    for (let i = 0; i + 3 < t.length; i += 4) {
      fx.moveTo(t[i]!, t[i + 1]!).lineTo(t[i + 2]!, t[i + 3]!);
    }
    if (t.length > 0) {
      fx.stroke({ width: 1.6, color: 0x6ee7c8, alpha: 0.5 });
    }

    const layer = this.enemies;
    layer.begin();
    const list = world.enemies.active;
    for (let i = 0; i < list.length; i++) {
      const e = list[i]!;
      if (e.hp <= 0) continue;
      // A submerged BURROWER draws as a disturbance in the ground, not a body.
      // It has to be trackable — the mechanic is a dodge, and you cannot dodge
      // something with no position — but it must also read as unshootable.
      if (e.submerged) {
        const mx = lerp(e.px, e.x, alpha);
        const my = lerp(e.py, e.y, alpha);
        fx.ellipse(mx, my, e.radius * 1.5, e.radius * 0.7)
          .fill({ color: 0x2a1e12, alpha: 0.5 });
        fx.ellipse(mx, my, e.radius * 1.5, e.radius * 0.7)
          .stroke({ width: 1.5, color: 0xc98a4b, alpha: 0.55 });
        continue;
      }
      const s = layer.take(this.enemyTexture[e.kind]);
      const x = lerp(e.px, e.x, alpha);
      const y = lerp(e.py, e.y, alpha);
      s.x = x;
      s.y = y;

      /**
       * PROCEDURAL MOTION — the actual art gap.
       *
       * A panel voted 8-0 against converting to sprite sheets and was right,
       * but for the wrong reason: what the hand-drawn competitors on this shelf
       * have is not resolution, it is that their art MOVES. Every enemy here
       * was drawn at a constant size with a constant tint, so a screen of 168
       * creatures read as 168 stickers sliding across the ground.
       *
       * Three cheap time terms fix that, and they are the whole difference:
       *   breathe  a squash-and-stretch cycle on SCALE, never on position, so
       *            the contact shadow baked into each sprite stays planted
       *   surge    a stretch along the direction of travel, so a thing moving
       *            fast looks like it is moving fast
       *   lean     a small roll into the heading, so bodies have weight
       *
       * The phase offset is derived from the pooled index, so neighbours are
       * never in step — a crowd breathing in unison reads worse than a crowd
       * that does not breathe at all. Roughly four float operations per enemy:
       * ~700 per frame at peak density, against a 0.083ms sim step.
       */
      const visual = VISUAL_SCALE[e.kind];
      const base = e.radius * visual;
      const phase = i * 0.7;
      const breathe = 1 + BREATHE_AMOUNT * Math.sin(this.animT * BREATHE_RATE + phase);
      const speed2 = e.vx * e.vx + e.vy * e.vy;
      const surge = speed2 > 1 ? Math.min(SURGE_MAX, speed2 * SURGE_SCALE) : 0;
      s.width = base * (breathe + surge);
      s.height = base * (2 - breathe - surge * 0.6);

      // Anything with a front faces its heading. Drifters are round, so
      // rotating them would cost work and change nothing on screen.
      if (e.kind === 'stalker' || e.kind === 'herald' || e.kind === 'lancer') {
        s.rotation = Math.atan2(e.vy, e.vx);
      } else {
        // Round bodies lean into their heading instead of rotating, which reads
        // as weight rather than as a spinning sprite.
        s.rotation = Math.sin(this.animT * LEAN_RATE + phase) * LEAN_AMOUNT + e.vx * LEAN_VELOCITY;
      }
      // Flash white on hit. Cheap, and it is most of what sells an impact.
      s.tint = e.flash > 0 ? 0xffffff : e.color;
      // A winding-up lancer flashes: the charge has to be readable before it
      // commits, or getting hit reads as unfair rather than as a mistake.
      // This MUST come after the hit-flash assignment — it was above it, so the
      // very next line overwrote it and the telegraph never rendered at all.
      if (e.kind === 'lancer' && e.phase === 1 && e.flash <= 0) {
        s.tint = Math.floor(e.special * 14) % 2 === 0 ? 0xffffff : e.color;
      }
      // A winding-up LANTERN goes white. Its shot must be readable from across
      // the screen or being hit reads as unfair rather than as a mistake.
      if (e.kind === 'lantern' && e.phase === 1 && e.flash <= 0) {
        s.tint = 0xffffff;
      }
      const glowAlpha = GLOW_ALPHA[e.kind];
      if (glowAlpha > 0) this.addGlow(x, y, e.radius * GLOW_SCALE[e.kind], e.color, glowAlpha);
    }
    layer.end();
  }

  private drawProjectiles(world: World, alpha: number): void {
    const layer = this.projectiles;
    layer.begin();
    const list = world.projectiles.active;
    for (let i = 0; i < list.length; i++) {
      const pr = list[i]!;
      const x = lerp(pr.px, pr.x, alpha);
      const y = lerp(pr.py, pr.y, alpha);
      if (pr.kind === 'mine') {
        // Mines pulse so a field of them stays legible against the swarm, and
        // so the player can tell an armed charge from a stray gem.
        const s = layer.take(this.textures.ring);
        const pulse = 1 + 0.18 * Math.sin(pr.life * 7);
        s.x = x;
        s.y = y;
        s.width = 26 * pulse;
        s.height = 26 * pulse;
        s.tint = pr.color;
        this.addGlow(x, y, 62, pr.color, 0.35);
        continue;
      }
      const s = layer.take(this.textures.bolt);
      s.x = x;
      s.y = y;
      s.width = pr.radius * 7;
      s.height = pr.radius * 3.4;
      s.rotation = Math.atan2(pr.vy, pr.vx);
      s.tint = pr.color || BOLT_COLOR;
      this.addGlow(x, y, pr.radius * 9, pr.color || BOLT_COLOR, 0.4);
    }
    layer.end();
  }

  /** Enemy fire, drawn hot so it never gets lost in the swarm. */
  private drawHostiles(world: World, alpha: number): void {
    const layer = this.hostileLayer;
    layer.begin();
    const list = world.hostiles.active;
    for (let i = 0; i < list.length; i++) {
      const pr = list[i]!;
      const s = layer.take();
      const x = lerp(pr.px, pr.x, alpha);
      const y = lerp(pr.py, pr.y, alpha);
      s.x = x;
      s.y = y;
      s.width = pr.radius * 2.6;
      s.height = pr.radius * 2.6;
      s.tint = pr.color;
      this.addGlow(x, y, pr.radius * 8, pr.color, 0.7);
    }
    layer.end();
  }

  private drawPlayer(world: World, alpha: number, camX: number, camY: number): void {
    const p = world.player;
    const arenaLeader = world.players.length > 1 ? world.standings()[0]?.index ?? -1 : -1;

    this.player.begin();
    // Every living combatant comes out of the SAME pooled layer as the local
    // player. A separate rival sprite path would be a second thing to keep in
    // step with the first, and the two would look different within a month.
    // The arena wall. Drawn first, under every combatant, as a boundary line
    // plus a wash outside it — the wash is what makes "outside" legible at a
    // glance, and the line is what you steer against. Zero radius in every solo
    // run, so this costs nothing there.
    this.rivalPlates.clear();
    if (world.arenaRing > 0) {
      const r = world.arenaRing;
      // A thick soft band rather than a filled disc: filling the whole outside
      // would dim the enemies out there, and they still kill you.
      this.rivalPlates
        .circle(0, 0, r + 900)
        .stroke({ width: 1800, color: 0x2a0d18, alpha: 0.5 });
      this.rivalPlates.circle(0, 0, r).stroke({ width: 3, color: 0xff5f7a, alpha: 0.85 });
      this.rivalPlates.circle(0, 0, r - 6).stroke({ width: 1, color: 0xff9fb0, alpha: 0.3 });
    }
    /**
     * THE SIPHON, drawn.
     *
     * A mechanic the player cannot see is a mechanic that does not exist, and
     * this one moves 23% of all the mass in a race. It is drawn as a bright
     * thread from the seat losing to the seat taking, thickening with the rate,
     * so the answer to "why is my number going down" is on screen at the moment
     * it happens rather than inferable afterwards from a leaderboard.
     *
     * Threads involving YOU are drawn hot and thick; two rivals robbing each
     * other across the arena are drawn faint, because that is information and
     * not something to look at.
     */
    for (const s of world.siphons) {
      const from = world.players[s.from];
      const to = world.players[s.to];
      if (!from || !to) continue;
      const mine = s.from === 0 || s.to === 0;
      const fx = lerp(from.px, from.x, alpha);
      const fy = lerp(from.py, from.y, alpha);
      const tx = lerp(to.px, to.x, alpha);
      const ty = lerp(to.py, to.y, alpha);
      const pulse = 0.55 + Math.sin(this.animT * 9 + s.from) * 0.25;
      // Losing mass is red; taking it is gold. From the player's point of view
      // the colour of the thread already says which way it is going.
      const color = s.to === 0 ? 0xffd166 : s.from === 0 ? 0xff5f7a : 0x9fb4d8;
      // Thickness is COMMITMENT, not rate. The thread starts hair-thin the
      // moment you arrive on somebody and swells as you hold them, so the
      // screen shows you what the mechanic is actually rewarding.
      this.rivalPlates
        .moveTo(fx, fy)
        .lineTo(tx, ty)
        .stroke({
          width: mine ? 1.5 + s.lock * 4 : 1,
          color,
          alpha: (mine ? 0.55 + s.lock * 0.35 : 0.22) * pulse,
        });
      // A bead travelling the thread, so the direction is unmistakable even
      // when both ends are moving.
      if (mine) {
        const t = (this.animT * 1.4) % 1;
        this.rivalPlates
          .circle(fx + (tx - fx) * t, fy + (ty - fy) * t, 3.5)
          .fill({ color, alpha: 0.9 });
      }
    }

    /**
     * Who you are hunting, and how far in you are.
     *
     * An arc that closes around your target as the lock builds. Without it the
     * player has no way to know they are committed to anybody, and "switching
     * costs you everything" is a rule they can only learn by being punished by
     * it invisibly.
     */
    const hunted = world.players[p.siphonTarget];
    if (world.players.length > 1 && hunted && hunted.alive && p.siphonTarget > 0) {
      const hx = lerp(hunted.px, hunted.x, alpha);
      const hy = lerp(hunted.py, hunted.y, alpha);
      const ring = seatRadius(hunted.arenaScore) + 14;
      const lock = Math.min(1, p.siphonLock / 4);
      this.rivalPlates.circle(hx, hy, ring).stroke({ width: 1, color: 0xffd166, alpha: 0.28 });
      this.rivalPlates
        .arc(hx, hy, ring, -Math.PI / 2, -Math.PI / 2 + TAU * lock)
        .stroke({ width: 3, color: 0xffd166, alpha: 0.5 + lock * 0.45 });
    }

    // Hide every name up front, so a seat that died or a solo run leaves no
    // orphaned label sitting in the world.
    // Seats can arrive out of order, leaving sparse slots in this array.
    for (const t of this.rivalNames) if (t) t.visible = false;
    /**
     * Where a name has already been written this frame.
     *
     * Seats overlap constantly in this arena — the median distance to your
     * nearest rival is negative — so six labels regularly land on top of each
     * other and resolve into a smear that names nobody. A label that cannot be
     * read is worse than no label, because it costs the same screen space and
     * hides what is underneath it.
     *
     * Live players and the leader are always written; everyone else is written
     * only where there is room. That ordering is the point: the two names worth
     * the pixels are the person you are actually playing against and the seat
     * you are trying to catch.
     */
    const placed: Array<{ x: number; y: number }> = [];
    const hasRoom = (x: number, y: number): boolean => {
      for (const p0 of placed) {
        if (Math.abs(p0.x - x) < 62 && Math.abs(p0.y - y) < 13) return false;
      }
      return true;
    };
    if (world.players.length > 1) {
      for (const q of world.players) {
        if (q.index === 0 || !q.alive) continue;
        const rx = lerp(q.px, q.x, alpha);
        const ry = lerp(q.py, q.y, alpha);
        const r = this.player.take();
        const body = seatRadius(q.arenaScore);
        r.x = rx;
        r.y = ry;
        // Size IS mass. The single most useful thing to know about a rival, and
        // it is now readable without looking at a number or a leaderboard.
        r.width = body * 2.5;
        r.height = body * 2.5;
        r.rotation = q.aimAngle;
        // Rivals wear their character's colour, dimmed. Full brightness on
        // seven other bodies makes it genuinely hard to find yourself, and
        // finding yourself is the one thing the screen must never cost you.
        const rtint = mixColor(q.character.color || PLAYER_COLOR, 0x101820, 0.35);
        r.tint = q.invul > 0 ? mixColor(rtint, 0xffffff, 0.5) : rtint;
        /**
         * A living person, marked.
         *
         * Nothing on screen used to separate a real opponent from the AI that
         * fills the empty seats, which quietly threw away the whole reason to
         * play the mode: the moment a stranger turns up is the moment
         * multiplayer is worth anything, and the game was keeping it a secret.
         *
         * A diamond over the head rather than a ring around the body. The first
         * attempt was a ring, and a screenshot killed it: the local player's
         * health is ALSO drawn as a green ring, so "green ring means a person"
         * and "green ring means my health" were the same shape in the same
         * colour on the same screen.
         */
        if (q.live) {
          const breath = 0.72 + Math.sin(this.animT * 2.6 + q.index) * 0.22;
          const dy = ry - body - 20;
          this.rivalPlates
            .poly([rx, dy - 6, rx + 5, dy, rx, dy + 6, rx - 5, dy])
            .fill({ color: 0x8affc1, alpha: breath });
        }
        if (q.index === arenaLeader) {
          const pulse = 0.52 + Math.sin(this.animT * 3.2) * 0.12;
          this.rivalPlates.circle(rx, ry, body + 10).stroke({ width: 2, color: 0xff7188, alpha: pulse });
          this.rivalPlates
            .poly([rx, ry - 27, rx - 5, ry - 20, rx + 5, ry - 20])
            .fill({ color: 0xff7188, alpha: 0.9 });
        }

        // A health bar, and only when it means something. A full bar over every
        // rival is seven pieces of furniture; a bar that appears as someone
        // starts losing is information you can act on.
        // The name. Kept small, dim and directly under the body so it reads as
        // a label on a person rather than a UI element floating in the world.
        let label = this.rivalNames[q.index - 1];
        if (!label) {
          label = new Text({
            text: '',
            style: {
              fontFamily: 'system-ui, sans-serif',
              fontSize: 9,
              fontWeight: '700',
              fill: 0x8fa4c8,
              letterSpacing: 0.4,
            },
          });
          label.anchor.set(0.5, 0);
          label.resolution = 2;
          this.rivalNames[q.index - 1] = label;
          this.rivalNameLayer.addChild(label);
        }
        if (label.text !== q.name) label.text = q.name;
        label.x = rx;
        label.y = ry + body * 2.5;
        const mustShow = q.live || q.index === arenaLeader;
        label.visible = mustShow || hasRoom(label.x, label.y);
        if (label.visible) placed.push({ x: label.x, y: label.y });
        // Live names sit in the same green as their ring, so the marker on the
        // body and the marker on the leaderboard are recognisably one thing.
        label.tint = q.live ? 0x8affc1 : rtint;

        // OFF-SCREEN MARKER. A rival who wanders past the edge stops existing as
        // far as the player is concerned, and an arena you cannot see is an
        // arena you do not believe is there. A chevron pinned just inside the
        // edge, in their colour, keeps all seven of them accounted for at the
        // cost of a few triangles.
        const offX = rx - camX;
        const offY = ry - camY;
        const hw = this.viewHalfW - 26;
        const hh = this.viewHalfH - 26;
        if (Math.abs(offX) > hw || Math.abs(offY) > hh) {
          const scale = Math.min(hw / Math.max(1, Math.abs(offX)), hh / Math.max(1, Math.abs(offY)));
          const mx = camX + offX * scale;
          const my = camY + offY * scale;
          const ang = Math.atan2(offY, offX);
          const c = Math.cos(ang);
          const sn = Math.sin(ang);
          this.rivalPlates
            .poly([
              mx + c * 9, my + sn * 9,
              mx - c * 5 - sn * 6, my - sn * 5 + c * 6,
              mx - c * 5 + sn * 6, my - sn * 5 - c * 6,
            ])
            .fill({ color: rtint, alpha: 0.85 });
          // The body itself is off screen, so the label would be too.
          label.visible = false;
          continue;
        }

        const frac = Math.max(0, Math.min(1, q.hp / Math.max(1, q.maxHp)));
        if (frac < 0.98) {
          const w = body * 2.6;
          const y = ry + body * 2.1;
          this.rivalPlates.rect(rx - w / 2, y, w, 2.5).fill({ color: 0x000000, alpha: 0.45 });
          this.rivalPlates
            .rect(rx - w / 2, y, w * frac, 2.5)
            .fill({ color: frac < 0.3 ? 0xff5566 : rtint, alpha: 0.9 });
        }
      }
    }
    const s = this.player.take();
    const myBody = seatRadius(p.arenaScore);
    s.x = camX;
    s.y = camY;
    s.width = myBody * 2.5;
    s.height = myBody * 2.5;
    // Points at whatever the auto-weapon is about to shoot, so the firing reads
    // as aimed rather than arbitrary.
    s.rotation = p.aimAngle;
    // The character's OWN colour, so the roster is visible on the field.
    const tint = world.character.color || PLAYER_COLOR;
    this.playerTint = tint;
    // Blink WHITE, never red. Red made the player vanish into a red swarm and a
    // red damage burst at precisely the moment they most need to find
    // themselves — the frames just after taking a hit. White is unique on
    // screen apart from the 80ms enemy hit flash.
    //
    // PULSE, do not strobe. This was a hard tint flip sampled at 10Hz, which
    // produces up to 5 full-contrast flashes per second — and because i-frames
    // collapse to their 0.16s floor once crowding maxes at t=180, the player was
    // measured invulnerable 30% of the late game, flipping 6.8 times a second.
    // That is comfortably past the 3-flashes-per-second photosensitive-seizure
    // threshold, on the sprite the eye is locked to. A smooth 2.5Hz blend reads
    // as the same "I am briefly safe" signal and cannot flash.
    if (p.invul > 0) {
      const pulse = 0.5 + 0.5 * Math.sin(p.invul * Math.PI * 2 * 2.5);
      s.tint = mixColor(tint, 0xffffff, 0.35 + pulse * 0.65);
    } else {
      s.tint = tint;
    }
    this.player.end();

    this.addGlow(camX, camY, myBody * 7, tint, 0.5);

    // Orbit and aura are the two weapons with a persistent physical presence,
    // so they are drawn from their live weapon instances rather than from a
    // flag on the player. Everything else exists only as projectiles.
    this.orbs.begin();
    this.auraRing.clear();
    for (let wi = 0; wi < p.weapons.length; wi++) {
      const inst = p.weapons[wi]!;
      const def = WEAPONS[inst.id];

      if (inst.id === 'orbit' || inst.id === 'vortex') {
        // Advance by the render remainder so it stays smooth above 60Hz.
        const spin = inst.id === 'vortex' ? 4.2 : 2.6;
        const angle = inst.phase + spin * FIXED_STEP * alpha;
        const orbs = weaponStat(def, def.count, inst.level);
        // Shared geometry with the damage path — see orbitRingRadius.
        const radius = orbitRingRadius(def, inst.level, p.areaMult);
        // Draw the blade at the size it actually hits at. It was pinned to 34px
        // while the hit radius scaled with +REACH, so at max area the sprite
        // covered less than half the ground it swept.
        const size = orbitBladeRadius(p.areaMult) * 2 + 8;
        for (let i = 0; i < orbs; i++) {
          const a = angle + (i / orbs) * TAU;
          const ox = camX + Math.cos(a) * radius;
          const oy = camY + Math.sin(a) * radius;
          const orb = this.orbs.take();
          orb.x = ox;
          orb.y = oy;
          orb.width = size;
          orb.height = size;
          orb.tint = def.color;
          this.addGlow(ox, oy, size * 2.2, def.color, 0.45);
        }
      } else if (inst.id === 'aura') {
        const radius = weaponStat(def, def.size, inst.level) * p.areaMult;
        // Pulses with its own damage tick so the player can see when it fires.
        const pulse = 0.55 + 0.25 * Math.sin(inst.phase * 6.5);
        this.auraRing
          .circle(camX, camY, radius)
          .stroke({ width: 2.5, color: def.color, alpha: pulse * 0.7 });
        this.auraRing
          .circle(camX, camY, radius)
          .fill({ color: def.color, alpha: 0.06 + pulse * 0.05 });
      }
    }
    this.orbs.end();

    // Health as a ring at the player's feet rather than a screen corner. On a
    // phone the eyes live on the character, and a corner bar goes unread until
    // it is already too late.
    const g = this.healthRing;
    g.clear();
    const frac = clamp(p.hp / p.maxHp, 0, 1);
    const r = myBody + 11;
    // A solid dark halo, not a faint one. This is what keeps the player
    // findable inside a dense swarm — without it the silhouette dissolves the
    // instant more than a handful of enemies close in.
    g.circle(camX, camY, r).stroke({ width: 5, color: 0x05070f, alpha: 0.85 });
    if (p.index === arenaLeader) {
      const pulse = 0.58 + Math.sin(this.animT * 3.2) * 0.16;
      g.circle(camX, camY, r + 6).stroke({ width: 2, color: 0x76e8ff, alpha: pulse });
      g.poly([camX, camY - r - 15, camX - 6, camY - r - 7, camX + 6, camY - r - 7])
        .fill({ color: 0x76e8ff, alpha: 0.95 });
    }
    if (frac > 0) {
      const start = -Math.PI / 2;
      // moveTo first: arc() follows the canvas convention and draws a line
      // from the current path point to the arc's start, which otherwise
      // trailed a stray stroke from the world origin to the player.
      g.moveTo(camX + Math.cos(start) * r, camY + Math.sin(start) * r);
      g.arc(camX, camY, r, start, start + TAU * frac).stroke({
        width: 3,
        color: frac > 0.5 ? 0x7dff9b : frac > 0.25 ? 0xffd23a : 0xff5c6e,
      });
    }
  }
}
