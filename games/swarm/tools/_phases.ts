import type { World } from '../src/sim/world.js';

/**
 * Phase handling for every offline harness, in one place.
 *
 * WHY THIS FILE EXISTS. `World.step()` returns immediately unless the phase is
 * 'playing', so a harness that does not answer a phase does not slow down — it
 * stops, silently, and keeps reporting the numbers from the moment it froze.
 * When the 'boon' phase was added, five probes kept running to completion and
 * kept printing plausible results measured entirely from the first boss kill
 * onward: a run whose median is 250s was being characterised by its first 82
 * seconds, and tuning comments cite those numbers as evidence.
 *
 * Every harness routes through `resolve()` so the next phase that gets added
 * breaks one function instead of five files. And `Stall` exists because the
 * failure is silent by nature: something has to notice that time stopped
 * moving, or the next unhandled phase costs another round of bad evidence.
 */

export type PhaseAction = 'again' | 'play' | 'dead';

export interface PhaseChoices {
  /** Which card to take. Defaults to the first offered. */
  card?: (world: World) => string;
  /** Which boon to take. Defaults to the first offered. */
  boon?: (world: World) => string;
}

/**
 * Answer whatever the world is currently asking for.
 *
 * Returns 'again' when a choice was made and the caller should re-enter the
 * loop without advancing time, 'play' when the world is ready to step, and
 * 'dead' when the run is over.
 */
export function resolve(world: World, choices: PhaseChoices = {}): PhaseAction {
  switch (world.phase) {
    case 'playing':
      return 'play';
    case 'dead':
      return 'dead';
    case 'levelup': {
      const cards = world.pendingCards;
      if (!cards || cards.length === 0) return 'play';
      world.chooseUpgrade(choices.card ? choices.card(world) : cards[0]!.id);
      return 'again';
    }
    case 'boon': {
      const offer = world.pendingBoons;
      if (!offer || offer.length === 0) return 'play';
      world.chooseBoon(choices.boon ? choices.boon(world) : offer[0]!);
      return 'again';
    }
    default: {
      // An unhandled phase is the exact bug this file exists to prevent, so it
      // is loud rather than a silent freeze.
      throw new Error(
        `harness does not handle phase '${String(world.phase)}' — add it to tools/_phases.ts`,
      );
    }
  }
}

/**
 * Notices when a run stops advancing.
 *
 * Guards on `world.time` rather than on consecutive non-playing iterations:
 * `chooseUpgrade` chains into `checkLevelUp`, so several level-ups legitimately
 * land back to back and a naive counter would fire on a healthy run.
 */
export class Stall {
  private lastTime = -1;
  private idle = 0;

  constructor(private readonly limit = 400) {}

  /** Throws if time has failed to move for `limit` consecutive iterations. */
  check(world: World): void {
    if (world.time > this.lastTime) {
      this.lastTime = world.time;
      this.idle = 0;
      return;
    }
    if (++this.idle > this.limit) {
      throw new Error(
        `harness stalled at t=${world.time.toFixed(1)}s in phase '${String(world.phase)}' — ` +
          `the world stopped advancing and every number after this point is from a frozen run`,
      );
    }
  }
}
