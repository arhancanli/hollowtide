/**
 * Boons — the reward for killing a boss, and the game's second decision axis.
 *
 * The level-up draft asks "which number goes up". That is one axis, and after
 * twenty runs a player has seen all of it. Boons ask a different question:
 * "what am I willing to give up." Every one here has a cost, and that is the
 * entire point — a boon with no downside is a stat, and stats already have a
 * system.
 *
 * They also give bosses a reason to exist beyond a health bar. Eleven boss
 * fights happen in a long run; before this, killing one paid experience and
 * gold, which is what killing anything pays. Now each is a fork in the run.
 *
 * DESIGN RULES:
 *
 * 1. Every boon must change how you PLAY, not just what your numbers are.
 *    MOMENTUM makes standing still bad. FORTRESS makes you slow and hard to
 *    kill. FRENZY makes low health a resource. If a boon does not change a
 *    decision you make with your thumbs, it is a passive card wearing a crown.
 * 2. The cost must be real and stated. A player who does not read the downside
 *    should still be able to feel it inside thirty seconds.
 * 3. They must combine into things the designer did not plan. HUNGER plus
 *    VAMPIRISM is a treadmill you have to keep killing to survive; FORTRESS
 *    plus MOMENTUM is a contradiction you have to pick a side of. That
 *    combinatorial surface is the depth — twelve boons taken three at a time
 *    is 220 distinct run shapes.
 * 4. Nothing here may be strictly better than another boon in the same draw,
 *    or the choice collapses into a lookup table.
 */

export type BoonId =
  | 'vampirism'
  | 'thorns'
  | 'overcharge'
  | 'momentum'
  | 'greed'
  | 'hunger'
  | 'fortress'
  | 'splinter'
  | 'execute'
  | 'resonance'
  | 'frenzy'
  | 'glasscannon';

export interface BoonDef {
  id: BoonId;
  name: string;
  /** What it gives. One line. */
  gain: string;
  /** What it costs. One line. Never empty. */
  cost: string;
  color: number;
}

export const BOONS: Record<BoonId, BoonDef> = {
  vampirism: {
    id: 'vampirism',
    name: 'VAMPIRISM',
    gain: 'Every kill heals you a little',
    cost: 'Health drops appear far less often',
    color: 0xff5c8a,
  },
  thorns: {
    id: 'thorns',
    name: 'THORNS',
    gain: 'Anything that touches you is hurt badly',
    cost: 'Your invulnerability window is shorter',
    color: 0xffd23a,
  },
  overcharge: {
    id: 'overcharge',
    name: 'OVERCHARGE',
    gain: 'Ability cooldown almost halved',
    cost: 'You take 20% more damage',
    color: 0x5cf0ff,
  },
  momentum: {
    id: 'momentum',
    name: 'MOMENTUM',
    gain: '+40% damage while you keep moving',
    cost: '-25% damage the moment you stop',
    color: 0x8ef7ff,
  },
  greed: {
    id: 'greed',
    name: 'GREED',
    gain: 'Double gold from this run',
    cost: 'Every enemy has 20% more health',
    color: 0xc9a15e,
  },
  hunger: {
    id: 'hunger',
    name: 'HUNGER',
    gain: '+50% experience from everything',
    cost: 'You lose health steadily, forever',
    color: 0xb478ff,
  },
  fortress: {
    id: 'fortress',
    name: 'FORTRESS',
    gain: 'Take 35% less damage',
    cost: 'Move 20% slower',
    color: 0x7dff9b,
  },
  splinter: {
    id: 'splinter',
    name: 'SPLINTER',
    gain: 'Your shots pierce two more foes',
    cost: 'They travel noticeably slower',
    color: 0xfff2a8,
  },
  execute: {
    id: 'execute',
    name: 'EXECUTE',
    gain: 'Badly wounded foes die instantly',
    cost: 'They drop no experience when they do',
    color: 0xff5c6e,
  },
  resonance: {
    id: 'resonance',
    name: 'RESONANCE',
    gain: 'Every fourth attack fires twice',
    cost: 'All your weapons fire 15% slower',
    color: 0x9ad6ff,
  },
  frenzy: {
    id: 'frenzy',
    name: 'FRENZY',
    gain: '+55% attack speed while below half health',
    cost: 'Your maximum health is cut by a quarter',
    color: 0xff8f3a,
  },
  glasscannon: {
    id: 'glasscannon',
    name: 'GLASS CANNON',
    gain: '+60% damage',
    cost: 'One touch does double damage to you',
    color: 0xff3ea5,
  },
};

export const BOON_IDS = Object.keys(BOONS) as BoonId[];

/** Tuning, kept out of the sim so the balance runner can sweep it. */
export const BOON = {
  vampirismHeal: 0.55,
  vampirismDropPenalty: 0.25,
  thornsDamage: 34,
  thornsIframeMult: 0.72,
  overchargeCooldown: 0.55,
  overchargeTaken: 1.2,
  momentumBonus: 1.4,
  momentumPenalty: 0.75,
  /** Below this speed you count as standing still. */
  momentumStillSpeed: 12,
  greedGold: 2,
  greedEnemyHp: 1.2,
  hungerXp: 1.5,
  hungerDrain: 1.6,
  fortressTaken: 0.65,
  fortressSpeed: 0.8,
  splinterPierce: 2,
  splinterSpeed: 0.78,
  /** Fraction of max health below which EXECUTE kills outright. */
  executeThreshold: 0.16,
  resonanceEvery: 4,
  resonanceRate: 0.85,
  frenzyRate: 1.55,
  frenzyBelow: 0.5,
  frenzyMaxHp: 0.75,
  glassDamage: 1.6,
  glassTaken: 2,
} as const;
