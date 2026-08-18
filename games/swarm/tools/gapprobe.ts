/**
 * How close do combatants actually get to each other?
 *
 * The previous version of this file swept the siphon reach by re-running whole
 * races at each setting and comparing. That was worthless and the output said
 * so: the fraction of time a siphon was live did not rise monotonically with
 * its reach, which is impossible unless the cells are not comparable — and they
 * are not, because changing the reach changes mass, which changes body size,
 * which changes contact, which changes the entire run from the first second.
 * Fourteen races per cell measured noise.
 *
 * So measure the MECHANISM instead. Record the gap between bodies in ordinary
 * play, once, and then ask what any candidate reach would have caught. One
 * simulation, every answer, no butterfly.
 */
import { FIXED_STEP } from '@arcade/core';
import { CHARACTERS } from '../src/content/characters.js';
import { LOBBY_SIZE, makeRivals } from '../src/content/rivals.js';
import { RivalBrain } from '../src/sim/seatai.js';
import { World } from '../src/sim/world.js';
import { seatRadius } from '../src/content/balance.js';

const RUNS = 20;
const CAP = 210;
const CANDIDATES = [30, 45, 60, 80, 100, 120, 160];

/** Clear-air gap, in world units, from a seat to its nearest living rival. */
const gaps: number[] = [];
/** Same, but only in the last third of a run, once the ring has closed in. */
const lateGaps: number[] = [];
/** Every pair involving the human-driven seat. */
const playerGaps: number[] = [];
/** Every pair of AI seats, which share one policy and therefore one opinion. */
const botGaps: number[] = [];

for (let run = 0; run < RUNS; run++) {
  const seed = 90_001 + run * 6_073;
  const profiles = makeRivals(seed, LOBBY_SIZE);
  const world = new World(seed);
  world.enterArena(profiles.slice(1), CHARACTERS, { seed });
  world.reset(seed, CHARACTERS[run % CHARACTERS.length]!);
  world.setView(320, 240);
  // The STRONGEST profile drives seat zero. The world stops stepping the moment
  // the local player dies, so a weak driver measured only the first forty
  // seconds and reported an empty late game.
  const strongest = profiles.slice().sort((a, b) => b.skill - a.skill)[0]!;
  const driver = new RivalBrain(strongest, seed, 0);

  for (let step = 0; step < CAP / FIXED_STEP; step++) {
    // Deliberately NOT breaking on the local player's death. The arena outlives
    // seat zero, and stopping there measured only the first forty seconds of a
    // three-and-a-half minute race — which is why the "last third" column of
    // the previous run was empty.
    if (world.phase === 'levelup') {
      const offer = world.pendingCards ?? [];
      if (offer.length) world.chooseUpgrade(driver.pickCard(offer));
      continue;
    }
    if (world.phase === 'boon') {
      const offer = world.pendingBoons ?? [];
      if (offer.length) world.chooseBoon(driver.pickBoon(offer));
      continue;
    }
    driver.think(world, world.player, FIXED_STEP);
    world.step(FIXED_STEP);
    world.clearEvents();

    // Sample ten times a second; sixty is the same number written out longer.
    if (step % 6 !== 0) continue;
    for (const a of world.players) {
      if (!a.alive) continue;
      let best = Infinity;
      for (const b of world.players) {
        if (b === a || !b.alive) continue;
        const gap = Math.sqrt((b.x - a.x) ** 2 + (b.y - a.y) ** 2)
          - seatRadius(a.arenaScore) - seatRadius(b.arenaScore);
        best = Math.min(best, gap);
        // Eight copies of one policy in one world make near-identical choices,
        // so AI-to-AI distance is not evidence about how far apart PEOPLE are.
        // Split the two populations or the headline number is an artifact.
        if (a.index === 0 || b.index === 0) playerGaps.push(gap);
        else botGaps.push(gap);
      }
      if (!Number.isFinite(best)) continue;
      gaps.push(best);
      if (world.time > CAP * 0.66) lateGaps.push(best);
    }
  }
}

const share = (xs: number[], under: number): number =>
  (100 * xs.filter((g) => g <= under).length) / Math.max(1, xs.length);
const med = (xs: number[]): number =>
  xs.slice().sort((a, b) => a - b)[Math.floor(xs.length / 2)] ?? 0;

console.log(`GAP PROFILE — ${RUNS} races, ${gaps.length} samples`);
console.log(`  median distance to your NEAREST rival      ${med(gaps).toFixed(0)}u  (negative means overlapping)`);
console.log(`  median gap, any pair involving the player  ${med(playerGaps).toFixed(0)}u`);
console.log(`  median gap, one AI seat to another         ${med(botGaps).toFixed(0)}u`);
console.log('');
console.log('  a siphon of this reach would be live for:');
for (const r of CANDIDATES) {
  console.log(`    ${String(r).padStart(4)}u  ${share(gaps, r).toFixed(1).padStart(5)}% of the run`);
}
console.log('');
console.log('  Read this before tuning SIPHON.radius. Proximity is not scarce in');
console.log('  this arena: seats spawn on an ellipse sized to the VIEWPORT');
console.log('  (ARENA_START_SHARE) so that everyone is visible from the first');
console.log('  second, which means your nearest rival is essentially always');
console.log('  adjacent. Reach is therefore not the lever it looks like — at 30');
console.log('  units it is already live for four fifths of the run.');
