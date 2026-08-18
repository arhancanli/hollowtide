/**
 * The permanent unlock ladder.
 *
 * Its only job right now is to be VISIBLE. The results screen shows the next
 * one as a silhouette with a bar creeping toward it, because "I got somewhere
 * even though I died" is the single biggest driver of starting run 2 — and
 * run 2 is the number CrazyGames actually rewards.
 *
 * The unlocks do not grant anything yet; wiring them into starting loadouts is
 * phase 4 work alongside the real meta backend. Showing the ladder is what
 * matters for retention, and it has to exist from run 1.
 */
export interface Unlock {
  id: string;
  name: string;
  cost: number;
  color: number;
}

export const UNLOCKS: readonly Unlock[] = [
  { id: 'lance', name: 'LANCE', cost: 250, color: 0xffd23a },
  { id: 'ward', name: 'WARD', cost: 700, color: 0x7dff9b },
  { id: 'echo', name: 'ECHO', cost: 1500, color: 0x5cd0ff },
  { id: 'nova', name: 'NOVA', cost: 3000, color: 0xff8f3a },
  { id: 'eclipse', name: 'ECLIPSE', cost: 6000, color: 0xb478ff },
];

/**
 * Gold for a run. Weighted toward time survived rather than kills, because
 * time is the metric the portals actually measure and the one we want players
 * optimising for.
 */
export function goldFor(timeSurvived: number, kills: number, level: number): number {
  return Math.floor(timeSurvived * 2.5 + kills * 0.8 + level * 12);
}

/** Unlocks whose threshold sits between two gold totals. */
export function unlocksCrossed(before: number, after: number): Unlock[] {
  return UNLOCKS.filter((u) => before < u.cost && after >= u.cost);
}

export function nextUnlock(totalGold: number): { unlock: Unlock; prevCost: number } | null {
  let prevCost = 0;
  for (const unlock of UNLOCKS) {
    if (totalGold < unlock.cost) return { unlock, prevCost };
    prevCost = unlock.cost;
  }
  return null;
}
