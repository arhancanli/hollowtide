import type { AbilityId } from './abilities.js';
import type { WeaponId } from './weapons.js';

/**
 * Characters — what the unlock ladder actually GRANTS.
 *
 * Before this, gold filled a bar toward five names and then nothing happened.
 * That is the classic retention hole: a progress bar pointing at nothing, and
 * every run starting identically. Run 2 and run 20 opened the same way, which
 * is exactly what caps a survivor-like at a handful of sessions.
 *
 * Each character starts with a DIFFERENT weapon, so a run plays differently
 * from its first second rather than diverging only after several level-ups.
 * The stat trade-offs are real trade-offs — every one gives something up — so
 * picking is a decision rather than a strict upgrade.
 */
export interface Character {
  id: string;
  name: string;
  /** One short line. Shown on the select strip. */
  tagline: string;
  color: number;
  /** Total lifetime gold required. 0 = available from the first run. */
  unlockGold: number;
  startWeapon: WeaponId;
  startWeaponLevel: number;
  /**
   * The character's active ability — its second verb.
   *
   * This is what makes the roster mechanically distinct rather than numerically
   * distinct. Six stat lines give a player no reason to learn a new character;
   * six different buttons do.
   */
  ability: AbilityId;
  /** Multipliers and offsets applied at run start. */
  maxHp: number;
  speedMult: number;
  damageMult: number;
  fireRateMult: number;
  areaMult: number;
  projectileCount: number;
}

export const CHARACTERS: readonly Character[] = [
  {
    id: 'scout',
    name: 'SCOUT',
    tagline: 'Fast and even-handed',
    color: 0x8ef7ff,
    unlockGold: 0,
    startWeapon: 'bolt',
    startWeaponLevel: 1,
    maxHp: 140,
    speedMult: 1.12,
    damageMult: 1,
    fireRateMult: 1,
    areaMult: 1,
    projectileCount: 0,
    ability: 'blink',
  },
  {
    id: 'lance',
    name: 'LANCE',
    tagline: 'Hits harder, breaks easier',
    color: 0xffd23a,
    unlockGold: 250,
    startWeapon: 'bolt',
    startWeaponLevel: 2,
    maxHp: 118,
    speedMult: 1,
    damageMult: 1.14,
    fireRateMult: 1,
    areaMult: 1,
    projectileCount: 1,
    ability: 'volley',
  },
  {
    id: 'ward',
    name: 'WARD',
    tagline: 'Burns everything that touches you',
    color: 0x7dff9b,
    unlockGold: 700,
    startWeapon: 'aura',
    startWeaponLevel: 2,
    maxHp: 170,
    speedMult: 0.9,
    damageMult: 1,
    fireRateMult: 1,
    areaMult: 1.15,
    projectileCount: 0,
    ability: 'bulwark',
  },
  {
    id: 'echo',
    name: 'ECHO',
    tagline: 'Lightning, and lots of it',
    color: 0x5cd0ff,
    unlockGold: 1500,
    startWeapon: 'chain',
    startWeaponLevel: 2,
    maxHp: 124,
    speedMult: 1.05,
    damageMult: 0.9,
    fireRateMult: 1.3,
    areaMult: 1,
    projectileCount: 0,
    ability: 'recall',
  },
  {
    id: 'nova',
    name: 'NOVA',
    tagline: 'Enormous blasts, slow to reload',
    color: 0xff8f3a,
    unlockGold: 3000,
    startWeapon: 'nova',
    startWeaponLevel: 2,
    maxHp: 158,
    speedMult: 0.95,
    damageMult: 1.15,
    // 0.88, not 0.80. fireRateMult was a no-op on several weapons until the
    // orbit/aura tick fix, so this penalty only became real just now — and it
    // immediately made NOVA the weakest character by a wide margin.
    fireRateMult: 0.88,
    areaMult: 1.35,
    projectileCount: 0,
    ability: 'detonate',
  },
  {
    id: 'eclipse',
    name: 'ECLIPSE',
    tagline: 'Blades close, health thin',
    color: 0xb478ff,
    unlockGold: 6000,
    startWeapon: 'orbit',
    startWeaponLevel: 3,
    /**
     * Raised AGAIN, and this time the reasoning is structural rather than a
     * number nudge.
     *
     * ORBIT is contact-range, so ECLIPSE has to stand inside the crowd to deal
     * damage — and the crowding rule is precisely what kills players. Its
     * ability then drags MORE enemies onto it. The identity is good and unlike
     * anything else in the roster, but it was fighting the game's central
     * danger with a mid-tier health pool: measured at 136hp it still finished
     * dead last at 149s against LANCE's 267s, while costing 24 times as much.
     *
     * A brawler has to be able to brawl. This is now by far the largest health
     * pool in the game, with the area to make the blades actually sweep, so the
     * trade it offers is real: you stand in the fire and you have the
     * constitution for it.
     *
     * Health specifically, and not damage: the power index that drives adaptive
     * threat reads offence but not maximum health, so a damage buff here
     * partly cancels itself while a health buff does not. Raising the
     * singularity's damage instead measurably made this character WORSE.
     */
    maxHp: 205,
    speedMult: 1.14,
    damageMult: 1.28,
    fireRateMult: 1.12,
    areaMult: 1.12,
    projectileCount: 0,
    ability: 'singularity',
  },
];

export const DEFAULT_CHARACTER = CHARACTERS[0]!;

export function characterById(id: string): Character {
  return CHARACTERS.find((c) => c.id === id) ?? DEFAULT_CHARACTER;
}

export function isUnlocked(c: Character, totalGold: number): boolean {
  return totalGold >= c.unlockGold;
}

export function unlockedCharacters(totalGold: number): Character[] {
  return CHARACTERS.filter((c) => isUnlocked(c, totalGold));
}

/** Characters whose threshold sits between two gold totals. */
export function charactersCrossed(before: number, after: number): Character[] {
  return CHARACTERS.filter((c) => c.unlockGold > 0 && before < c.unlockGold && after >= c.unlockGold);
}

export function nextCharacter(totalGold: number): Character | null {
  for (const c of CHARACTERS) {
    if (totalGold < c.unlockGold) return c;
  }
  return null;
}
