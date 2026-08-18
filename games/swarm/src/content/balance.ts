/**
 * Every tuning number in the game, in one place.
 *
 * Nothing here may be duplicated into sim code — the headless balance runner
 * sweeps this file, and a number hidden somewhere else is a number that never
 * gets tuned.
 */

/**
 * MASS — what an arena run is actually about, and now a physical fact.
 *
 * Mass was a score in a corner. It is now the size of your body, which makes
 * the whole lobby readable at a glance: you can see who is fat and who is
 * starving from across the arena, without reading a single number.
 *
 * Crucially, being big is NOT strictly better. A larger body is a larger
 * target for a swarm whose entire threat model is contact, so growth buys
 * you the lead and charges you for holding it. A player who has been drained
 * is smaller, harder to touch, and cheaper to keep alive — which is the
 * comeback path, and the reason the leader is prey rather than a fortress.
 *
 * SOLO IS UNTOUCHED BY CONSTRUCTION. `arenaScore` is pinned at `base` for the
 * whole of a solo run — nothing adds to it unless the lobby holds more than
 * one seat — so `seatRadius` returns exactly PLAYER.radius there, and the
 * difficulty geometry that took four tuning passes to get right is not in
 * scope of any of this.
 */
export const MASS = {
  /** Every seat opens here, and radius is measured against it. */
  base: 100,
  /** Extra radius per quadrupling of mass. Square-root, not linear: mass can
   *  run into the thousands late and a linear body would fill the screen. */
  growth: 0.34,
  /** A drained seat shrinks, but stays large enough to find on a phone. */
  minScale: 0.85,
  /** And a fat one stays small enough to fit between two enemies. */
  maxScale: 1.9,
} as const;

/**
 * THE SIPHON — mass moves from the hurt to the healthy.
 *
 * The rule that makes eight people on one screen into a fight. Stand near a
 * rival and mass flows toward whichever of you is in better shape, fast enough
 * to matter within a few seconds.
 *
 * It keys on HEALTH, not on size, and that choice is the whole design. Keying
 * on size would mean the biggest player eats everyone and the lead compounds
 * into a formality. Keying on health means the fat leader who has just been
 * chewed up by a horde is the most profitable thing on the map, a small player
 * can rob a large one, and the way to get rich is to hunt whoever is hurting —
 * which is a decision, made with your feet, every second of the run.
 */
export const SIPHON = {
  /** Clear-air distance between two bodies before mass starts moving. */
  radius: 120,
  /**
   * A SHARE of the victim's mass per second, at a full health gap — not a flat
   * amount.
   *
   * It was flat, and measured at 62 seconds every rival in the lobby sat pinned
   * at the floor while one player held 2,304: a fixed 26 a second strips a poor
   * player in four seconds and barely scratches a rich one, which is precisely
   * backwards. Taking a share means the fat leader is the profitable target and
   * a starving rival is not worth crossing the arena for — the food chain
   * points the right way up, and nobody gets farmed to zero.
   */
  share: 0.26,
  /**
   * The health advantage needed before anything moves at all.
   *
   * Wide enough that two players in similar shape simply coexist. Mass should
   * change hands because somebody is genuinely hurt, not because of a two
   * percent difference nobody can see.
   */
  deadband: 0.12,
  /** Nobody can be drained to nothing. Losing everything has to be a death. */
  floor: 25,
  /**
   * THE LOCK — why this is a decision and not weather.
   *
   * Measured: the median distance to your nearest rival in this arena is
   * NEGATIVE. Bodies overlap, because seats spawn on an ellipse sized to the
   * viewport so that everybody is visible from the first second. Proximity is
   * therefore not scarce, and a siphon keyed on proximity alone is live for
   * 85% of the run no matter how short you make its reach — which is a
   * pressure, not a choice.
   *
   * So commitment is the scarce thing instead. You drain ONE rival, chosen by
   * being nearest with a health advantage, and the drain starts weak and grows
   * the longer you stay on them. Switching costs you everything you had built
   * up. You cannot bleed the lobby by standing in it; you pick somebody, you
   * stay with them while the swarm closes on you, and that is the decision.
   */
  lockFull: 4,
  /** Share of full strength the moment you arrive on a new target. */
  opening: 0.25,
  /** Lock-seconds lost per second once you leave, so a lapse is recoverable. */
  release: 3,
} as const;

/**
 * Body radius for a seat carrying this much mass.
 *
 * Square root, because mass is unbounded and screens are not. Math.sqrt is one
 * of the few functions ECMA-262 specifies exactly, so this is safe inside the
 * deterministic simulation — see tools/detguard.mjs.
 */
export function seatRadius(mass: number): number {
  const scale = 1 + MASS.growth * (Math.sqrt(Math.max(1, mass) / MASS.base) - 1);
  return PLAYER.radius * Math.max(MASS.minScale, Math.min(MASS.maxScale, scale));
}

/**
 * AGGRO — who the swarm is chasing, and how hard it is to change its mind.
 *
 * Enemies used to re-pick the nearest combatant every single step, with a
 * comment explaining why: sticky aggro would let two players stand a metre
 * apart and cleanly halve the swarm between them, making the arena easier the
 * more people are in it. That warning is right and this has to respect it.
 *
 * So the swarm still goes to whoever is nearest — it just takes a real
 * difference to turn its head. A challenger has to be meaningfully closer than
 * the combatant it is already chasing, which changes nothing about where a
 * crowd settles and everything about the transient: you can gather a horde,
 * carry it, and put it on somebody. Killing a player without ever shooting at
 * them is the deepest thing two people can do to each other in a game whose
 * only verb is movement.
 *
 * Solo never reaches any of this — the one-seat branch short-circuits above it.
 */
export const AGGRO = {
  /**
   * How much closer a challenger must be to steal a chasing enemy, as a
   * fraction of the current target's distance. 1.0 would be no stickiness at
   * all; lower is harder to steal.
   */
  handoff: 0.62,
  /**
   * Enemies that must change hands between one pair before it is announced.
   *
   * Raised from 10 once runs started lasting their full length: at 10 the
   * banner fired 65 times a race, and a celebration that happens every four
   * seconds is wallpaper. A horde arriving should be an event.
   */
  announce: 24,
  /** Tally decay per second, so a slow trickle never adds up to a moment. */
  decay: 1.4,
} as const;

export const PLAYER = {
  /**
   * 120, and 0.65s of invulnerability.
   *
   * At 100hp/0.5s a surrounded player took ~29 damage per second late in a run,
   * i.e. under four seconds of contact from full. That is survivable in a
   * 2-minute run and impossible in a 5-minute one, and it was a large part of
   * why every skill level died at the same time.
   */
  maxHp: 120,
  speed: 140,
  radius: 14,
  /** Seconds of invulnerability after taking a hit, when touched by ONE enemy. */
  iframes: 0.65,
  /**
   * Crowding terms — the single most important numbers in the game.
   *
   * `playerContact` used to take one hit per i-frame and return, so 605 enemies
   * on screen dealt exactly what 2 did. Measured consequence: the maximum
   * damage this game could EVER inflict was 43.3 DPS against 120-270 effective
   * HP, and in the last three minutes of a run 57,078 enemies died without a
   * single one dying inside the 25px circle where it could hurt you.
   *
   * Now every toucher contributes and i-frames shorten with the crowd. ONE
   * contact is unchanged, so the authored opening minute is untouched; eight
   * contacts drop i-frames to ~0.19s, which turns density from decoration into
   * the actual threat.
   */
  surroundShare: 0.16,
  iframeCrowding: 0.18,
  iframesFloor: 0.16,
  /**
   * Generous on purpose. Measured at 60 the game killed far more XP than it
   * delivered — a kiting player earned 70 kills by 60s and was still level 2,
   * because gems drop where the enemy died and the player had already moved on.
   */
  pickupRadius: 95,
  /** Gems inside this radius accelerate toward the player instead of sitting. */
  magnetAccel: 900,
} as const;

/**
 * Gems outside the pickup radius drift toward the player, slowly.
 *
 * Measured necessity, not generosity: with inert gems a kiting player banked
 * only ~23% of the XP they earned, because the spawn ring follows the player,
 * so running away always works and always leaves the drops behind. XP you
 * fought for should mostly reach you — the tension in this genre belongs in
 * positioning against damage, not in logistics.
 *
 * driftMax stays well under the player's 140 speed, so a player in full flight
 * still loses ground and there is still a reason to turn and sweep.
 */
export const GEM = {
  driftAccel: 240,
  /**
   * Drift speed RISES WITH AGE.
   *
   * A flat 95 against a player moving at 140+ meant a player who kept moving
   * permanently outran their own XP. That single fact made the game bimodal:
   * stand still and you hit level 24 by two minutes; play "well" and kite and
   * you reach level 6 and die at two minutes having made four decisions.
   * Neither is the mastery curve we want, and both come from here.
   *
   * Fresh gems stay slow, so sweeping back through your kills is still the
   * skilful play and positioning still matters. Abandoned XP gradually finds
   * you instead of being deleted, so playing well stops being punished.
   */
  driftBase: 70,
  driftPerSecond: 26,
  driftMax: 230,
  /**
   * When the pool is this full, new drops MERGE into the nearest existing gem
   * instead of being silently discarded. Measured: 28,744 of 43,584 gems in a
   * single run were destroyed on spawn — the pool filled with uncollected XP
   * and every subsequent kill paid nothing at all.
   */
  mergeAbove: 0.30,
  mergeRadius: 620,
  /**
   * A gem this old is banked automatically, wherever it is.
   *
   * The merge rule above stopped XP being DESTROYED, but nothing ever drained
   * the pool: `updateGems` had no lifetime and no cull, and the only bulk
   * collector was the level-up vacuum. So the field pinned at the 360 merge
   * ceiling (0.30 x 1200) from ~2:15 onward and stayed there for the rest of
   * every run. 13 of 15 measured builds reported it independently, and pixel
   * analysis put green coverage in a 90px disc around the player at 67% — the
   * player's own sprite was unfindable inside their XP.
   *
   * Banking rather than deleting: the player earned it. Sweeping back through
   * your kills is still much faster, so positioning still pays.
   */
  autoBankAge: 14,
  /**
   * Above this many gems on screen, bank aggressively. A count rule catches the
   * late-game inflow (hundreds of kills a second) that an age rule alone cannot.
   */
  bankSoftCap: 90,
  autoBankAgeBusy: 5,
  /**
   * Hard ceiling on gems drawn. Any age rule is a rate rule in disguise: at a
   * measured 40,000 kills in ten minutes, even a 5-second lifetime settles at
   * ~1,000 gems, so the first version of this fix still reached the same 360
   * carpet it was written to remove. Banking down to a fixed count is the only
   * rule that holds regardless of kill rate.
   */
  hardCap: 82,
  /** Never bank a gem this fresh — a just-dropped gem is the pickup that pays. */
  minBankAge: 1.5,
  /**
   * Over the cap, gems past this distance bank first.
   *
   * Draining by AGE alone banks the newest drops, which are the ones at the
   * player's feet that they were about to collect — exactly backwards. Distance
   * is the honest proxy for "you were never going to reach this": the visible
   * half-width on a phone is ~240, so anything out here is off-screen already.
   */
  bankBeyond: 320,
  /**
   * Multiple of hardCap at which the freshness exemption is overridden.
   *
   * This IS the steady-state gem count: below it nothing is force-banked, above
   * it everything but the newest 0.4s is. At 2.0 the field settled at ~180 —
   * half the old carpet but still busy enough to hide enemies. 1.25 settles it
   * near 110, which reads as a trail of loot rather than ground cover.
   */
  floodedAt: 1.0,
  /**
   * Fraction of a gem's XP paid when it is banked for DENSITY rather than age —
   * i.e. when the player never went near it. See the note in updateGems.
   */
  forcedBankValue: 0.45,
} as const;

/**
 * XP required to reach the NEXT level, indexed by current level - 1.
 *
 * Hand-authored for the first eight levels because the first three decide
 * whether the player ever sees the core loop. Target: level 1 lands at ~8s for
 * a good player and ~12s for someone barely moving. A confused player must
 * still get their first card — that is the whole point of the low L1 cost.
 *
 * Beyond the table, cost grows 1.28x per level.
 */
/**
 * The first entry is deliberately the most expensive, and it is not a typo.
 *
 * Level 1 is a GATE, not a step. Doubling drifter XP silently halved the time
 * to the first card, firing the modal at t=2.2s before the player had touched
 * anything: it paused the sim on top of the unprompted opening demo — the
 * game's single best asset — and froze ~80% of the 15-second bounce window.
 * Worse, the cards sit in the thumb-rest zone, so the first steering touch
 * blind-bought an upgrade. Five independent review lenses hit this.
 *
 * Raising the WHOLE curve to fix it was the wrong correction and measured
 * badly: evolutions collapsed from 23% of runs to 5% and average weapons held
 * fell from 4.2 to 3.1. So level 1 alone is expensive enough to protect the
 * opening, and levels 2-8 are slightly cheaper than before to keep total
 * progression where it measured healthy.
 */
export const XP_TABLE = [16, 13, 21, 31, 43, 57, 73, 91] as const;
/**
 * 1.18, not 1.28.
 *
 * At 1.28 a measured run reached level ~6 and held 3.4 of 6 weapons, so no run
 * in 960 ever produced an evolution — the entire payoff of the weapon system
 * was unreachable. A build needs roughly 16-20 level-ups to become a build.
 */
export const XP_GROWTH = 1.13;

export function xpToNext(level: number): number {
  if (level <= XP_TABLE.length) return XP_TABLE[level - 1]!;
  // Annotated, because `as const` narrows the table to a literal union and the
  // running total below is an ordinary number.
  let v: number = XP_TABLE[XP_TABLE.length - 1]!;
  for (let i = XP_TABLE.length; i < level; i++) v = Math.round(v * XP_GROWTH);
  return v;
}

export type EnemyKind =
  | 'drifter'
  | 'lantern'
  | 'elite'
  | 'herald'
  | 'stalker'
  | 'splitter'
  | 'bomber'
  // Late kinds. The swarm's composition was provably frozen from t=204 — every
  // spawn weight had hit its clamp — so minute 4 differed from minute 12 only
  // in enemy hit points. These three change what the fight IS, not how hard it
  // is: one punishes small fast hits, one punishes ignoring the right target,
  // one cannot be answered by range at all.
  | 'bulwark'
  | 'weaver'
  | 'burrower'
  | 'warden'
  | 'lancer'
  | 'brood'
  | 'colossus'
  | 'harbinger';

export const BOSS_KINDS: readonly EnemyKind[] = [
  'warden',
  'lancer',
  'brood',
  'colossus',
  'harbinger',
];

/**
 * Hard concurrency caps for kinds that can accumulate.
 *
 * The LANTERN holds at range instead of closing, so without a cap every one
 * ever spawned stays alive forever — it reached 45% of the entire population.
 * Any enemy that does not commit to reaching the player needs a ceiling.
 */
export const CONCURRENT_CAP: Partial<Record<EnemyKind, number>> = {
  lantern: 9,
  // A weaver shields everything near it, so a screenful of them makes the crowd
  // effectively unkillable rather than merely harder. Few enough to be a target.
  weaver: 5,
  /**
   * Nine, not four.
   *
   * This is the lever that actually closes the late game, and hit points are
   * not. A fully-upgraded build outgrows any HP curve — raising late
   * compounding from 1.46 to 1.62 per minute barely moved the number of maxed
   * runs surviving seven minutes. The BURROWER is the only enemy whose answer
   * is not damage: it is out of the spatial hash while it travels, so no weapon
   * can touch it, and it must be physically dodged.
   *
   * Still capped, because the mechanic IS the dodge: once enough telegraphs
   * overlap there is nowhere to stand and it stops being a skill check. Nine
   * is pressure; unlimited would be a coin flip.
   */
  burrower: 9,
  /**
   * Independent of the armour fix above, and kept because it is the general
   * rule: anything that outlives a drifter by an order of magnitude accumulates
   * until it IS the screen, whatever its spawn share says. A cap makes that
   * impossible rather than merely unlikely.
   */
  bulwark: 16,
};

/**
 * Ceilings on player projectiles that persist rather than travel.
 *
 * MINES had none, and its drop rate scaled with fireRateMult while its lifetime
 * did not: measured 78 alive at once, every one of them within 130px of the
 * player, rendering as a single unreadable red mass over the character.
 */
/**
 * Health drops.
 *
 * The game had NO way to recover health. Not a pickup, not regeneration —
 * nothing but SUPERNOVA's heal, which requires an evolution that 7% of runs
 * ever reach. Every point of contact damage was therefore permanent, so a run
 * was a one-way attrition curve: measured, players bled from 140 HP to 37 in
 * the first 45 seconds and arrived at the 60-second WARDEN already half dead.
 * Drifters accounted for 49.1% of all damage taken and the WARDEN 29.9%.
 *
 * This is the missing system, and it is a design gain rather than a difficulty
 * dial: a heart on the far side of an elite turns "avoid everything" into a
 * decision about whether the trip is worth it, which is the genre's central
 * tension and was previously absent.
 */
export const HEALTH_DROP = {
  /** Elites always drop one. They are the fight you choose to take. */
  elite: 22,
  /** Heralds sometimes do, so the mid-game has a trickle between elites. */
  heraldChance: 0.28,
  herald: 14,
  /** A boss pays properly — it is the longest commitment in the run. */
  boss: 45,
  bossCount: 3,
} as const;

export const PROJECTILE_CAP = {
  mines: 18,
} as const;

export function isBoss(kind: EnemyKind): boolean {
  return BOSS_KINDS.includes(kind);
}

export interface EnemyStats {
  hp: number;
  speed: number;
  radius: number;
  damage: number;
  xp: number;
  /** Render tint, also used as the identity colour in programmer art. */
  color: number;
  /** How hard this enemy resists being pushed out of the swarm. */
  mass: number;
}

/**
 * Enemy speeds sit at roughly 50-70% of the player's 140, which is the genre's
 * working range. The first pass used 40 (29%) and it measured terribly: the
 * player outran everything, was never surrounded, and so was never actually
 * threatened. Slow enemies do not read as "easy", they read as "nothing is
 * happening".
 */
export const ENEMIES: Record<EnemyKind, EnemyStats> = {
  // 2 XP, not 1. Total XP available across a run was the binding constraint on
  // whether a build ever developed at all.
  drifter: { hp: 10, speed: 88, radius: 11, damage: 8, xp: 2, color: 0xff5c6e, mass: 1 },
  elite: { hp: 150, speed: 52, radius: 30, damage: 15, xp: 12, color: 0xffb03a, mass: 6 },
  // The 55s "it gets bigger than this" promise. Fast, tanky, visually loud.
  herald: { hp: 60, speed: 98, radius: 16, damage: 12, xp: 6, color: 0xb478ff, mass: 2 },
  /**
   * The only enemy FASTER than the player (140). Introduced ~75s.
   *
   * This is the fix for a structural problem, not a difficulty knob. With
   * everything slower than the player, running away always worked and the late
   * game could only threaten by boxing you in — a competent evader finished
   * two minutes at 90 of 100 HP no matter how much density was thrown at them.
   * Something that catches you forces engagement. Deliberately fragile: it is
   * a threat you answer by shooting, not by outrunning.
   */
  stalker: { hp: 34, speed: 168, radius: 12, damage: 14, xp: 5, color: 0xff3ea5, mass: 1.4 },
  /** Dies into two smaller copies — killing it makes the crowd worse, briefly. */
  splitter: { hp: 26, speed: 82, radius: 15, damage: 10, xp: 3, color: 0x6ee7c8, mass: 1.4 },
  /** Detonates on death. Punishes killing things while standing on top of them. */
  bomber: { hp: 22, speed: 74, radius: 15, damage: 10, xp: 4, color: 0xffa03a, mass: 1.5 },
  /**
   * The only enemy that does NOT need to touch you.
   *
   * Every other kind is the same melee chaser, so 100% of damage required body
   * contact — which meant any kill-bubble wider than 25px was total immunity,
   * and the player's reaches ~400px. This one stops at 520px, outside every
   * build's reach, and throws a slow telegraphed orb. It is trivially dodged by
   * a player who keeps moving and lethal to one who has stopped, which is
   * exactly the failure mode being fixed.
   */
  lantern: { hp: 46, speed: 70, radius: 14, damage: 14, xp: 7, color: 0xffe066, mass: 1.6 },

  /**
   * ~3:45. Armoured: every hit is reduced by a flat amount before it lands.
   *
   * The counter to the build the late game actually produces. Player damage is
   * multiplicative and arrives as a torrent of small tics — SWARM, TEMPEST and
   * ORBIT all trade size for rate — so a flat per-hit subtraction is nearly free
   * against one big hit and devastating against a hundred tiny ones. It is the
   * first enemy in the game whose answer is a DIFFERENT build rather than more
   * of the same, which is what makes POWER a real choice instead of a default.
   */
  bulwark: { hp: 190, speed: 58, radius: 24, damage: 20, xp: 16, color: 0x8fa3c8, mass: 8 },
  /**
   * ~5:10. Tethers nearby enemies and shields them while it lives.
   *
   * Every enemy before this one is answered by pointing damage at the crowd.
   * This one makes the crowd the wrong target: the swarm around a weaver takes
   * 45% damage until the weaver itself dies, so an auto-aiming build that always
   * shoots the nearest thing is now shooting the wrong thing. Fragile on its
   * own, and the tether is drawn, so the fix is legible the moment you look.
   */
  weaver: { hp: 70, speed: 74, radius: 17, damage: 14, xp: 14, color: 0x6ee7c8, mass: 2 },
  /**
   * ~6:30. Submerges, travels UNDER your weapons, and erupts on top of you.
   *
   * The answer to the run that cannot be lost. A mature build kills everything
   * at ~400px while the hitbox that can hurt it is 25px, so nothing ever reaches
   * the player — measured at 57,078 kills in three minutes with zero of them
   * inside contact range. While submerged this is not in the spatial hash at
   * all, so no weapon can target it and no amount of damage answers it. It has
   * to be dodged. That is the whole point: a threat that ignores the stat the
   * player has been stacking for ten minutes.
   */
  burrower: { hp: 80, speed: 96, radius: 18, damage: 34, xp: 15, color: 0xc98a4b, mass: 3 },

  // ---- bosses ----------------------------------------------------------
  /** 60s. Slow siege engine that keeps summoning while you chew through it. */
  warden: { hp: 700, speed: 82, radius: 46, damage: 22, xp: 140, color: 0xff8f3a, mass: 24 },
  /** 120s. Winds up, then commits to a charge you must read and dodge. */
  lancer: { hp: 1000, speed: 58, radius: 34, damage: 30, xp: 160, color: 0xff3ea5, mass: 16 },
  /** 180s. Bursts into splitters on death, so the kill is not the end of it. */
  brood: { hp: 1500, speed: 42, radius: 50, damage: 24, xp: 200, color: 0x9d7bff, mass: 26 },
  /**
   * 4:20. Slams the ground; the shockwave, not the body, is the threat.
   *
   * The first boss whose damage does not require it to touch you, and therefore
   * the first one a kiting player cannot simply ignore. Telegraphed ring, then a
   * hard beat — you have to read it and be elsewhere.
   */
  colossus: { hp: 2600, speed: 46, radius: 58, damage: 30, xp: 260, color: 0x7f8fa6, mass: 30 },
  /**
   * 5:50. Blinks to you and fires radial volleys.
   *
   * Distance is the answer to every other boss in the game. This one closes it
   * whenever it likes, so the fight follows you, and the volley punishes the
   * stand-still-and-out-DPS-it plan that beats the rest.
   */
  harbinger: { hp: 3200, speed: 64, radius: 38, damage: 28, xp: 300, color: 0x9ad6ff, mass: 18 },
};

/** Bosses, in the order they appear, with the time they arrive. */
/**
 * Spaced out after forensics: 120s put LANCER on top of the elite wave, the
 * first surge and the splitter introduction all at once, and death forensics
 * put the clear-time peak (1.56s) and the bulk of deaths in that exact window.
 * The schedule now ROTATES rather than clamping, so all three keep returning.
 */
/**
 * Seven entries, not three.
 *
 * With three, the last first-time content in the entire game landed at t=186 —
 * 3:06, which is exactly the "after 3 minutes" the owner reported twice — and
 * every run from then on was the same three bosses rotating on a 75s loop while
 * a number went up. Measured across 15 builds, the median run spent 58s past
 * that wall and the long tail spent seven minutes there.
 *
 * The gaps widen deliberately (72, 54, 76, 88, 90, 100): early bosses are
 * introductions and want to arrive quickly, late ones are fights and need room
 * to breathe between them. Past the last entry the rotation-with-modifiers takes
 * over, so the first true repeat is now at ~10:40 instead of 4:21.
 */
export const BOSS_SCHEDULE: ReadonlyArray<{ t: number; kind: EnemyKind; name: string }> = [
  /**
   * 82, not 60.
   *
   * WARDEN is the FIRST boss, and at 60s it was arriving while the player was
   * at their weakest point in the whole run. Measured: 47% of runs ended in a
   * 63-66s cluster with WARDEN alive, players reaching it at ~66 of 140 HP
   * after bleeding through the opening minute. That is not a difficulty curve,
   * it is a filter — and it produced a barbell distribution where half of all
   * runs ended before 90s and the rest went to 250s+, with almost nothing in
   * between.
   *
   * 82 puts it after the 75s elite pair and gives the player two or three more
   * level-ups first, so the first boss is an encounter they are equipped for
   * rather than the thing that ends most sessions.
   */
  { t: 82, kind: 'warden', name: 'WARDEN' },
  { t: 148, kind: 'lancer', name: 'LANCER' },
  { t: 196, kind: 'brood', name: 'BROODMOTHER' },
  // Pulled forward with the roster. COLOSSUS at 262 was reached by 11% of runs
  // and HARBINGER at 350 by 7%; the 440s and 540s entries by nobody at all.
  { t: 206, kind: 'colossus', name: 'COLOSSUS' },
  { t: 272, kind: 'harbinger', name: 'HARBINGER' },
  { t: 348, kind: 'brood', name: 'BROODMOTHER' },
  { t: 430, kind: 'colossus', name: 'COLOSSUS' },
  { t: 515, kind: 'harbinger', name: 'HARBINGER' },
];

/** After the scripted three, bosses keep coming on this cadence. */
export const BOSS_REPEAT_PERIOD = 75;

/**
 * Boss modifiers, applied from the second cycle onward.
 *
 * The schedule now rotates rather than clamping, but a rotation is still a
 * rerun — measured, the back half of a long run was the same three fights over
 * and over, which is the clearest possible signal to a player that the content
 * has ended. Each modifier changes how the fight PLAYS, not just its numbers.
 */
export type BossModifier = 'armored' | 'enraged' | 'twin';

export const BOSS_MODIFIERS: readonly BossModifier[] = ['armored', 'enraged', 'twin'];

export const BOSS_MOD_STATS: Record<BossModifier, { hp: number; speed: number; damage: number; label: string }> = {
  // Slower and far tougher: a wall you have to commit to.
  armored: { hp: 2.4, speed: 0.82, damage: 1.15, label: 'ARMORED' },
  // Fast and vicious: it catches you.
  enraged: { hp: 1.15, speed: 1.5, damage: 1.35, label: 'ENRAGED' },
  // Two of them at reduced health: the fight has two centres.
  twin: { hp: 0.62, speed: 1.1, damage: 1, label: 'TWIN' },
};

/**
 * The boss leash.
 *
 * Bosses move at 42-82 against a player at 140+, so a boss fight was optional:
 * you walked away and it never caught up. Measured across 12 runs, 2 of 22 boss
 * spawns were ever killed, and the health bar sat on screen with nothing under
 * it for up to 30% of the time it was up — the game announcing a fight that was
 * not happening. BROOD already had a `dist > 320 ? speed * 1.6` rule, which at
 * 67px/s never closed on 140 either.
 *
 * Distance-scaled rather than a flat buff, so a boss keeps its designed pace
 * where the fight actually happens and only accelerates once you are leaving.
 * The telegraph freeze is deliberately exempt: the LANCER's windup must stay
 * readable or the charge becomes unfair.
 */
/**
 * These three numbers set where a fleeing player and a chasing boss balance,
 * and that equilibrium is the real design decision. The boss holds station
 * wherever its ramped speed equals the player's 140, i.e. at
 *   start + span * (140 - bossSpeed) / (player * catchUp - bossSpeed)
 * A first pass at 300/340/1.12 settled BROOD at ~590px — outrunnable no longer,
 * but still off-screen, so the health bar sat over an empty field. These settle
 * the slowest boss near ~340px and the fastest near ~320px: at the edge of
 * frame while you run, and immediately in it the moment you turn.
 */
export const BOSS_LEASH = {
  /** Below this, the boss moves at its own speed and its mechanic reads. */
  start: 230,
  /** Distance over which it ramps to full pursuit. */
  span: 170,
  /** Multiple of the PLAYER's speed at full ramp — above 1, so it closes. */
  catchUp: 1.24,
  /**
   * The leash MATURES over the run, and this is the correction to a real
   * regression.
   *
   * A flat 1.24 was right for the problem it fixed — bosses were being walked
   * away from, and 20 of 22 spawns were never fought. But it applied equally to
   * WARDEN at 60 seconds, which is the player's FIRST boss and is meant to be a
   * spectacle they survive, not a wall. Measured after the change: a kiting
   * player's median death moved to 136s, four seconds after LANCER arrives, and
   * only 12% of runs reached three minutes against a 40% target.
   *
   * Below catchUpEarly the boss cannot quite close on a fleeing player, so the
   * first two encounters are escapable and teach the fight. By five minutes the
   * leash is at full strength and a boss is once again inescapable.
   */
  catchUpEarly: 0.82,
  rampFrom: 90,
  rampTo: 300,
} as const;

/**
 * THE TIDE — the closing ring, and the run's ending.
 *
 * Players reported the late game as thin, and they were right: past the last
 * introduction the only thing that changed was numbers. Adding a sixteenth
 * enemy kind would not fix that, because the VERB never changes — it is still
 * "kill the things coming at you" with a bigger multiplier.
 *
 * This changes the verb. A safe circle contracts around where you stood when it
 * began, and outside it you burn. Space itself becomes the scarce resource, so
 * the late game stops being about damage and starts being about position — the
 * one axis a maxed build cannot buy its way out of. It is also the only thing
 * here that gives a run a shape: a beginning, a middle, and a closing.
 *
 * Deliberately survivable. The ring stops shrinking rather than collapsing to a
 * point, because a run that ends on a timer teaches nothing — a player has to
 * be able to say what killed them.
 */
export const TIDE = {
  /** When the ring first appears. Comfortably past the median run. */
  startAt: 300,
  /** Seconds it takes to reach its final size. */
  closeOver: 165,
  startRadius: 880,
  endRadius: 300,
  /** Health per second outside the ring, before the ramp below. */
  damage: 9,
  /** Damage multiplier per full second spent outside, so lingering escalates. */
  damageRamp: 0.55,
  damageMax: 4,
} as const;

export const BOSS_BEHAVIOUR = {
  /**
   * Warden: seconds between summon bursts, and how many it calls.
   *
   * Eased because the summons COMPOUND against a player who cannot yet clear
   * them: three adds every 3.4s on top of the ambient tide is what actually did
   * the killing, not the boss's own contact damage. It still cannot be ignored,
   * it just no longer outruns a level-8 build's ability to answer it.
   */
  wardenSummonPeriod: 4.4,
  wardenSummonCount: 2,
  /** Lancer: windup, charge speed, charge duration. */
  lancerWindup: 0.9,
  lancerChargeSpeed: 430,
  lancerChargeTime: 0.85,
  lancerRest: 1.6,
  /** Brood: how many splitters it bursts into. */
  broodSpawn: 9,
  /** Colossus: telegraph length, slam radius, and gap between slams. */
  colossusWindup: 0.85,
  colossusRadius: 210,
  colossusPeriod: 3.6,
  /** Harbinger: blink cadence, how far it lands, and volley size. */
  harbingerPeriod: 4.2,
  harbingerBlink: 250,
  harbingerOrbs: 9,
} as const;

/**
 * BULWARK armour, before the threat curve scales it.
 *
 * Sized against a mid-run hit rather than a late one: at ~26 it removes most of
 * a single ORBIT blade tick and almost none of a SUPERNOVA, which is exactly
 * the discrimination it exists to create.
 */
export const BULWARK_ARMOR = 26;

export const WEAVER = {
  range: 190,
  /** Enemies shielded per weaver. Low, so the answer is "kill that one". */
  links: 6,
  /** Incoming damage multiplier applied to tethered enemies. */
  vuln: 0.45,
} as const;

export const BURROWER = {
  /** Seconds visible and killable before it dives. This is the window. */
  surfaceTime: 2.6,
  /** Longest it may stay under before it must come up. */
  diveTime: 3.4,
  /** Under the ground it is faster — it is closing while untouchable. */
  diveSpeedMult: 1.55,
  /** Comes up once this close, whether or not the dive timer has run out. */
  eruptRange: 90,
  /**
   * The dodge window. The circle is placed when this starts and does not
   * follow, so moving out of it is a complete answer and standing still is not.
   */
  telegraph: 0.75,
  blast: 96,
} as const;

export const BOLT = {
  damage: 12,
  cooldown: 0.8,
  speed: 400,
  radius: 5,
  /**
   * 0.9s of flight = ~360px of range, deliberately short.
   *
   * At 1.6s the bolt reached 640px and killed things most of a screen away,
   * so gems piled up out in the dark where nobody ever walked. Short range
   * pulls the kills — and therefore the XP — into the space the player is
   * already fighting in.
   */
  life: 0.9,
  pierce: 0,
  count: 1,
} as const;

export const ORBIT = {
  damage: 8,
  radius: 78,
  orbRadius: 12,
  angularSpeed: 2.6,
  count: 2,
  /** Per-enemy cooldown, so orbs chip rather than instantly delete. */
  hitCooldown: 0.35,
} as const;

/**
 * The opening is seeded rather than left to the spawner.
 *
 * The first bolt must visibly connect before the player has touched anything —
 * that unprompted hit is the game demonstrating its own loop, and it is the
 * most important second in the build. Enemies from the normal spawn ring are
 * ~450px out and would not be reached until ~1.9s, which is far too late. So
 * the opening trio spawns on screen and close, and the first shot comes early.
 */
export const OPENING = {
  count: 3,
  radius: 175,
  /** Seconds before the first bolt fires. Impact lands at ~0.97s. */
  firstShotDelay: 0.55,
} as const;

/** Pool capacities. Spawning past these is a bug, not a soft failure. */
export const CAPACITY = {
  enemies: 900,
  projectiles: 400,
  /** Enemy fire, kept apart so it can never starve the player's weapons. */
  hostiles: 220,
  gems: 1200,
} as const;

export const WORLD = {
  /** Enemies spawn this far outside the visible rectangle. Small: they only
   * need to be off screen, and every extra pixel is dead walking time. */
  spawnMargin: 50,
  /**
   * Fraction of ambient spawns placed ahead of the player's travel direction.
   *
   * Fixes a dominant strategy the balance runner exposed: the field is
   * unbounded and the spawn ring follows the player, so running in a straight
   * line forever was strictly optimal — the kiting bot finished a minute at 91
   * of 100 HP having never been threatened, and left three quarters of its XP
   * on the floor behind it. Biasing spawns forward means flight runs you into
   * what you are fleeing, so circling and sweeping becomes the skill. Vampire
   * Survivors gets this for free from a bounded map; we have to author it.
   */
  spawnForwardBias: 0.6,
  /** Half-width of the forward spawn arc, radians. */
  spawnForwardArc: 1.0,
  /**
   * 900, down from 1600.
   *
   * Instrumented review found 2 of 68 live enemies inside the viewport at t=80s
   * and 4 of 219 at t=180s — the player outruns everything, so the horde
   * compacts into a trailing blob that is alive, counted, and invisible. Kill
   * throughput hit ZERO between t=140 and t=160 with 195 enemies alive.
   * Recycling stragglers sooner puts them back in front of the player.
   */
  cullRadius: 620,
  /** Broad-phase cell size — about 2x the largest common enemy radius. */
  cellSize: 48,
} as const;
