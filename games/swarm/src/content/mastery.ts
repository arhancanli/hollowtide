import type { PlayerStats } from '../sim/types.js';

/**
 * Per-character mastery — a separate chase for every character.
 *
 * The Forge is one shared pool: buy MIGHT and every character has it, so once
 * it is full the roster is six skins on the same progression. Mastery is the
 * opposite shape. It is earned by playing a SPECIFIC character and only ever
 * helps that one, so a player who has exhausted the Forge still has five more
 * curves to climb, and picking WARD for a run means something afterwards.
 *
 * It is also the thing that makes trying a new character feel like a beginning
 * rather than a downgrade: your ECLIPSE is mastery 7 and your NOVA is mastery
 * 0, which is a reason to play NOVA, not a reason to avoid it.
 *
 * WHY THIS IS SAFE TO GRANT, when handing out permanent power usually is not:
 * threat now scales with the build's power (see content/threat.ts), so mastery
 * does not make the game easier — it makes a HARDER game survivable. The player
 * feels stronger and the world answers. Without that system this would be a
 * straight difficulty giveaway; with it, it is a difficulty ceiling raise.
 */

/** Mastery experience for finishing a run with a character. */
export function masteryFor(time: number, kills: number, level: number, goldMult: number): number {
  // Weighted toward TIME survived, like gold, because that is the metric the
  // portals measure and the one worth teaching players to optimise. The
  // ascension multiplier carries over, so a harder run teaches more.
  // Kills are weighted DOWN relative to time. At 0.12 they contributed 720 of
  // 1,120 experience in a four-minute run — so mastery measured how wide your
  // build swept, not how long you lasted, and one character maxed in eleven
  // runs. Time is both the metric the portals reward and the one a player has
  // to genuinely improve at.
  return Math.floor((time * 0.85 + kills * 0.05 + level * 4) * Math.min(2.5, goldMult));
}

/** Total experience needed to go from `level` to `level + 1`. */
export function masteryStep(level: number): number {
  // ~16,500 experience for one character at ~650 a run: roughly 25 runs each,
  // 150 across the roster. Long enough to be a tail, short enough that the
  // first two levels arrive while the player still remembers choosing them.
  return 300 + level * 300;
}

export const MASTERY_MAX = 10;

/** Level and progress for a raw experience total. */
export function masteryLevel(xp: number): { level: number; into: number; need: number } {
  let level = 0;
  let remaining = Math.max(0, xp);
  while (level < MASTERY_MAX) {
    const step = masteryStep(level);
    if (remaining < step) return { level, into: remaining, need: step };
    remaining -= step;
    level++;
  }
  return { level: MASTERY_MAX, into: 0, need: 0 };
}

/**
 * Applied at run start, on top of the character and the Forge.
 *
 * Deliberately modest and split across offence AND survivability, so mastery
 * never turns a character into a different one — it sharpens what that
 * character already is rather than papering over its weakness.
 */
export function applyMastery(p: PlayerStats, level: number): void {
  const n = Math.max(0, Math.min(MASTERY_MAX, level));
  if (n === 0) return;
  p.damageMult *= 1 + 0.022 * n;
  p.maxHp += 4 * n;
  p.hp += 4 * n;
}

/** Total experience to take one character from nothing to mastery 10. */
export function masteryTotalCost(): number {
  let sum = 0;
  for (let i = 0; i < MASTERY_MAX; i++) sum += masteryStep(i);
  return sum;
}
