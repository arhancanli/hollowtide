import type { PlayerStats } from '../sim/types.js';

/**
 * The Forge — permanent upgrades bought with gold.
 *
 * This exists because the game had no gold SINK at all. `totalGold` only ever
 * incremented, the five character unlocks keyed off that lifetime total rather
 * than off spending, and a single 13-minute run pays ~4,400 gold against a
 * 6,000 top threshold. So the entire meta-game was over in two or three runs
 * and every run after that earned a number that bought nothing. That is a large
 * part of why a game with thirteen minutes of content still reads as thin: the
 * depth is all inside one run, and nothing accumulates between them.
 *
 * DESIGN CONSTRAINTS, in priority order:
 *
 * 1. No dark patterns. No timers, no daily-loss threats, no paywalls. The chase
 *    is long because the numbers are large, not because the game withholds.
 * 2. Modest per-level effects. Maxing every track is roughly +20% damage and
 *    +40 max HP — enough that a returning player feels the difference in the
 *    first thirty seconds, small enough that it never replaces playing well.
 *    A meta that trivialises the game destroys the thing it exists to sell.
 * 3. Every track must be legible in one line. If a player has to model an
 *    interaction to know whether an upgrade is good, it is a worse upgrade than
 *    one that is obviously mildly good.
 *
 * SIZING. Eight tracks x five levels at 200/380/700/1250/2200 is 37,840 gold,
 * plus 11,450 for the six characters: ~49,000 to own everything. Against ~2,000
 * for a competent six-minute run that is roughly 25 runs, and GREED compounds it
 * downward. For comparison the shelf leader sizes its equivalent chase at ~48,650
 * against 100-300 per victory — deliberately 150+ runs. Ours is a fifth of that,
 * because a portal player's session count is not a premium roguelite's.
 */

export interface ForgeTrack {
  id: string;
  name: string;
  /** One line, stating the per-level effect plainly. */
  desc: string;
  color: number;
  maxLevel: number;
  apply: (p: PlayerStats, level: number) => void;
}

/** Gold cost of each level, indexed by the level being bought minus one. */
export const FORGE_COSTS: readonly number[] = [200, 380, 700, 1250, 2200];

export const FORGE_TRACKS: readonly ForgeTrack[] = [
  {
    id: 'might',
    name: 'MIGHT',
    desc: '+4% damage per level',
    color: 0xff5c6e,
    maxLevel: 5,
    apply: (p, lv) => {
      p.damageMult *= 1 + 0.04 * lv;
    },
  },
  {
    id: 'vitality',
    name: 'VITALITY',
    desc: '+8 max health per level',
    color: 0xff7ab8,
    maxLevel: 5,
    apply: (p, lv) => {
      p.maxHp += 8 * lv;
      p.hp += 8 * lv;
    },
  },
  {
    id: 'haste',
    name: 'HASTE',
    desc: '+3% attack speed per level',
    color: 0xffd23a,
    maxLevel: 5,
    apply: (p, lv) => {
      p.fireRateMult *= 1 + 0.03 * lv;
    },
  },
  {
    id: 'reach',
    name: 'REACH',
    desc: '+3% area per level',
    color: 0x9ad6ff,
    maxLevel: 5,
    apply: (p, lv) => {
      p.areaMult *= 1 + 0.03 * lv;
    },
  },
  {
    id: 'swiftness',
    name: 'SWIFTNESS',
    desc: '+2% move speed per level',
    color: 0x5cf0ff,
    maxLevel: 5,
    apply: (p, lv) => {
      p.speed *= 1 + 0.02 * lv;
    },
  },
  {
    id: 'magnet',
    name: 'MAGNET',
    desc: '+8% pickup range per level',
    color: 0x7dff9b,
    maxLevel: 5,
    apply: (p, lv) => {
      p.pickupRadius *= 1 + 0.08 * lv;
    },
  },
  /**
   * The two tracks that do not touch combat.
   *
   * GREED and GROWTH are the ones that make a run feel like it fed the next
   * one, which is the specific feeling this whole system exists to create. They
   * are applied outside PlayerStats — see forgeGoldMult / forgeXpMult — because
   * neither belongs in the simulation's own stat block.
   */
  {
    id: 'greed',
    name: 'GREED',
    desc: '+6% gold earned per level',
    color: 0xc9a15e,
    maxLevel: 5,
    apply: () => {},
  },
  {
    id: 'growth',
    name: 'GROWTH',
    desc: '+4% experience per level',
    color: 0xb478ff,
    maxLevel: 5,
    apply: () => {},
  },
];

export const FORGE_BY_ID = new Map(FORGE_TRACKS.map((t) => [t.id, t]));

/** Gold to buy the NEXT level of a track. Null when maxed. */
export function forgeCost(track: ForgeTrack, currentLevel: number): number | null {
  if (currentLevel >= track.maxLevel) return null;
  return FORGE_COSTS[currentLevel] ?? null;
}

/** Total gold to take every track from nothing to maximum. */
export function forgeTotalCost(): number {
  return FORGE_TRACKS.reduce(
    (sum, t) => sum + FORGE_COSTS.slice(0, t.maxLevel).reduce((a, b) => a + b, 0),
    0,
  );
}

export type ForgeLevels = Readonly<Record<string, number>>;

/** Apply every purchased track to a fresh run's stats. */
export function applyForge(p: PlayerStats, levels: ForgeLevels): void {
  for (const track of FORGE_TRACKS) {
    const lv = levels[track.id] ?? 0;
    if (lv > 0) track.apply(p, lv);
  }
}

export function forgeGoldMult(levels: ForgeLevels): number {
  return 1 + 0.06 * (levels.greed ?? 0);
}

export function forgeXpMult(levels: ForgeLevels): number {
  return 1 + 0.04 * (levels.growth ?? 0);
}

/** Levels bought across every track, for the results screen. */
export function forgeProgress(levels: ForgeLevels): { bought: number; total: number } {
  let bought = 0;
  let total = 0;
  for (const t of FORGE_TRACKS) {
    bought += Math.min(t.maxLevel, levels[t.id] ?? 0);
    total += t.maxLevel;
  }
  return { bought, total };
}
