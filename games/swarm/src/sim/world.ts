import { Pool, Rng, SpatialHash, TAU, clamp, datan2, dcos, dexp, dhypot, dsin } from '@arcade/core';
import { RivalBrain } from './seatai.js';
import type { RivalProfile } from '../content/rivals.js';
import {
  BOSS_BEHAVIOUR,
  BOSS_LEASH,
  BOSS_REPEAT_PERIOD,
  BOSS_MODIFIERS,
  BOSS_MOD_STATS,
  BOSS_SCHEDULE,
  CAPACITY,
  CONCURRENT_CAP,
  ENEMIES,
  GEM,
  HEALTH_DROP,
  AGGRO,
  OPENING,
  PLAYER,
  SIPHON,
  seatRadius,
  BULWARK_ARMOR,
  BURROWER,
  PROJECTILE_CAP,
  TIDE,
  WEAVER,
  WORLD,
  isBoss,
  xpToNext,
  type EnemyKind,
} from '../content/balance.js';
import {
  ELITE_WAVE_PERIOD,
  ELITE_WAVE_START,
  SCRIPT,
  SURGE_PERIOD,
  SURGE_START,
  ambientKind,
  crowdFactor,
  densityAt,
  eliteWavePeriodAt,
  surgePeriodAt,
  threatDamage,
  threatHp,
  threatSpeed,
} from '../content/waves.js';
import { FIRST_DRAW, UPGRADES_BY_ID, buildCardPool, type Card } from '../content/upgrades.js';
import { MAX_WEAPONS, WEAPONS, type WeaponId } from '../content/weapons.js';
import { DEFAULT_CHARACTER, type Character } from '../content/characters.js';
import { ABILITIES, ABILITY } from '../content/abilities.js';
import { applyForge, forgeXpMult, type ForgeLevels } from '../content/forge.js';
import { applyMastery } from '../content/mastery.js';
import { BOON, BOONS, BOON_IDS, type BoonId } from '../content/boons.js';
import { ascensionMods, type AscensionMods } from '../content/ascension.js';
import {
  damageFromPower,
  densityFromPower,
  powerIndex,
  threatFromPower,
} from '../content/threat.js';
import { tickWeapon } from './weapons.js';
import type {
  Enemy,
  Gem,
  PlayerStats,
  Projectile,
  ProjectileKind,
  RunPhase,
  RunState,
  SimEvent,
  WeaponInstance,
} from './types.js';

/**
 * The simulation.
 *
 * HARD RULE: nothing in sim/ may import from render/ or from pixi.js. The sim
 * must run headless in Node so `tools/balance` can execute thousands of runs
 * to tune the XP curve. Break that rule and the tuning story dies with it.
 *
 * Determinism: no Math.random, no Date.now, no wall-clock reads. A run is a
 * pure function of (seed, input sequence, upgrade choices).
 */

const MAX_SPAWNS_PER_STEP = 14;
const MAX_SEPARATION_NEIGHBOURS = 8;
const KNOCKBACK_DECAY = 9;
/** Gems vanish into the player slightly inside their body, which reads better. */
const COLLECT_RADIUS = PLAYER.radius + 6;
/** Splitters stop splitting at this depth, or one kill cascades forever. */
const MAX_GENERATION = 1;
/** Seconds a boss may linger before retreating so the schedule can advance. */
const BOSS_LINGER = 48;
/** Banishes a player gets per run. A resource, so using one is a decision. */
const BANISHES_PER_RUN = 3;
/** Steps of position history kept for RECALL. 4s at 60Hz, with headroom. */
const TRAIL_LEN = 256;
/** Smallest fraction of a hit that always lands, however armoured the target. */
const ARMOR_MIN_THROUGH = 0.45;

/**
 * How far out the other seats begin.
 *
 * Far enough that nobody opens the run inside someone else's weapon, close
 * enough that the arena reads as one fight rather than eight private ones.
 */
/**
 * Where the other seats begin, as a share of the visible half-extents.
 *
 * A FIXED RADIUS WAS WRONG and it is why the arena looked empty. 260 units on a
 * portrait phone, whose visible half-width is about 240, put every seat near
 * the horizontal axis just past the edge of the screen — you entered an
 * eight-player arena and saw nobody until they happened to wander inward.
 * Spreading them on the viewport's own ellipse means they are on screen at the
 * start on any device, which is the only moment the game gets to tell you what
 * mode you are in.
 */
const ARENA_START_SHARE = 0.62;

/** How far a level-up reaches for gems in a lobby, as a multiple of pickup. */
const ARENA_VACUUM_REACH = 3;

/**
 * What a shot is worth against a person rather than a monster.
 *
 * `scale` is deliberately tiny and `maxShare` is the real governor: no single
 * hit can ever take more than this fraction of a target's maximum health, no
 * matter how absurd the build that fired it. Eight percent means roughly
 * thirteen clean hits to drop someone from full — long enough that they can
 * react, short enough that a duel resolves inside a fight rather than
 * outlasting it. `flat` keeps an early, weak build from being harmless.
 */
/**
 * The closing ring, in the arena only.
 *
 * WHY IT HAS TO EXIST. Measured across five eight-seat runs, PvP landed a
 * handful of hits in seven minutes: a survivor-like teaches you to move AWAY
 * from crowds, so eight people spread across the map and never meet. Seven
 * rivals who merely coexist with you are scenery with names. The ring is what
 * makes them opponents — the space runs out, and the last of it is shared.
 *
 * IT IS NOT A BATTLE-ROYALE TIMER. It never forces a kill and it never ends the
 * run; it removes room. Everything that kills you is still the swarm and the
 * other players' weapons, which means the skill it rewards is the same skill
 * the solo game teaches. It also opts out entirely below `holdFor` seconds, so
 * the opening minute of an arena run is the opening minute players already
 * know how to play.
 */
export const ARENA_RING = {
  /** Seconds of untouched play before the walls start moving. */
  holdFor: 45,
  start: 1500,
  /**
   * Never smaller than this: a ring you cannot move inside is not a fight.
   *
   * MEASURED, and the obvious reasoning was wrong. Squeezing the lobby tighter
   * should mean more weapons overlap, so 420 was tried at 250 — and PvP hits
   * HALVED, 169 down to 90. The ring compresses the arena either way (mean
   * separation 385 -> 329), but the tighter floor also kills people faster, and
   * a shorter run fires fewer shots than a roomier one. Contact is bounded by
   * time alive, not by distance, which is not what closing walls are for.
   *
   * So this sits at the value that measured better, and the next attempt at
   * making the arena a fight has to pull a different lever — weapon range, or
   * an objective worth standing on — rather than more of this one.
   */
  floor: 420,
  /** World units per second the wall closes. ~75s from start to floor. */
  closeRate: 16.5,
  /** Damage per second outside the wall, as a share of max health. */
  burnShare: 0.055,
  /** Damage cannot be dodged by standing just outside, so it ramps with depth. */
  burnPerUnit: 0.00022,
} as const;

const PVP = {
  scale: 0.02,
  flat: 2,
  maxShare: 0.08,
  /** Longer than a monster's, so nobody is chain-shot out of a bad position. */
  iframes: 0.45,
  killCredit: 25,
  claimWindow: 5,
  /**
   * THE SHATTER. Everything they were carrying hits the floor.
   *
   * Was 28%, which made a kill a rounding error and gave nobody a reason to
   * chase one. At 100% a single elimination can double you, the leader is the
   * most valuable object on the map, and the moment somebody goes down the
   * whole lobby converges on the same square of ground — which is the most
   * dangerous and most interesting place this game can produce.
   *
   * The victim keeps their own score for the results screen; this is loot on
   * the floor, not a transfer out of their record.
   */
  spillShare: 1.0,
  /** A small guaranteed cut, because the pile is contested and may be lost. */
  bountyShare: 0.1,
} as const;

export interface Player extends PlayerStats, RunState {
  x: number;
  y: number;
  px: number;
  py: number;
  invul: number;
  /** Seconds until the active ability is ready. Zero means ready. */
  abilityCd: number;
  /**
   * Rolling trail of recent positions, one per step, for RECALL.
   *
   * A ring buffer rather than an array of objects: this is written every single
   * step for the whole run, and the pooling rule exists precisely so that hot
   * paths never allocate.
   */
  trailX: Float64Array;
  trailY: Float64Array;
  trailHead: number;
  /**
   * Heading of the nearest target. Purely presentational — the render layer
   * points the player at what the auto-weapon is about to shoot, so the firing
   * reads as aimed rather than arbitrary.
   */
  aimAngle: number;
  weapons: WeaponInstance[];
  /**
   * Per-combatant run state that used to live on World.
   *
   * Each of these is genuinely independent in an arena — eight people levelling
   * off one swarm hold different builds, different boons, and different
   * banished cards.
   */
  boons: Set<BoonId>;
  banished: Set<string>;
  banishesLeft: number;
  /** Movement for this step, written by the controller that owns this seat. */
  input: { x: number; y: number };
  /** Cached power reading and the threat multipliers it produces. */
  power: number;
  powerHp: number;
  powerDensity: number;
  powerDamage: number;
  resonanceTick: number;
  /** Forge and mastery are per-seat: an AI rival has its own progression. */
  forge: ForgeLevels;
  xpMult: number;
  masteryLevel: number;
  character: Character;
  /** Passive stack counts, which gate max-stack caps and evolutions. */
  stacks: Map<string, number>;
  /** Cards taken this run. Seeds the deck, so it must be per combatant. */
  levelUpsTaken: number;
  /**
   * The seat number every client in the room agrees on.
   *
   * Equal to `index` in a solo or offline arena. In a networked one it is the
   * relay's numbering, because each client seats itself at zero and therefore
   * numbers the room differently. Used as the last tiebreak in the standings:
   * two rivals on exactly equal mass were being ordered by local seat order,
   * so two players saw the same photo finish resolve in opposite directions.
   */
  seatId: number;
  /** Last rival to damage this seat, for fair elimination credit. */
  lastHitBy: number;
  lastHitAt: number;
  /** The rival this seat is currently draining, or -1. Local seat index. */
  siphonTarget: number;
  /** Seconds spent holding that target, which is what makes the drain strong. */
  siphonLock: number;
  /**
   * True when another PERSON is sitting here, over the network.
   *
   * The simulation needs this for exactly one reason, and it is the difference
   * between a fair match and a lie: this client is not the authority on that
   * seat. Its owner is. So local damage may light them up, but only the packet
   * from their own machine may kill them — see hurtSeat and reportSeatDown.
   * The renderer also reads it, because "one of these seven is a real person"
   * is the single most valuable fact in a multiplayer round and it used to be
   * invisible.
   */
  live: boolean;
  /**
   * The policy driving this seat, for seats nobody is sitting in.
   *
   * Undefined means a human is here — the local player, or eventually a remote
   * one. The seat itself does not care which, and that is the whole point: a
   * human joining mid-run is a brain being removed, not a different code path.
   */
  brain?: SeatBrain;
}

/**
 * What drives an unoccupied seat.
 *
 * Deliberately narrow. A brain supplies exactly what a human supplies — a
 * direction to move, a card to take, a boon to keep — and nothing else, so it
 * can never reach past the interface a player has.
 */
export interface SeatBrain {
  /** Network seats must consume authoritative correction even if prediction killed them. */
  readonly runsWhileDead?: boolean;
  /** Called every step. Writes the seat's input. */
  think(world: World, seat: Player, dt: number): void;
  pickCard(cards: readonly Card[]): string;
  pickBoon(offer: readonly string[]): string;
}

export interface ProjectileOptions {
  radius: number;
  speed: number;
  life: number;
  color: number;
  turn?: number;
  pierce?: number;
}

export class World {
  readonly rng: Rng;
  seed: number;

  /**
   * One clock for the whole arena. Time is the only run state that stays on the
   * World — everyone in a shared arena is living through the same minute.
   */
  time = 0;

  /**
   * Per-seat state, delegated to seat 0.
   *
   * These were plain fields on World, which is the same thing as asserting that
   * exactly one person is playing. They now live on the seat, and these
   * accessors mean the ~100 existing call sites — and every harness — keep
   * reading and writing them exactly as before. Solo behaviour is unchanged by
   * construction rather than by testing, because it is the same code.
   */
  get level(): number { return this.player.level; }
  set level(v: number) { this.player.level = v; }
  get xp(): number { return this.player.xp; }
  set xp(v: number) { this.player.xp = v; }
  get xpNeeded(): number { return this.player.xpNeeded; }
  set xpNeeded(v: number) { this.player.xpNeeded = v; }
  get kills(): number { return this.player.kills; }
  set kills(v: number) { this.player.kills = v; }
  get damageTaken(): number { return this.player.damageTaken; }
  set damageTaken(v: number) { this.player.damageTaken = v; }
  get evolutionsThisRun(): number { return this.player.evolutionsThisRun; }
  set evolutionsThisRun(v: number) { this.player.evolutionsThisRun = v; }
  get character(): Character { return this.player.character; }
  set character(v: Character) { this.player.character = v; }
  get banishesLeft(): number { return this.player.banishesLeft; }
  set banishesLeft(v: number) { this.player.banishesLeft = v; }
  get masteryLevel(): number { return this.player.masteryLevel; }
  set masteryLevel(v: number) { this.player.masteryLevel = v; }
  get power(): number { return this.player.power; }
  set power(v: number) { this.player.power = v; }
  phase: RunPhase = 'playing';
  /** Rewarded-ad revives used this run. Capped at one. */
  revivesUsed = 0;

  /** Per-run stats, for achievements and the results screen. */
  readonly bossKindsKilled: string[] = [];

  /**
   * Everyone in the arena. Seat 0 is the local player, always.
   *
   * Solo mode is an arena of one, deliberately — a separate single-player code
   * path would be a second implementation of every rule, and the two would
   * drift apart within a week.
   */
  readonly players: Player[] = [];

  /** The local player. Kept as a property so ~100 call sites did not change. */
  get player(): Player {
    return this.players[0]!;
  }
  readonly enemies: Pool<Enemy>;
  readonly projectiles: Pool<Projectile>;
  /**
   * Hostile projectiles get their OWN pool.
   *
   * They shared the player's 400-slot pool, so a screen full of LANTERNs could
   * fill it and the player's own weapons would silently stop firing — no error,
   * no warning, the guns just stop working. That reads as the game glitching.
   */
  readonly hostiles: Pool<Projectile>;
  readonly gems: Pool<Gem>;

  /** Cards awaiting a choice. Non-null exactly when phase === 'levelup'. */
  pendingCards: Card[] | null = null;

  readonly events: SimEvent[] = [];

  /** Movement direction for this step, written by the host before step(). */
  get input(): { x: number; y: number } { return this.player.input; }

  /** The boss currently alive, for the health bar. Null when none. */
  activeBoss: Enemy | null = null;
  activeBossName = '';
  private activeBossSpawnedAt = 0;

  /** Reused by the chain weapon so it never allocates a Set per cast. */
  readonly chainScratch = new Set<number>();

  /** Live WEAVER tethers as a flat [x1,y1,x2,y2,...] list, for the renderer. */
  readonly tethers: number[] = [];

  /** Active SINGULARITY, if any. Zero time means none. */
  singularityX = 0;
  singularityY = 0;
  singularityTime = 0;

  /**
   * Cards banished for the rest of the run, and how many banishes are left.
   *
   * The draft was a lottery: the player could pursue a build only by hoping the
   * card they needed appeared, and could not remove the ones crowding it out.
   * Three banishes turn a wish into a plan — and because they are a finite
   * resource, spending one is itself a decision rather than a free filter.
   * Deliberately NOT gated behind an ad; the whole point is agency.
   */
  get banished(): Set<string> { return this.player.banished; }

  /**
   * Boons taken this run, and the offer awaiting a choice.
   *
   * `phase` becomes 'boon' while the player picks, exactly as it becomes
   * 'levelup' for a card — the sim stops, so a boss dying in a crowd cannot
   * kill you while you read three sentences.
   */
  get boons(): Set<BoonId> { return this.player.boons; }
  pendingBoons: BoonId[] | null = null;

  /** Boons that need a running counter rather than a flag. */
  private get resonanceTick(): number { return this.player.resonanceTick; }
  private set resonanceTick(v: number) { this.player.resonanceTick = v; }

  /**
   * Chosen difficulty tier, and its accumulated modifiers.
   *
   * Read as a flat set of multipliers so the simulation never has to know the
   * ladder exists — adding a tier is a data change in content/ascension.ts.
   */
  ascension = 0;

  /**
   * The closing ring. Zero radius means it has not begun.
   *
   * Centred where the player stood when it started, so it is never a surprise
   * teleport — the safe ground is the ground they were already on.
   */
  tideX = 0;
  tideY = 0;
  tideRadius = 0;
  /** Seconds spent outside, which escalates the burn. Resets on returning. */
  private tideExposure = 0;
  /**
   * Health the tide has taken this run.
   *
   * Tracked separately from `damageTaken` because the tide is the one thing
   * that kills without anything touching you — a results screen that cannot
   * distinguish "the swarm got you" from "you stood outside the ring" is
   * telling the player the wrong story about their own death.
   */
  tideDamage = 0;
  private asc: AscensionMods = ascensionMods(0);

  /** Boss kinds already fought this run — drives the repeat modifier. */
  private readonly seenBossKinds = new Set<EnemyKind>();

  /**
   * Purchased Forge levels, applied on top of the character at run start.
   *
   * Set by the host before reset(). Held here rather than read from storage so
   * the sim stays a pure function of its inputs and the headless harness can
   * simulate any meta-state it wants.
   */
  private get forge(): ForgeLevels { return this.player.forge; }
  private set forge(v: ForgeLevels) { this.player.forge = v; }
  private get xpMult(): number { return this.player.xpMult; }
  private set xpMult(v: number) { this.player.xpMult = v; }

  /**
   * A SEPARATE random stream for the card deck.
   *
   * The daily challenge claimed everyone plays an identical run. Measured, two
   * players on one seed diverged in the simulation stream at frame 35 — 0.58
   * seconds — and were offered completely different cards by their second
   * level-up. One finished level 15 with 436 kills, the other level 29 with
   * 2,989. Ranking those against each other ranks luck.
   *
   * It cannot be fixed by sharing a seed alone, because the main stream is
   * consumed by spawn positions, and how many enemies spawn depends on where
   * the player is standing. So the deck is reseeded from (seed, level-up
   * ordinal) before every draw: the Nth card screen of a given seed is the same
   * for everyone, however they played to get there.
   *
   * Difficulty is already fair without this — DENSITY, BOSS_SCHEDULE and the
   * threat curves are all keyed to the clock, so second 240 is identical for
   * every player. This is the missing half.
   */
  private readonly deckRng = new Rng(1);

  private readonly hash = new SpatialHash(WORLD.cellSize);
  private readonly scratch: number[] = [];
  private get stacks(): Map<string, number> { return this.player.stacks; }
  private get levelUpsTaken(): number { return this.player.levelUpsTaken; }
  private set levelUpsTaken(v: number) { this.player.levelUpsTaken = v; }
  private nextScriptIndex = 0;
  private nextEliteWave = ELITE_WAVE_START;
  private nextSurge = SURGE_START;
  private nextBossIndex = 0;
  private nextBossTime = BOSS_SCHEDULE[0]!.t;

  /**
   * How strong this build is, recomputed when it changes rather than per frame.
   *
   * Read by the spawner, so a swarm arriving at 6:00 is sized against the
   * player who is actually standing there — see content/threat.ts.
   */
  private get powerHp(): number { return this.player.powerHp; }
  private set powerHp(v: number) { this.player.powerHp = v; }
  private get powerDensity(): number { return this.player.powerDensity; }
  private set powerDensity(v: number) { this.player.powerDensity = v; }
  private get powerDamage(): number { return this.player.powerDamage; }
  private set powerDamage(v: number) { this.player.powerDamage = v; }

  /** Half-extents of the visible area, used to place the spawn ring. */
  private viewHalfW = 640;
  private viewHalfH = 360;

  constructor(seed: number) {
    this.seed = seed;
    this.rng = new Rng(seed);

    this.players.push(this.makeSeat(0));

    this.enemies = new Pool<Enemy>(CAPACITY.enemies, makeEnemy, resetEnemy);
    this.projectiles = new Pool<Projectile>(CAPACITY.projectiles, makeProjectile, resetProjectile);
    this.hostiles = new Pool<Projectile>(CAPACITY.hostiles, makeProjectile, resetProjectile);
    this.gems = new Pool<Gem>(CAPACITY.gems, makeGem, resetGem);

    this.resetState();
  }

  /**
   * Restart in place, reusing the pools.
   *
   * Constructing a fresh World allocates ~2500 pooled objects, and the restart
   * tap is precisely the moment the player is least willing to wait and most
   * likely to leave. Reset costs nothing and keeps the GC quiet.
   */
  /** Mastery level of the character being played. Call before reset(). */
  setMastery(level: number): void {
    this.masteryLevel = level;
  }

  /** Difficulty tier for the next run. Call before reset(). */
  setAscension(level: number): void {
    this.ascension = level;
    this.asc = ascensionMods(level);
  }

  /** Permanent upgrades for the next run. Call before reset(). */
  setForge(levels: ForgeLevels): void {
    this.forge = levels;
    this.xpMult = forgeXpMult(levels);
  }

  reset(seed: number, character: Character = DEFAULT_CHARACTER): void {
    this.seed = seed;
    this.rng.state = seed >>> 0 || 1;
    this.character = character;
    this.resetState();
  }

  /**
   * One seat in the arena, fully independent.
   *
   * Everything a combatant needs to run its own build lives here, so adding a
   * seat is one call rather than a second copy of the run rules.
   */
  private makeSeat(index: number): Player {
    return {
      index,
      name: '',
      alive: true,
      level: 1,
      xp: 0,
      xpNeeded: xpToNext(1),
      kills: 0,
      damageTaken: 0,
      evolutionsThisRun: 0,
      diedAt: -1,
      x: 0,
      y: 0,
      px: 0,
      py: 0,
      hp: PLAYER.maxHp,
      maxHp: PLAYER.maxHp,
      speed: PLAYER.speed,
      pickupRadius: PLAYER.pickupRadius,
      damageMult: 1,
      fireRateMult: 1,
      projectileCount: 0,
      areaMult: 1,
      invul: 0,
      abilityCd: 0,
      trailX: new Float64Array(TRAIL_LEN),
      trailY: new Float64Array(TRAIL_LEN),
      trailHead: 0,
      aimAngle: 0,
      weapons: [],
      boons: new Set<BoonId>(),
      banished: new Set<string>(),
      banishesLeft: BANISHES_PER_RUN,
      input: { x: 0, y: 0 },
      power: 1,
      powerHp: 1,
      powerDensity: 1,
      powerDamage: 1,
      resonanceTick: 0,
      forge: {},
      xpMult: 1,
      masteryLevel: 0,
      character: DEFAULT_CHARACTER,
      stacks: new Map<string, number>(),
      levelUpsTaken: 0,
      arenaScore: 100,
      pvpKills: 0,
      arenaStreak: 0,
      seatId: index,
      siphonTarget: -1,
      siphonLock: 0,
      lastHitBy: -1,
      lastHitAt: -999,
      live: false,
    };
  }

  /**
   * Bring one seat to its opening state.
   *
   * Extracted from the run reset so an arena seat is built by exactly the same
   * code as the local player's. A rival assembled by a second, similar-looking
   * function is a rival that is subtly not playing the same game, and the
   * difference would show up as a balance mystery months later.
   */
  private initSeat(p: Player): void {
    const c = p.character;
    // Seats start spaced around a ring so an arena does not open with eight
    // people standing on the same pixel. Seat zero keeps the origin, which is
    // what a solo run has always started from.
    if (p.index === 0) {
      p.x = 0;
      p.y = 0;
    } else {
      const a = (p.index / Math.max(1, this.players.length)) * TAU;
      p.x = dcos(a) * this.viewHalfW * ARENA_START_SHARE;
      p.y = dsin(a) * this.viewHalfH * ARENA_START_SHARE;
    }
    p.px = p.x;
    p.py = p.y;
    p.maxHp = Math.round(c.maxHp * this.asc.startingHp);
    p.hp = p.maxHp;
    p.speed = PLAYER.speed * c.speedMult;
    p.pickupRadius = PLAYER.pickupRadius;
    p.damageMult = c.damageMult;
    p.fireRateMult = c.fireRateMult;
    p.projectileCount = c.projectileCount;
    p.areaMult = c.areaMult;
    p.invul = 0;
    // Ready from the first second. An ability the player cannot use during the
    // opening is an ability they never learn they have.
    p.abilityCd = 0;
    p.trailX.fill(0);
    p.trailY.fill(0);
    p.trailHead = 0;
    p.aimAngle = 0;
    p.weapons.length = 0;
    // Permanent upgrades stack on top of the character, never replace it — a
    // character's identity has to survive a fully-bought Forge or the roster
    // stops meaning anything to a returning player.
    applyForge(p, p.forge);
    // Mastery sharpens the character it belongs to, on top of the shared Forge.
    applyMastery(p, p.masteryLevel);
    this.refreshPower(p);
    // The first shot fires unprompted at 0.55s — that unprompted hit is the
    // game demonstrating its own loop before the player has touched anything.
    p.weapons.push({
      id: c.startWeapon,
      origin: c.startWeapon,
      level: c.startWeaponLevel,
      cd: OPENING.firstShotDelay,
      phase: 0,
    });

  }

  // ------------------------------------------------------------- the arena

  /**
   * Fill the empty seats.
   *
   * Called before reset, because the seats have to exist when the run is built
   * or they would open the game already a level behind. Passing zero rivals is
   * the solo game and touches nothing.
   */
  enterArena(
    profiles: readonly RivalProfile[],
    roster: readonly Character[],
    opts: {
      /**
       * The seed of the run about to start.
       *
       * Passed explicitly because seats are built BEFORE reset, so `this.seed`
       * is still the previous run's. Every rival's behaviour hangs off it, and
       * in a networked arena two clients that seeded their rivals from whatever
       * they happened to be playing last are watching two different lobbies.
       */
      seed?: number;
      /**
       * The shared seat number each local seat represents.
       *
       * Local seat 0 is always whoever is holding this client, so every client
       * numbers the room differently. Identity — which character a rival wears,
       * which behaviour profile it runs, which random stream it draws from —
       * must hang off the SHARED number instead, or the same person is a
       * different character on every screen and no two clients agree on who is
       * winning. Measured before this existed: the wrong character on 50% of
       * samples, and one client in four naming a different leader.
       */
      ids?: readonly number[];
      /** The shared seat number this client itself holds. */
      self?: number;
    } = {},
  ): void {
    this.players.length = 1;
    this.players[0]!.seatId = Math.max(0, opts.self ?? 0);
    const seed = opts.seed ?? this.seed;
    for (let i = 0; i < profiles.length; i++) {
      const seat = this.makeSeat(i + 1);
      const prof = profiles[i]!;
      const shared = opts.ids?.[i] ?? i + 1;
      seat.seatId = shared;
      seat.name = prof.name;
      // Rivals draw from the same roster the player picks from, spread across
      // it so the arena shows off characters rather than eight of one.
      seat.character = roster.length > 0 ? roster[shared % roster.length]! : DEFAULT_CHARACTER;
      seat.brain = new RivalBrain(prof, seed, shared);
      this.players.push(seat);
    }
  }

  /**
   * Hand a seat to a real person, mid-run, without anyone noticing.
   *
   * This is the whole reason the AI lives behind the same interface a player
   * uses. Joining is not a spawn and not a lobby transition: it is one brain
   * being dropped, and the build, position, level and standing that seat had a
   * moment ago carry straight on. Nobody watching sees a player appear from
   * nothing, and the joiner does not sit through a queue.
   */
  seatPlayer(index: number): Player | null {
    const seat = this.players[index];
    if (!seat || !seat.brain) return null;
    seat.brain = undefined;
    seat.input.x = 0;
    seat.input.y = 0;
    return seat;
  }

  /**
   * The arriving player takes a seat an AI has been warming.
   *
   * Called after a late joiner fast-forwards their copy of the run to the room
   * clock. The AI may well have died during that catch-up, and handing someone
   * a corpse as their first frame of multiplayer is not a game. They take the
   * seat standing, with the build it earned and a fraction of its health, plus
   * enough breathing room to read the screen before the swarm reaches them.
   */
  takeOverSeat(): void {
    const p = this.player;
    this.phase = 'playing';
    p.alive = true;
    p.diedAt = -1;
    p.hp = Math.max(p.hp, p.maxHp * 0.6);
    p.invul = 2.5;
    const list = this.enemies.active;
    for (let i = list.length - 1; i >= 0; i--) {
      const e = list[i]!;
      if (isBoss(e.kind)) continue;
      const dx = e.x - p.x;
      const dy = e.y - p.y;
      if (dx * dx + dy * dy < 260 * 260) this.enemies.despawnAt(i);
    }
  }

  /**
   * Adopt the room owner's record for a seat nobody is sitting in.
   *
   * Every seat needs exactly one authority or the scoreboard is fiction. A
   * person is the authority on themselves; the seats nobody is sitting in are
   * owned by the lowest-numbered client in the room. Without this, each client
   * grew its own copy of the same seven rivals from its own copy of the fight,
   * and the copies drifted: measured across four clients in one room, every
   * single player was shown a different finishing place on different machines.
   *
   * Only the numbers the standings are computed from are adopted. Position and
   * health stay local, because those are drawn from a fight this client is
   * actually running and a corrected ghost would read worse than a consistent
   * one. Death is monotone and therefore safe to propagate; life is not, so a
   * seat this client has already buried is never resurrected by a packet.
   */
  applySeatRecord(
    index: number,
    record: {
      score: number;
      level: number;
      kills: number;
      dead: boolean;
      killer: number;
      hp: number;
      maxHp: number;
    },
  ): void {
    const seat = this.players[index];
    if (!seat || index === 0 || seat.live) return;
    seat.arenaScore = Math.max(0, record.score);
    seat.level = Math.max(1, record.level | 0);
    seat.kills = Math.max(seat.kills, record.kills | 0);
    // Health comes from the owner too, or a seat this client has shot to a
    // sliver would sit there with an empty bar refusing to die.
    if (record.maxHp > 0) seat.maxHp = record.maxHp;
    if (record.hp > 0) seat.hp = Math.min(seat.maxHp, record.hp);
    if (record.dead && seat.alive) this.reportSeatDown(seat, record.killer);
  }

  /**
   * This client's fight says a seat it does not own should be dead.
   *
   * It does not get to decide that. It holds the seat at a sliver of health so
   * the sprite does not read as an invincible rival, and hands the claim to the
   * transport, which passes it to whoever owns the seat. If the owner agrees,
   * the death comes back as a packet like any other and the killer named here
   * is the one who gets paid.
   */
  private claimSeatDown(p: Player): void {
    p.hp = 1;
    const killer = this.time - p.lastHitAt <= PVP.claimWindow ? p.lastHitBy : -1;
    this.onSeatDownClaim?.(p.index, killer);
  }

  /**
   * Set by the transport. Called when this client believes a seat it does not
   * own has been killed by it — see claimSeatDown.
   */
  onSeatDownClaim: ((seat: number, killer: number) => void) | null = null;

  /**
   * A person's own machine reporting that they went down.
   *
   * The only path by which a live seat may die on this client. Their client is
   * the authority on their health; ours is authority on nothing about them. It
   * still runs the full local death — bounty, elimination banner, the mass that
   * spills onto the floor — because those are OUR reactions to their death, and
   * the killer named in the packet is the one who gets paid.
   */
  reportSeatDown(seat: Player, killerIndex: number): void {
    if (!seat.alive) return;
    const killer = this.players[killerIndex];
    if (killer && killer !== seat) {
      seat.lastHitBy = killerIndex;
      seat.lastHitAt = this.time;
    } else {
      seat.lastHitBy = -1;
      seat.lastHitAt = -999;
    }
    this.killSeat(seat);
  }

  /**
   * Shots that actually landed on a person this run.
   *
   * Exists because the first arena probe inferred PvP from seats losing health,
   * which is also what enemy contact looks like — the check would have passed
   * with PvP entirely disconnected. A metric that cannot fail is worse than no
   * metric.
   */
  pvpHits = 0;

  /** Which seat the spawn director serves first. Rotates every step. */
  private spawnRotation = 0;

  /**
   * Radius of the arena wall. Zero means no wall — every solo run, always.
   *
   * Public so the renderer can draw it: a boundary the player cannot see is
   * just unexplained damage, which is the one thing a difficulty mechanic must
   * never be.
   */
  arenaRing = 0;

  /** Everyone still standing, in placement order. */
  standings(): Player[] {
    return this.players.slice().sort((a, b) => {
      if (a.alive !== b.alive) return a.alive ? -1 : 1;
      // The shared seat number breaks every remaining tie, so a dead heat
      // resolves the same way on every machine in the room.
      if (a.alive && b.alive) {
        return b.arenaScore - a.arenaScore || b.level - a.level || a.seatId - b.seatId;
      }
      return b.diedAt - a.diedAt || a.seatId - b.seatId;
    });
  }

  private resetState(): void {
    this.time = 0;
    this.phase = 'playing';
    this.pvpHits = 0;
    this.spawnRotation = 0;
    this.rerolls = 0;
    this.arenaRing = 0;
    // Every seat comes back to life. Without this a world reused after a death
    // starts the next run with a corpse in seat zero, and the only visible
    // symptom is that your weapons never fire.
    for (const p of this.players) {
      p.alive = true;
      p.diedAt = -1;
      p.level = 1;
      p.xp = 0;
      p.xpNeeded = xpToNext(1);
      p.kills = 0;
      p.damageTaken = 0;
      p.evolutionsThisRun = 0;
      p.levelUpsTaken = 0;
      p.arenaScore = 100;
      p.pvpKills = 0;
      p.arenaStreak = 0;
      p.lastHitBy = -1;
      p.lastHitAt = -999;
      p.siphonTarget = -1;
      p.siphonLock = 0;
      p.stacks.clear();
      p.boons.clear();
      p.banished.clear();
      p.banishesLeft = BANISHES_PER_RUN;
      p.resonanceTick = 0;
      p.input.x = 0;
      p.input.y = 0;
      p.weapons.length = 0;
      p.abilityCd = 0;
      p.invul = 0;
      p.trailHead = 0;
    }
    this.level = 1;
    this.xp = 0;
    this.xpNeeded = xpToNext(1);
    this.kills = 0;
    this.revivesUsed = 0;

    this.pendingCards = null;
    this.events.length = 0;
    this.input.x = 0;
    this.input.y = 0;

    this.stacks.clear();
    this.levelUpsTaken = 0;
    this.nextScriptIndex = 0;
    this.nextEliteWave = ELITE_WAVE_START;
    this.nextSurge = SURGE_START;
    this.nextBossIndex = 0;
    this.nextBossTime = BOSS_SCHEDULE[0]!.t * this.asc.bossTiming;
    this.activeBoss = null;
    this.activeBossName = '';
    this.activeBossSpawnedAt = 0;
    this.seenBossKinds.clear();
    this.singularityTime = 0;
    this.tideRadius = 0;
    this.tideExposure = 0;
    this.tideDamage = 0;
    this.banished.clear();
    this.banishesLeft = BANISHES_PER_RUN;
    this.boons.clear();
    this.pendingBoons = null;
    this.resonanceTick = 0;

    this.enemies.clear();
    this.projectiles.clear();
    this.hostiles.clear();
    this.gems.clear();
    this.tethers.length = 0;

    this.damageTaken = 0;
    this.evolutionsThisRun = 0;
    this.bossKindsKilled.length = 0;

    // Character defines the whole opening: which weapon fires first, and what
    // the run's stat profile is. This is what makes run 20 open differently
    // from run 2.
    for (const seat of this.players) this.initSeat(seat);

    this.seedOpening();
  }

  /**
   * Rewarded-ad revive. Once per run.
   *
   * Clears the immediate area rather than only restoring health — coming back
   * to life inside the same crowd that just killed you reads as a cheat, not a
   * rescue, and burns the goodwill the ad was supposed to buy.
   */
  revive(): void {
    if (this.phase !== 'dead' || this.revivesUsed > 0) return;
    this.revivesUsed++;
    this.phase = 'playing';

    const p = this.player;
    p.hp = p.maxHp;
    p.invul = 2.5;
    // Back in the arena. Without this the seat stays flagged dead and its
    // weapons silently stop firing — the revive would return the sprite and
    // not the player.
    p.alive = true;
    p.diedAt = -1;

    const list = this.enemies.active;
    for (let i = list.length - 1; i >= 0; i--) {
      const e = list[i]!;
      if (isBoss(e.kind)) continue; // clearing the boss would erase the fight
      const dx = e.x - p.x;
      const dy = e.y - p.y;
      if (dx * dx + dy * dy < 320 * 320) this.enemies.despawnAt(i);
    }
    this.events.push({ type: 'revived' });
  }

  setView(halfW: number, halfH: number): void {
    this.viewHalfW = halfW;
    this.viewHalfH = halfH;
  }

  clearEvents(): void {
    this.events.length = 0;
  }

  stacksOf(id: string, seat: Player = this.player): number {
    return seat.stacks.get(id) ?? 0;
  }

  weaponLevel(id: WeaponId): number {
    const w = this.player.weapons.find((x) => x.id === id);
    return w ? w.level : 0;
  }

  // ---------------------------------------------------------------- step

  step(dt: number): void {
    if (this.phase !== 'playing') return;

    this.time += dt;

    // Unoccupied seats decide first, so their input is read by the same
    // movement code the local player's input goes through. A brain that could
    // move a seat directly would be able to do things a player cannot.
    if (this.players.length > 1) {
      for (const seat of this.players) {
        if (seat.brain && (seat.alive || seat.brain.runsWhileDead)) seat.brain.think(this, seat, dt);
      }
      this.updateRivalPlayers(dt);
    }

    this.runScript();
    this.runBossSchedule();
    this.runRecurringWaves();
    this.spawnToDensity();
    this.rebuildHash();
    this.updateTethers();

    this.updatePlayer(dt);
    this.updateEnemies(dt);
    this.updateWeapons(dt);
    this.updateProjectiles(dt);
    this.updateHostiles(dt);
    this.updateGems(dt);
    this.playerContact(dt);

    if (this.players.length > 1) {
      this.updateArenaRing(dt);
      this.updateSiphon(dt);
      const bleed = AGGRO.decay * dt;
      for (let i = 0; i < 64; i++) {
        if (this.handoffTally[i]! > 0) {
          this.handoffTally[i] = Math.max(0, this.handoffTally[i]! - bleed);
        }
      }
    }

    this.compactEnemies();
    this.checkLevelUp();
    if (this.players.length > 1) {
      for (let i = 1; i < this.players.length; i++) this.checkLevelUp(this.players[i]!);
    }
  }

  // ------------------------------------------------------------- spawning

  private seedOpening(): void {
    // Evenly spaced rather than random, so the opening reads as composed and
    // every seed produces the same clean first two seconds.
    for (let i = 0; i < OPENING.count; i++) {
      const a = (i / OPENING.count) * TAU + 0.4;
      this.spawnEnemyAt('drifter', dcos(a) * OPENING.radius, dsin(a) * OPENING.radius);
    }
  }

  /**
   * Distance from the player to just outside the visible RECTANGLE along a
   * given heading — not a circle.
   *
   * A circle of radius max(halfW, halfH) puts every spawn as far away as the
   * longest axis, so on a tall portrait phone enemies appeared ~590px out and
   * spent eight seconds walking in. Nine seconds into a run with sixteen
   * enemies alive, exactly one was on screen.
   */
  private spawnDistance(angle: number): number {
    const hw = this.viewHalfW + WORLD.spawnMargin;
    const hh = this.viewHalfH + WORLD.spawnMargin;
    const ca = Math.abs(dcos(angle));
    const sa = Math.abs(dsin(angle));
    const tx = ca < 1e-6 ? Infinity : hw / ca;
    const ty = sa < 1e-6 ? Infinity : hh / sa;
    return Math.min(tx, ty);
  }

  private spawnEnemyOnRing(kind: EnemyKind, radius?: number, around?: Player): Enemy | null {
    const anchor = around ?? this.player;
    const ix = anchor.input.x;
    const iy = anchor.input.y;
    let a: number;
    if ((ix !== 0 || iy !== 0) && this.rng.next() < WORLD.spawnForwardBias) {
      // Ahead of travel, so fleeing in a straight line stops being free.
      const travel = datan2(iy, ix);
      a = travel + this.rng.range(-WORLD.spawnForwardArc, WORLD.spawnForwardArc);
    } else {
      a = this.rng.angle();
    }
    const r = radius ?? this.spawnDistance(a);
    return this.spawnEnemyAt(kind, anchor.x + dcos(a) * r, anchor.y + dsin(a) * r, 0, anchor);
  }

  spawnEnemyAt(
    kind: EnemyKind,
    x: number,
    y: number,
    generation = 0,
    // Whose build this enemy is scaled against. An enemy walking toward a
    // level-3 rival must not carry the health the level-40 local player earned.
    against: Player = this.player,
  ): Enemy | null {
    const cap = CONCURRENT_CAP[kind];
    if (cap !== undefined) {
      let n = 0;
      const list = this.enemies.active;
      for (let i = 0; i < list.length; i++) {
        if (list[i]!.hp > 0 && list[i]!.kind === kind) n++;
      }
      if (n >= cap) return null;
    }
    const e = this.enemies.spawn();
    if (!e) return null;
    const s = ENEMIES[kind];
    // Threat is baked in at spawn, not applied per-frame — an enemy keeps the
    // stats of the moment it arrived, so the difficulty of what is already on
    // screen never shifts under the player.
    const scale = generation > 0 ? 0.55 : 1;
    // Time AND build. See content/threat.ts for why one without the other
    // cannot work.
    const greed = against.boons.has('greed') ? BOON.greedEnemyHp : 1;
    const hp = s.hp * threatHp(this.time) * against.powerHp * greed * this.asc.enemyHp * scale;
    e.x = x;
    e.y = y;
    e.px = x;
    e.py = y;
    e.vx = 0;
    e.vy = 0;
    e.hp = hp;
    e.maxHp = hp;
    e.radius = s.radius * (generation > 0 ? 0.72 : 1);
    e.speed = s.speed * threatSpeed(this.time) * this.asc.enemySpeed * (generation > 0 ? 1.15 : 1);
    e.damage = s.damage * threatDamage(this.time) * this.powerDamage * this.asc.enemyDamage;
    e.xp = s.xp;
    e.mass = s.mass;
    e.kind = kind;
    e.color = s.color;
    e.flash = 0;
    e.orbCd = 0;
    e.auraCd = 0;
    e.kx = 0;
    e.ky = 0;
    e.special = 0;
    e.phase = 0;
    e.generation = generation;
    // Armour scales with the same curve as hit points, so a BULWARK stays
    // proportionally as resistant at 10 minutes as it is at 4. A flat constant
    // would be meaningless within a minute of its introduction.
    e.armor = kind === 'bulwark' ? BULWARK_ARMOR * threatHp(this.time) * scale : 0;
    e.vuln = 1;
    e.submerged = false;
    return e;
  }

  private runScript(): void {
    while (this.nextScriptIndex < SCRIPT.length) {
      const entry = SCRIPT[this.nextScriptIndex]!;
      if (entry.t > this.time) break;
      this.nextScriptIndex++;

      const ev = entry.event;
      if (ev.type === 'spawn') {
        for (let i = 0; i < ev.count; i++) this.spawnEnemyOnRing(ev.kind);
        if (ev.kind === 'elite') this.events.push({ type: 'eliteSpawned' });
        if (ev.kind === 'herald') this.events.push({ type: 'heraldSpawned' });
      } else {
        // A closing ring, tight enough to demand real dodging. This is the
        // engineered near-death — without a moment of genuine threat the
        // preceding power fantasy has nothing to push against.
        const base = this.rng.angle();
        for (let i = 0; i < ev.count; i++) {
          const a = base + (i / ev.count) * TAU;
          this.spawnEnemyAt(
            ev.kind,
            this.player.x + dcos(a) * ev.radius,
            this.player.y + dsin(a) * ev.radius,
          );
        }
      }
    }
  }

  /**
   * Bosses.
   *
   * A run needs punctuation, not just a rising density gradient. Three authored
   * encounters land at 60/120/180s and then repeat on a cadence, each one a
   * recognisable event with a name and a health bar rather than a bigger circle.
   */
  private runBossSchedule(): void {
    if (this.time < this.nextBossTime) return;
    // Never stack bosses. The schedule used to fire on the clock alone, so
    // LANCER spawned at t=120 on top of a WARDEN still at 87-100% health; the
    // single activeBoss slot was overwritten and the older one became an
    // orphan — alive, summoning, with no bar and no name attached to it.
    if (this.activeBoss && this.activeBoss.hp > 0) {
      // A boss that has outstayed its welcome RETREATS, so the schedule can
      // move on. Without this, deferring cost variety: players who could not
      // finish WARDEN simply never met LANCER or BROODMOTHER at all, and boss
      // 2 reach fell from 61% to 22%. Leaving is not a reward — no gem, no
      // gold — it just stops one stalled fight from eating the whole run.
      if (this.time - this.activeBossSpawnedAt > BOSS_LINGER) {
        const idx = this.enemies.active.indexOf(this.activeBoss);
        if (idx >= 0) this.enemies.despawnAt(idx);
        this.activeBoss = null;
        this.activeBossName = '';
      } else {
        this.nextBossTime = this.time + 4;
        return;
      }
    }

    // Rotate, do not clamp. Clamping meant WARDEN and LANCER appeared exactly
    // once each and BROODMOTHER then repeated eight times — the clearest
    // possible signal to a player that the content has run out.
    const entry = BOSS_SCHEDULE[this.nextBossIndex % BOSS_SCHEDULE.length]!;

    // Modify any boss KIND the player has already fought this run — not merely
    // ones past the end of the schedule.
    //
    // The old rule keyed on the schedule wrapping, which was correct only while
    // the table held three unique kinds. The table now revisits BROODMOTHER at
    // 7:20 and COLOSSUS at 9:00 deliberately (a long run needs more fights than
    // there are distinct bosses), and under the wrap rule those two arrived as
    // byte-identical reruns inside the first cycle. Keying on "have I shown this
    // before" is the rule that was always meant, and it subsumes the wrap case.
    const seen = this.seenBossKinds.has(entry.kind);
    const mod = seen ? BOSS_MODIFIERS[this.nextBossIndex % BOSS_MODIFIERS.length]! : null;
    this.seenBossKinds.add(entry.kind);
    const stats = mod ? BOSS_MOD_STATS[mod] : null;
    const name = stats ? `${stats.label} ${entry.name}` : entry.name;

    const apply = (b: Enemy | null): Enemy | null => {
      if (!b || !stats) return b;
      b.hp *= stats.hp;
      b.maxHp *= stats.hp;
      b.speed *= stats.speed;
      b.damage *= stats.damage;
      return b;
    };

    const boss = apply(this.spawnEnemyOnRing(entry.kind));
    if (mod === 'twin') apply(this.spawnEnemyOnRing(entry.kind));

    if (boss) {
      this.activeBoss = boss;
      this.activeBossSpawnedAt = this.time;
      this.activeBossName = name;
      this.events.push({ type: 'bossSpawned', name });
    }

    this.nextBossIndex++;
    const next = BOSS_SCHEDULE[this.nextBossIndex];
    // HUNTED pulls the whole schedule forward, not just the first entry.
    this.nextBossTime = next
      ? next.t * this.asc.bossTiming
      : this.time + BOSS_REPEAT_PERIOD * this.asc.bossTiming;
  }

  /**
   * Recurring pressure after the authored script runs out at 90s.
   *
   * The scripted beats (elite at 25s, closing ring at 40s) are what give the
   * first ninety seconds their shape. Past that the run needs the same kind of
   * punctuation or it flattens into a density gradient with no events in it —
   * so elite packs and closing rings keep coming, and both grow.
   */
  private runRecurringWaves(): void {
    while (this.time >= this.nextEliteWave) {
      const index = Math.floor((this.nextEliteWave - ELITE_WAVE_START) / ELITE_WAVE_PERIOD);
      const count = Math.min(7, 1 + Math.floor(index / 2));
      for (let i = 0; i < count; i++) this.spawnEnemyOnRing('elite');
      this.events.push({ type: 'eliteSpawned' });
      this.nextEliteWave += eliteWavePeriodAt(this.time);
    }

    while (this.time >= this.nextSurge) {
      const index = Math.floor((this.nextSurge - SURGE_START) / SURGE_PERIOD);
      // Smaller rings, growing more slowly. A 20-strong closing ring landing
      // while crowding is near full strength was a coin-flip death regardless
      // of how far ahead the player was on sustained damage.
      const count = Math.min(34, 12 + index * 4);
      const base = this.rng.angle();
      for (let i = 0; i < count; i++) {
        const a = base + (i / count) * TAU;
        this.spawnEnemyAt(
          'drifter',
          this.player.x + dcos(a) * 340,
          this.player.y + dsin(a) * 340,
        );
      }
      this.nextSurge += surgePeriodAt(this.time);
    }
  }

  private spawnToDensity(): void {
    // A stronger build meets a thicker crowd — gently. Density is the most
    // lethal lever in the game, so it moves a little where hit points move a lot.
    // Count what is ON SCREEN, not what is alive. 68-84% of live enemies trail
    // off screen, so the director believed it was applying pressure while the
    // player looked at an empty field for 7-10 seconds at a stretch.
    //
    // AND IT COUNTS PER SEAT. Anchored to the local player, every enemy in an
    // eight-seat arena spawned on top of one person: measured, the local player
    // finished last in 5 of 5 runs at level 43 while rivals coasted on 16, and
    // on one seed the rivals never met a single enemy and sat on level 1 for
    // the entire run. Whoever is under-supplied gets the crowd, so the swarm
    // is a thing everyone in the lobby is dealing with.
    const hw = this.viewHalfW + WORLD.spawnMargin;
    const hh = this.viewHalfH + WORLD.spawnMargin;
    const list = this.enemies.active;
    let spawned = 0;

    // Rotate who gets served first.
    //
    // The per-step spawn budget is global, and iterating seats in index order
    // meant seat zero was always served first and the rest took what was left.
    // Measured: the local player died at ~200s in 5 of 5 runs while no rival
    // died at all — not because rivals played better, but because the local
    // player was the only one the director could afford to pressure.
    this.spawnRotation++;
    const n = this.players.length;
    for (let k = 0; k < n; k++) {
      const seat = this.players[(this.spawnRotation + k) % n]!;
      if (!seat.alive) continue;
      // Threat scales off the seat being pressured, not off the strongest build
      // in the lobby — otherwise one runaway player makes the game unplayable
      // for seven people who did nothing.
      const target = densityAt(this.time) * seat.powerDensity * this.asc.density;
      let near = 0;
      for (let i = 0; i < list.length; i++) {
        const e = list[i]!;
        if (e.hp <= 0) continue;
        if (Math.abs(e.x - seat.x) <= hw && Math.abs(e.y - seat.y) <= hh) near++;
      }
      while (near + spawned < target && spawned < MAX_SPAWNS_PER_STEP) {
        const kind = ambientKind(this.time, this.rng.next());
        if (!this.spawnEnemyOnRing(kind, undefined, seat)) break;
        spawned++;
      }
      if (spawned >= MAX_SPAWNS_PER_STEP) break;
    }
  }

  private rebuildHash(): void {
    this.hash.clear();
    const list = this.enemies.active;
    for (let i = 0; i < list.length; i++) {
      const e = list[i]!;
      // Skipping the insert is what makes a submerged BURROWER untargetable:
      // every weapon reaches enemies through this hash, so one omission here
      // does the job that a flag checked at eleven call sites would have.
      if (e.submerged) continue;
      this.hash.insert(i, e.x, e.y);
    }
  }

  /** Broad-phase query, exposed so weapons do not each need their own. */
  queryEnemies(x: number, y: number, radius: number, out: number[]): number {
    return this.hash.query(x, y, radius, out);
  }

  // -------------------------------------------------------------- player

  /**
   * Move every non-local arena seat through the same speed/input contract as
   * seat zero. The brains have always written valid input, but no code consumed
   * it, leaving every supposed opponent frozen at its spawn point. Keeping this
   * separate from updatePlayer avoids duplicating local-only Tide and world
   * ability effects while making both AI and network seats genuinely move.
   */
  private updateRivalPlayers(dt: number): void {
    for (let i = 1; i < this.players.length; i++) {
      const p = this.players[i]!;
      if (!p.alive) continue;
      p.px = p.x;
      p.py = p.y;
      p.x += p.input.x * p.speed * dt;
      p.y += p.input.y * p.speed * dt;
      if (p.invul > 0) p.invul -= dt;
      if (p.abilityCd > 0) p.abilityCd -= dt;
      if (p.boons.has('hunger') && p.hp > 1) {
        p.hp = Math.max(1, p.hp - BOON.hungerDrain * dt);
      }
      p.trailHead = (p.trailHead + 1) % TRAIL_LEN;
      p.trailX[p.trailHead] = p.x;
      p.trailY[p.trailHead] = p.y;
    }
  }

  private updatePlayer(dt: number): void {
    const p = this.player;
    p.px = p.x;
    p.py = p.y;
    p.x += this.input.x * p.speed * dt;
    p.y += this.input.y * p.speed * dt;
    if (p.invul > 0) p.invul -= dt;
    if (p.abilityCd > 0) p.abilityCd -= dt;
    // THE TIDE. Space becomes the scarce resource — see TIDE in balance.ts.
    if (this.time >= TIDE.startAt) {
      if (this.tideRadius === 0) {
        this.tideX = p.x;
        this.tideY = p.y;
        this.tideRadius = TIDE.startRadius;
        this.events.push({ type: 'tideBegan', x: p.x, y: p.y });
      }
      const closed = Math.min(1, (this.time - TIDE.startAt) / TIDE.closeOver);
      this.tideRadius = TIDE.startRadius + (TIDE.endRadius - TIDE.startRadius) * closed;

      const dx = p.x - this.tideX;
      const dy = p.y - this.tideY;
      if (dhypot(dx, dy) > this.tideRadius) {
        this.tideExposure += dt;
        // Lingering outside escalates, so the ring is a boundary rather than a
        // tax a strong build can simply pay.
        const ramp = Math.min(TIDE.damageMax, 1 + this.tideExposure * TIDE.damageRamp);
        const burn = TIDE.damage * ramp * dt;
        p.hp -= burn;
        this.tideDamage += burn;
        if (p.hp <= 0) this.killPlayer();
      } else if (this.tideExposure > 0) {
        this.tideExposure = Math.max(0, this.tideExposure - dt * 2);
      }
    }

    // HUNGER: the treadmill. It never stops, so the run becomes a race between
    // the experience it buys and the health it costs.
    if (this.boons.has('hunger') && p.hp > 1) {
      p.hp = Math.max(1, p.hp - BOON.hungerDrain * dt);
    }

    // Record the trail AFTER moving, so RECALL rewinds to a position the player
    // actually occupied.
    p.trailHead = (p.trailHead + 1) % TRAIL_LEN;
    p.trailX[p.trailHead] = p.x;
    p.trailY[p.trailHead] = p.y;

    // The singularity is a world effect rather than an entity: it has no hit
    // points, so no build can delete it, and it is the only thing in the game
    // that moves enemies against their own steering.
    if (this.singularityTime > 0) {
      this.singularityTime -= dt;

      const r = ABILITY.singularityRadius;
      const list = this.enemies.active;
      const n = this.hash.query(this.singularityX, this.singularityY, r, this.scratch);
      for (let k = 0; k < n; k++) {
        const e = list[this.scratch[k]!];
        if (!e || e.hp <= 0 || isBoss(e.kind)) continue;
        const dx = this.singularityX - e.x;
        const dy = this.singularityY - e.y;
        const d = dhypot(dx, dy) || 1;
        if (d > r) continue;
        // Pull scales with how far in they already are, so the edge is a drift
        // and the centre is a vice.
        const pull = ABILITY.singularityPull * (1 - d / r) * dt;
        e.x += (dx / d) * pull;
        e.y += (dy / d) * pull;
      }
    }
  }

  /**
   * Fire the character's ability, if it is off cooldown.
   *
   * Returns whether anything happened, so the host can decide whether to play a
   * sound — a button that thunks on a dead press teaches the cooldown far better
   * than one that is silently ignored.
   */
  useAbility(seat: Player = this.player): boolean {
    const p = seat;
    if (this.phase !== 'playing' || p.abilityCd > 0) return false;
    const def = ABILITIES[p.character.ability];
    p.abilityCd = def.cooldown * (p.boons.has('overcharge') ? BOON.overchargeCooldown : 1);

    /**
     * Rebuild the broad phase before an area ability resolves.
     *
     * This is called by the HOST from an input handler, not from inside step(),
     * so the spatial hash it would otherwise query is whatever the last step
     * left behind. In normal play that is at most one frame stale and harmless;
     * but any path that changes the world between steps — a revive, a resize, a
     * spawn — leaves an ability firing against a map of where things USED to be.
     * Measured in a probe: DETONATE killed 5 of 24 enemies standing well inside
     * its radius. Once per ~10 seconds this costs nothing.
     */
    this.rebuildHash();

    switch (p.character.ability) {
      case 'blink':
        this.doBlink(p);
        break;
      case 'volley':
        this.doVolley(p);
        break;
      case 'bulwark':
        this.doBulwark(p);
        break;
      case 'recall':
        this.doRecall(p);
        break;
      case 'detonate':
        this.doDetonate(p);
        break;
      case 'singularity':
        this.doSingularity(p);
        break;
    }
    this.events.push({ type: 'abilityUsed', id: p.character.ability, x: p.x, y: p.y });
    return true;
  }

  /** Teleport along the current heading, or along the aim if standing still. */
  private doBlink(p: Player): void {
    let ax = this.input.x;
    let ay = this.input.y;
    if (ax === 0 && ay === 0) {
      ax = dcos(p.aimAngle);
      ay = dsin(p.aimAngle);
    }
    const d = dhypot(ax, ay) || 1;
    p.x += (ax / d) * ABILITY.blinkDistance;
    p.y += (ay / d) * ABILITY.blinkDistance;
    p.px = p.x;
    p.py = p.y;
    // A blink that lands you inside the crowd you fled must not be instant
    // death, or the ability is a trap rather than an escape.
    p.invul = Math.max(p.invul, ABILITY.blinkIframes);
  }

  /** A heavy piercing burst along the aim — the only aimed damage in the game. */
  private doVolley(p: Player): void {
    const target = this.nearestEnemy();
    const base = target ? datan2(target.y - p.y, target.x - p.x) : p.aimAngle;
    const n = ABILITY.volleyCount;
    const start = base - ((n - 1) * ABILITY.volleySpread) / 2;
    const damage = ABILITY.volleyDamageMult * 12 * p.damageMult;
    for (let i = 0; i < n; i++) {
      this.spawnProjectile('bolt', start + i * ABILITY.volleySpread, damage, {
        radius: 8,
        speed: ABILITY.volleySpeed,
        life: ABILITY.volleyLife,
        color: 0xffd23a,
        pierce: ABILITY.volleyPierce,
      });
    }
  }

  /** Shove everything away and take a moment of immunity. Deals no damage. */
  private doBulwark(p: Player): void {
    const r = ABILITY.bulwarkRadius;
    const list = this.enemies.active;
    const n = this.hash.query(p.x, p.y, r, this.scratch);
    for (let k = 0; k < n; k++) {
      const e = list[this.scratch[k]!];
      if (!e || e.hp <= 0) continue;
      const dx = e.x - p.x;
      const dy = e.y - p.y;
      const d = dhypot(dx, dy) || 1;
      if (d > r) continue;
      // Mass resists, so a boss is shoved but not removed from the fight.
      const force = (ABILITY.bulwarkKnockback * (1 - d / r)) / Math.max(1, e.mass * 0.5);
      e.kx += (dx / d) * force;
      e.ky += (dy / d) * force;
    }
    p.invul = Math.max(p.invul, ABILITY.bulwarkIframes);
    this.events.push({ type: 'blast', x: p.x, y: p.y, radius: r, color: 0x7dff9b });
  }

  /** Rewind to where you stood three seconds ago, and heal a little. */
  private doRecall(p: Player): void {
    const back = Math.min(TRAIL_LEN - 1, Math.round(ABILITY.recallSeconds * 60));
    const idx = (p.trailHead - back + TRAIL_LEN * 2) % TRAIL_LEN;
    p.x = p.trailX[idx]!;
    p.y = p.trailY[idx]!;
    p.px = p.x;
    p.py = p.y;
    p.hp = Math.min(p.maxHp, p.hp + ABILITY.recallHeal);
    p.invul = Math.max(p.invul, ABILITY.recallIframes);
  }

  /** An instant blast centred on the player. The only full-surround answer. */
  private doDetonate(p: Player): void {
    const r = ABILITY.detonateRadius;
    const damage = ABILITY.detonateDamage * p.damageMult;
    const list = this.enemies.active;
    const n = this.hash.query(p.x, p.y, r, this.scratch);
    for (let k = 0; k < n; k++) {
      const e = list[this.scratch[k]!];
      if (!e || e.hp <= 0) continue;
      const dx = e.x - p.x;
      const dy = e.y - p.y;
      if (dx * dx + dy * dy > r * r) continue;
      this.damageEnemy(e, damage, p.x, p.y);
    }
    this.events.push({ type: 'blast', x: p.x, y: p.y, radius: r, color: 0xff8f3a });
  }

  /** Drop a gravity well that drags the swarm into one point. */
  private doSingularity(p: Player): void {
    // Placed AHEAD of the player, never on them: a well centred on yourself is
    // a suicide button, and the point of this one is to make a pile somewhere
    // you are about to shoot.
    const ax = this.input.x || dcos(p.aimAngle);
    const ay = this.input.y || dsin(p.aimAngle);
    const d = dhypot(ax, ay) || 1;
    this.singularityX = p.x + (ax / d) * 170;
    this.singularityY = p.y + (ay / d) * 170;
    this.singularityTime = ABILITY.singularityDuration;
    this.events.push({
      type: 'telegraph',
      x: this.singularityX,
      y: this.singularityY,
      radius: ABILITY.singularityRadius,
      duration: ABILITY.singularityDuration,
      color: 0xb478ff,
    });
  }

  // ------------------------------------------------------------- enemies

  /**
   * Who this enemy is chasing.
   *
   * Enemies lock to the nearest living combatant. With one seat the branch
   * short-circuits to that seat and the arithmetic is exactly what the
   * single-player build did, which is what keeps solo runs reproducible.
   */
  private targetOf(x: number, y: number, current = -1): Player {
    if (this.players.length === 1) return this.players[0]!;

    /**
     * The enemy keeps chasing whoever it is chasing until somebody is
     * MEANINGFULLY closer — see AGGRO.handoff for why that threshold exists
     * and what it is protecting against.
     */
    const held = current >= 0 ? this.players[current] : undefined;
    let best = this.players[0]!;
    let bestD = Infinity;
    if (held && held.alive) {
      const hx = held.x - x;
      const hy = held.y - y;
      best = held;
      // Inflated: a challenger has to beat the held target by this margin, not
      // merely tie it.
      bestD = (hx * hx + hy * hy) * AGGRO.handoff * AGGRO.handoff;
    }
    for (const p of this.players) {
      if (!p.alive || p === held) continue;
      const dx = p.x - x;
      const dy = p.y - y;
      const d = dx * dx + dy * dy;
      if (d < bestD) {
        bestD = d;
        best = p;
      }
    }
    return best;
  }

  /**
   * Enemies that have changed hands recently, per (from, to) pair.
   *
   * Decays continuously so a slow trickle of ones never accumulates into a
   * celebration — an announcement should mean a horde arrived, not that two
   * players walked past each other for a minute.
   */
  private readonly handoffTally = new Float64Array(64);

  private updateEnemies(dt: number): void {
    const list = this.enemies.active;
    const cull2 = WORLD.cullRadius * WORLD.cullRadius;

    for (let i = 0; i < list.length; i++) {
      const e = list[i]!;
      if (e.hp <= 0) continue;

      // Whoever is nearest still wins the swarm — it just takes a real
      // difference to turn its head, which is what makes a horde something you
      // can carry and put on somebody. See AGGRO.
      const was = e.seat;
      const p = this.targetOf(e.x, e.y, was);
      e.seat = p.index;
      if (was !== p.index && this.players.length > 1 && was >= 0) {
        const cell = was * 8 + p.index;
        if (cell >= 0 && cell < 64) {
          this.handoffTally[cell] += 1;
          if (this.handoffTally[cell] >= AGGRO.announce) {
            this.handoffTally[cell] = 0;
            this.events.push({
              type: 'handoff',
              from: was,
              to: p.index,
              count: AGGRO.announce,
              x: e.x,
              y: e.y,
            });
          }
        }
      }

      e.px = e.x;
      e.py = e.y;
      if (e.flash > 0) e.flash -= dt;
      if (e.orbCd > 0) e.orbCd -= dt;
      if (e.auraCd > 0) e.auraCd -= dt;

      // Chase.
      let dx = p.x - e.x;
      let dy = p.y - e.y;
      const d2 = dx * dx + dy * dy;

      // Wandered far off? Recycle onto the ring rather than despawning, so the
      // density spawner does not have to churn the pool. Bosses never recycle —
      // teleporting a named encounter behind the player is disorienting.
      if (d2 > cull2 && !isBoss(e.kind)) {
        const a = this.rng.angle();
        const r = this.spawnDistance(a);
        e.x = p.x + dcos(a) * r;
        e.y = p.y + dsin(a) * r;
        e.px = e.x;
        e.py = e.y;
        continue;
      }

      const d = Math.sqrt(d2) || 1;
      dx /= d;
      dy /= d;

      let speed = e.speed;
      if (isBoss(e.kind)) speed = this.updateBoss(e, dt, dx, dy, d);
      else if (e.kind === 'lantern') speed = this.updateLantern(e, dt, dx, dy, d);
      else if (e.kind === 'burrower') speed = this.updateBurrower(e, dt, dx, dy, d);

      // Separation, so the swarm reads as a crowd rather than a single stacked
      // sprite. This is most of what makes grey circles feel alive.
      let sx = 0;
      let sy = 0;
      const n = this.hash.query(e.x, e.y, e.radius * 2, this.scratch);
      let hits = 0;
      for (let k = 0; k < n && hits < MAX_SEPARATION_NEIGHBOURS; k++) {
        const j = this.scratch[k]!;
        if (j === i) continue;
        const o = list[j];
        if (!o || o.hp <= 0) continue;
        const ox = e.x - o.x;
        const oy = e.y - o.y;
        const od2 = ox * ox + oy * oy;
        const minD = e.radius + o.radius;
        if (od2 >= minD * minD) continue;
        hits++;
        if (od2 < 1e-6) {
          // Perfectly stacked. Deterministic scatter from the index.
          const a = i * 2.399963;
          sx += dcos(a);
          sy += dsin(a);
          continue;
        }
        const od = Math.sqrt(od2);
        const push = ((minD - od) / minD) * (o.mass / e.mass);
        sx += (ox / od) * push;
        sy += (oy / od) * push;
      }

      // A committed lancer ignores steering entirely — that is what makes the
      // charge readable and dodgeable instead of homing.
      if (e.kind === 'lancer' && e.phase === 2) {
        e.x += e.vx * dt;
        e.y += e.vy * dt;
      } else {
        // Separation uses the ABSOLUTE speed. It used to use the signed one, so
        // any enemy that backs away (the LANTERN returns a negative chase speed
        // to hold its range) had its separation force INVERTED — pulling it into
        // its neighbours instead of apart from them. A clump of lanterns
        // vibrating against each other is exactly what "glitchy" looks like.
        const sep = Math.max(60, Math.abs(speed)) * 1.4;
        e.vx = dx * speed + sx * sep;
        e.vy = dy * speed + sy * sep;
        e.x += (e.vx + e.kx) * dt;
        e.y += (e.vy + e.ky) * dt;
      }

      const decay = dexp(-KNOCKBACK_DECAY * dt);
      e.kx *= decay;
      e.ky *= decay;
    }
  }

  /**
   * LANTERN: stops outside every build's kill radius and throws an orb.
   *
   * Holds at ~520px, which measurement put beyond where any current weapon
   * does meaningful damage, then winds up visibly for 0.45s before firing. The
   * orb is slow and travels in a straight line, so it costs a moving player
   * nothing and punishes a stationary one — which is precisely the player this
   * whole change set exists to threaten.
   */
  /**
   * WEAVER tethers, recomputed every step.
   *
   * `vuln` is rewritten from scratch rather than incremented and decremented,
   * so a weaver dying mid-frame can never leave a permanently shielded enemy
   * behind. Bosses are exempt: a boss that happens to walk past a weaver and
   * becomes 45% resistant is an invisible, unfair difficulty spike rather than
   * a readable one.
   */
  private updateTethers(): void {
    const list = this.enemies.active;
    this.tethers.length = 0;
    for (let i = 0; i < list.length; i++) list[i]!.vuln = 1;

    for (let i = 0; i < list.length; i++) {
      const w = list[i]!;
      if (w.kind !== 'weaver' || w.hp <= 0) continue;
      const n = this.hash.query(w.x, w.y, WEAVER.range, this.scratch);
      let linked = 0;
      for (let k = 0; k < n && linked < WEAVER.links; k++) {
        const j = this.scratch[k]!;
        if (j === i) continue;
        const o = list[j];
        if (!o || o.hp <= 0 || o.kind === 'weaver' || isBoss(o.kind)) continue;
        const dx = o.x - w.x;
        const dy = o.y - w.y;
        if (dx * dx + dy * dy > WEAVER.range * WEAVER.range) continue;
        o.vuln = WEAVER.vuln;
        linked++;
        // The renderer draws these. A shield the player cannot see is just the
        // game feeling arbitrarily spongy.
        this.tethers.push(w.x, w.y, o.x, o.y);
      }
    }
  }

  /**
   * BURROWER: surfaced → submerged → erupting → surfaced.
   *
   * The eruption point is fixed at the START of the telegraph, which is the
   * entire mechanic — the circle appears where you are standing, and moving off
   * it is the answer. Damage, area and rate of fire are all irrelevant to it.
   */
  private updateBurrower(e: Enemy, dt: number, _dx: number, _dy: number, dist: number): number {
    e.special -= dt;

    if (e.phase === 0) {
      if (e.special <= 0) {
        e.phase = 1;
        e.submerged = true;
        e.special = BURROWER.diveTime;
      }
      return e.speed;
    }

    if (e.phase === 1) {
      if (e.special <= 0 || dist < BURROWER.eruptRange) {
        e.phase = 2;
        e.special = BURROWER.telegraph;
        const t = this.seatOf(e);
        e.x = t.x;
        e.y = t.y;
        e.px = e.x;
        e.py = e.y;
        this.events.push({
          type: 'telegraph',
          x: e.x,
          y: e.y,
          radius: BURROWER.blast,
          duration: BURROWER.telegraph,
          color: ENEMIES.burrower.color,
        });
      }
      return e.speed * BURROWER.diveSpeedMult;
    }

    if (e.special <= 0) {
      e.phase = 0;
      e.submerged = false;
      e.special = BURROWER.surfaceTime;
      // The eruption hits everyone caught in it, not only the person it
      // surfaced under — a shared arena means shared blast radii.
      for (const q of this.players) {
        if (!q.alive) continue;
        const pdx = q.x - e.x;
        const pdy = q.y - e.y;
        if (pdx * pdx + pdy * pdy < BURROWER.blast * BURROWER.blast) {
          this.hurtSeat(q, e.damage, PLAYER.iframes);
        }
      }
      this.events.push({
        type: 'blast',
        x: e.x,
        y: e.y,
        radius: BURROWER.blast,
        color: ENEMIES.burrower.color,
      });
    }
    return 0;
  }

  private updateLantern(e: Enemy, dt: number, dx: number, dy: number, dist: number): number {
    const HOLD = 330;
    e.special -= dt;

    if (dist > HOLD) return e.speed;

    if (e.phase === 0) {
      e.phase = 1;
      e.special = 0.45; // windup, drives the render telegraph
    } else if (e.phase === 1 && e.special <= 0) {
      e.phase = 2;
      e.special = 2.2;
      const a = datan2(dy, dx);
      this.spawnHostileOrb(e.x, e.y, a, e.damage);
    } else if (e.phase === 2 && e.special <= 0) {
      e.phase = 1;
      e.special = 0.45;
    }
    // Strafes rather than closing, so it stays at its own range.
    return e.speed * -0.25;
  }

  spawnHostileOrb(x: number, y: number, angle: number, damage: number): void {
    const proj = this.hostiles.spawn();
    if (!proj) return;
    proj.x = x;
    proj.y = y;
    proj.px = x;
    proj.py = y;
    // Slower than the player's 140 so it is always outrunnable.
    proj.vx = dcos(angle) * 118;
    proj.vy = dsin(angle) * 118;
    proj.damage = damage;
    proj.radius = 10;
    proj.life = 6;
    proj.pierce = 0;
    proj.kind = 'enemyOrb';
    proj.turn = 0;
    proj.blast = 0;
    proj.color = 0xffe066;
    proj.hostile = true;
  }

  /** Returns the speed the boss should move at this step. */
  /**
   * Ramp a boss's speed toward the player's once it falls behind. See
   * BOSS_LEASH — without it a boss fight is optional and 20 of 22 spawns are
   * simply walked away from.
   */
  private leash(base: number, dist: number, chased?: Player): number {
    if (dist <= BOSS_LEASH.start) return base;
    const t = Math.min(1, (dist - BOSS_LEASH.start) / BOSS_LEASH.span);
    // How grown-up this boss is allowed to be — see BOSS_LEASH.catchUpEarly.
    const maturity = clamp(
      (this.time - BOSS_LEASH.rampFrom) / (BOSS_LEASH.rampTo - BOSS_LEASH.rampFrom),
      0,
      1,
    );
    const catchUp =
      BOSS_LEASH.catchUpEarly + (BOSS_LEASH.catchUp - BOSS_LEASH.catchUpEarly) * maturity;
    const target = (chased ?? this.player).speed * catchUp;
    return target > base ? base + (target - base) * t : base;
  }

  /** The combatant an enemy is currently chasing. */
  private seatOf(e: Enemy): Player {
    return this.players[e.seat] ?? this.players[0]!;
  }

  private updateBoss(e: Enemy, dt: number, dx: number, dy: number, dist: number): number {
    e.special -= dt;

    if (e.kind === 'warden') {
      // Keeps summoning while you fight it, so ignoring the adds is not an
      // option and neither is ignoring the boss.
      if (e.special <= 0) {
        e.special = BOSS_BEHAVIOUR.wardenSummonPeriod;
        for (let i = 0; i < BOSS_BEHAVIOUR.wardenSummonCount; i++) {
          const a = this.rng.angle();
          this.spawnEnemyAt('drifter', e.x + dcos(a) * 60, e.y + dsin(a) * 60);
        }
      }
      return this.leash(e.speed, dist, this.seatOf(e));
    }

    if (e.kind === 'lancer') {
      if (e.phase === 0) {
        if (e.special <= 0) {
          e.phase = 1;
          e.special = BOSS_BEHAVIOUR.lancerWindup;
        }
        return this.leash(e.speed, dist, this.seatOf(e));
      }
      if (e.phase === 1) {
        if (e.special <= 0) {
          e.phase = 2;
          e.special = BOSS_BEHAVIOUR.lancerChargeTime;
          e.vx = dx * BOSS_BEHAVIOUR.lancerChargeSpeed;
          e.vy = dy * BOSS_BEHAVIOUR.lancerChargeSpeed;
        }
        return e.speed * 0.15; // near-freeze telegraph
      }
      if (e.special <= 0) {
        e.phase = 0;
        e.special = BOSS_BEHAVIOUR.lancerRest;
      }
      return this.leash(e.speed, dist, this.seatOf(e));
    }

    if (e.kind === 'colossus') {
      // Rooted slam. The body is not the threat — the ring is — so unlike every
      // other boss this one can hurt a player who never lets it touch them.
      if (e.phase === 0) {
        if (e.special <= 0) {
          e.phase = 1;
          e.special = BOSS_BEHAVIOUR.colossusWindup;
          this.events.push({
            type: 'telegraph',
            x: e.x,
            y: e.y,
            radius: BOSS_BEHAVIOUR.colossusRadius,
            duration: BOSS_BEHAVIOUR.colossusWindup,
            color: ENEMIES.colossus.color,
          });
        }
        return this.leash(e.speed, dist, this.seatOf(e));
      }
      if (e.special <= 0) {
        e.phase = 0;
        e.special = BOSS_BEHAVIOUR.colossusPeriod;
        const r = BOSS_BEHAVIOUR.colossusRadius;
        for (const q of this.players) {
          if (!q.alive) continue;
          const pdx = q.x - e.x;
          const pdy = q.y - e.y;
          if (pdx * pdx + pdy * pdy < r * r) this.hurtSeat(q, e.damage, PLAYER.iframes);
        }
        this.events.push({ type: 'blast', x: e.x, y: e.y, radius: r, color: ENEMIES.colossus.color });
      }
      return 0;
    }

    if (e.kind === 'harbinger') {
      // Closes distance by teleporting, so kiting stops being the whole answer,
      // then pays for the blink with a radial volley you have to move through.
      if (e.special <= 0) {
        e.special = BOSS_BEHAVIOUR.harbingerPeriod;
        const a = this.rng.angle();
        const t = this.seatOf(e);
        e.x = t.x + dcos(a) * BOSS_BEHAVIOUR.harbingerBlink;
        e.y = t.y + dsin(a) * BOSS_BEHAVIOUR.harbingerBlink;
        e.px = e.x;
        e.py = e.y;
        for (let i = 0; i < BOSS_BEHAVIOUR.harbingerOrbs; i++) {
          this.spawnHostileOrb(e.x, e.y, a + (i / BOSS_BEHAVIOUR.harbingerOrbs) * TAU, e.damage);
        }
      }
      return this.leash(e.speed, dist, this.seatOf(e));
    }

    // Brood lumbers, but will not be left behind.
    return this.leash(e.speed, dist, this.seatOf(e));
  }

  damageEnemy(e: Enemy, amount: number, fromX: number, fromY: number): void {
    // A submerged BURROWER is not in the hash, so nothing should be able to
    // reach it — this is the backstop for any path that iterates enemies
    // directly rather than querying.
    if (e.submerged) return;

    /**
     * Armour is capped RELATIVE to the hit, not absolutely.
     *
     * The first version subtracted a flat amount scaled by the same curve as hit
     * points, which is wrong in a way that only shows up late: armour interacts
     * with hit COUNT, while player damage grows multiplicatively and arrives as
     * a torrent of small tics. At ten minutes armour reached ~575 and most
     * individual hits were under it, so every hit landed on the 1-damage floor
     * and BULWARKs became literally unkillable — measured at 272 of 277 enemies
     * on screen, 98.2%, a swarm made of one enemy that could not die.
     *
     * Letting at least 45% of any hit through preserves exactly the intended
     * discrimination — a small tic loses more than half its value, a SUPERNOVA
     * loses almost nothing — while making immortality arithmetically impossible.
     */
    const raw = amount * e.vuln;
    const dealt = e.armor > 0 ? Math.max(raw * ARMOR_MIN_THROUGH, raw - e.armor) : raw;
    e.hp -= dealt;
    e.flash = 0.08;

    // EXECUTE — anything left badly wounded dies now. It pays no experience,
    // which is the cost: the boon clears the screen and starves the build.
    let executed = false;
    if (!(e.hp <= 0) && this.boons.has('execute') && e.maxHp > 0 &&
        e.hp / e.maxHp <= BOON.executeThreshold && !isBoss(e.kind)) {
      e.hp = 0;
      executed = true;
    }
    const killed = e.hp <= 0;
    this.events.push({ type: 'enemyHit', x: e.x, y: e.y, damage: dealt, killed, kind: e.kind });

    if (killed) {
      this.onEnemyKilled(e, executed);
      return;
    }

    // Knockback scales inversely with mass, so elites shrug it off.
    const dx = e.x - fromX;
    const dy = e.y - fromY;
    const d = dhypot(dx, dy) || 1;
    const force = 120 / e.mass;
    e.kx += (dx / d) * force;
    e.ky += (dy / d) * force;
  }

  private onEnemyKilled(e: Enemy, executed = false): void {
    this.kills++;
    if (this.boons.has('vampirism')) {
      const p = this.player;
      p.hp = Math.min(p.maxHp, p.hp + BOON.vampirismHeal);
    }
    this.events.push({ type: 'enemyKilled', x: e.x, y: e.y, kind: e.kind, color: e.color });
    if (!executed) this.spawnGem(e.x, e.y, e.xp);

    // Health drops — see HEALTH_DROP. The only source of healing in the game.
    const dropRate =
      (this.boons.has('vampirism') ? BOON.vampirismDropPenalty : 1) * this.asc.healthDropRate;
    if (e.kind === 'elite' && this.rng.next() < dropRate) {
      this.spawnHeart(e.x, e.y, HEALTH_DROP.elite);
    } else if (e.kind === 'herald' && this.rng.next() < HEALTH_DROP.heraldChance * dropRate) {
      this.spawnHeart(e.x, e.y, HEALTH_DROP.herald);
    } else if (isBoss(e.kind)) {
      this.offerBoons();
      for (let i = 0; i < HEALTH_DROP.bossCount; i++) {
        const a = (i / HEALTH_DROP.bossCount) * TAU;
        this.spawnHeart(e.x + dcos(a) * 34, e.y + dsin(a) * 34, HEALTH_DROP.boss);
      }
    }

    if (e.kind === 'splitter' && e.generation < MAX_GENERATION) {
      for (let i = 0; i < 2; i++) {
        const a = this.rng.angle();
        this.spawnEnemyAt('splitter', e.x + dcos(a) * 14, e.y + dsin(a) * 14, e.generation + 1);
      }
    }

    if (e.kind === 'bomber') {
      // Detonates where it died. Punishes killing things on top of yourself,
      // which is the one habit the aura/vortex builds encourage.
      this.explode(e.x, e.y, 76, e.damage * 1.4, e.color, true);
    }

    if (e.kind === 'brood') {
      for (let i = 0; i < BOSS_BEHAVIOUR.broodSpawn; i++) {
        const a = (i / BOSS_BEHAVIOUR.broodSpawn) * TAU;
        this.spawnEnemyAt('splitter', e.x + dcos(a) * 46, e.y + dsin(a) * 46);
      }
    }

    if (isBoss(e.kind)) {
      this.bossKindsKilled.push(e.kind);
      this.events.push({ type: 'bossKilled', x: e.x, y: e.y, color: e.color });
      if (this.activeBoss === e) {
        this.activeBoss = null;
        this.activeBossName = '';
      }
    }
  }

  /** Radial damage. `hurtsPlayer` is true for enemy detonations only. */
  explode(x: number, y: number, radius: number, damage: number, color: number, hurtsPlayer: boolean): void {
    const list = this.enemies.active;
    const n = this.hash.query(x, y, radius, this.scratch);
    for (let k = 0; k < n; k++) {
      const e = list[this.scratch[k]!];
      if (!e || e.hp <= 0) continue;
      const dx = e.x - x;
      const dy = e.y - y;
      const rr = radius + e.radius;
      if (dx * dx + dy * dy > rr * rr) continue;
      this.damageEnemy(e, damage, x, y);
    }

    if (hurtsPlayer) {
      for (const p of this.players) {
        if (!p.alive || p.invul > 0) continue;
        const dx = p.x - x;
        const dy = p.y - y;
        const rr = radius + seatRadius(p.arenaScore);
        if (dx * dx + dy * dy <= rr * rr) this.hurtSeat(p, damage);
      }
    }

    this.events.push({ type: 'blast', x, y, radius, color });
  }

  /**
   * A shot landing on another combatant.
   *
   * PVP DAMAGE IS NOT WEAPON DAMAGE, and this is the most important number in
   * the arena. A late build hits enemies for thousands against a boss with
   * eight thousand health; a person has around a hundred and forty. Passed
   * through unscaled, the first player to reach an evolution deletes the lobby
   * in one pass and the match is decided by the draw rather than by anyone
   * playing it.
   *
   * So a hit is worth a FRACTION OF THE TARGET'S MAXIMUM, capped hard. Eight
   * percent means roughly thirteen clean hits from full — long enough to react
   * to, short enough to resolve inside a fight. It also means none of the solo
   * weapon tuning had to move to make this work.
   */
  private resolvePvp(pr: Projectile): boolean {
    for (const q of this.players) {
      if (!q.alive || q.index === pr.owner || q.invul > 0) continue;
      const dx = q.x - pr.x;
      const dy = q.y - pr.y;
      // A rival swollen with stolen mass is a bigger thing to hit. Being rich
      // is supposed to be dangerous from every direction, not just the swarm.
      const rr = seatRadius(q.arenaScore) + pr.radius;
      if (dx * dx + dy * dy > rr * rr) continue;
      const shooter = this.players[pr.owner];
      if (shooter) this.hitRival(shooter, q, pr.damage);
      return true;
    }
    return false;
  }

  /** Give continuous/radial weapons the same PvP contract as projectiles. */
  damageRivalsInArea(owner: Player, x: number, y: number, radius: number, rawDamage: number): number {
    if (this.players.length <= 1) return 0;
    let hits = 0;
    for (const q of this.players) {
      if (!q.alive || q === owner || q.invul > 0) continue;
      const dx = q.x - x;
      const dy = q.y - y;
      const rr = radius + seatRadius(q.arenaScore);
      if (dx * dx + dy * dy > rr * rr) continue;
      this.hitRival(owner, q, rawDamage);
      hits++;
    }
    return hits;
  }

  /** One deliberate PvP jump for chain-family weapons. */
  damageNearestRival(owner: Player, x: number, y: number, range: number, rawDamage: number): Player | null {
    let best: Player | null = null;
    let bestD2 = range * range;
    for (const q of this.players) {
      if (!q.alive || q === owner || q.invul > 0) continue;
      const dx = q.x - x;
      const dy = q.y - y;
      const d2 = dx * dx + dy * dy;
      if (d2 < bestD2) {
        bestD2 = d2;
        best = q;
      }
    }
    if (best) this.hitRival(owner, best, rawDamage);
    return best;
  }

  private hitRival(owner: Player, target: Player, rawDamage: number): void {
    const bite = Math.min(target.maxHp * PVP.maxShare, PVP.flat + rawDamage * PVP.scale);
    this.pvpHits++;
    target.lastHitBy = owner.index;
    target.lastHitAt = this.time;
    this.hurtSeat(target, bite, PVP.iframes);
  }

  /**
   * Live mass transfers, rebuilt every step for the renderer to draw.
   *
   * Exposed as state rather than events because a siphon is a CONDITION that
   * lasts for seconds, not a thing that happens once — and an event per pair
   * per step is 28 events a frame of pure noise.
   */
  readonly siphons: Array<{ from: number; to: number; rate: number; amount: number; lock: number }> = [];

  /**
   * THE SIPHON — mass moves from the hurt to the healthy.
   *
   * The rule that turns eight people sharing a screen into a fight. Before it,
   * the only way to touch another player was a stray bullet from a weapon that
   * never aimed at them, capped at 8% of their health, thirteen hits from a
   * kill that therefore never happened. Eight players never interacted once.
   *
   * It keys on health rather than on size deliberately. Size would mean the
   * biggest player eats everybody and the lead compounds into a formality;
   * health means the fattest seat in the lobby is also the most profitable
   * thing on the map the moment a horde gets to it, and a starving player can
   * rob a rich one by catching them at the wrong moment. The question the
   * arena now asks every second — who is hurt, and can I reach them — is a
   * question you answer with your feet, which is the only verb this genre has.
   */
  private updateSiphon(dt: number): void {
    this.siphons.length = 0;
    for (const a of this.players) {
      if (!a.alive) {
        a.siphonTarget = -1;
        a.siphonLock = 0;
        continue;
      }

      /**
       * STICKY. The seat keeps the rival it is already on for as long as that
       * rival is still a valid victim, and only looks for a new one when it is
       * not.
       *
       * The first version re-picked the nearest valid rival every frame, which
       * in an arena where everybody overlaps meant a new "lock" every 0.7
       * seconds — measured at 286 switches a race, a median lock strength of
       * 9%, and a mechanic that collapsed to a twentieth of the economy. A lock
       * that re-targets on its own is not a lock.
       */
      const aFrac = a.hp / Math.max(1, a.maxHp);
      const held = a.siphonTarget >= 0 ? this.players[a.siphonTarget] : undefined;
      let target: Player | null = held && this.canSiphon(a, held, aFrac) ? held : null;
      let bestGap = target ? aFrac - target.hp / Math.max(1, target.maxHp) : 0;
      if (!target) {
        let bestD2 = Infinity;
        for (const b of this.players) {
          if (b === a || !this.canSiphon(a, b, aFrac)) continue;
          const dx = b.x - a.x;
          const dy = b.y - a.y;
          const d2 = dx * dx + dy * dy;
          if (d2 >= bestD2) continue;
          bestD2 = d2;
          bestGap = aFrac - b.hp / Math.max(1, b.maxHp);
          target = b;
        }
      }

      if (!target) {
        // Lapses are recoverable — a moment of separation should not throw away
        // a hunt, or the mechanic punishes exactly the movement it is asking for.
        a.siphonLock = Math.max(0, a.siphonLock - SIPHON.release * dt);
        a.siphonTarget = -1;
        continue;
      }
      if (target.index === a.siphonTarget) {
        a.siphonLock = Math.min(SIPHON.lockFull, a.siphonLock + dt);
      } else {
        // Switching costs everything built up on the last one.
        a.siphonTarget = target.index;
        a.siphonLock = 0;
      }
      const ramp = SIPHON.opening
        + (1 - SIPHON.opening) * (a.siphonLock / SIPHON.lockFull);
      this.drain(target, a, bestGap * ramp, dt, a.siphonLock / SIPHON.lockFull);
    }
  }

  /**
   * Move mass between two seats.
   *
   * Each client applies only the half it owns, and that is not a compromise —
   * it is correct. Both machines run this same rule over the same synchronized
   * positions and health, so the victim's own client removes exactly what the
   * beneficiary's client adds. See World.applySeatRecord for the ownership
   * rule this follows.
   */
  /** Is `b` a rival `a` can currently take mass from? */
  private canSiphon(a: Player, b: Player, aFrac: number): boolean {
    if (b === a || !b.alive) return false;
    if (b.arenaScore <= SIPHON.floor) return false;
    if (aFrac - b.hp / Math.max(1, b.maxHp) <= SIPHON.deadband) return false;
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const reach = SIPHON.radius + seatRadius(a.arenaScore) + seatRadius(b.arenaScore);
    return dx * dx + dy * dy <= reach * reach;
  }

  private drain(from: Player, to: Player, gap: number, dt: number, lock = 1): void {
    const amount = Math.min(
      SIPHON.share * from.arenaScore * gap * dt,
      Math.max(0, from.arenaScore - SIPHON.floor),
    );
    if (amount <= 0) return;
    if (this.ownsScore(from)) from.arenaScore -= amount;
    if (this.ownsScore(to)) to.arenaScore += amount;
    this.siphons.push({ from: from.index, to: to.index, rate: gap, amount, lock });
  }

  /**
   * Close the walls, and burn whoever is outside them.
   *
   * Centred on the origin rather than on any one player, so nobody can drag the
   * safe zone around by walking — the ring is a fact about the arena, not a
   * leash attached to the leader.
   */
  private updateArenaRing(dt: number): void {
    if (this.time < ARENA_RING.holdFor) {
      this.arenaRing = 0;
      return;
    }
    if (this.arenaRing === 0) {
      this.arenaRing = ARENA_RING.start;
      this.events.push({ type: 'ringClosing', radius: this.arenaRing });
    }
    this.arenaRing = Math.max(
      ARENA_RING.floor,
      this.arenaRing - ARENA_RING.closeRate * dt,
    );

    const r = this.arenaRing;
    for (const p of this.players) {
      if (!p.alive) continue;
      const d = dhypot(p.x, p.y);
      if (d <= r) continue;
      // Deeper outside hurts more, so the wall cannot be treated as a place to
      // live one pixel beyond. i-frames are bypassed deliberately: this is not
      // a hit, it is standing somewhere that is no longer part of the arena.
      const depth = d - r;
      const share = ARENA_RING.burnShare + depth * ARENA_RING.burnPerUnit;
      p.hp -= p.maxHp * share * dt;
      // No event for the burn itself: it fires every step you are outside, and
      // the wall is drawn, so the screen already says why.
      // A seat we do not own is not ours to kill — its owner burns it too.
      if (p.hp <= 0) {
        if (this.ownsScore(p)) this.killSeat(p);
        else this.claimSeatDown(p);
      }
    }
  }

  private compactEnemies(): void {
    const list = this.enemies.active;
    for (let i = list.length - 1; i >= 0; i--) {
      if (list[i]!.hp <= 0) this.enemies.despawnAt(i);
    }
    if (this.activeBoss && this.activeBoss.hp <= 0) {
      this.activeBoss = null;
      this.activeBossName = '';
    }
  }

  // ------------------------------------------------------------- weapons

  private updateWeapons(dt: number): void {
    for (const p of this.players) {
      if (!p.alive) continue;

      // Tracked every step, not only on fire, so the aim reads smooth rather
      // than snapping once per cooldown. Consumes no RNG, so determinism holds.
      // Aim is taken from the enemy nearest to THIS seat: shared-arena weapons
      // that all pointed at the local player's target would fire into nothing.
      const nearest = this.nearestEnemy(p);
      if (nearest) p.aimAngle = datan2(nearest.y - p.y, nearest.x - p.x);

      for (let i = 0; i < p.weapons.length; i++) {
        tickWeapon(this, p, p.weapons[i]!, dt);
      }
    }
  }

  /**
   * Auto-aim target.
   *
   * NOT strictly nearest. Strict nearest meant a boss standing inside its own
   * swarm was never once targeted — across 960 measured runs, bosses were
   * reached 100% of the time and killed 0% of the time. They were not hard,
   * they were unshootable.
   *
   * Priority is applied as an effective-distance discount so it still behaves
   * sensibly: a boss is worth crossing the screen for, an elite is worth a
   * detour, and chaff is only shot when nothing better is in reach.
   */
  nearestEnemy(seat: Player = this.player): Enemy | null {
    const list = this.enemies.active;
    const p = seat;
    let best: Enemy | null = null;
    let bestScore = Infinity;
    for (let i = 0; i < list.length; i++) {
      const e = list[i]!;
      if (e.hp <= 0) continue;
      const dx = e.x - p.x;
      const dy = e.y - p.y;
      const d2 = dx * dx + dy * dy;
      const priority = isBoss(e.kind) ? 0.12 : e.kind === 'elite' ? 0.45 : 1;
      const score = d2 * priority;
      if (score < bestScore) {
        bestScore = score;
        best = e;
      }
    }
    return best;
  }

  spawnProjectile(
    kind: ProjectileKind,
    angle: number,
    damage: number,
    o: ProjectileOptions,
    from: Player = this.player,
  ): void {
    const proj = this.projectiles.spawn();
    if (!proj) return;
    const p = from;
    proj.owner = p.index;
    proj.x = p.x;
    proj.y = p.y;
    proj.px = p.x;
    proj.py = p.y;
    proj.vx = dcos(angle) * o.speed;
    proj.vy = dsin(angle) * o.speed;
    proj.damage = damage;
    proj.radius = o.radius;
    proj.life = o.life;
    proj.pierce = o.pierce ?? 0;
    proj.kind = kind;
    proj.turn = o.turn ?? 0;
    proj.blast = 0;
    proj.color = o.color;
    proj.hostile = false;
  }

  spawnMine(
    x: number,
    y: number,
    damage: number,
    blast: number,
    color: number,
    life = 9,
    owner: Player = this.player,
  ): void {
    // Hard ceiling, independent of the lifetime rule. Two mechanisms because
    // this one field was measured at 78 overlapping sprites glued to the
    // player: whichever assumption breaks next, the count still holds.
    const list = this.projectiles.active;
    let mines = 0;
    let oldest = -1;
    let oldestLife = Infinity;
    for (let i = 0; i < list.length; i++) {
      const pr = list[i]!;
      if (pr.kind !== 'mine') continue;
      mines++;
      if (pr.life < oldestLife) {
        oldestLife = pr.life;
        oldest = i;
      }
    }
    if (mines >= PROJECTILE_CAP.mines && oldest >= 0) this.projectiles.despawnAt(oldest);

    const proj = this.projectiles.spawn();
    if (!proj) return;
    proj.x = x;
    proj.y = y;
    proj.px = x;
    proj.py = y;
    proj.vx = 0;
    proj.vy = 0;
    proj.damage = damage;
    proj.radius = 9;
    proj.life = life;
    proj.pierce = 0;
    proj.kind = 'mine';
    proj.turn = 0;
    proj.blast = blast;
    proj.color = color;
    proj.hostile = false;
    proj.owner = owner.index;
  }

  private updateProjectiles(dt: number): void {
    const list = this.projectiles.active;
    const enemies = this.enemies.active;

    for (let i = list.length - 1; i >= 0; i--) {
      const pr = list[i]!;
      pr.px = pr.x;
      pr.py = pr.y;

      if (pr.kind === 'homing') {
        // Steer toward the nearest enemy at a bounded turn rate, so missiles
        // arc rather than snapping onto the target like a tracking beam.
        const target = this.nearestTo(pr.x, pr.y);
        if (target) {
          const want = datan2(target.y - pr.y, target.x - pr.x);
          const cur = datan2(pr.vy, pr.vx);
          let delta = want - cur;
          while (delta > Math.PI) delta -= TAU;
          while (delta < -Math.PI) delta += TAU;
          const step = clamp(delta, -pr.turn * dt, pr.turn * dt);
          const speed = dhypot(pr.vx, pr.vy);
          const a = cur + step;
          pr.vx = dcos(a) * speed;
          pr.vy = dsin(a) * speed;
        }
      }

      pr.x += pr.vx * dt;
      pr.y += pr.vy * dt;
      pr.life -= dt;

      if (pr.life <= 0) {
        if (pr.kind === 'mine') this.explode(pr.x, pr.y, pr.blast, pr.damage, pr.color, false);
        this.projectiles.despawnAt(i);
        continue;
      }

      // PvP. Only ever runs in a populated arena, so solo pays nothing for it.
      if (this.players.length > 1 && this.resolvePvp(pr)) {
        this.projectiles.despawnAt(i);
        continue;
      }

      let spent = false;
      const reach = pr.kind === 'mine' ? 26 : pr.radius + 32;
      const n = this.hash.query(pr.x, pr.y, reach, this.scratch);
      for (let k = 0; k < n; k++) {
        const e = enemies[this.scratch[k]!];
        if (!e || e.hp <= 0) continue;
        const dx = e.x - pr.x;
        const dy = e.y - pr.y;
        const rr = e.radius + (pr.kind === 'mine' ? 16 : pr.radius);
        if (dx * dx + dy * dy > rr * rr) continue;

        if (pr.kind === 'mine') {
          this.explode(pr.x, pr.y, pr.blast, pr.damage, pr.color, false);
          spent = true;
          break;
        }

        this.damageEnemy(e, pr.damage, pr.x - pr.vx * dt, pr.y - pr.vy * dt);
        if (pr.pierce > 0) {
          pr.pierce--;
        } else {
          spent = true;
          break;
        }
      }

      if (spent) this.projectiles.despawnAt(i);
    }
  }

  /** Enemy fire. Separate loop, separate pool, tested against the player only. */
  private updateHostiles(dt: number): void {
    const list = this.hostiles.active;
    const p = this.player;
    for (let i = list.length - 1; i >= 0; i--) {
      const pr = list[i]!;
      pr.px = pr.x;
      pr.py = pr.y;
      pr.x += pr.vx * dt;
      pr.y += pr.vy * dt;
      pr.life -= dt;
      if (pr.life <= 0) {
        this.hostiles.despawnAt(i);
        continue;
      }
      let struck = false;
      for (const q of this.players) {
        if (!q.alive) continue;
        const rr = seatRadius(q.arenaScore) + pr.radius;
        const dx = q.x - pr.x;
        const dy = q.y - pr.y;
        if (dx * dx + dy * dy > rr * rr) continue;
        // The orb is spent on contact whether or not it landed: an orb that
        // passed through an invulnerable player and hit them again on the far
        // side would make i-frames worse than useless.
        struck = true;
        if (q.invul <= 0) this.hurtSeat(q, pr.damage);
        break;
      }
      if (struck) {
        this.hostiles.despawnAt(i);
      }
    }
  }

  private nearestTo(x: number, y: number): Enemy | null {
    const list = this.enemies.active;
    let best: Enemy | null = null;
    let bestD2 = 420 * 420;
    const n = this.hash.query(x, y, 420, this.scratch);
    for (let k = 0; k < n; k++) {
      const e = list[this.scratch[k]!];
      if (!e || e.hp <= 0) continue;
      const dx = e.x - x;
      const dy = e.y - y;
      const d2 = dx * dx + dy * dy;
      if (d2 < bestD2) {
        bestD2 = d2;
        best = e;
      }
    }
    return best;
  }

  // ---------------------------------------------------------------- gems

  /**
   * A heart. Never merges and is never auto-banked — a health drop the player
   * did not physically reach must not silently heal them, or the trip stops
   * being the decision it exists to be.
   */
  spawnHeart(x: number, y: number, heal: number): void {
    const g = this.gems.spawn();
    if (!g) return;
    g.x = x;
    g.y = y;
    g.px = x;
    g.py = y;
    g.vx = 0;
    g.vy = 0;
    g.value = 0;
    g.heal = heal;
    g.homing = false;
    g.age = 0;
  }

  private spawnGem(x: number, y: number, value: number): void {
    // Merge rather than discard once the pool is crowded. Dropping the gem on
    // the floor meant kills stopped paying entirely in the late game.
    if (this.gems.count >= this.gems.capacity * GEM.mergeAbove) {
      const list = this.gems.active;
      let best: Gem | null = null;
      let bestD2 = GEM.mergeRadius * GEM.mergeRadius;
      for (let i = 0; i < list.length; i++) {
        const g0 = list[i]!;
        const dx = g0.x - x;
        const dy = g0.y - y;
        const d2 = dx * dx + dy * dy;
        if (d2 < bestD2) {
          bestD2 = d2;
          best = g0;
        }
      }
      if (best) {
        best.value += value;
        return;
      }
    }
    const g = this.gems.spawn();
    if (!g) return;
    g.x = x;
    g.y = y;
    g.px = x;
    g.py = y;
    // A small scatter on drop so a cluster of kills does not look like one gem.
    const a = this.rng.angle();
    const s = this.rng.range(20, 55);
    g.vx = dcos(a) * s;
    g.vy = dsin(a) * s;
    g.value = value;
    g.heal = 0;
    g.homing = false;
    g.age = 0;
  }

  /**
   * The ONE place experience is added.
   *
   * Three separate call sites added to `this.xp` directly (pickup, auto-bank,
   * level-up vacuum), which is exactly the shape that lets a multiplier apply to
   * two of them and silently not the third.
   */
  private gainXp(amount: number, seat: Player = this.player): void {
    const boon = seat.boons.has('hunger') ? BOON.hungerXp : 1;
    const gained = amount * seat.xpMult * boon;
    seat.xp += gained;
    if (this.players.length > 1 && this.ownsScore(seat)) seat.arenaScore += gained;
  }

  /**
   * Whether this client is allowed to write a seat's MASS.
   *
   * Yours, always. A person's, never — their own packets carry it. A seat
   * nobody is sitting in belongs to the room owner, so on every other client it
   * is read-only too.
   *
   * Both exclusions were measured. Without them the local simulation grew its
   * own copy of a rival's mass between packets and the packet yanked it back,
   * producing a sawtooth that crossed neighbouring seats: four clients in one
   * room showed a different finishing order on 12.7% of readings, 2.7% of them
   * between seats that were not remotely tied.
   */
  private ownsScore(seat: Player): boolean {
    if (seat.index === 0) return true;
    if (seat.live) return false;
    return this.ownsRivalScores;
  }

  /**
   * True unless another client in the room owns the seats nobody is sitting in.
   *
   * Always true in solo and in an offline arena, which is why nothing outside a
   * live match is affected by any of this.
   */
  ownsRivalScores = true;

  /** Gold multiplier from boons AND the chosen tier. Read when the run ends. */
  get goldMult(): number {
    return (this.boons.has('greed') ? BOON.greedGold : 1) * this.asc.gold;
  }

  /**
   * Damage multiplier applied to every weapon, recomputed per activation.
   *
   * MOMENTUM and FRENZY are conditional on what the player is doing RIGHT NOW,
   * which is the whole reason they change play rather than just numbers.
   */
  get boonDamageMult(): number {
    return this.boonDamageMultFor(this.player);
  }

  boonDamageMultFor(p: Player): number {
    let m = 1;
    if (p.boons.has('glasscannon')) m *= BOON.glassDamage;
    if (p.boons.has('momentum')) {
      const moving = Math.abs(p.input.x) + Math.abs(p.input.y) > 0.01;
      m *= moving ? BOON.momentumBonus : BOON.momentumPenalty;
    }
    return m;
  }

  /** Fire-rate multiplier from boons. See boonDamageMult. */
  get boonRateMult(): number {
    let m = 1;
    if (this.boons.has('resonance')) m *= BOON.resonanceRate;
    if (this.boons.has('frenzy') && this.player.hp <= this.player.maxHp * BOON.frenzyBelow) {
      m *= BOON.frenzyRate;
    }
    return m;
  }

  /** SPLINTER: extra pierce on every projectile. */
  get boonPierce(): number {
    return this.boonPierceFor(this.player);
  }

  boonPierceFor(p: Player): number {
    return p.boons.has('splinter') ? BOON.splinterPierce : 0;
  }

  /** SPLINTER's cost — the same shots travel slower. */
  get boonSpeedMult(): number {
    return this.boons.has('splinter') ? BOON.splinterSpeed : 1;
  }

  /** True on every Nth weapon activation, for RESONANCE. */
  consumeResonance(): boolean {
    if (!this.boons.has('resonance')) return false;
    this.resonanceTick++;
    return this.resonanceTick % BOON.resonanceEvery === 0;
  }

  private updateGems(dt: number): void {
    const list = this.gems.active;
    // Solo skips the per-gem lookup entirely: one seat means one answer, and
    // this loop runs over every gem on the field every step.
    const solo = this.players.length === 1 ? this.players[0]! : null;
    // Continuous drain. The threshold tightens once the field is crowded, so
    // the rule is invisible in a normal minute and decisive in a dense one.
    const bankAge = list.length > GEM.bankSoftCap ? GEM.autoBankAgeBusy : GEM.autoBankAge;
    const far2 = GEM.bankBeyond * GEM.bankBeyond;
    // Counts down as gems are banked, so forced banking stops the moment the
    // field is back under the ceiling.
    let remaining = list.length;

    for (let i = list.length - 1; i >= 0; i--) {
      const g = list[i]!;
      g.px = g.x;
      g.py = g.y;
      g.age += dt;

      // Gems belong to whoever is closest. Nobody can hoover the field from
      // across the arena, so standing near the fighting is how you level.
      const p = solo ?? this.targetOf(g.x, g.y);
      const pickup2 = p.pickupRadius * p.pickupRadius;

      const dx = p.x - g.x;
      const dy = p.y - g.y;
      const d2 = dx * dx + dy * dy;

      // Three drain rules, ordered by how little the player loses when each
      // fires. Banking credits the XP either way — the only thing at stake is
      // whether they got to watch it fly in.
      //   stale       — it has been lying there long enough to be forgotten
      //   unreachable — over the cap AND far enough away to be off-screen
      //   flooded     — twice over the cap; at 200 kills/sec nothing else holds
      // Hearts are exempt: banking one would heal a player who never went and
      // got it, which removes the entire decision the drop exists to create.
      const stale = g.age > bankAge;
      const forced =
        (remaining > GEM.hardCap && d2 > far2) ||
        (remaining > GEM.hardCap * GEM.floodedAt && g.age > GEM.minBankAge * 0.25);
      if (g.heal === 0 && (stale || forced)) {
        remaining--;
        // Banked silently: no pickup event. At late-game kill rates this fires
        // hundreds of times a second, and a ding per gem would drown the mix
        // and starve the particle pool for feedback the player never asked for.
        this.gainXp(g.value, p);
        this.gems.despawnAt(i);
        continue;
      }

      if (!g.homing && d2 < pickup2) g.homing = true;

      if (g.homing) {
        const d = Math.sqrt(d2) || 1;
        // Eased acceleration, not constant velocity — linear reads as dead,
        // accelerating reads as magnetic.
        g.vx += (dx / d) * PLAYER.magnetAccel * dt;
        g.vy += (dy / d) * PLAYER.magnetAccel * dt;
      } else {
        const d = Math.sqrt(d2) || 1;
        g.vx += (dx / d) * GEM.driftAccel * dt;
        g.vy += (dy / d) * GEM.driftAccel * dt;
        // Speed cap rises with age: recent drops reward sweeping back, old ones
        // eventually come to you rather than being lost for playing well.
        const cap = Math.min(GEM.driftMax, GEM.driftBase + g.age * GEM.driftPerSecond);
        const sp = dhypot(g.vx, g.vy);
        if (sp > cap) {
          g.vx = (g.vx / sp) * cap;
          g.vy = (g.vy / sp) * cap;
        }
      }

      g.x += g.vx * dt;
      g.y += g.vy * dt;

      if (d2 < COLLECT_RADIUS * COLLECT_RADIUS) {
        if (g.heal > 0) {
          const before = p.hp;
          p.hp = Math.min(p.maxHp, p.hp + g.heal);
          if (p.index === 0) this.events.push({ type: 'healed', amount: Math.round(p.hp - before) });
        } else {
          this.gainXp(g.value, p);
          if (p.index === 0) this.events.push({ type: 'gemCollected', value: g.value });
        }
        this.gems.despawnAt(i);
      }
    }
  }

  // ------------------------------------------------------------- contact

  private hurtPlayer(damage: number, iframes: number = PLAYER.iframes): void {
    this.hurtSeat(this.player, damage, iframes);
  }

  /**
   * Damage one combatant.
   *
   * Boons are read off the seat rather than the world, because in a shared
   * arena the person being hit is not necessarily the person holding FORTRESS.
   */
  private hurtSeat(p: Player, damage: number, iframes: number = PLAYER.iframes): void {
    if (!p.alive) return;
    // Boons that change what a hit costs. They MULTIPLY, so stacking two
    // defensive ones is genuinely strong and stacking two offensive ones is
    // genuinely reckless — which is the decision the system exists to create.
    let taken = damage;
    if (p.boons.has('fortress')) taken *= BOON.fortressTaken;
    if (p.boons.has('overcharge')) taken *= BOON.overchargeTaken;
    if (p.boons.has('glasscannon')) taken *= BOON.glassTaken;
    if (p.boons.has('thorns')) iframes *= BOON.thornsIframeMult;
    p.hp -= taken;
    p.damageTaken += taken;
    p.invul = iframes;
    // Only the local player's hits shake the screen. A rival taking a hit is
    // information, not a hit you felt.
    if (p.index === 0) this.events.push({ type: 'playerHit', damage: taken });

    if (p.hp <= 0) {
      /**
       * A seat is only ever killed by the client that owns it.
       *
       * This client simulates every seat, including ones it does not own, and
       * its copy of their health is a guess between packets. Letting the guess
       * kill produced two different failures. For a person it produced deaths
       * that never happened — the local client banked a bounty and announced a
       * kill while the victim played on, unaware. For an AI seat it produced
       * two clients holding different funerals: measured, one client in four
       * had a rival dead that the others had alive, which moves everybody's
       * place on the board.
       *
       * So the killing blow is REPORTED instead. The owner runs the death and
       * publishes it, and every client — including this one — learns about it
       * the same way, at the same time, with the same killer named.
       */
      if (this.ownsScore(p)) this.killSeat(p);
      else this.claimSeatDown(p);
    }
  }

  /**
   * The single death path.
   *
   * Extracted because THE TIDE kills without a hit — it burns you for standing
   * in the wrong place — and duplicating the phase change plus the event would
   * be exactly the kind of second code path that quietly drifts from the first.
   */
  private killPlayer(): void {
    this.killSeat(this.player);
  }

  private killSeat(p: Player): void {
    if (!p.alive) return;
    p.hp = 0;
    p.alive = false;
    p.diedAt = this.time;
    const claimant =
      this.time - p.lastHitAt <= PVP.claimWindow ? this.players[p.lastHitBy] : undefined;
    if (claimant && claimant !== p && claimant.alive) {
      const bounty = Math.max(40, Math.round(p.arenaScore * PVP.bountyShare));
      // Same rule: whoever owns that seat's mass is already paying this bounty
      // and publishing the result, so adding it here would double-count it
      // until the next packet corrected it back down.
      if (this.ownsScore(claimant)) claimant.arenaScore += bounty;
      claimant.pvpKills++;
      claimant.arenaStreak++;
      claimant.kills += PVP.killCredit;
      this.events.push({
        type: 'rivalDown',
        x: p.x,
        y: p.y,
        name: p.name || `RIVAL ${p.index}`,
        killer: claimant.name || (claimant.index === 0 ? 'YOU' : `RIVAL ${claimant.index}`),
        bounty,
      });
    }
    if (this.players.length > 1) this.spillArenaMass(p);
    // A rival dying does not end the run; it changes the standings. Only seat
    // zero going down ends the game the local player is playing.
    if (p.index !== 0) return;
    if (this.phase === 'dead') return;
    this.phase = 'dead';
    this.events.push({
      type: 'died',
      time: this.time,
      level: this.level,
      kills: this.kills,
    });
  }

  /** Defeat becomes opportunity: loose growth draws everyone into the danger. */
  private spillArenaMass(p: Player): void {
    const total = Math.max(12, p.arenaScore * PVP.spillShare);
    const count = Math.max(8, Math.min(18, Math.round(total / 18)));
    const each = total / count;
    for (let i = 0; i < count; i++) {
      const a = (i / count) * TAU + this.rng.range(-0.12, 0.12);
      const r = this.rng.range(12, 52);
      this.spawnGem(p.x + dcos(a) * r, p.y + dsin(a) * r, each);
    }
  }

  private playerContact(dt: number): void {
    // One pass per living combatant. In solo that is one pass over one seat,
    // which is the identical work the single-player version did.
    for (const p of this.players) {
      if (p.alive) this.seatContact(p, dt);
    }
  }

  private seatContact(p: Player, dt: number): void {
    void dt;
    if (p.invul > 0) return;

    const list = this.enemies.active;
    // The BODY, not the constant. A seat fat with stolen mass is a bigger
    // target for a swarm whose whole threat model is contact — that is the
    // price of being rich, and it is charged here. In solo this is exactly
    // PLAYER.radius, because solo mass never leaves its starting value.
    const body = seatRadius(p.arenaScore);
    const n = this.hash.query(p.x, p.y, body + 64, this.scratch);

    // EVERY toucher contributes, and the i-frame window shrinks with the crowd.
    // Taking one hit and returning meant 605 enemies dealt what 2 dealt, which
    // capped the game's maximum possible damage output at 43.3 DPS forever.
    let worst = 0;
    let rest = 0;
    let contacts = 0;
    for (let k = 0; k < n; k++) {
      const e = list[this.scratch[k]!];
      if (!e || e.hp <= 0) continue;
      const dx = e.x - p.x;
      const dy = e.y - p.y;
      const rr = e.radius + body;
      if (dx * dx + dy * dy > rr * rr) continue;
      contacts++;
      if (e.damage > worst) {
        rest += worst;
        worst = e.damage;
      } else {
        rest += e.damage;
      }
    }
    if (contacts === 0) return;

    // Crowding ramps in from 45s to 105s so the authored opening is untouched.
    const crowd = crowdFactor(this.time);
    const damage = worst + rest * PLAYER.surroundShare * crowd;
    const iframes = Math.max(
      PLAYER.iframesFloor,
      PLAYER.iframes / (1 + PLAYER.iframeCrowding * crowd * (contacts - 1)),
    );
    // THORNS punishes the crowd for the contact it just made. Applied before
    // the hit resolves, so a touch that kills you still costs them.
    if (p.boons.has('thorns')) {
      const list = this.enemies.active;
      const n = this.hash.query(p.x, p.y, body + 64, this.scratch);
      for (let k = 0; k < n; k++) {
        const e = list[this.scratch[k]!];
        if (!e || e.hp <= 0) continue;
        const rr = e.radius + body;
        const dx = e.x - p.x;
        const dy = e.y - p.y;
        if (dx * dx + dy * dy > rr * rr) continue;
        this.damageEnemy(e, BOON.thornsDamage * p.powerHp, p.x, p.y);
      }
    }
    this.hurtSeat(p, damage, iframes);
  }

  // ------------------------------------------------------------ levelling

  private checkLevelUp(seat: Player = this.player): void {
    // Only the local player's level-up pauses the arena. A rival levelling has
    // to resolve in place — stopping the world for someone else's card would
    // make a lobby of eight unplayable within a minute.
    if (seat.index === 0 && this.phase !== 'playing') return;
    if (!seat.alive) return;
    if (seat.xp < seat.xpNeeded) return;

    // Vacuum the field on every level-up.
    //
    // THE cause of "it gets too complicated at 3 minutes": the gem pool pins at
    // its cap from t=180 onward, so 440 of 683 on-screen objects were gems the
    // player would never reach, and 80-86% of earned XP was being destroyed on
    // spawn. Collecting on level-up clears the carpet at the exact moment the
    // player is looking at cards anyway, and pays back XP they already earned.
    // Only the local player vacuums the field. Eight seats each clearing every
    // gem on level-up would delete the map's economy several times a second.
    // The level-up vacuum, which in solo sweeps the whole field because the gem
    // carpet is a readability problem there.
    //
    // In an arena it CANNOT sweep the field. Measured with eight seats: the
    // local player levelled 37 times and took every gem on the map each time,
    // so the rivals finished on level 5 to 17 having been robbed rather than
    // outplayed. Whoever levels first would compound into an unassailable lead
    // by doing nothing but levelling. In a lobby the sweep is local — you
    // collect what you were standing near, which is the same rule everyone
    // else is playing by.
    const gems = this.gems.active;
    if (this.players.length === 1) {
      for (let i = gems.length - 1; i >= 0; i--) {
        this.gainXp(gems[i]!.value, seat);
        this.gems.despawnAt(i);
      }
    } else {
      const r = seat.pickupRadius * ARENA_VACUUM_REACH;
      const r2 = r * r;
      for (let i = gems.length - 1; i >= 0; i--) {
        const g = gems[i]!;
        const dx = g.x - seat.x;
        const dy = g.y - seat.y;
        if (dx * dx + dy * dy > r2) continue;
        this.gainXp(g.value, seat);
        this.gems.despawnAt(i);
      }
    }

    seat.xp -= seat.xpNeeded;
    seat.level++;
    seat.xpNeeded = xpToNext(seat.level);

    const cards = this.drawCards(seat);
    if (seat.index !== 0) {
      // A rival picks and plays on, in the same step.
      const pick = seat.brain ? seat.brain.pickCard(cards) : cards[0]?.id;
      const card = cards.find((c) => c.id === pick) ?? cards[0];
      if (card) {
        this.applyCard(card, seat);
        seat.levelUpsTaken++;
        seat.hp = clamp(seat.hp, 0, seat.maxHp);
        this.refreshPower(seat);
      }
      this.checkLevelUp(seat);
      return;
    }
    if (cards.length === 0) {
      // Unreachable now that the endless tier is always in the pool, and kept as
      // a guard. The event fires only when there is something behind it: firing
      // it first meant the chord, the shockwave and the particle burst all
      // played for a level-up that offered nothing, 5-11 times in a long run.
      this.checkLevelUp(seat);
      return;
    }
    this.events.push({ type: 'levelUp', level: this.level });
    this.pendingCards = cards;
    this.phase = 'levelup';
  }

  /**
   * Redraw the current level-up offer.
   *
   * Deliberately draws from the same pool with the same weights rather than
   * guaranteeing anything better — a reroll that promises an upgrade is a
   * purchase, and this is an ad. It is a second roll of the same dice, which is
   * exactly what the player is being offered.
   */
  /**
   * Remove a card from this run's pool and immediately redraw.
   *
   * Evolutions can never be banished — banishing the payoff of your own build
   * is never what a player means to do, and a mis-tap that did it would be
   * unrecoverable.
   */
  banishCard(id: string): boolean {
    if (this.phase !== 'levelup' || this.banishesLeft <= 0) return false;
    const card = this.pendingCards?.find((c) => c.id === id);
    if (!card || card.kind === 'evolution') return false;
    this.banished.add(id);
    this.banishesLeft--;
    const cards = this.drawCards();
    if (cards.length > 0) this.pendingCards = cards;
    return true;
  }

  /**
   * Three boons the player does not already hold, drawn from the deck stream so
   * a shared daily offers the same fork to everyone.
   */
  /**
   * A boss died: everyone still standing gets a fork.
   *
   * IT USED TO BE ONE PERSON'S FORK. offerBoons read this.boons — seat zero's
   * set — so twelve boons with genuine costs applied to one of eight
   * combatants, and every rival fought the back half of an arena run with a
   * strictly weaker toolkit than the player. That is not difficulty, it is the
   * opponents being handed a worse copy of the game.
   *
   * Only the local player's fork stops the world. A rival's resolves in place,
   * for the same reason their level-ups do: pausing eight people so one of them
   * can read a panel makes a lobby unplayable inside a minute.
   */
  private offerBoons(): void {
    for (const seat of this.players) {
      if (!seat.alive) continue;
      const offer = this.drawBoons(seat);
      if (offer.length === 0) continue;
      if (seat.index === 0) {
        this.pendingBoons = offer;
        this.phase = 'boon';
        this.events.push({ type: 'boonOffered' });
        continue;
      }
      const pick = seat.brain ? seat.brain.pickBoon(offer) : offer[0]!;
      this.applyBoon(seat, (offer.includes(pick as BoonId) ? pick : offer[0]!) as BoonId);
    }
  }

  private drawBoons(seat: Player): BoonId[] {
    const pool = BOON_IDS.filter((b) => !seat.boons.has(b));
    if (pool.length === 0) return [];
    // Seat index folded in so the lobby does not all get the same fork. Seat
    // zero contributes nothing, which keeps solo runs reproducible.
    this.deckRng.state =
      mixSeed(this.seed, 9000 + seat.boons.size + seat.index * 131071) || 1;
    const picked: BoonId[] = [];
    const bag = pool.slice();
    while (picked.length < Math.min(3, bag.length) && bag.length > 0) {
      const i = Math.floor(this.deckRng.next() * bag.length) % bag.length;
      picked.push(bag.splice(i, 1)[0]!);
    }
    return picked;
  }

  /** The stat changes a boon makes once, rather than every frame. */
  private applyBoon(seat: Player, boon: BoonId): void {
    seat.boons.add(boon);
    if (boon === 'fortress') seat.speed *= BOON.fortressSpeed;
    if (boon === 'frenzy') {
      seat.maxHp = Math.round(seat.maxHp * BOON.frenzyMaxHp);
      seat.hp = Math.min(seat.hp, seat.maxHp);
    }
    this.refreshPower(seat);
  }

  chooseBoon(id: string): void {
    if (this.phase !== 'boon' || !this.pendingBoons) return;
    if (!this.pendingBoons.includes(id as BoonId)) return;
    const boon = id as BoonId;
    this.pendingBoons = null;
    this.phase = 'playing';
    this.applyBoon(this.player, boon);
    this.events.push({ type: 'boonTaken', id: boon, name: BOONS[boon].name });
    // A boss kill can land during a level-up chain; resolve any pending one.
    this.checkLevelUp();
  }

  /** Take nothing. Useful once the pool has been shaped and nothing fits. */
  skipCards(): void {
    if (this.phase !== 'levelup') return;
    this.levelUpsTaken++;
    this.pendingCards = null;
    this.phase = 'playing';
    this.checkLevelUp();
  }

  /**
   * Redraw the current offer. Sits behind a rewarded ad.
   *
   * THIS RETURNED THE SAME THREE CARDS. drawCards reseeds the deck stream from
   * (seed, levelUpsTaken, seat index) on entry, and a reroll changes none of
   * those three — so the ad played, the cards were redrawn from an identical
   * stream, and the identical three came back. The player watched thirty
   * seconds of advertising for a no-op, which is worse than not offering the
   * button: it teaches them that the game's ads are a con.
   *
   * The roll counter is mixed in ALONGSIDE the seat index, not instead of it,
   * because per-seat determinism depends on that term surviving.
   */
  /** Whether a redraw could actually change the offer. Gates the ad. */
  canReroll(): boolean {
    return this.phase === 'levelup' && this.levelUpsTaken > 0;
  }

  rerollCards(): boolean {
    if (this.phase !== 'levelup') return false;
    // The opening draw is fixed content and ignores the RNG entirely, so a
    // reroll there cannot do anything no matter how the stream is seeded.
    // Offering it would be the same dead ad by a different route.
    if (this.levelUpsTaken === 0) return false;
    this.rerolls++;
    const cards = this.drawCards();
    if (cards.length === 0) return false;
    this.pendingCards = cards;
    return true;
  }

  /** Rerolls taken this run. Part of the deck seed, so a redraw is a new draw. */
  private rerolls = 0;

  private drawCards(seat: Player = this.player): Card[] {
    // Reseed per draw, so the Nth offer of a seed is stable across players.
    // The seat index is folded in so each combatant draws its own offers rather
    // than the whole lobby converging on one build. Seat zero contributes
    // nothing to the mix, which is what keeps solo runs reproducible.
    this.deckRng.state =
      mixSeed(
        this.seed,
        seat.levelUpsTaken + seat.index * 1000003 + this.rerolls * 7919,
      ) || 1;
    if (seat.levelUpsTaken === 0) {
      /**
       * The fixed opening draw must honour a banish too.
       *
       * It returned FIRST_DRAW unconditionally, so banishing on the very first
       * level-up spent one of the run's three charges and changed nothing on
       * screen — the card was still there. Filtering here and topping back up
       * from the real pool keeps the opening's three-different-kinds guarantee
       * while making the control mean what it says everywhere it appears.
       */
      const first = FIRST_DRAW.map((id) => UPGRADES_BY_ID.get(id)!)
        .filter(Boolean)
        .filter((c) => !this.banished.has(c.id));
      if (first.length >= 3) return first;
      const rest = buildCardPool(this).filter((c) => !first.some((f) => f.id === c.id));
      return [...first, ...this.weightedDraw(rest, 3 - first.length)];
    }
    const pool = buildCardPool(this);
    // Evolutions are always offered when available. They are the payoff the
    // whole weapon system builds toward, and burying one behind a random draw
    // means most players never see the system exists.
    const evolutions = pool.filter((c) => c.kind === 'evolution');
    const rest = pool.filter((c) => c.kind !== 'evolution');
    if (evolutions.length > 0) {
      return [evolutions[0]!, ...this.weightedDraw(rest, 2)];
    }
    return this.weightedDraw(rest, 3);
  }

  /** Weighted sample without replacement. See Card.weight for why. */
  private weightedDraw(pool: Card[], count: number): Card[] {
    const remaining = pool.slice();
    const out: Card[] = [];
    for (let n = 0; n < count && remaining.length > 0; n++) {
      let total = 0;
      for (let i = 0; i < remaining.length; i++) total += remaining[i]!.weight;
      let roll = this.deckRng.next() * total;
      let picked = remaining.length - 1;
      for (let i = 0; i < remaining.length; i++) {
        roll -= remaining[i]!.weight;
        if (roll <= 0) {
          picked = i;
          break;
        }
      }
      out.push(remaining[picked]!);
      remaining.splice(picked, 1);
    }
    return out;
  }

  chooseUpgrade(id: string): void {
    if (this.phase !== 'levelup' || !this.pendingCards) return;
    const card = this.pendingCards.find((c) => c.id === id);
    if (!card) return;

    this.applyCard(card);
    this.levelUpsTaken++;
    this.pendingCards = null;
    this.phase = 'playing';
    this.player.hp = clamp(this.player.hp, 0, this.player.maxHp);
    this.refreshPower();

    // Several levels can land in one step during a dense wave. Chain them.
    this.checkLevelUp();
  }

  /**
   * Recompute the build's power. Called after anything that can change it.
   *
   * Not per frame: it reads six fields and a weapon list, and it only ever
   * moves on a card, an evolution or a run reset.
   */
  private refreshPower(seat: Player = this.player): void {
    seat.power = powerIndex(seat, seat.weapons);
    seat.powerHp = threatFromPower(seat.power, this.time);
    seat.powerDensity = densityFromPower(seat.power, this.time);
    seat.powerDamage = damageFromPower(seat.power, this.time);
  }

  private applyCard(card: Card, seat: Player = this.player): void {
    const p = seat;

    if (card.kind === 'passive') {
      card.apply?.(p);
      // Key by the BARE passive id, not the prefixed card id — max-stack caps
      // and evolution requirements both look it up that way.
      const key = card.passiveId ?? card.id;
      p.stacks.set(key, this.stacksOf(key, p) + 1);
      return;
    }

    if (card.kind === 'weapon') {
      const existing = p.weapons.find((w) => w.id === card.weaponId);
      if (existing) {
        existing.level = Math.min(WEAPONS[existing.id].maxLevel, existing.level + 1);
      } else if (p.weapons.length < MAX_WEAPONS) {
        p.weapons.push({
          id: card.weaponId!,
          origin: card.weaponId!,
          level: 1,
          cd: 0.35,
          phase: 0,
        });
        this.events.push({ type: 'weaponGained', id: card.weaponId! });
      }
      return;
    }

    // Evolution: the base weapon is consumed and replaced in place, so slot
    // count is unchanged and the build reads as a transformation.
    const base = p.weapons.find((w) => w.id === card.weaponId);
    if (!base) return;
    const evolved = card.evolveTo!;
    base.id = evolved;
    base.level = 1;
    base.cd = 0.3;
    base.phase = 0;
    this.evolutionsThisRun++;
    this.events.push({ type: 'evolved', id: evolved, name: WEAPONS[evolved].name });
  }
}

/**
 * Deterministically combine a run seed with a draw ordinal.
 *
 * Plain addition or XOR would make adjacent ordinals produce adjacent streams,
 * so consecutive level-ups would offer suspiciously similar cards. This is the
 * standard 32-bit finaliser.
 */
function mixSeed(seed: number, n: number): number {
  let h = (seed ^ Math.imul(n + 1, 0x9e3779b9)) >>> 0;
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b) >>> 0;
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35) >>> 0;
  h ^= h >>> 16;
  return h >>> 0;
}

function makeEnemy(): Enemy {
  return {
    seat: 0,
    x: 0, y: 0, px: 0, py: 0, vx: 0, vy: 0,
    hp: 0, maxHp: 0, radius: 0, speed: 0, damage: 0, xp: 0, mass: 1,
    kind: 'drifter', color: 0xffffff, flash: 0, orbCd: 0, auraCd: 0,
    kx: 0, ky: 0, special: 0, phase: 0, generation: 0,
    armor: 0, vuln: 1, submerged: false,
  };
}
function resetEnemy(e: Enemy): void {
  e.seat = 0;
  e.hp = 0;
  e.flash = 0;
  e.orbCd = 0;
  e.auraCd = 0;
  e.kx = 0;
  e.ky = 0;
  e.vx = 0;
  e.vy = 0;
  e.special = 0;
  e.phase = 0;
  e.generation = 0;
  e.armor = 0;
  e.vuln = 1;
  e.submerged = false;
}

function makeProjectile(): Projectile {
  return {
    x: 0, y: 0, px: 0, py: 0, vx: 0, vy: 0, damage: 0, radius: 0, life: 0,
    pierce: 0, kind: 'bolt', turn: 0, blast: 0, color: 0xffffff, hostile: false,
    owner: 0,
  };
}
function resetProjectile(p: Projectile): void {
  p.owner = 0;
  p.life = 0;
  p.pierce = 0;
  p.turn = 0;
  p.blast = 0;
  p.hostile = false;
}

function makeGem(): Gem {
  return { x: 0, y: 0, px: 0, py: 0, vx: 0, vy: 0, value: 0, heal: 0, homing: false, age: 0 };
}
function resetGem(g: Gem): void {
  g.value = 0;
  g.heal = 0;
  g.homing = false;
  g.vx = 0;
  g.vy = 0;
  g.age = 0;
}
