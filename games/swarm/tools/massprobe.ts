/**
 * The mass economy: does the arena now contain a fight?
 *
 * Written before a single pixel of the siphon was drawn, because the failure
 * this project keeps hitting is a mechanic that reads beautifully in the source
 * and never once executes. The first question here is not "is it balanced", it
 * is "did it happen at all".
 *
 * What it measures:
 *   - siphon reach:   how often two seats are close enough for mass to move
 *   - siphon volume:  how much of the final mass was TAKEN rather than earned
 *   - the shatter:    how much of a dead rival's pile gets collected
 *   - the food chain: does the lead change hands, and is the leader hunted
 *   - the cost of being fat: do the biggest seats die more than the lean ones
 */
import { FIXED_STEP } from '@arcade/core';
import { CHARACTERS } from '../src/content/characters.js';
import { LOBBY_SIZE, makeRivals } from '../src/content/rivals.js';
import { RivalBrain } from '../src/sim/seatai.js';
import { World } from '../src/sim/world.js';
import { MASS, seatRadius } from '../src/content/balance.js';

const RUNS = 24;
const CAP = 210;

let siphonSteps = 0;
let totalSteps = 0;
let siphonedMass = 0;
let earnedMass = 0;
let leaderChanges = 0;
let leaderDrained = 0;
let racesWithSiphon = 0;
let racesWithShatter = 0;
let shatterGems = 0;
const lockSamples: number[] = [];
let fullLock = 0;
let targetSwitches = 0;
let handoffEvents = 0;
let privacySum = 0;
let privacyN = 0;
const peakMass: number[] = [];
const finalSpread: number[] = [];
const fatDeaths: Array<{ rank: number; died: boolean }> = [];
const deaths: number[] = [];

for (let run = 0; run < RUNS; run++) {
  const seed = 90_001 + run * 6_073;
  const profiles = makeRivals(seed, LOBBY_SIZE);
  const world = new World(seed);
  world.enterArena(profiles.slice(1), CHARACTERS, { seed });
  world.reset(seed, CHARACTERS[run % CHARACTERS.length]!);
  world.setView(320, 240);
  const driver = new RivalBrain(profiles[0]!, seed, 0);

  // Mass a seat holds, sampled each step, so growth can be split into what it
  // earned from the field and what it took off somebody.
  const previous = world.players.map((p) => p.arenaScore);
  let sawSiphon = false;
  let sawShatter = false;
  let lastLeader = -1;
  let runPeak = 0;
  let downs = 0;
  const lastTarget = world.players.map(() => -2);

  for (let step = 0; step < CAP / FIXED_STEP; step++) {
    if (world.phase === 'dead') break;
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
    totalSteps++;

    if (world.siphons.length > 0) {
      siphonSteps++;
      sawSiphon = true;
      const leader = world.standings()[0];
      for (const s of world.siphons) {
        if (leader && s.from === leader.index) leaderDrained++;
      }
    }

    // Split each seat's change in mass into taken vs earned.
    for (let i = 0; i < world.players.length; i++) {
      const p = world.players[i]!;
      const delta = p.arenaScore - previous[i]!;
      previous[i] = p.arenaScore;
      if (delta > 0) earnedMass += delta;
      runPeak = Math.max(runPeak, p.arenaScore);
    }
    for (const s of world.siphons) {
      siphonedMass += s.amount;
      lockSamples.push(s.lock);
      if (s.lock >= 0.99) fullLock++;
    }
    for (const p of world.players) {
      if (!p.alive) continue;
      if (p.siphonTarget !== lastTarget[p.index]) {
        if (lastTarget[p.index] !== -2) targetSwitches++;
        lastTarget[p.index] = p.siphonTarget;
      }
    }

    const leader = world.standings()[0]?.index ?? -1;
    if (lastLeader >= 0 && leader !== lastLeader) leaderChanges++;
    lastLeader = leader;

    for (const ev of world.events) {
      if (ev.type === 'rivalDown') {
        downs++;
        sawShatter = true;
      }
      if (ev.type === 'handoff') handoffEvents++;
    }

    /**
     * The failure the old "re-target every step" comment warned about: sticky
     * aggro letting each player keep a private swarm, which makes the arena
     * EASIER the more people are in it. Measured as: of the enemies near a
     * seat, what share are actually chasing that seat? Near 100% means the
     * swarm has split into separate fights.
     */
    if (step % 30 === 0) {
      for (const seat of world.players) {
        if (!seat.alive) continue;
        let near = 0;
        let mine = 0;
        for (const e of world.enemies.active) {
          if (e.hp <= 0) continue;
          const dx = e.x - seat.x;
          const dy = e.y - seat.y;
          if (dx * dx + dy * dy > 300 * 300) continue;
          near++;
          if (e.seat === seat.index) mine++;
        }
        if (near >= 8) {
          privacySum += mine / near;
          privacyN++;
        }
      }
    }
    world.clearEvents();
    shatterGems = Math.max(shatterGems, world.gems.count);
  }

  if (sawSiphon) racesWithSiphon++;
  if (sawShatter) racesWithShatter++;
  peakMass.push(runPeak);
  const scores = world.players.map((p) => p.arenaScore);
  finalSpread.push(Math.max(...scores) - Math.min(...scores));
  deaths.push(downs);

  // Was the fattest seat punished for it?
  const byMass = world.players.slice().sort((a, b) => b.arenaScore - a.arenaScore);
  byMass.forEach((p, rank) => fatDeaths.push({ rank, died: !p.alive }));
}

const median = (xs: number[]): number => {
  const s = xs.slice().sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)] ?? 0;
};
const pct = (n: number, d: number): string => `${((100 * n) / Math.max(1, d)).toFixed(1)}%`;

console.log(`MASS PROBE — ${RUNS} eight-seat races`);
console.log(`  races where mass moved between seats  ${racesWithSiphon}/${RUNS}`);
console.log(`  steps with a live siphon              ${pct(siphonSteps, totalSteps)} of ${totalSteps}`);
console.log(`  races with an elimination             ${racesWithShatter}/${RUNS}`);
console.log(`  median eliminations per race          ${median(deaths)}`);
console.log(`  peak gems on the field                ${shatterGems}`);
console.log(`  median peak mass held                 ${median(peakMass).toFixed(0)}`);
console.log(`  median final spread                   ${median(finalSpread).toFixed(0)}`);
console.log(`  lead changes per race                 ${(leaderChanges / RUNS).toFixed(1)}`);
console.log(`  steps the LEADER was being drained    ${leaderDrained}`);
console.log(`  mass TAKEN off other players          ${siphonedMass.toFixed(0)}`);
console.log(`  median lock strength while draining   ${(median(lockSamples) * 100).toFixed(0)}%`);
console.log(`  drains at FULL lock                   ${pct(fullLock, lockSamples.length)}`);
console.log(`  target switches per race              ${(targetSwitches / RUNS).toFixed(0)}`);
console.log(`  HORDE HANDOFFS announced per race     ${(handoffEvents / RUNS).toFixed(1)}`);
console.log(`  share of a seat's nearby swarm that   ${(100 * privacySum / Math.max(1, privacyN)).toFixed(0)}%`);
console.log(`    is actually chasing that seat        (100% = the swarm has split into private fights)`);
console.log(`  ...as a share of all mass gained      ${pct(siphonedMass, earnedMass)}`);
console.log(`  body at median peak mass              ${seatRadius(median(peakMass)).toFixed(1)}px ` +
  `(${(seatRadius(median(peakMass)) / seatRadius(MASS.base)).toFixed(2)}x base)`);

const topThird = fatDeaths.filter((f) => f.rank < 3);
const bottomThird = fatDeaths.filter((f) => f.rank >= 5);
console.log(`  death rate, three fattest seats       ${pct(topThird.filter((f) => f.died).length, topThird.length)}`);
console.log(`  death rate, three leanest seats       ${pct(bottomThird.filter((f) => f.died).length, bottomThird.length)}`);

if (racesWithSiphon === 0) {
  throw new Error('THE SIPHON NEVER FIRED — the mechanic does not execute');
}
if (siphonSteps < totalSteps * 0.01) {
  throw new Error('Players are almost never close enough to siphon; the mechanic is theoretical');
}
