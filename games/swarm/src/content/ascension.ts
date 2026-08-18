/**
 * The ascension ladder — difficulty the player CHOOSES.
 *
 * Every retention system in this game so far makes the player stronger: the
 * Forge, the characters, the evolutions. That curve terminates. Once you own
 * everything there is nothing left to want, and the measured meta is roughly 19
 * runs deep — which is a fortnight, not a habit.
 *
 * This is the other direction, and it is the one that does not terminate: a
 * ladder of harder games, each unlocked by beating the last, each paying more.
 * It is the standard roguelite answer (Hades' Heat, Slay the Spire's Ascension,
 * Vampire Survivors' Hyper) and it works because the player opts in. Difficulty
 * you chose is a challenge; difficulty imposed is a complaint.
 *
 * DESIGN RULES:
 *
 * 1. Every tier NAMES what it changed. "Ascension 4" tells a player nothing;
 *    "SWARMING — twenty percent more of them" tells them how to play differently.
 * 2. Tiers are cumulative and ordered so the early ones change tactics and the
 *    late ones change builds. Speed and density are answerable by movement;
 *    scarcity and fragility force different draft priorities.
 * 3. Unlock by SURVIVING, not by winning — there is no win. The threshold is
 *    deliberately below the measured median so the next rung is always visible.
 * 4. The gold multiplier must make the harder run the better run economically,
 *    or the ladder is a vanity setting nobody climbs twice.
 * 5. NO tier removes the player's agency. Nothing here takes away banishes,
 *    hides information, or makes a run unwinnable — harder, never unfair.
 */

export interface AscensionTier {
  level: number;
  name: string;
  /** One line, stating exactly what got worse. */
  effect: string;
  /** Seconds a player must survive at the previous tier to unlock this one. */
  unlockAt: number;
  /** Multiplier on gold earned, cumulative with the tier itself. */
  gold: number;
}

/**
 * Thresholds are FLAT and modest, not rising.
 *
 * The first version raised the bar with every rung (150s, 165s, 180s...) while
 * each rung also cut survival time hard — measured, tier 2 dropped the median
 * run from 281s to 85s against its own 165s unlock. The ladder was
 * mathematically unclimbable past the second rung, which is the worst possible
 * failure for a progression system: it looks like a chase and is actually a
 * wall. A flat 135s against a median that stays well above it means every rung
 * is reachable by a player who is improving.
 */
export const ASCENSIONS: readonly AscensionTier[] = [
  { level: 0, name: 'STANDARD', effect: 'The tide as it comes', unlockAt: 0, gold: 1 },
  { level: 1, name: 'RELENTLESS', effect: 'Everything moves 8% faster', unlockAt: 135, gold: 1.2 },
  { level: 2, name: 'HARDENED', effect: 'Everything has 15% more health', unlockAt: 135, gold: 1.45 },
  { level: 3, name: 'SCARCITY', effect: 'Health drops are 30% rarer', unlockAt: 135, gold: 1.75 },
  { level: 4, name: 'SWARMING', effect: '12% more of them, always', unlockAt: 135, gold: 2.1 },
  { level: 5, name: 'BRUTAL', effect: 'Every hit takes 15% more', unlockAt: 135, gold: 2.5 },
  { level: 6, name: 'HUNTED', effect: 'The bosses arrive early', unlockAt: 135, gold: 3 },
  { level: 7, name: 'FRAGILE', effect: 'You begin with 15% less health', unlockAt: 135, gold: 3.6 },
  { level: 8, name: 'THE DEEP', effect: 'All of it, and the tide never slows', unlockAt: 135, gold: 4.5 },
];

export const MAX_ASCENSION = ASCENSIONS.length - 1;

/**
 * Everything a tier changes, accumulated from level 0 up to `level`.
 *
 * Returned as one object rather than queried per-tier so the simulation reads a
 * flat set of multipliers and never has to know the ladder exists.
 */
export interface AscensionMods {
  enemySpeed: number;
  enemyHp: number;
  enemyDamage: number;
  density: number;
  healthDropRate: number;
  /** Multiplier on boss schedule times. Below 1 means they arrive sooner. */
  bossTiming: number;
  startingHp: number;
  gold: number;
}

export function ascensionMods(level: number): AscensionMods {
  const n = Math.max(0, Math.min(MAX_ASCENSION, Math.floor(level)));
  const m: AscensionMods = {
    enemySpeed: 1,
    enemyHp: 1,
    enemyDamage: 1,
    density: 1,
    healthDropRate: 1,
    bossTiming: 1,
    startingHp: 1,
    gold: ASCENSIONS[n]!.gold,
  };
  if (n >= 1) m.enemySpeed *= 1.08;
  if (n >= 2) m.enemyHp *= 1.15;
  if (n >= 3) m.healthDropRate *= 0.7;
  if (n >= 4) m.density *= 1.12;
  if (n >= 5) m.enemyDamage *= 1.15;
  if (n >= 6) m.bossTiming *= 0.9;
  if (n >= 7) m.startingHp *= 0.85;
  // THE DEEP stacks a second helping of the two levers that shape the run most,
  // rather than introducing a ninth rule nobody would remember.
  if (n >= 8) {
    m.enemyHp *= 1.15;
    m.density *= 1.08;
    m.enemySpeed *= 1.05;
  }
  return m;
}

/** The tier a player has earned, given the best time they reached at each. */
export function highestUnlocked(bestByAscension: Readonly<Record<string, number>>): number {
  let unlocked = 0;
  for (let i = 1; i <= MAX_ASCENSION; i++) {
    const prevBest = bestByAscension[String(i - 1)] ?? 0;
    if (prevBest >= ASCENSIONS[i]!.unlockAt) unlocked = i;
    else break;
  }
  return unlocked;
}
