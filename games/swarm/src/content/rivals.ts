import { Rng } from '@arcade/core';

/**
 * Rivals — the other players in the arena.
 *
 * They are NOT a scoreboard of invented numbers. Each one owns a real World and
 * genuinely plays the same seeded run the player is playing: same waves, same
 * card offers, same bosses. Their time survived is a time they actually
 * survived. That is only possible because the simulation is deterministic and
 * cheap (0.083ms a step), and it is the difference between a competitive layer
 * and a decorated progress bar.
 *
 * WHY BOTS AT ALL. A browser player closes the tab after ten to fifteen seconds
 * of an empty lobby, which craters exactly the day-one retention a portal trial
 * measures. Filling the arena immediately is the standard answer and portals
 * favour it. The rules that make it work are about honesty of FEEL, not
 * deception:
 *
 *  1. Never call them "Bot 1". A name that announces itself as furniture makes
 *     the whole arena furniture.
 *  2. Spread the skill. Eight identical opponents read as a machine; a spread
 *     from careless to genuinely good reads as a room of people.
 *  3. Give them reaction delay and mistakes. A bot that responds on the exact
 *     frame is the tell — humans are late, and sometimes wrong.
 *  4. They must be beatable AND able to beat you. A lobby you always win is a
 *     single-player game with extra text.
 *
 * WHAT WE DELIBERATELY DO NOT DO. An earlier version gave each rival a fake
 * ping so the standings would read like a network game. That is not making the
 * arena feel alive, it is manufacturing evidence that specific people are
 * connected when they are not, and it is the one line here that would be a lie
 * rather than a design choice. Rivals are simulated opponents; the game does
 * not claim otherwise.
 *
 * When real players eventually fill these slots, the rival simply stops being
 * simulated and starts being replayed — the surrounding system does not change.
 */

/**
 * Name parts, combined deterministically from the run seed.
 *
 * Generated rather than free-text for a specific reason: a text field on a
 * kids-adjacent portal creates a permanent moderation duty for a solo operator.
 * These read as handles without anyone ever having to police one.
 */
const NAME_A = [
  'dusk', 'ember', 'hollow', 'iron', 'jade', 'kilo', 'lunar', 'moth', 'nova',
  'onyx', 'pale', 'quartz', 'rust', 'salt', 'tide', 'umbra', 'vex', 'wisp',
  'zero', 'ash', 'bram', 'coil', 'drift', 'echo', 'flint', 'grim', 'haze',
];
const NAME_B = [
  'walker', 'fang', 'spark', 'crown', 'thorn', 'vault', 'wing', 'shard',
  'runner', 'blade', 'crow', 'stone', 'flare', 'kite', 'wolf', 'moth',
  'reign', 'drake', 'lynx', 'ward', 'hex', 'pike', 'talon', 'vane',
];

export interface RivalProfile {
  name: string;
  /**
   * 0..1. Drives every behavioural knob below, so a rival is one number the
   * lobby can be balanced on rather than six that can drift apart.
   */
  skill: number;
  /** Seconds between re-reading the field. Humans do not react per frame. */
  reaction: number;
  /** How close the crowd gets before they retreat. Lower is braver. */
  nerve: number;
  /** Chance per decision of simply choosing wrong. */
  mistake: number;
  /** Whether they pursue evolutions or grab whatever looks biggest. */
  drafts: boolean;
}

/**
 * Build the lobby for a run.
 *
 * Deterministic in the seed, so a shared daily produces the same opponents for
 * everyone — the same field, not merely the same waves.
 */
export function makeRivals(seed: number, count: number): RivalProfile[] {
  const rng = new Rng((seed ^ 0x5f356495) >>> 0 || 1);
  const used = new Set<string>();
  const out: RivalProfile[] = [];

  for (let i = 0; i < count; i++) {
    let name = '';
    for (let tries = 0; tries < 12; tries++) {
      const a = NAME_A[Math.floor(rng.next() * NAME_A.length) % NAME_A.length]!;
      const b = NAME_B[Math.floor(rng.next() * NAME_B.length) % NAME_B.length]!;
      // A trailing number on some of them, the way real handles look.
      const tail = rng.next() < 0.35 ? String(Math.floor(rng.next() * 89) + 10) : '';
      name = `${a}${b}${tail}`;
      // Uniqueness is checked on the STEM, not the full handle.
      //
      // Checking the whole string let "zerovault" and "zerovault48" sit in one
      // lobby — screenshotted. Two handles that differ only by a numeric tail
      // do not read as two people, they read as a rendering glitch, and the
      // entire reason these are generated is so the arena feels populated by
      // someone rather than by a list.
      if (!used.has(`${a}${b}`)) break;
    }
    const stem = name.replace(/[0-9]+$/, '');
    used.add(stem);

    /**
     * Skill spread across the lobby, not random per rival.
     *
     * Eight independent rolls cluster around the middle and produce a lobby
     * where everyone is average. Spacing them along the range guarantees there
     * is always someone clearly better than the player and someone clearly
     * worse, which is what makes a standings list worth looking at.
     */
    const spread = count > 1 ? i / (count - 1) : 0.5;
    const skill = Math.max(0.05, Math.min(0.98, spread * 0.85 + rng.range(-0.09, 0.09) + 0.08));

    out.push({
      name,
      skill,
      // A careless player reacts in ~350ms; a sharp one in ~90ms. Nobody is
      // frame-perfect, because frame-perfect is the tell.
      reaction: 0.35 - skill * 0.26,
      nerve: 70 + skill * 90,
      mistake: 0.28 - skill * 0.25,
      drafts: skill > 0.42,
    });
  }
  // Shuffled so the standings do not open sorted by strength.
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng.next() * (i + 1)) % (i + 1);
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

/** Slots in an arena, including the player. */
export const LOBBY_SIZE = 8;
