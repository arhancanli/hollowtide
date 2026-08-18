import type { PlayerStats, WeaponInstance } from '../sim/types.js';
import { WEAPONS } from './weapons.js';
import { dpow } from '@arcade/core';

/**
 * Difficulty that answers the BUILD, not just the clock.
 *
 * Playtest verdict, from actual humans: "after some point it's impossible to
 * die." That is correct, and every previous attempt to fix it failed for the
 * same structural reason — enemy hit points, speed and damage were all pure
 * functions of TIME. Player power is not. It is multiplicative and unbounded:
 * weapon levels times passive stacks times evolutions times Forge tracks. A
 * curve keyed to the clock is a fixed target that a compounding build walks
 * straight past, and no amount of steepening fixes that, because steepening
 * enough to challenge a strong build annihilates a weak one at the same minute.
 *
 * So threat now reads the build. A player who drafts well meets a swarm that
 * has kept pace with them; a player who drafts badly is not punished for it.
 * Two players at 6:00 with very different builds get very different fights,
 * which is the thing a time-only curve can never do.
 *
 * THE RULE THAT MATTERS: this must never make upgrading feel pointless. The
 * scaling is deliberately SUB-LINEAR — power grows faster than the answer to
 * it, so every upgrade is still a real gain, just not an infinite one. You
 * always end up stronger than you were; the world simply stops being trivial.
 */

/**
 * How strong this build actually is, as a multiple of a fresh run.
 *
 * Deliberately built from what the player CHOSE — damage, rate, area, weapon
 * levels, evolutions — and not from kills or level, which measure how long they
 * have been alive rather than how dangerous they are.
 */
export function powerIndex(p: PlayerStats, weapons: readonly WeaponInstance[]): number {
  // Offence multiplies, exactly as the real damage pipeline does. Area gets a
  // square root because coverage converts to kills with diminishing returns.
  const offence = p.damageMult * p.fireRateMult * Math.sqrt(p.areaMult);

  let levels = 0;
  let evolutions = 0;
  for (const w of weapons) {
    levels += w.level;
    if (WEAPONS[w.id].evolved) evolutions++;
  }

  // An evolution is worth far more than the levels that bought it — it is the
  // single largest step change available, so it has to register as one.
  return offence * (1 + levels * 0.055) * (1 + evolutions * 0.30);
}

/**
 * What a NORMAL build has at time t.
 *
 * This is the correction to the first version, and the error is worth stating
 * because it is easy to make: I scaled threat by ABSOLUTE power. But every
 * player's power grows — levelling a weapon is not an achievement, it is just
 * playing — so absolute scaling taxed ordinary progression and the median run
 * collapsed from 252s to 98s while the runaway builds it was aimed at barely
 * noticed.
 *
 * Threat should answer how far AHEAD of the curve a build is, not how far along
 * it. A player tracking this line meets exactly the game that was tuned for
 * them; only a build that has genuinely broken away gets a bigger swarm. That
 * is also what makes it feel earned rather than punitive: the game pushes back
 * precisely when you have done something clever.
 */
export function expectedPower(t: number): number {
  return 1 + t / 34;
}

/**
 * Enemy hit-point multiplier contributed by the player's own power.
 *
 * The exponent is the whole design. At 1.0 the world would exactly cancel every
 * upgrade and the game would be unwinnable and pointless. At 0 it is today's
 * bug. 0.72 means a build running 10x ahead of the curve meets enemies roughly
 * 5.2x tougher — still far better off than it was, and still working for it.
 */
const POWER_EXP = 0.72;
/**
 * Ceiling, so a runaway build meets a hard limit rather than an ever-receding
 * one. Without it a 100x build would face 17x enemies and every kill would take
 * visibly too long, which reads as the game being broken rather than hard.
 */
const POWER_CAP = 9;

export function threatFromPower(power: number, t: number): number {
  const excess = power / expectedPower(t);
  if (excess <= 1) return 1;
  return Math.min(POWER_CAP, dpow(excess, POWER_EXP));
}

/**
 * Extra spawn pressure from power, applied to the density target.
 *
 * Much gentler than the hit-point term. A strong build should meet a THICKER
 * crowd, but density is the most lethal lever in the game and the most
 * expensive to render, so it moves a little where hit points move a lot.
 */
export function densityFromPower(power: number, t: number): number {
  const excess = power / expectedPower(t);
  if (excess <= 1) return 1;
  return Math.min(1.75, dpow(excess, 0.30));
}

/**
 * Share of a strong build's power that translates into enemy DAMAGE.
 *
 * Deliberately the smallest of the three, and capped hard. Scaling incoming
 * damage with the player's offence punishes them for building offence, which
 * is the exact feel-bad this system exists to avoid — the answer to a strong
 * build is more to kill and tougher things to kill, not bigger numbers hitting
 * a health bar that never grew.
 */
export function damageFromPower(power: number, t: number): number {
  const excess = power / expectedPower(t);
  if (excess <= 1) return 1;
  return Math.min(1.3, dpow(excess, 0.18));
}
