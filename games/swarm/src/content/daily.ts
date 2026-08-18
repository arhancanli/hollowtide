/**
 * The daily challenge.
 *
 * The one mechanism in the game aimed at next-day return, and deliberately the
 * gentlest possible version: today has its own seed and its own best time, and
 * that is all. No streak, no counter that resets, no "come back or lose it".
 *
 * A streak would work — that is exactly why it is not here. It works by making
 * absence painful, and the owner ruled dark patterns out. This gives a reason
 * to come back without giving anyone a reason to feel bad for not.
 *
 * Everyone on the same UTC day plays an identical run, so a time is comparable
 * — which is what makes beating it mean something.
 */
export function dailyKey(nowMs: number): string {
  return new Date(nowMs).toISOString().slice(0, 10);
}

/** Deterministic 32-bit seed from the UTC day. */
export function dailySeed(day: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < day.length; i++) {
    h ^= day.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0) || 1;
}
