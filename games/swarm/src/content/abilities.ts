/**
 * Active abilities — the game's SECOND VERB.
 *
 * Until now the player had exactly one continuous input (move) and one discrete
 * one (pick a card every ~20 seconds). Every enemy but two resolves to "walk at
 * the player", so the entire moment-to-moment decision space was: kite, do not
 * get cornered, walk over gems. A competent player solves that in about five
 * runs, and no amount of additional content minutes changes it — more enemies
 * to kite is still kiting.
 *
 * This is the fix, and it is deliberately not "a dash for everyone". Each
 * character gets a DIFFERENT verb, so the roster stops being six stat lines and
 * becomes six ways to play. The choice on the results screen changes what your
 * hands do, not just what your numbers are.
 *
 * DESIGN RULES:
 *
 * 1. Every ability must answer a situation movement alone cannot. If the honest
 *    description is "helps a bit", it is a passive wearing a button.
 * 2. Cooldowns are long enough to be a decision (8-14s). A spammable ability is
 *    a stat, and stats already have a system.
 * 3. Nothing here may be strictly better than nothing — no pure-upside button.
 *    Each has a cost: a commitment, a wind-down, or a position you must accept.
 * 4. Readable in one line on a results-screen chip. A player choosing a
 *    character has to know what they are choosing.
 */

export type AbilityId = 'blink' | 'volley' | 'bulwark' | 'recall' | 'detonate' | 'singularity';

export interface AbilityDef {
  id: AbilityId;
  name: string;
  /** One line. Shown on the character chip and the ability button. */
  desc: string;
  cooldown: number;
  color: number;
}

export const ABILITIES: Record<AbilityId, AbilityDef> = {
  /**
   * The escape. Answers being surrounded, which is the death this game actually
   * produces — the crowding rule means eight touchers kill you in under two
   * seconds and no amount of running speed gets you out of a closed ring.
   * Costs nothing but the cooldown, so it has the longest one.
   */
  blink: {
    id: 'blink',
    name: 'BLINK',
    desc: 'Teleport through the crowd',
    cooldown: 9,
    color: 0x8ef7ff,
  },
  /**
   * The burst. A single heavy piercing volley along your heading — the answer to
   * one dangerous thing rather than to many weak ones, which is otherwise a gap:
   * every weapon in the game is an area or an auto-target, so a player has no
   * way to CHOOSE what dies.
   */
  volley: {
    id: 'volley',
    name: 'VOLLEY',
    desc: 'Piercing burst where you face',
    cooldown: 8,
    color: 0xffd23a,
  },
  /**
   * The stand. Shoves everything away and grants a moment of immunity — lets a
   * slow character deliberately accept a surround it could never walk out of.
   * The cost is that it does no damage: you buy space, not a kill.
   */
  bulwark: {
    id: 'bulwark',
    name: 'BULWARK',
    desc: 'Shove everything back, briefly immune',
    cooldown: 11,
    color: 0x7dff9b,
  },
  /**
   * The undo. Returns you to where you stood three seconds ago and heals a
   * little. Rewards a player who can remember the board — and punishes one who
   * cannot, because it will happily drop you back into a crowd that has since
   * closed in behind you.
   */
  recall: {
    id: 'recall',
    name: 'RECALL',
    desc: 'Return to where you were, and heal',
    cooldown: 13,
    color: 0x5cd0ff,
  },
  /**
   * The panic button, priced as one. An instant blast centred on you, and the
   * only ability that clears a full surround outright — so it has a real cost:
   * the longest wind-down in the set, during which you cannot use it again.
   */
  detonate: {
    id: 'detonate',
    name: 'DETONATE',
    desc: 'Blast everything around you',
    cooldown: 14,
    color: 0xff8f3a,
  },
  /**
   * The trap. Pulls the swarm INTO a point for two seconds, which is the only
   * ability that makes the crowd worse on purpose. It is a setup tool for a
   * build that wants everything in one place, and it will kill a careless
   * player who stands in their own gravity well.
   */
  singularity: {
    id: 'singularity',
    name: 'SINGULARITY',
    desc: 'Drag the swarm into one point',
    cooldown: 12,
    color: 0xb478ff,
  },
};

/** Tuning for the individual effects, kept out of the sim per the balance rule. */
export const ABILITY = {
  blinkDistance: 210,
  /** Invulnerability granted on arrival, so a blink into a crowd is not fatal. */
  blinkIframes: 0.45,

  volleyCount: 7,
  volleySpread: 0.30,
  volleyDamageMult: 3.4,
  volleyPierce: 4,
  volleySpeed: 620,
  volleyLife: 0.85,

  bulwarkRadius: 240,
  /**
   * 2200, not 780.
   *
   * Knockback decays at KNOCKBACK_DECAY = 9/s, so total displacement is roughly
   * velocity/9 — 780 moved the crowd a measured 58px, which for an 11-second
   * cooldown on a character with no other escape is not a shove, it is a nudge.
   * This clears a genuine bubble (~200px) and is the whole reason to pick WARD:
   * it is the only character that can deliberately accept a surround.
   */
  bulwarkKnockback: 2200,
  bulwarkIframes: 1.1,

  /** How far back RECALL rewinds, in seconds. */
  recallSeconds: 3,
  recallHeal: 22,
  recallIframes: 0.5,

  detonateRadius: 300,
  /** Multiplier on the player's damage stat, so it scales with the build. */
  detonateDamage: 120,

  singularityRadius: 320,
  singularityDuration: 2.0,
  /**
   * The well PULLS. It deliberately deals NO damage.
   *
   * I gave it damage to try to buff ECLIPSE and it was wrong twice over. It did
   * not help — offence feeds the power index that drives adaptive threat, so
   * the buff partly cancelled itself and the character measured WORSE. And it
   * destroyed the ability's identity: with damage it killed the crowd instead
   * of gathering it, and its measured crowd-spread went from 9 (a tight
   * gravity well, unlike anything else in the set) to 414 (scattered
   * survivors), making it a strictly worse DETONATE.
   *
   * Gathering IS the ability. It is the only one that makes the crowd worse on
   * purpose, and that is what a build can be constructed around.
   */
  /**
   * Strong enough to be decisive. At 460 the well merely bent the crowd's path;
   * a trap that only slightly inconveniences the swarm is not a trap, and this
   * is the ability the whole ECLIPSE build is supposed to be set up around.
   */
  singularityPull: 1100,
} as const;
