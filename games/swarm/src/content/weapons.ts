/**
 * Weapon definitions.
 *
 * This is the retention engine, not a feature list. In this genre the thing
 * that produces runs 5 through 50 is a player thinking "next run I want to try
 * X with Y" — build expression, not more enemies or more time. Seven weapons
 * with distinct behaviour and four evolutions is what turns a four-run game
 * into a thirty-run one, and it is all data and behaviour rather than assets.
 *
 * Every weapon must be mechanically distinct, not a reskin. If two weapons
 * differ only in numbers the player has no reason to prefer either, and the
 * choice at level-up stops being interesting.
 */

export type WeaponId =
  | 'bolt'
  | 'orbit'
  | 'nova'
  | 'chain'
  | 'mines'
  | 'aura'
  | 'homing'
  // Evolutions. Reached, never offered from scratch.
  | 'storm'
  | 'vortex'
  | 'supernova'
  | 'tempest'
  | 'cluster'
  | 'inferno'
  | 'swarm';

export interface WeaponDef {
  id: WeaponId;
  name: string;
  /** One short line. If it needs two, the weapon is too complicated. */
  desc: string;
  color: number;
  maxLevel: number;
  /** Per-level tables. Index is level-1. */
  damage: readonly number[];
  cooldown: readonly number[];
  /** Meaning varies by weapon: projectile count, orb count, chain jumps... */
  count: readonly number[];
  /** Radius, range or blast depending on the weapon. */
  size: readonly number[];
  /** True for evolved forms — never offered as a fresh pick. */
  evolved?: boolean;
  /** Evolution target, unlocked at max level while holding `evolveWith`. */
  evolvesInto?: WeaponId;
  /** Passive upgrade id required to trigger the evolution. */
  evolveWith?: string;
  /**
   * How many stacks of that passive are needed. Defaults to 1.
   *
   * MINES, AURA and SEEKER were dead ends — three of seven weapon lines with no
   * payoff, which is a third of the game's content arriving and then stopping.
   * All four passives were already spoken for by the first four evolutions, so
   * these key off the same passives at a DEEPER stack. One rule to learn
   * ("max the weapon, hold the passive"), with a second tier behind it.
   */
  evolveStacks?: number;
}

export const WEAPONS: Record<WeaponId, WeaponDef> = {
  bolt: {
    id: 'bolt',
    name: 'BOLT',
    desc: 'Fires at the nearest foe',
    color: 0xfff2a8,
    maxLevel: 5,
    damage: [14, 19, 25, 32, 41],
    cooldown: [0.8, 0.70, 0.62, 0.54, 0.46],
    count: [1, 1, 2, 2, 3],
    size: [5, 5, 6, 6, 7],
    evolvesInto: 'storm',
    evolveWith: 'damage',
  },
  orbit: {
    id: 'orbit',
    name: 'ORBIT',
    desc: 'Blades circle you',
    color: 0x5cd0ff,
    maxLevel: 5,
    damage: [8, 11, 14, 18, 23],
    cooldown: [0.35, 0.32, 0.29, 0.26, 0.23],
    count: [2, 2, 3, 4, 5],
    size: [78, 82, 88, 94, 100],
    evolvesInto: 'vortex',
    evolveWith: 'area',
  },
  nova: {
    id: 'nova',
    name: 'NOVA',
    desc: 'Blast rings outward',
    color: 0xff8f3a,
    maxLevel: 5,
    damage: [18, 24, 31, 40, 52],
    cooldown: [3.2, 2.9, 2.6, 2.3, 2.0],
    count: [1, 1, 1, 2, 2],
    size: [120, 145, 170, 195, 225],
    evolvesInto: 'supernova',
    evolveWith: 'vitality',
  },
  chain: {
    id: 'chain',
    name: 'CHAIN',
    desc: 'Arcs between foes',
    color: 0x9ad6ff,
    maxLevel: 5,
    damage: [14, 19, 25, 32, 41],
    cooldown: [1.5, 1.35, 1.2, 1.05, 0.9],
    count: [3, 4, 5, 6, 8],
    size: [190, 200, 215, 230, 250],
    evolvesInto: 'tempest',
    evolveWith: 'firerate',
  },
  mines: {
    id: 'mines',
    name: 'MINES',
    desc: 'Drops charges behind you',
    color: 0xff5c6e,
    maxLevel: 5,
    damage: [30, 40, 52, 66, 84],
    cooldown: [1.8, 1.6, 1.4, 1.2, 1.0],
    count: [1, 1, 2, 2, 3],
    size: [70, 78, 86, 94, 105],
    evolvesInto: 'cluster',
    evolveWith: 'damage',
    evolveStacks: 3,
  },
  aura: {
    id: 'aura',
    name: 'AURA',
    desc: 'Burns anything close',
    color: 0xb478ff,
    maxLevel: 5,
    damage: [7, 9, 12, 15, 19],
    cooldown: [0.5, 0.46, 0.42, 0.38, 0.34],
    count: [1, 1, 1, 1, 1],
    size: [78, 90, 102, 116, 132],
    evolvesInto: 'inferno',
    evolveWith: 'area',
    evolveStacks: 3,
  },
  homing: {
    id: 'homing',
    name: 'SEEKER',
    desc: 'Missiles that follow',
    // Magenta, NOT green. This was 0x7dff9b — byte-identical to GEM_COLOR, so
    // on a seeker build the player could not tell their own missiles from XP
    // pickups. Green belongs to the pickup, and nothing else may use it.
    color: 0xff5cd8,
    maxLevel: 5,
    damage: [16, 21, 27, 34, 43],
    cooldown: [1.6, 1.45, 1.3, 1.15, 1.0],
    count: [1, 2, 2, 3, 4],
    size: [6, 6, 7, 7, 8],
    evolvesInto: 'swarm',
    evolveWith: 'firerate',
    evolveStacks: 3,
  },

  // ---- evolutions -------------------------------------------------------
  storm: {
    id: 'storm',
    name: 'STORM',
    desc: 'Volleys in every direction',
    color: 0xffd23a,
    maxLevel: 5,
    damage: [40, 46, 53, 61, 70],
    cooldown: [0.55, 0.52, 0.49, 0.45, 0.42],
    count: [10, 10, 11, 11, 12],
    size: [7, 7, 8, 8, 8],
    evolved: true,
  },
  vortex: {
    id: 'vortex',
    name: 'VORTEX',
    desc: 'Blades drag foes inward',
    color: 0x5cf0ff,
    maxLevel: 5,
    damage: [28, 32, 37, 42, 48],
    cooldown: [0.18, 0.17, 0.16, 0.15, 0.14],
    count: [6, 6, 7, 7, 8],
    size: [110, 114, 118, 122, 126],
    evolved: true,
  },
  supernova: {
    id: 'supernova',
    name: 'SUPERNOVA',
    desc: 'Devastating blast, heals you',
    color: 0xff6a3a,
    maxLevel: 5,
    damage: [70, 80, 92, 105, 120],
    cooldown: [2.2, 2.05, 1.9, 1.78, 1.65],
    count: [2, 2, 3, 3, 3],
    size: [300, 310, 320, 330, 340],
    evolved: true,
  },
  cluster: {
    id: 'cluster',
    name: 'CLUSTER',
    desc: 'Charges that split on impact',
    color: 0xff8fa0,
    maxLevel: 5,
    damage: [74, 84, 96, 110, 126],
    cooldown: [1.0, 0.94, 0.88, 0.82, 0.76],
    count: [3, 3, 4, 4, 5],
    size: [118, 122, 126, 130, 134],
    evolved: true,
  },
  inferno: {
    id: 'inferno',
    name: 'INFERNO',
    desc: 'A furnace you carry with you',
    color: 0xff6a3a,
    maxLevel: 5,
    damage: [22, 25, 28, 32, 37],
    cooldown: [0.26, 0.25, 0.24, 0.23, 0.22],
    count: [1, 1, 1, 1, 1],
    size: [162, 168, 174, 180, 186],
    evolved: true,
  },
  swarm: {
    id: 'swarm',
    name: 'SWARM',
    desc: 'A cloud of seeking missiles',
    // Follows SEEKER off green for the same reason, and stays recognisably its
    // brighter descendant.
    color: 0xffa8ec,
    maxLevel: 5,
    damage: [31, 35, 40, 46, 53],
    cooldown: [0.55, 0.52, 0.49, 0.45, 0.42],
    count: [5, 5, 6, 6, 7],
    size: [8, 8, 9, 9, 9],
    evolved: true,
  },
  tempest: {
    id: 'tempest',
    name: 'TEMPEST',
    desc: 'Endless forking lightning',
    color: 0xc8ecff,
    maxLevel: 5,
    damage: [46, 52, 60, 69, 79],
    cooldown: [0.65, 0.62, 0.58, 0.55, 0.52],
    count: [14, 15, 16, 17, 18],
    size: [300, 308, 316, 324, 332],
    evolved: true,
  },
};

/** Weapons offerable as a fresh pick. */
export const STARTER_POOL: readonly WeaponId[] = [
  // BOLT belongs here. It was excluded, so its evolution STORM was unreachable
  // for four of the six characters — an evolution two thirds of the roster
  // could never see.
  'bolt',
  'orbit',
  'nova',
  'chain',
  'mines',
  'aura',
  'homing',
];

/**
 * Weapon slots.
 *
 * FOUR, deliberately. Unlimited slots means every run converges on "take
 * everything" and builds stop being choices — the scarcity is what makes the
 * card interesting.
 *
 * With six slots and four passives a competent run collected 4-5 evolutions
 * every time, regardless of what the player was trying to do — so the printed
 * evolution recipe was never a plan, just a description of what was going to
 * happen anyway. Seven weapon lines competing for four slots means every run
 * drops three of them, and taking VITAL for SUPERNOVA now costs you RAPID for
 * TEMPEST. The evolution key finally has a price, which is the mechanism that
 * makes a build a build rather than an inventory.
 */
export const MAX_WEAPONS = 4;

export function weaponStat(def: WeaponDef, table: readonly number[], level: number): number {
  return table[Math.min(level, def.maxLevel) - 1] ?? table[table.length - 1]!;
}

/**
 * ORBIT/VORTEX geometry — the ONE definition, used by both the sim and the
 * renderer.
 *
 * These lived in two places and drifted apart. The sim damps the ring to 25% of
 * the +REACH bonus (enemies press against the player, so a ring that grows with
 * area sweeps blades OUT of the crowd — measured 0.00x damage at max REACH once
 * the radius scaled cleanly). The fix was applied to the damage path and never
 * to the draw call, so at max REACH the blades were DRAWN at 336px and could
 * only HIT to 159px: 2.11x further out than they reach. One probe recorded zero
 * hits over three seconds with seventy enemies touching the player, while the
 * screen showed blades sweeping through all of them.
 *
 * A weapon whose picture disagrees with its hitbox is unlearnable. Keep both
 * call sites on these two functions.
 */
export function orbitRingRadius(def: WeaponDef, level: number, areaMult: number): number {
  return weaponStat(def, def.size, level) * (1 + (areaMult - 1) * 0.25);
}

/** The blade's own hit radius. Takes the FULL area bonus — that is the payoff. */
export function orbitBladeRadius(areaMult: number): number {
  return 14 * areaMult;
}
