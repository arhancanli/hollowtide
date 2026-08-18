import type { Portal } from '@arcade/portal';
import { DEFAULT_CHARACTER, characterById, type Character } from '../content/characters.js';
import { masteryLevel } from '../content/mastery.js';

const KEY = 'swarm.meta.v3';
/** Read once, for players who already have a v2 save. */
const LEGACY_KEY = 'swarm.meta.v2';

export interface MetaState {
  bestTime: number;
  /**
   * Gold EARNED over the account's life. Kept for achievements and stats, and
   * as the migration anchor from v2 — it is no longer what anything is gated on.
   */
  totalGold: number;
  /**
   * Gold available to spend. This is the number the player sees.
   *
   * v2 had only `totalGold`, which only ever incremented and which the character
   * unlocks keyed off directly — so there was no sink, nothing was ever
   * deducted, and the whole meta-game resolved in two or three runs. Splitting
   * earned from spendable is what makes gold a currency instead of a score.
   */
  gold: number;
  /** Purchased Forge levels, by track id. */
  forge: Record<string, number>;
  /** Character ids bought with gold. */
  ownedCharacters: string[];
  runs: number;
  /** Currently selected character id. */
  character: string;
  /** Earned achievement ids. */
  achievements: string[];
  /** Best time on the daily seed, keyed by UTC day. Only today is kept. */
  dailyDay: string;
  dailyBest: number;
  /** Per-character best times, so each one has its own thing to beat. */
  bestByCharacter: Record<string, number>;
  /**
   * Persisted mute.
   *
   * Every page load started unmuted regardless of what the player chose last
   * time — real friction on mobile web, where a large share of sessions happen
   * somewhere audio is not acceptable.
   */
  muted: boolean;
  /**
   * Has this player EVER used an active ability.
   *
   * Retires the teaching beat forever rather than per-run: a hint that returns
   * every session is clutter, and one that never appears leaves six abilities
   * invisible. Persisted for the same reason the movement hint is.
   */
  abilityUsed: boolean;
  /** Difficulty tier chosen for the next run. */
  ascension: number;
  /** Best time reached at each tier, keyed by tier number. Drives unlocks. */
  bestByAscension: Record<string, number>;
  /** Mastery experience per character id. See content/mastery.ts. */
  mastery: Record<string, number>;
  /** Competitive records; separate from survival time so each mode has a chase. */
  arenaBestMass: number;
  arenaBestPlace: number;
  arenaBestPvpKills: number;
  arenaRuns: number;
  arenaWins: number;
}

const EMPTY: MetaState = {
  bestTime: 0,
  totalGold: 0,
  gold: 0,
  forge: {},
  ownedCharacters: [],
  runs: 0,
  character: DEFAULT_CHARACTER.id,
  achievements: [],
  dailyDay: '',
  dailyBest: 0,
  bestByCharacter: {},
  muted: false,
  abilityUsed: false,
  ascension: 0,
  bestByAscension: {},
  mastery: {},
  arenaBestMass: 0,
  arenaBestPlace: 0,
  arenaBestPvpKills: 0,
  arenaRuns: 0,
  arenaWins: 0,
};

/**
 * Persistent meta progression.
 *
 * Goes through the Portal rather than touching localStorage directly, so
 * phase 5 can swap in CrazyGames' synced save (and later Supabase for the
 * cross-game account) without any call site changing.
 *
 * Reads are cached in memory and writes are fire-and-forget, because this gets
 * touched on the death screen where every millisecond is between the player
 * and the restart button.
 */
export class MetaStore {
  private state: MetaState = structuredCloneState(EMPTY);
  private readonly portal: Portal;

  constructor(portal: Portal) {
    this.portal = portal;
  }

  get current(): Readonly<MetaState> {
    return this.state;
  }

  get character(): Character {
    return characterById(this.state.character);
  }

  /**
   * Re-read after the player signs in, MERGING rather than replacing.
   *
   * A signed-out player has usually already built something locally, and the
   * cloud copy may be older, newer or empty. Taking either side wholesale
   * throws away real progress — so every field takes the better of the two:
   * the higher best time, the larger gold balance, the union of achievements
   * and characters, the deeper Forge level. A player can only ever gain by
   * signing in, which is the only version of this that is safe to prompt.
   */
  async reloadAndMerge(): Promise<void> {
    const local = structuredCloneState(this.state);
    await this.load();
    const cloud = this.state;
    const forge: Record<string, number> = { ...cloud.forge };
    for (const [k, v] of Object.entries(local.forge)) {
      forge[k] = Math.max(forge[k] ?? 0, v);
    }
    const bestBy: Record<string, number> = { ...cloud.bestByCharacter };
    for (const [k, v] of Object.entries(local.bestByCharacter)) {
      bestBy[k] = Math.max(bestBy[k] ?? 0, v);
    }
    this.state = {
      ...cloud,
      bestTime: Math.max(cloud.bestTime, local.bestTime),
      totalGold: Math.max(cloud.totalGold, local.totalGold),
      gold: Math.max(cloud.gold, local.gold),
      runs: Math.max(cloud.runs, local.runs),
      forge,
      bestByCharacter: bestBy,
      bestByAscension: (() => {
        const merged: Record<string, number> = { ...cloud.bestByAscension };
        for (const [k, v] of Object.entries(local.bestByAscension)) {
          merged[k] = Math.max(merged[k] ?? 0, v);
        }
        return merged;
      })(),
      ascension: Math.max(cloud.ascension, local.ascension),
      mastery: (() => {
        const merged: Record<string, number> = { ...cloud.mastery };
        for (const [k, v] of Object.entries(local.mastery)) {
          merged[k] = Math.max(merged[k] ?? 0, v);
        }
        return merged;
      })(),
      ownedCharacters: [...new Set([...cloud.ownedCharacters, ...local.ownedCharacters])],
      achievements: [...new Set([...cloud.achievements, ...local.achievements])],
      abilityUsed: cloud.abilityUsed || local.abilityUsed,
      muted: local.muted,
      arenaBestMass: Math.max(cloud.arenaBestMass, local.arenaBestMass),
      arenaBestPlace: bestPlace(cloud.arenaBestPlace, local.arenaBestPlace),
      arenaBestPvpKills: Math.max(cloud.arenaBestPvpKills, local.arenaBestPvpKills),
      arenaRuns: Math.max(cloud.arenaRuns, local.arenaRuns),
      arenaWins: Math.max(cloud.arenaWins, local.arenaWins),
    };
    this.save();
  }

  async load(): Promise<void> {
    let raw = await this.portal.load(KEY);
    /**
     * Migrate a v2 save rather than resetting it.
     *
     * A returning player whose unlocks silently vanished would be right to stop
     * playing. v2 gold was lifetime-only and nothing was ever spent, so their
     * entire earned total converts to spendable balance — they arrive at the new
     * Forge with everything they earned under the old rules still theirs.
     */
    if (!raw) {
      const legacy = await this.portal.load(LEGACY_KEY);
      if (!legacy) return;
      try {
        const old = JSON.parse(legacy) as Partial<MetaState>;
        raw = JSON.stringify({ ...old, gold: Number(old.totalGold) || 0, forge: {}, ownedCharacters: [] });
      } catch {
        return;
      }
    }
    try {
      const parsed = JSON.parse(raw) as Partial<MetaState>;
      this.state = {
        bestTime: Number(parsed.bestTime) || 0,
        totalGold: Number(parsed.totalGold) || 0,
        gold: Number(parsed.gold) || 0,
        forge:
          parsed.forge && typeof parsed.forge === 'object'
            ? (parsed.forge as Record<string, number>)
            : {},
        ownedCharacters: Array.isArray(parsed.ownedCharacters)
          ? parsed.ownedCharacters.filter((c) => typeof c === 'string')
          : [],
        runs: Number(parsed.runs) || 0,
        character: typeof parsed.character === 'string' ? parsed.character : DEFAULT_CHARACTER.id,
        achievements: Array.isArray(parsed.achievements) ? parsed.achievements.filter((a) => typeof a === 'string') : [],
        dailyDay: typeof parsed.dailyDay === 'string' ? parsed.dailyDay : '',
        dailyBest: Number(parsed.dailyBest) || 0,
        bestByCharacter:
          parsed.bestByCharacter && typeof parsed.bestByCharacter === 'object'
            ? (parsed.bestByCharacter as Record<string, number>)
            : {},
        muted: parsed.muted === true,
        abilityUsed: parsed.abilityUsed === true,
        ascension: Number(parsed.ascension) || 0,
        bestByAscension:
          parsed.bestByAscension && typeof parsed.bestByAscension === 'object'
            ? (parsed.bestByAscension as Record<string, number>)
            : {},
        mastery:
          parsed.mastery && typeof parsed.mastery === 'object'
            ? (parsed.mastery as Record<string, number>)
            : {},
        arenaBestMass: Number(parsed.arenaBestMass) || 0,
        arenaBestPlace: Number(parsed.arenaBestPlace) || 0,
        arenaBestPvpKills: Number(parsed.arenaBestPvpKills) || 0,
        arenaRuns: Number(parsed.arenaRuns) || 0,
        arenaWins: Number(parsed.arenaWins) || 0,
      };
    } catch {
      // Corrupt or hand-edited save. Start clean rather than crashing the boot.
      this.state = structuredCloneState(EMPTY);
    }
  }

  masteryXp(characterId: string): number {
    return this.state.mastery[characterId] ?? 0;
  }

  /** Award mastery. Returns the levels gained, so the host can celebrate them. */
  addMastery(characterId: string, xp: number): number {
    const before = masteryLevel(this.masteryXp(characterId)).level;
    this.state.mastery[characterId] = this.masteryXp(characterId) + Math.max(0, xp);
    this.save();
    return masteryLevel(this.masteryXp(characterId)).level - before;
  }

  setAscension(level: number): void {
    this.state.ascension = level;
    this.save();
  }

  /**
   * Record a run at a tier. Returns true if it unlocked the next rung.
   *
   * Unlocks are earned by SURVIVING rather than by winning, because there is no
   * win — and the threshold sits below the measured median at each tier so the
   * next rung is always visible rather than theoretical.
   */
  recordAscension(level: number, time: number): boolean {
    const key = String(level);
    const prev = this.state.bestByAscension[key] ?? 0;
    if (time <= prev) return false;
    this.state.bestByAscension[key] = time;
    this.save();
    return true;
  }

  markAbilityUsed(): void {
    if (this.state.abilityUsed) return;
    this.state.abilityUsed = true;
    this.save();
  }

  setMuted(muted: boolean): void {
    this.state.muted = muted;
    this.save();
  }

  selectCharacter(id: string): void {
    this.state.character = id;
    this.save();
  }

  /** Returns whether this run set a new overall best. */
  recordRun(time: number, gold: number, characterId: string): boolean {
    const isBest = time > this.state.bestTime;
    this.state.bestTime = Math.max(this.state.bestTime, time);
    this.state.totalGold += gold;
    this.state.gold += gold;
    this.state.runs += 1;
    const prev = this.state.bestByCharacter[characterId] ?? 0;
    if (time > prev) this.state.bestByCharacter[characterId] = time;
    this.save();
    return isBest;
  }

  recordArena(mass: number, place: number, pvpKills: number): { massBest: boolean; placeBest: boolean } {
    const massBest = mass > this.state.arenaBestMass;
    const placeBest = place > 0 && (this.state.arenaBestPlace === 0 || place < this.state.arenaBestPlace);
    this.state.arenaBestMass = Math.max(this.state.arenaBestMass, mass);
    if (placeBest) this.state.arenaBestPlace = place;
    this.state.arenaBestPvpKills = Math.max(this.state.arenaBestPvpKills, pvpKills);
    this.state.arenaRuns++;
    if (place === 1) this.state.arenaWins++;
    this.save();
    return { massBest, placeBest };
  }

  bestFor(characterId: string): number {
    return this.state.bestByCharacter[characterId] ?? 0;
  }

  /** Extra gold from a rewarded ad, applied after the run was recorded. */
  addGold(gold: number): void {
    this.state.totalGold += gold;
    this.state.gold += gold;
    this.save();
  }

  /** Deduct, or return false and change nothing. */
  spend(amount: number): boolean {
    if (amount <= 0 || this.state.gold < amount) return false;
    this.state.gold -= amount;
    this.save();
    return true;
  }

  forgeLevel(trackId: string): number {
    return this.state.forge[trackId] ?? 0;
  }

  /** Buy one level of a Forge track. Returns false if unaffordable or maxed. */
  buyForge(trackId: string, cost: number): boolean {
    if (!this.spend(cost)) return false;
    this.state.forge[trackId] = (this.state.forge[trackId] ?? 0) + 1;
    this.save();
    return true;
  }

  ownsCharacter(id: string): boolean {
    return this.state.ownedCharacters.includes(id);
  }

  buyCharacter(id: string, cost: number): boolean {
    if (this.ownsCharacter(id)) return false;
    if (!this.spend(cost)) return false;
    this.state.ownedCharacters.push(id);
    this.save();
    return true;
  }

  /** Returns the achievement ids that were newly added. */
  awardAchievements(ids: readonly string[]): string[] {
    const held = new Set(this.state.achievements);
    const fresh = ids.filter((id) => !held.has(id));
    if (fresh.length === 0) return [];
    this.state.achievements.push(...fresh);
    this.save();
    return fresh;
  }

  /**
   * Daily challenge best. Rolls over on UTC date change.
   *
   * Deliberately NOT a streak. A streak punishes you for missing a day, which
   * is the manipulative version of a return hook — this is just "today has its
   * own seed and its own score", which gives a reason to come back without
   * giving a reason to feel bad for not.
   */
  recordDaily(day: string, time: number): boolean {
    if (this.state.dailyDay !== day) {
      this.state.dailyDay = day;
      this.state.dailyBest = 0;
    }
    const isBest = time > this.state.dailyBest;
    if (isBest) this.state.dailyBest = time;
    this.save();
    return isBest;
  }

  dailyBestFor(day: string): number {
    return this.state.dailyDay === day ? this.state.dailyBest : 0;
  }

  private save(): void {
    void this.portal.save(KEY, JSON.stringify(this.state));
  }
}

function bestPlace(a: number, b: number): number {
  if (a <= 0) return b;
  if (b <= 0) return a;
  return Math.min(a, b);
}

function structuredCloneState(s: MetaState): MetaState {
  return {
    ...s,
    achievements: [...s.achievements],
    bestByCharacter: { ...s.bestByCharacter },
    bestByAscension: { ...s.bestByAscension },
    mastery: { ...s.mastery },
    forge: { ...s.forge },
    ownedCharacters: [...s.ownedCharacters],
  };
}
