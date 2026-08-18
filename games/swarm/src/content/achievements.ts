/**
 * Achievements.
 *
 * The point is not completionism, it is DIRECTION. With a single number to beat
 * ("survive longer") a player runs out of motivation quickly, and the content
 * already built goes unseen — measured runs showed 15% ever reach the third
 * boss and 11% ever see an evolution.
 *
 * Each of these asks the player to play differently rather than merely longer,
 * which multiplies the value of content that already exists. They are also the
 * cheapest possible way to point a player at the parts of the game they have
 * not found yet.
 */
export interface RunStats {
  timeSec: number;
  level: number;
  kills: number;
  weaponsHeld: number;
  evolutions: number;
  bossesKilled: number;
  bossKindsKilled: string[];
  damageTaken: number;
  characterId: string;
  revived: boolean;
}

export interface Achievement {
  id: string;
  name: string;
  desc: string;
  /** Hidden until earned — used sparingly, for genuine surprises. */
  secret?: boolean;
  check: (r: RunStats) => boolean;
}

export const ACHIEVEMENTS: readonly Achievement[] = [
  { id: 'first100', name: 'CULLING', desc: 'Kill 100 in one run', check: (r) => r.kills >= 100 },
  { id: 'kills1000', name: 'TIDE', desc: 'Kill 1000 in one run', check: (r) => r.kills >= 1000 },
  { id: 'survive2', name: 'STANDING', desc: 'Survive 2 minutes', check: (r) => r.timeSec >= 120 },
  { id: 'survive4', name: 'ENDURING', desc: 'Survive 4 minutes', check: (r) => r.timeSec >= 240 },
  { id: 'survive7', name: 'UNBROKEN', desc: 'Survive 7 minutes', check: (r) => r.timeSec >= 420 },
  { id: 'boss1', name: 'GIANT KILLER', desc: 'Kill any boss', check: (r) => r.bossesKilled >= 1 },
  {
    id: 'allbosses',
    name: 'HEADHUNTER',
    desc: 'Kill all three bosses in one run',
    check: (r) => new Set(r.bossKindsKilled).size >= 3,
  },
  { id: 'evolve', name: 'ASCENDANT', desc: 'Reach an evolution', check: (r) => r.evolutions >= 1 },
  {
    id: 'evolve3',
    name: 'TRANSCENDENT',
    desc: 'Reach three evolutions in one run',
    check: (r) => r.evolutions >= 3,
  },
  { id: 'arsenal', name: 'ARSENAL', desc: 'Hold six weapons at once', check: (r) => r.weaponsHeld >= 6 },
  {
    id: 'untouched',
    name: 'FLAWLESS',
    desc: 'Reach 60s without taking a hit',
    check: (r) => r.timeSec >= 60 && r.damageTaken === 0,
  },
  {
    id: 'nohelp',
    name: 'NO SECOND CHANCES',
    desc: 'Survive 3 minutes without reviving',
    check: (r) => r.timeSec >= 180 && !r.revived,
  },
];

export const ACHIEVEMENTS_BY_ID = new Map(ACHIEVEMENTS.map((a) => [a.id, a]));

/** Achievements earned by this run that were not already held. */
export function newlyEarned(r: RunStats, already: readonly string[]): Achievement[] {
  const held = new Set(already);
  return ACHIEVEMENTS.filter((a) => !held.has(a.id) && a.check(r));
}
