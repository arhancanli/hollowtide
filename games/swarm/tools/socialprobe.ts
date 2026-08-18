/**
 * SOCIAL PROBE — does "same seed" actually mean "same course"?
 *
 * The async-social pitch (shared daily seed, ghost races, verified boards)
 * assumes two things this file measures instead of asserting:
 *
 *  1. REPLAY FIDELITY: recording (seed, per-frame input, card picks) and
 *     re-simulating reproduces the run exactly. That is what makes a
 *     leaderboard verifiable.
 *  2. COURSE SHARING: two players on the same seed face a comparable world.
 *     In a time-attack racer the track is fixed, so a ghost is a fair race.
 *     Here the world is a function of seed AND input, so player movement may
 *     re-route the enemy stream. If it does, a "shared seed" is only a shared
 *     opening, not a shared course.
 */
import { World } from '../src/sim/world.js';
import { Stall } from './_phases.js';
import { CHARACTERS } from '../src/content/characters.js';
import { FIXED_STEP } from '@arcade/core';

const SECONDS = 240;
const STEPS = Math.round(SECONDS / FIXED_STEP);

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

interface Frame {
  x: number;
  y: number;
}

/** Records the exact input tape + card picks, and a per-second world fingerprint. */
function run(
  seed: number,
  policySeed: number,
  jitter: number,
  tape: Frame[] | null,
  picks: string[] | null,
): {
  tape: Frame[];
  picks: string[];
  prints: string[];
  level: number;
  kills: number;
  died: number;
  rngState: number;
  rngTrace: number[];
  offerTrace: string[];
} {
  const world = new World(seed);
  world.reset(seed, CHARACTERS[0]!);
  world.setView(240, 498);
  const rng = makeRng(policySeed);
  const outTape: Frame[] = [];
  const outPicks: string[] = [];
  const prints: string[] = [];
  let heading = 0;
  let cooldown = 0;
  let died = 0;
  let pickIdx = 0;
  let stepIdx = 0;
  const rngTrace: number[] = [];
  const offerTrace: string[] = [];

  const stall = new Stall();
  for (let i = 0; i < STEPS; i++) {
    stall.check(world);
    if (world.phase === 'boon') {
      // A boss boon. Without this branch the world sits in 'boon'
      // forever and step() silently returns, so the probe runs to
      // completion reporting numbers frozen at the first boss kill.
      const offer = world.pendingBoons;
      if (offer && offer.length > 0) world.chooseBoon(offer[0]!);
      else break;
      continue;
    }
    if (world.phase === 'levelup') {
      const cards = world.pendingCards ?? [];
      offerTrace.push(cards.map((c) => c.id).join(','));
      let id: string;
      if (picks) {
        id = picks[pickIdx] ?? cards[0]!.id;
        // If the recorded pick is not on offer the worlds have already diverged.
        if (!cards.some((c) => c.id === id)) id = cards[0]!.id;
      } else {
        id = cards[Math.floor(rng() * cards.length)]!.id;
      }
      outPicks.push(id);
      pickIdx++;
      world.chooseUpgrade(id);
      continue;
    }
    if (world.phase === 'dead') {
      if (!died) died = world.time;
      break;
    }

    if (tape) {
      const f = tape[stepIdx];
      world.input.x = f ? f.x : 0;
      world.input.y = f ? f.y : 0;
    } else {
      cooldown -= FIXED_STEP;
      if (cooldown <= 0) {
        cooldown = 0.22;
        const p = world.player;
        let cx = 0;
        let cy = 0;
        let n = 0;
        for (const e of world.enemies.active) {
          if (e.hp <= 0) continue;
          const dx = e.x - p.x;
          const dy = e.y - p.y;
          if (dx * dx + dy * dy > 190 * 190) continue;
          cx += dx;
          cy += dy;
          n++;
        }
        if (n > 0) heading = Math.atan2(-cy, -cx) + (rng() - 0.5) * jitter;
        else heading += (rng() - 0.5) * 1.2;
      }
      world.input.x = Math.cos(heading);
      world.input.y = Math.sin(heading);
    }
    outTape.push({ x: world.input.x, y: world.input.y });

    world.step(FIXED_STEP);
    rngTrace.push(world.rng.state);
    stepIdx++;

    if (stepIdx % 60 === 1) {
      const p = world.player;
      let ex = 0;
      let n = 0;
      for (const e of world.enemies.active) {
        if (e.hp > 0) {
          ex += e.x + e.y;
          n++;
        }
      }
      prints.push(
        `${Math.round(world.time)}s alive=${n} hp=${p.hp.toFixed(1)} lvl=${world.level} kills=${world.kills} rng=${world.rng.state} exy=${ex.toFixed(0)}`,
      );
    }
  }

  return {
    tape: outTape,
    picks: outPicks,
    prints,
    level: world.level,
    kills: world.kills,
    died,
    rngState: world.rng.state,
    rngTrace,
    offerTrace,
  };
}

// ---- TEST 1: replay fidelity -------------------------------------------------
const SEED = 12345;
const a = run(SEED, 999, 0.55, null, null);
const replay = run(SEED, 0, 0, a.tape, a.picks);
const identical =
  a.level === replay.level &&
  a.kills === replay.kills &&
  a.rngState === replay.rngState &&
  a.prints.join('|') === replay.prints.join('|');
console.log('== TEST 1: record -> re-simulate (same process, same engine)');
console.log(`   original: lvl=${a.level} kills=${a.kills} rng=${a.rngState}`);
console.log(`   replayed: lvl=${replay.level} kills=${replay.kills} rng=${replay.rngState}`);
console.log(`   VERDICT: ${identical ? 'BIT-IDENTICAL' : 'DIVERGED'}`);

// ---- TEST 2: same seed, two different players --------------------------------
console.log('\n== TEST 2: same seed, different players — is the course shared?');
const p1 = run(SEED, 111, 0.55, null, null);
const p2 = run(SEED, 222, 0.55, null, null);
let firstDiff = -1;
for (let i = 0; i < Math.min(p1.prints.length, p2.prints.length); i++) {
  if (p1.prints[i] !== p2.prints[i]) {
    firstDiff = i;
    break;
  }
}
console.log(`   p1 @0s: ${p1.prints[0]}`);
console.log(`   p2 @0s: ${p2.prints[0]}`);
console.log(`   first differing second (positions): ${firstDiff < 0 ? 'never' : firstDiff + 's'}`);
let rngDiff = -1;
for (let i = 0; i < Math.min(p1.rngTrace.length, p2.rngTrace.length); i++) {
  if (p1.rngTrace[i] !== p2.rngTrace[i]) { rngDiff = i; break; }
}
console.log(`   first differing SIM STREAM frame: ${rngDiff < 0 ? 'never' : rngDiff + ' (' + (rngDiff / 60).toFixed(2) + 's)'}`);
let offDiff = -1;
for (let i = 0; i < Math.min(p1.offerTrace.length, p2.offerTrace.length); i++) {
  if (p1.offerTrace[i] !== p2.offerTrace[i]) { offDiff = i; break; }
}
console.log(`   level-up card offers identical for the first ${offDiff < 0 ? 'all' : offDiff} level-ups`);
console.log(`   p1 lvl2 offer: ${p1.offerTrace[1]}`);
console.log(`   p2 lvl2 offer: ${p2.offerTrace[1]}`);
const k = Math.min(p1.prints.length, p2.prints.length) - 1;
console.log(`   p1 @${k}s: ${p1.prints[k]}`);
console.log(`   p2 @${k}s: ${p2.prints[k]}`);
console.log(`   p1 final: lvl=${p1.level} kills=${p1.kills}`);
console.log(`   p2 final: lvl=${p2.level} kills=${p2.kills}`);

// ---- TEST 3: tape size for a 20-minute run ----------------------------------
const bytesRaw = a.tape.length * 8;
console.log('\n== TEST 3: replay tape size');
console.log(`   ${a.tape.length} frames over ${SECONDS}s = ${(bytesRaw / 1024).toFixed(1)} KB raw (2 floats/frame)`);
const quantised = a.tape.length * 1; // one byte = 256 headings
console.log(`   quantised to 1 byte of heading/frame: ${(quantised / 1024).toFixed(1)} KB`);
const secs = a.tape.length / 60;
console.log(`   ACTUAL run length: ${secs.toFixed(0)}s (${a.tape.length} frames at 60fps)`);
// quantise heading to 1 of 256 and run-length encode
let prev = -1, runs = 0;
for (const f of a.tape) {
  const q = ((Math.atan2(f.y, f.x) + Math.PI) / (Math.PI * 2) * 256) & 255;
  if (q !== prev) { runs++; prev = q; }
}
console.log(`   RLE: ${runs} heading changes in ${a.tape.length} frames -> ${(runs * 2 / 1024).toFixed(1)} KB (2 B/change)`);
console.log(`   per minute: ${(runs * 2 / secs * 60 / 1024).toFixed(2)} KB/min -> 20-min run ~= ${(runs * 2 / secs * 1200 / 1024).toFixed(1)} KB before gzip`);
