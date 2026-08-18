/**
 * Build-convergence probe.
 *
 * Question: after N level-ups, how DIFFERENT are two runs from each other?
 * In this genre the reason to start run 7 is "next run I want X with Y". That
 * only exists if the end state of a run is not forced.
 *
 * Method: immortal player (HP pinned), 13 minutes, four draft policies x six
 * characters x three seeds. Record final weapon set, final passive stacks and
 * evolutions. Then measure pairwise Jaccard similarity of end loadouts.
 */
import { FIXED_STEP } from '@arcade/core';
import { Stall } from './_phases.js';
import { World } from '../src/sim/world.js';
import { WEAPONS, type WeaponId } from '../src/content/weapons.js';
import { CHARACTERS } from '../src/content/characters.js';
import { PASSIVES } from '../src/content/upgrades.js';

const SIM_SECONDS = 780;
type Draft = 'collector' | 'specialist' | 'evolution' | 'first' | 'random';

function makeRng(seed: number): () => number {
  let s = seed >>> 0 || 1;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), 1 | t);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function chooseCard(world: World, draft: Draft, rng: () => number): void {
  const cards = world.pendingCards;
  if (!cards || cards.length === 0) return;
  const evolution = cards.find((c) => c.kind === 'evolution');
  const fresh = cards.find((c) => c.kind === 'weapon' && c.levelLabel === '');
  const level = cards.find((c) => c.kind === 'weapon' && c.levelLabel !== '');
  const passive = cards.find((c) => c.kind === 'passive');
  let pick = cards[0]!;
  if (draft === 'collector') pick = evolution ?? fresh ?? level ?? cards[0]!;
  else if (draft === 'specialist') pick = evolution ?? level ?? fresh ?? cards[0]!;
  else if (draft === 'evolution') {
    const enabling = cards.find(
      (c) => c.kind === 'passive' && world.player.weapons.some((w) => WEAPONS[w.id].evolveWith === c.passiveId),
    );
    pick = evolution ?? enabling ?? level ?? fresh ?? cards[0]!;
  } else if (draft === 'first') pick = cards[0]!;
  else pick = cards[Math.floor(rng() * cards.length)]!;
  // Bias 'collector' toward passives sometimes so policies really differ.
  if (draft === 'collector' && !evolution && !fresh && passive && rng() < 0.5) pick = passive;
  world.chooseUpgrade(pick.id);
}

interface End {
  key: string;
  weapons: WeaponId[];
  evolved: WeaponId[];
  stacks: Record<string, number>;
  level: number;
  levelUps: number;
  buildCompleteAt: number | null;
  lastNoveltyAt: number;
}

function runOnce(seed: number, draft: Draft, charIndex: number): End {
  const character = CHARACTERS[charIndex % CHARACTERS.length]!;
  const world = new World(seed);
  world.reset(seed, character);
  world.setView(240, 498);
  const rng = makeRng(seed ^ 0x1234567);
  let heading = rng() * Math.PI * 2;
  let cd = 0;
  let levelUps = 0;
  let lastNoveltyAt = 0;
  let buildCompleteAt: number | null = null;

  const steps = Math.ceil(SIM_SECONDS / FIXED_STEP);
  const stall = new Stall();
  for (let i = 0; i < steps; i++) {
    stall.check(world);
    if (world.phase === 'boon') {
      // A boss boon. Without this branch the world sits in 'boon' forever and
      // step() silently returns, so the probe runs to completion reporting
      // numbers frozen at the first boss kill.
      const offer = world.pendingBoons;
      if (offer && offer.length > 0) world.chooseBoon(offer[0]!);
      else break;
      continue;
    }
    if (world.phase === 'levelup') {
      chooseCard(world, draft, rng);
      levelUps++;
      continue;
    }
    // Immortality: pin HP each frame so the run always reaches 13 minutes.
    world.player.hp = world.player.maxHp;
    world.player.invul = 1;
    cd -= FIXED_STEP;
    if (cd <= 0) {
      cd = 0.12;
      heading += (rng() - 0.5) * 1.4;
    }
    world.input.x = Math.cos(heading);
    world.input.y = Math.sin(heading);
    world.step(FIXED_STEP);
    for (const ev of world.events) {
      if (ev.type === 'evolved' || ev.type === 'weaponGained') lastNoveltyAt = world.time;
    }
    world.clearEvents();
    if (buildCompleteAt === null && world.player.weapons.length >= 6) {
      const allMax = world.player.weapons.every(
        (w) => w.level >= WEAPONS[w.id].maxLevel || WEAPONS[w.id].evolved,
      );
      if (allMax) buildCompleteAt = world.time;
    }
  }
  const weapons = world.player.weapons.map((w) => w.id).sort();
  const evolved = weapons.filter((w) => WEAPONS[w].evolved);
  const stacks: Record<string, number> = {};
  for (const p of PASSIVES) stacks[p.id] = world.stacksOf(p.id);
  return {
    key: `${character.id}/${draft}/${seed}`,
    weapons,
    evolved,
    stacks,
    level: world.level,
    levelUps,
    buildCompleteAt,
    lastNoveltyAt,
  };
}

function jaccard(a: string[], b: string[]): number {
  const A = new Set(a);
  const B = new Set(b);
  let inter = 0;
  for (const x of A) if (B.has(x)) inter++;
  return inter / (A.size + B.size - inter);
}

const drafts: Draft[] = ['collector', 'specialist', 'evolution', 'first', 'random'];
const results: End[] = [];
for (const d of drafts) {
  for (let c = 0; c < CHARACTERS.length; c++) {
    for (const seed of [11, 4242]) {
      results.push(runOnce(seed, d, c));
    }
  }
}

for (const r of results) {
  console.log(
    r.key.padEnd(28),
    `lv${String(r.level).padStart(3)}`,
    `ups${String(r.levelUps).padStart(3)}`,
    'W:' + r.weapons.join(',').padEnd(46),
    'EVO:' + String(r.evolved.length),
    'P:' + PASSIVES.map((p) => `${p.id[0]}${r.stacks[p.id]}`).join(''),
    'done@' + (r.buildCompleteAt === null ? '-' : r.buildCompleteAt.toFixed(0)),
    'lastNew@' + r.lastNoveltyAt.toFixed(0),
  );
}

let sum = 0;
let n = 0;
let identical = 0;
for (let i = 0; i < results.length; i++) {
  for (let j = i + 1; j < results.length; j++) {
    const s = jaccard(results[i]!.weapons, results[j]!.weapons);
    sum += s;
    n++;
    if (s === 1) identical++;
  }
}
console.log('\npairs', n, 'mean weapon-set Jaccard', (sum / n).toFixed(3), 'identical sets', identical, `(${((identical / n) * 100).toFixed(1)}%)`);
const passiveMaxed = results.filter((r) => PASSIVES.every((p) => r.stacks[p.id]! >= p.maxStacks)).length;
console.log('runs with ALL four passives at max stacks:', passiveMaxed, '/', results.length);
console.log('runs holding 6 weapons:', results.filter((r) => r.weapons.length >= 6).length, '/', results.length);
const nov = results.map((r) => r.lastNoveltyAt).sort((a, b) => a - b);
console.log('lastNovelty median', nov[Math.floor(nov.length / 2)]!.toFixed(0), 's  max', nov[nov.length - 1]!.toFixed(0), 's');
