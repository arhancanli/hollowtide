/** Multiplayer-specific regression probe: does an eight-seat run create a race? */
import { FIXED_STEP } from '@arcade/core';
import { CHARACTERS } from '../src/content/characters.js';
import { makeRivals } from '../src/content/rivals.js';
import { RivalBrain } from '../src/sim/seatai.js';
import { World } from '../src/sim/world.js';

const RUNS = 24;
const CAP = 210;
let totalHits = 0;
let totalDowns = 0;
let contested = 0;
const scoreSpreads: number[] = [];
const places: number[] = [];

for (let run = 0; run < RUNS; run++) {
  const seed = 70_001 + run * 7_919;
  const profiles = makeRivals(seed, 8);
  const world = new World(seed);
  world.enterArena(profiles.slice(1), CHARACTERS);
  world.reset(seed, CHARACTERS[run % CHARACTERS.length]!);
  world.setView(640, 360);
  const driver = new RivalBrain(profiles[0]!, seed, 0);
  const leaders = new Set<number>();
  let downs = 0;

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
    leaders.add(world.standings()[0]?.index ?? -1);
    for (const ev of world.events) if (ev.type === 'rivalDown') downs++;
    world.clearEvents();
  }

  const scores = world.players.map((p) => p.arenaScore);
  scoreSpreads.push(Math.max(...scores) - Math.min(...scores));
  places.push(world.standings().findIndex((p) => p.index === 0) + 1);
  totalHits += world.pvpHits;
  totalDowns += downs;
  if (leaders.size >= 2) contested++;
}

scoreSpreads.sort((a, b) => a - b);
places.sort((a, b) => a - b);
const median = (xs: number[]) => xs[Math.floor(xs.length / 2)] ?? 0;

console.log('ARENA PROBE — 24 eight-seat races');
console.log(`  PvP hits             ${totalHits}`);
console.log(`  rival eliminations   ${totalDowns}`);
console.log(`  contested lead       ${contested}/${RUNS} runs`);
console.log(`  median mass spread   ${median(scoreSpreads).toFixed(0)}`);
console.log(`  player median place  #${median(places)}`);

if (totalHits < RUNS * 10) throw new Error('Arena produced too little player contact');
if (totalDowns < RUNS) throw new Error('Arena produced fewer than one rival elimination per run');
if (contested < RUNS * 0.4) throw new Error('Arena leader was too static');
if (median(scoreSpreads) < 50) throw new Error('Growth race did not create meaningful separation');
