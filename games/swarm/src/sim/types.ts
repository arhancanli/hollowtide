import type { EnemyKind } from '../content/balance.js';
import type { WeaponId } from '../content/weapons.js';

/**
 * Entity shapes are fixed and monomorphic on purpose — every field is present
 * and numeric from construction, so V8 keeps one hidden class per pool and the
 * hot loops stay fast. Never add a field conditionally.
 *
 * `px`/`py` are the previous step's position, used for render interpolation.
 */
export interface Enemy {
  /**
   * Which combatant this enemy is chasing. Always 0 in a solo run, so the
   * single-player path never pays for the arena.
   */
  seat: number;
  x: number;
  y: number;
  px: number;
  py: number;
  vx: number;
  vy: number;
  hp: number;
  maxHp: number;
  radius: number;
  speed: number;
  damage: number;
  xp: number;
  mass: number;
  kind: EnemyKind;
  color: number;
  /** Counts down after a hit; drives the white flash in the render layer. */
  flash: number;
  /** Per-enemy orbit cooldown, so orbs chip instead of instantly deleting. */
  orbCd: number;
  /** Separate aura tick, so the two damage-over-time sources never mask each other. */
  auraCd: number;
  /** Knockback velocity, decays independently of steering. */
  kx: number;
  ky: number;
  /** Generic behaviour timer: boss attack cadence, charge windup, fuse. */
  special: number;
  /** Behaviour phase for bosses (0 = pursue, 1 = winding up, 2 = committed). */
  phase: number;
  /** Generation counter, so splitters cannot split forever. */
  generation: number;
  /**
   * Flat damage subtracted from every hit before it lands. BULWARK's whole
   * identity — see ENEMIES.bulwark for why flat rather than proportional.
   */
  armor: number;
  /**
   * Incoming damage multiplier, rewritten every step. 1 normally; a WEAVER's
   * tether drops nearby enemies to 0.45 while it lives.
   */
  vuln: number;
  /** True while a BURROWER is under the ground: no hash entry, no contact. */
  submerged: boolean;
}

export type ProjectileKind = 'bolt' | 'homing' | 'mine' | 'enemyOrb';

export interface Projectile {
  /** Seat that fired this. Used to keep PvP damage off its owner. */
  owner: number;
  x: number;
  y: number;
  px: number;
  py: number;
  vx: number;
  vy: number;
  damage: number;
  radius: number;
  life: number;
  pierce: number;
  kind: ProjectileKind;
  /** Homing turn rate, radians per second. */
  turn: number;
  /** Blast radius on detonation. Zero for plain projectiles. */
  blast: number;
  color: number;
  /** Hostile projectiles test against the PLAYER, not the enemy hash. */
  hostile: boolean;
}

export interface Gem {
  x: number;
  y: number;
  px: number;
  py: number;
  vx: number;
  vy: number;
  value: number;
  /**
   * Health restored on pickup. Zero for an ordinary XP gem.
   *
   * Carried on the gem rather than in a separate pool because the drift, the
   * magnet, the merge rule and the auto-bank are all already correct here, and
   * a second pool would have to duplicate every one of them.
   */
  heal: number;
  /**
   * True for the mass that spills out of a fallen player.
   *
   * It pays MASS ONLY — no experience. Measured with it paying experience like
   * an ordinary gem: a 100% shatter turned every elimination into an XP
   * fountain, the winner became unkillable by 50 seconds, and the last three
   * minutes of a run were a solo farm in total safety. Score and power are the
   * same currency in this game, so loot has to opt out of one of them.
   */
  loot: boolean;
  /** Latches true once in range, so gems never un-magnetise mid-flight. */
  homing: boolean;
  /** Seconds since drop. Older gems chase harder — see GEM in balance.ts. */
  age: number;
}

export interface WeaponInstance {
  id: WeaponId;
  /**
   * The weapon this slot STARTED as, preserved through evolution.
   *
   * Evolution rewrites `id` in place, so a check of "do I already hold nova?"
   * stopped matching once NOVA became SUPERNOVA and NOVA was offered again as
   * brand new. Measured: 26% of runs ended holding duplicates, one run logged
   * five evolutions in a game that contains four, and one evaluator finished
   * with three SUPERNOVAs — the only healing in the game — and could not die.
   */
  origin: WeaponId;
  level: number;
  /** Time until next activation. */
  cd: number;
  /** Free-running state: orbit angle, alternating volley offsets. */
  phase: number;
}

/**
 * Per-combatant run state.
 *
 * These lived on World as single fields — one xp, one level, one kill count —
 * which encoded the assumption that exactly one person is playing. In a shared
 * arena eight combatants each level independently off the same swarm, so the
 * state has to move onto the combatant. Solo is simply an arena of one, which
 * is what keeps the single-player game on exactly the same code path rather
 * than a parallel one that quietly drifts.
 */
export interface RunState {
  /** Seat in the lobby. 0 is always the local player. */
  index: number;
  /** Display name. Empty for the local player, who is just "you". */
  name: string;
  /** False once dead. Dead combatants stay in the world for the standings. */
  alive: boolean;
  level: number;
  xp: number;
  xpNeeded: number;
  kills: number;
  damageTaken: number;
  evolutionsThisRun: number;
  /** Time of death, or -1 while alive. Drives placement. */
  diedAt: number;
  /** Multiplayer growth currency: prey collected plus rival bounties. */
  arenaScore: number;
  /** Rival eliminations, distinct from ordinary swarm kills. */
  pvpKills: number;
  /** Consecutive rival eliminations this life. */
  arenaStreak: number;
}

export interface PlayerStats {
  hp: number;
  maxHp: number;
  speed: number;
  pickupRadius: number;
  damageMult: number;
  fireRateMult: number;
  /** Extra projectiles added to every projectile weapon. */
  projectileCount: number;
  /** Multiplier on every weapon's area/radius stat. */
  areaMult: number;
}

/** 'boon' pauses the sim while the player picks a boss reward. */
export type RunPhase = 'playing' | 'levelup' | 'boon' | 'dead';

/** Events the sim emits for the render/juice/audio/analytics layers. */
export type SimEvent =
  | { type: 'enemyHit'; x: number; y: number; damage: number; killed: boolean; kind: EnemyKind }
  | { type: 'enemyKilled'; x: number; y: number; kind: EnemyKind; color: number }
  | { type: 'playerHit'; damage: number }
  | { type: 'gemCollected'; value: number }
  | { type: 'healed'; amount: number }
  | { type: 'levelUp'; level: number }
  | { type: 'died'; time: number; level: number; kills: number }
  | { type: 'rivalDown'; x: number; y: number; name: string; killer: string; bounty: number }
  /** A batch of enemies changed which combatant they are chasing. */
  | { type: 'handoff'; from: number; to: number; count: number; x: number; y: number }
  | { type: 'revived' }
  | { type: 'eliteSpawned' }
  | { type: 'heraldSpawned' }
  /** Flat [x0,y0,x1,y1,...] polyline for the render layer to draw as lightning. */
  | { type: 'chainArc'; points: number[]; color: number }
  | { type: 'blast'; x: number; y: number; radius: number; color: number }
  /**
   * An area that WILL be dangerous, shown before it is.
   *
   * The first hazards in the game that damage without contact, so they need a
   * tell the player can act on — the ring is drawn at full size immediately and
   * fills over `duration`, which is the time available to leave it.
   */
  | {
      type: 'telegraph';
      x: number;
      y: number;
      radius: number;
      duration: number;
      color: number;
    }
  | { type: 'bossSpawned'; name: string }
  | { type: 'bossKilled'; x: number; y: number; color: number }
  | { type: 'weaponGained'; id: WeaponId }
  | { type: 'evolved'; id: WeaponId; name: string }
  | { type: 'tideBegan'; x: number; y: number }
  /** The arena wall started closing. Fires once, so the UI can announce it. */
  | { type: 'ringClosing'; radius: number }
  | { type: 'boonOffered' }
  | { type: 'boonTaken'; id: string; name: string }
  | { type: 'abilityUsed'; id: string; x: number; y: number };
