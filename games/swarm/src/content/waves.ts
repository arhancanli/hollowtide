import { dpow } from '@arcade/core';
import type { EnemyKind } from './balance.js';

/**
 * The first 90 seconds are hand-scripted; after that the director goes
 * procedural.
 *
 * You cannot get the intended emotional shape out of a spawn curve. The beats
 * that matter are load-bearing and are therefore authored, not emergent:
 *
 *   0.8s   weapon auto-fires with no input — the game demos its own loop
 *   ~11s   first level-up (driven by the XP table, not here)
 *   25s    first elite: the first target that is not disposable
 *   40s    engineered near-death — a closing ring, survivable but frightening
 *   50s    relief, so the 40s spike reads as a spike
 *   55s    a herald on the horizon: "it gets bigger than this"
 */

/**
 * Keyframes of target concurrent enemies. Linearly interpolated.
 *
 * Raised across the board after measurement. Enemies spawn on a ring outside
 * the view and have to walk in, so the density number is not what is on screen
 * — it is the size of the inbound pipeline. The first pass starved the player
 * of targets between the opening trio dying and the ring arriving.
 */
/**
 * These are now ON-SCREEN counts, not live counts.
 *
 * The spawner used to fill against every body alive, and 68-84% of those were
 * trailing off screen — so the same numbers now represent roughly 3-5x more
 * actual pressure. Rescaled accordingly, or the fix for an empty screen becomes
 * a fix that kills everyone in ninety seconds.
 */
export const DENSITY: ReadonlyArray<{ t: number; alive: number }> = [
  { t: 0, alive: 3 },
  { t: 4, alive: 5 },
  { t: 10, alive: 10 },
  { t: 25, alive: 15 },
  { t: 40, alive: 18 },
  { t: 50, alive: 14 }, // relief window
  { t: 60, alive: 17 },
  { t: 90, alive: 26 },
];

/**
 * After the script ends, density climbs — and the climb itself accelerates.
 *
 * A linear ramp meant a competent player's upgrades outgrew the pressure and
 * the run flattened into a victory lap. The quadratic term is what keeps the
 * later minutes rising faster than the player does.
 */
/**
 * Gentler than it was, on purpose.
 *
 * Player power plateaus — weapons cap at level 5 and passives cap out — so if
 * density keeps accelerating past that plateau every run ends at the same
 * ~2 minutes regardless of skill or build, which is exactly what 960 measured
 * runs showed. The content needs 4-6 minutes to express itself.
 */
/**
 * Density plateaus; late threat comes from durability and mechanics instead.
 *
 * Once the spawner started counting on-screen enemies, raw count became by far
 * the most lethal lever — and stacking it into the late game just produced a
 * hard wall at ~180s that nobody crossed. Escalation past that point is carried
 * by compounding enemy HP, rising speed, and the LANTERN's ranged pressure,
 * which threaten a strong player without making the screen unreadable.
 */
// Sustained pressure carries the late game; bursts punctuate it. Forensics
// showed the opposite shape — the player comfortably ahead on sustained DPS
// (clear-time 0.52s) and then deleted by a single closing ring.
export const PROCEDURAL_RAMP = 0.17;
export const PROCEDURAL_ACCEL = 0.0006;
export const PROCEDURAL_CAP = 165;

/**
 * Threat scaling — the other half of "later rounds should bite".
 *
 * Density alone cannot do it: past a point more 10hp drifters just means more
 * things dying to the same shot. Scaling enemy hit points is what stops damage
 * upgrades from trivialising the late game, and it is the standard fix in the
 * genre. Deliberately flat until 45s so the opening minute stays a power
 * fantasy, exactly as specced.
 */
export const THREAT_FLAT_UNTIL = 55;

/**
 * Early enemy-HP compounding, per minute, until t=150.
 *
 * 1.16 was measured as the wrong side of the crossover. Player DPS against
 * arriving enemy HP ran 81 v 121 at 60-90s and 163 v 184 at 90-120s — the
 * player is BEHIND for the first two minutes — and only crosses at 392 v 330
 * in the 120-150s window. Median death landed at 140s, which is to say players
 * were dying in the same ten seconds their build would have come online. Past
 * that point they are 3.1x ahead.
 *
 * So this is not a slope, it is a wall with the whole game behind it. Easing
 * the early rate is what lets a median run reach its own payoff; the steep
 * post-150s rate is untouched, because that is what keeps the back half from
 * becoming the deletion bubble this file already warns about.
 */
const EARLY_HP_RATE = 1.085;

/**
 * Late compounding, per minute, past t=150.
 *
 * Raised with the early rate lowered, and the pairing is the point. Easing the
 * opening let a median run reach its own payoff; left alone, it also handed the
 * back half to the player — 6 of 16 fully-upgraded runs survived seven minutes,
 * which is the deletion bubble this file has warned about since the first pass.
 *
 * The two rates now do different jobs: the early one decides whether you GET a
 * build, the late one decides whether the build ends. Tuning them together is
 * the only way to move one without spoiling the other.
 */
const LATE_HP_RATE = 1.62;

/**
 * Enemy max HP multiplier at time t — COMPOUNDING, not linear.
 *
 * Player damage is multiplicative (levels x weapon levels x POWER stacks x
 * evolutions) and measured at 71 DPS in the first 30s against 205,874 DPS in
 * the last 30s of a ten-minute run — a 2,900x climb. Linear enemy HP topped out
 * at 3.96x. Nothing linear can stay in tension with something exponential, so
 * this compounds too. Still flat for the first 45 seconds.
 */
export function threatHp(t: number): number {
  if (t <= THREAT_FLAT_UNTIL) return 1;
  // PIECEWISE, from death forensics. A single compounding rate cannot serve
  // both ends: gentle enough for the 30-90s window (where 10% of runs were
  // dying) is far too gentle at 4 minutes, and steep enough for 4 minutes kills
  // everyone at 80 seconds. So it stays shallow until 150s, then accelerates —
  // which is exactly where the player's multiplicative power starts to run away.
  const early = dpow(EARLY_HP_RATE, (Math.min(t, 150) - THREAT_FLAT_UNTIL) / 60);
  if (t <= 150) return early;
  return early * dpow(LATE_HP_RATE, (t - 150) / 60);
}

/**
 * Enemy speed multiplier at time t.
 *
 * Capped so drifters top out around 122 against the player's 140 — close
 * enough that escape costs commitment, far enough that it stays possible.
 * Enemies that catch you are the stalker's job, not the whole swarm's.
 */
export function threatSpeed(t: number): number {
  if (t <= 60) return 1;
  // Cap raised from 1.70, which was reached at t=360 — six minutes before a
  // ten-minute run ends. Tops out around 2.3x at 10:00.
  return Math.min(2.35, 1 + ((t - 60) / 60) * 0.15);
}

/** Enemy contact damage multiplier at time t. */
export function threatDamage(t: number): number {
  if (t <= 60) return 1;
  // Cap raised from 1.80, which was reached at t=496.
  return Math.min(2.4, 1 + ((t - 60) / 60) * 0.10);
}

/**
 * How much of the crowding penalty is active at time t.
 *
 * Zero for the first 45 seconds and fully on by 105s. The opening minute
 * measured as the best-paced part of the game and is meant to be a power
 * fantasy; the crowding rule exists to close the LATE-game ceiling, so applying
 * it from t=0 just moved the problem from "cannot die" to "dies at 70 seconds".
 */
export function crowdFactor(t: number): number {
  if (t <= 75) return 0;
  // Full strength at ~3:30, not 2:05. It was landing inside the same thirteen
  // seconds as the splitter introduction, the LANCER and the first elite wave —
  // see the spacing note above.
  return Math.min(1, (t - 75) / 135);
}

/** First recurring elite pack, and the gap between them thereafter. */
export const ELITE_WAVE_START = 164;
export const ELITE_WAVE_PERIOD = 32;
/** First recurring closing ring after the scripted one at 40s. */
export const SURGE_START = 178;
export const SURGE_PERIOD = 58;

/** Visible, unbounded pressure tier. A new tier begins every minute. */
export function threatTierAt(t: number): number {
  return Math.max(1, 1 + Math.floor(Math.max(0, t) / 60));
}

/**
 * Punctuation accelerates with the run instead of settling into a fixed loop.
 * The floors preserve readability and frame budget; late difficulty comes from
 * a denser rhythm of authored threats, not an unreadable wall of bodies.
 */
export function eliteWavePeriodAt(t: number): number {
  return Math.max(20, ELITE_WAVE_PERIOD - Math.max(0, threatTierAt(t) - 2) * 2);
}

export function surgePeriodAt(t: number): number {
  return Math.max(38, SURGE_PERIOD - Math.max(0, threatTierAt(t) - 2) * 3);
}

export type ScriptEventKind =
  | { type: 'spawn'; kind: EnemyKind; count: number }
  /** A tight closing ring around the player — the engineered near-death. */
  | { type: 'surge'; kind: EnemyKind; count: number; radius: number };

export interface ScriptEvent {
  t: number;
  event: ScriptEventKind;
}

export const SCRIPT: ReadonlyArray<ScriptEvent> = [
  { t: 25, event: { type: 'spawn', kind: 'elite', count: 1 } },
  // Sized to frighten, not to kill. It lands on top of the density ramp, so a
  // ring big enough to look survivable on paper is a wipe in practice.
  { t: 40, event: { type: 'surge', kind: 'drifter', count: 18, radius: 340 } },
  { t: 55, event: { type: 'spawn', kind: 'herald', count: 1 } },
  { t: 70, event: { type: 'spawn', kind: 'elite', count: 2 } },
  { t: 85, event: { type: 'spawn', kind: 'herald', count: 3 } },
];

/** Density at time t, in seconds. */
export function densityAt(t: number): number {
  const last = DENSITY[DENSITY.length - 1]!;
  if (t >= last.t) {
    const dt = t - last.t;
    return Math.min(PROCEDURAL_CAP, last.alive + dt * PROCEDURAL_RAMP + dt * dt * PROCEDURAL_ACCEL);
  }
  for (let i = 1; i < DENSITY.length; i++) {
    const b = DENSITY[i]!;
    if (t <= b.t) {
      const a = DENSITY[i - 1]!;
      const span = b.t - a.t;
      const f = span <= 0 ? 0 : (t - a.t) / span;
      return a.alive + (b.alive - a.alive) * f;
    }
  }
  return last.alive;
}

/** First ambient stalker. Well clear of the authored opening minute. */
export const STALKER_START = 68;
/**
 * SPACED, after measuring where players actually die.
 *
 * SPLITTER at 130, LANCER at 132, ELITE_WAVE at 138 and crowdFactor reaching
 * full strength at 125 were four escalations inside thirteen seconds, and the
 * deaths clustered there exactly: median 136s for a competent player, with only
 * 12% of runs reaching three minutes. A comment in this file already claimed
 * these had been "pushed apart" from the boss — they were two seconds apart.
 *
 * Each of the four now owns its own beat, so a player who loses can tell WHICH
 * thing killed them. Difficulty that arrives all at once does not read as
 * difficulty, it reads as the game breaking.
 */
export const SPLITTER_START = 152;
export const BOMBER_START = 174;
/** The ranged kind. After the measured 150-180s mortality band, not inside it. */
export const LANTERN_START = 192;
/**
 * The late roster.
 *
 * Everything above saturates by t=204 — every `Math.min` in `ambientKind` has
 * hit its clamp — so the swarm's composition was mathematically constant from
 * then until the run ended, however long that was. These three keep the mix
 * moving out to ~7 minutes, and each is introduced with room around it rather
 * than stacked on a boss beat.
 */
export const BULWARK_START = 148;
export const WEAVER_START = 206;
export const BURROWER_START = 268;

/**
 * Weighted kind selection for ambient (non-scripted) spawns.
 *
 * The first 60 seconds are pure drifters on purpose — the opening is a power
 * fantasy and mixing threats into it would blunt the 40s scare. Everything
 * that raises the ceiling arrives after that beat has landed.
 */
export function ambientKind(t: number, roll: number): EnemyKind {
  if (t < 60) return 'drifter';

  /**
   * HERALD and STALKER are capped far lower than they were.
   *
   * Measured across the harness: herald accounts for 24.1% of all damage taken
   * and stalker 19.1% — 43% from the two kinds a kiting player structurally
   * cannot outrun (stalker at 168 is faster than the player's 140 by design,
   * herald at 98 closes while you collect). Both reached full strength inside
   * exactly the 90-150s window where every run was ending. They are meant to be
   * threats you answer, not a tax you cannot pay.
   */
  const heraldChance = Math.min(0.115, (t - 68) * 0.0032);
  // Capped lower than before. Stalkers outrun the player, so an unavoidable
  // share of them flattens skill: measured novice and expert both died ~110s
  // because neither could escape. They should be a threat you answer, not a tax.
  const stalkerChance = t < STALKER_START ? 0 : Math.min(0.075, (t - STALKER_START) * 0.0018);
  // Splitters and bombers arrive later still. Both change how you fight rather
  // than how hard you fight: one punishes clearing a lane, the other punishes
  // killing things while standing on top of them.
  const splitterChance = t < SPLITTER_START ? 0 : Math.min(0.16, (t - SPLITTER_START) * 0.004);
  const bomberChance = t < BOMBER_START ? 0 : Math.min(0.14, (t - BOMBER_START) * 0.004);

  const lanternChance = t < LANTERN_START ? 0 : Math.min(0.17, (t - LANTERN_START) * 0.0035);

  // The late roster.
  //
  // BULWARK's cap is far below the others and that is deliberate. Spawn share is
  // not screen share: it has ~19x a drifter's hit points, so it lives ~19x as
  // long, and a 12% spawn rate produced a screen that was visibly MOSTLY
  // bulwarks at seven minutes. Anything durable has to be rarer than its
  // intended presence, not equal to it.
  const bulwarkChance = t < BULWARK_START ? 0 : Math.min(0.055, (t - BULWARK_START) * 0.0008);
  const weaverChance = t < WEAVER_START ? 0 : Math.min(0.055, (t - WEAVER_START) * 0.0009);
  // BURROWER scales hardest of the three. It is the only enemy a maxed build
  // cannot delete — untargetable while it travels — so it is what keeps the
  // late game loseable for a player whose damage has run away.
  const burrowerChance = t < BURROWER_START ? 0 : Math.min(0.105, (t - BURROWER_START) * 0.0016);

  /**
   * Normalise, and keep a drifter floor.
   *
   * These were eight independent `Math.min` clamps summed into a running
   * accumulator, which works only while the total stays under 1. Adding three
   * more kinds pushed it to 1.027 at t=431 — so drifters, the tide this entire
   * game is played against, stopped spawning ENTIRELY, and BURROWER, last in
   * the chain, silently received 1% instead of its intended 7%. No error, no
   * warning: the last branch just quietly starves.
   *
   * Scaling proportionally keeps the mix the tuning intended and makes the
   * failure impossible rather than merely fixed at today's numbers.
   */
  const special =
    lanternChance +
    stalkerChance +
    heraldChance +
    splitterChance +
    bomberChance +
    bulwarkChance +
    weaverChance +
    burrowerChance;
  const budget = 1 - DRIFTER_FLOOR;
  const k = special > budget ? budget / special : 1;

  let acc = lanternChance * k;
  if (roll < acc) return 'lantern';
  acc += stalkerChance * k;
  if (roll < acc) return 'stalker';
  acc += heraldChance * k;
  if (roll < acc) return 'herald';
  acc += splitterChance * k;
  if (roll < acc) return 'splitter';
  acc += bomberChance * k;
  if (roll < acc) return 'bomber';
  acc += bulwarkChance * k;
  if (roll < acc) return 'bulwark';
  acc += weaverChance * k;
  if (roll < acc) return 'weaver';
  acc += burrowerChance * k;
  if (roll < acc) return 'burrower';
  return 'drifter';
}

/**
 * Share of ambient spawns that stay plain drifters, however crowded the roster
 * gets. The swarm has to still read as a swarm.
 */
const DRIFTER_FLOOR = 0.3;
