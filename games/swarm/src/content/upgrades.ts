import type { PlayerStats } from '../sim/types.js';
import type { World } from '../sim/world.js';
import { MAX_WEAPONS, STARTER_POOL, WEAPONS, type WeaponId } from './weapons.js';

/**
 * Level-up cards.
 *
 * Three kinds share one pool: a new weapon, a level in a weapon you already
 * hold, or a passive. Evolutions are a fourth kind that only appears when
 * earned, and they always take a slot on the card draw when available.
 *
 * The design constraint that matters: the three options must feel different in
 * KIND, not just in numbers. A draw of three passives is a boring turn, and a
 * boring turn is the moment a player decides they have seen the game.
 */

export type CardKind = 'weapon' | 'passive' | 'evolution';

export interface Card {
  id: string;
  kind: CardKind;
  /**
   * Draw weight.
   *
   * Levelling a weapon you already hold is weighted far above starting a new
   * one. Uniform draws measured terribly: with 7 weapons and 7 passives in the
   * pool, the specific card needed to finish a line almost never appeared, so
   * across 960 runs players held 4.4 weapons at ~2 levels each and 2% ever
   * reached an evolution. Weighting toward what you already own is what makes a
   * build converge into a build instead of a shallow spread.
   */
  weight: number;
  name: string;
  /** One short line. If it needs two, the card is too complicated. */
  desc: string;
  /**
   * The evolution requirement, as its own field.
   *
   * This used to be appended onto `desc` with an arrow, which made the single
   * most important line on the card the longest one — "Blast rings outward →
   * SUPERNOVA at Lv 5 + VITALITY ✓" wraps to three lines on a phone and spilled
   * straight out of the bottom of the card. Two different kinds of information
   * were sharing one string: what this upgrade DOES, and what it BECOMES. They
   * are read at different moments and deserve different weight.
   */
  note?: string;
  /** True when the player already holds the passive the evolution needs. */
  noteMet?: boolean;
  color: number;
  /** Shown as "Lv 3" on the card, or blank for a fresh pick. */
  levelLabel: string;
  weaponId?: WeaponId;
  evolveTo?: WeaponId;
  /**
   * Bare passive id, WITHOUT the `p:` card prefix.
   *
   * Carried explicitly because the card id and the stack key are different
   * namespaces. Storing stacks under the prefixed id silently broke both the
   * max-stack cap (passives became infinitely stackable) and every evolution
   * requirement, since those look the passive up by its bare id.
   */
  passiveId?: string;
  apply?: (p: PlayerStats) => void;
}

export interface PassiveDef {
  id: string;
  name: string;
  desc: string;
  color: number;
  maxStacks: number;
  apply: (p: PlayerStats) => void;
}

/**
 * FOUR passives, not seven.
 *
 * SWIFT, SPLIT and MAGNET were measured to make the player WORSE than ignoring
 * them, and two of the three sat on the fixed level-1 draw — so a new player's
 * very first decision was between one good option and two traps. Cutting them
 * also produces a clean 1:1 map of passive to evolution (POWER->STORM,
 * REACH->VORTEX, VITAL->SUPERNOVA, RAPID->TEMPEST): one rule to learn instead
 * of four arbitrary pairings, and every passive is now an evolution key.
 */
export const PASSIVES: readonly PassiveDef[] = [
  {
    id: 'damage',
    name: 'POWER',
    desc: '+25% damage',
    color: 0xff5c6e,
    maxStacks: 8,
    apply: (p) => {
      p.damageMult *= 1.25;
    },
  },
  {
    id: 'firerate',
    name: 'RAPID',
    desc: '+20% attack speed',
    color: 0xffd23a,
    maxStacks: 6,
    apply: (p) => {
      p.fireRateMult *= 1.2;
    },
  },
  {
    id: 'area',
    name: 'REACH',
    desc: '+20% area',
    color: 0x9ad6ff,
    maxStacks: 5,
    apply: (p) => {
      p.areaMult *= 1.2;
    },
  },
  {
    id: 'vitality',
    name: 'VITAL',
    desc: '+25 max health',
    color: 0xff7ab8,
    maxStacks: 6,
    apply: (p) => {
      p.maxHp += 25;
      p.hp = Math.min(p.maxHp, p.hp + 25);
    },
  },
];

const PASSIVES_BY_ID = new Map(PASSIVES.map((p) => [p.id, p]));

/**
 * The endless tier: cards with no maximum, so the pool can never run dry.
 *
 * Every capped option in the game sums to ~56 picks — 6 weapon slots x 5 levels,
 * 4 evolutions, 25 passive stacks. Past that `drawCards()` returned an empty
 * array and `checkLevelUp()` recursed, so the level counter ticked, the chord
 * and the shockwave played, and NOTHING was offered. Measured across 15 builds:
 * 5-11 of these silent level-ups per long run, first one landing at ~390s, and
 * three of six traced seeds received zero further picks between that point and
 * death. The card screen degrading 3 -> 2 -> 1 -> none is the same cause.
 *
 * Deliberately modest, and deliberately only ONE of the three is raw offence.
 * The reason a late run stops being loseable is that the player deletes
 * everything before it reaches them, so an endless damage escalator would make
 * that worse. Health and pickup range extend the run without accelerating it.
 *
 * Low weight: these sit in the pool from level 2 but almost never win a draw
 * while real choices remain. They are what is left when nothing else is.
 */
const REFINEMENTS: readonly PassiveDef[] = [
  {
    id: 'hone',
    name: 'HONE',
    desc: '+6% damage',
    color: 0xc9a15e,
    maxStacks: Number.POSITIVE_INFINITY,
    apply: (p) => {
      p.damageMult *= 1.06;
    },
  },
  {
    id: 'temper',
    name: 'TEMPER',
    desc: '+15 max health',
    color: 0xc9a15e,
    maxStacks: Number.POSITIVE_INFINITY,
    apply: (p) => {
      p.maxHp += 15;
      p.hp = Math.min(p.maxHp, p.hp + 15);
    },
  },
  {
    id: 'grasp',
    name: 'GRASP',
    desc: '+12% pickup range',
    color: 0xc9a15e,
    maxStacks: Number.POSITIVE_INFINITY,
    apply: (p) => {
      p.pickupRadius *= 1.12;
    },
  },
];

function passiveCard(def: PassiveDef, stacks: number, completes?: string): Card {
  return {
    id: `p:${def.id}`,
    kind: 'passive',
    name: def.name,
    desc: completes ? `${def.desc}  ·  unlocks ${completes}` : def.desc,
    color: def.color,
    levelLabel: stacks > 0 ? `Lv ${stacks + 1}` : '',
    weight: 1,
    passiveId: def.id,
    apply: def.apply,
  };
}

function weaponCard(id: WeaponId, level: number, hasKey = false): Card {
  const def = WEAPONS[id];
  // State the evolution rule on the card. It existed nowhere in the game, so a
  // player following what the cards rewarded reached an evolution in 0 of 30
  // measured runs. Absence of the line is also how MINES/AURA/SEEKER teach that
  // they dead-end.
  const desc = level > 0 ? def.desc : `NEW · ${def.desc}`;
  let note: string | undefined;
  if (def.evolvesInto && def.evolveWith) {
    const target = WEAPONS[def.evolvesInto].name;
    const need = def.evolveStacks ?? 1;
    const key = need > 1 ? `${def.evolveWith.toUpperCase()} ×${need}` : def.evolveWith.toUpperCase();
    note = `${target} · Lv ${def.maxLevel} + ${key}`;
  }
  return {
    id: `w:${id}`,
    kind: 'weapon',
    name: def.name,
    desc,
    note,
    noteMet: hasKey,
    color: def.color,
    levelLabel: level > 0 ? `Lv ${level + 1}` : '',
    // Owned weapons dominate the draw so lines actually finish.
    weight: level > 0 ? 3.2 : 1.4,
    weaponId: id,
  };
}

function evolutionCard(base: WeaponId): Card {
  const def = WEAPONS[base];
  const target = WEAPONS[def.evolvesInto!];
  return {
    id: `e:${base}`,
    kind: 'evolution',
    name: target.name,
    desc: `EVOLVE · ${target.desc}`,
    color: target.color,
    levelLabel: '',
    weight: 100,
    weaponId: base,
    evolveTo: target.id,
  };
}

/**
 * The level 1 draw is FIXED, not random.
 *
 * It hard-guarantees the three-different-kinds-of-choice rule on the single
 * most important decision in the game, and guarantees a flashy new weapon is on
 * the table. Most players take ORBIT, and the next ten seconds get visibly
 * better — which is exactly the payoff we want them to feel for having made a
 * choice at all. Randomise from level 2 onward.
 */
export const FIRST_DRAW: readonly string[] = ['w:orbit', 'p:damage', 'p:area'];

export const UPGRADES_BY_ID: ReadonlyMap<string, Card> = new Map<string, Card>([
  ['w:orbit', weaponCard('orbit', 0)],
  ['p:damage', passiveCard(PASSIVES_BY_ID.get('damage')!, 0)],
  ['p:area', passiveCard(PASSIVES_BY_ID.get('area')!, 0)],
]);

/** Everything currently legal to offer, before the random draw narrows it. */
export function buildCardPool(world: World): Card[] {
  const pool: Card[] = [];
  const banished = world.banished;
  const p = world.player;

  // Evolutions first: a weapon at max level while holding the required passive.
  for (const w of p.weapons) {
    const def = WEAPONS[w.id];
    if (!def.evolvesInto || !def.evolveWith) continue;
    if (w.level < def.maxLevel) continue;
    if (world.stacksOf(def.evolveWith) < (def.evolveStacks ?? 1)) continue;
    pool.push(evolutionCard(w.id));
  }

  // Levels in weapons already held — INCLUDING evolved ones.
  //
  // Evolved forms were excluded here and defined with maxLevel 1, so reaching an
  // evolution permanently ended that weapon line. Succeeding at your build was
  // what killed your build, and the better the build the earlier it died: the
  // 6,000-gold ECLIPSE unlock reaches VORTEX at a measured 28.3s and then that
  // slot could never change again for the remaining twelve minutes. Every funnel
  // build in the game dead-ended at the exact moment it worked.
  for (const w of p.weapons) {
    const def = WEAPONS[w.id];
    if (w.level >= def.maxLevel) continue;
    pool.push(
      weaponCard(w.id, w.level, !!def.evolveWith && world.stacksOf(def.evolveWith) >= (def.evolveStacks ?? 1)),
    );
  }

  // Fresh weapons, if there is a slot.
  if (p.weapons.length < MAX_WEAPONS) {
    for (const id of STARTER_POOL) {
      // Compare against ORIGIN, not id — an evolved slot still occupies its
      // lineage and must not be offered again as a fresh pick.
      if (p.weapons.some((w) => w.origin === id || w.id === id)) continue;
      const d = WEAPONS[id];
      pool.push(
        weaponCard(id, 0, !!d.evolveWith && world.stacksOf(d.evolveWith) >= (d.evolveStacks ?? 1)),
      );
    }
  }

  // Passives.
  for (const def of PASSIVES) {
    const stacks = world.stacksOf(def.id);
    if (stacks >= def.maxStacks) continue;
    // If this passive is the missing half of an evolution the player is already
    // holding a maxed weapon for, say so — that is the moment it matters most.
    let completes: string | undefined;
    if (stacks === 0) {
      for (const w of p.weapons) {
        const wd = WEAPONS[w.id];
        if (
        wd.evolveWith === def.id &&
        w.level >= wd.maxLevel &&
        wd.evolvesInto &&
        stacks + 1 >= (wd.evolveStacks ?? 1)
      ) {
          completes = WEAPONS[wd.evolvesInto].name;
          break;
        }
      }
    }
    pool.push(passiveCard(def, stacks, completes));
  }

  // The endless tier. Always present, so `drawCards()` can never return fewer
  // than three and a level-up can never fire with nothing behind it.
  for (const def of REFINEMENTS) {
    const card = passiveCard(def, world.stacksOf(def.id));
    card.weight = 0.35;
    pool.push(card);
  }

  // Banished cards are gone for the rest of the run — that is the whole point.
  // Evolutions are never filtered: they are never banishable in the first place,
  // and a build's payoff must always be able to appear.
  return pool.filter((c) => c.kind === 'evolution' || !banished.has(c.id));
}
