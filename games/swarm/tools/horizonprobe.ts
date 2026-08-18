import { FIXED_STEP } from '@arcade/core';
import { World } from '../src/sim/world.js';
import { WEAPONS } from '../src/content/weapons.js';
import { CHARACTERS } from '../src/content/characters.js';
import { goldFor } from '../src/content/unlocks.js';
import { FORGE_TRACKS, forgeCost, forgeGoldMult } from '../src/content/forge.js';
import { masteryFor, masteryLevel, MASTERY_MAX } from '../src/content/mastery.js';
import { highestUnlocked, MAX_ASCENSION, ASCENSIONS } from '../src/content/ascension.js';

/**
 * THE SEVENTH DAY probe.
 *
 * Plays a committed player's whole account forward, run by run, with the real
 * meta rules: gold is earned by goldFor + GREED + the tier multiplier, spent on
 * the cheapest available Forge level, mastery accrues per character, and the
 * ascension ladder unlocks off bestByAscension. Reports the run number at which
 * each chase closes.
 */

const VIEW_HALF_W = 240;
const VIEW_HALF_H = 498;
const SIM_SECONDS = 900;

type Skill = 'novice' | 'average' | 'good' | 'expert';
const SKILL: Record<Skill, { react: number; error: number; radius: number }> = {
  novice: { react: 0.42, error: 1.1, radius: 150 },
  average: { react: 0.22, error: 0.55, radius: 190 },
  good: { react: 0.1, error: 0.25, radius: 220 },
  expert: { react: 0.03, error: 0.08, radius: 260 },
};

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

function driveInput(
  world: World,
  skill: Skill,
  rng: () => number,
  state: { heading: number; cooldown: number },
  dt: number,
): void {
  const cfg = SKILL[skill];
  state.cooldown -= dt;
  if (state.cooldown <= 0) {
    state.cooldown = cfg.react;
    const p = world.player;
    let cx = 0;
    let cy = 0;
    let n = 0;
    const list = world.enemies.active;
    for (let i = 0; i < list.length; i++) {
      const e = list[i]!;
      if (e.hp <= 0) continue;
      const dx = e.x - p.x;
      const dy = e.y - p.y;
      if (dx * dx + dy * dy > cfg.radius * cfg.radius) continue;
      cx += dx;
      cy += dy;
      n++;
    }
    if (n > 0) state.heading = Math.atan2(-cy, -cx) + (rng() - 0.5) * 2 * cfg.error;
    else state.heading += (rng() - 0.5) * 1.2;
  }
  world.input.x = Math.cos(state.heading);
  world.input.y = Math.sin(state.heading);
}

function chooseCard(world: World, rng: () => number): void {
  const cards = world.pendingCards;
  if (!cards || cards.length === 0) return;
  const evolution = cards.find((c) => c.kind === 'evolution');
  const enabling = cards.find(
    (c) =>
      c.kind === 'passive' &&
      world.player.weapons.some((w) => WEAPONS[w.id].evolveWith === c.passiveId),
  );
  const level = cards.find((c) => c.kind === 'weapon' && c.levelLabel !== '');
  const fresh = cards.find((c) => c.kind === 'weapon' && c.levelLabel === '');
  const pick = evolution ?? enabling ?? level ?? fresh ?? cards[Math.floor(rng() * cards.length)]!;
  world.chooseUpgrade(pick.id);
}

interface RunOut { time: number; kills: number; level: number }

function runOnce(
  seed: number,
  skill: Skill,
  charIndex: number,
  forge: Record<string, number>,
  mastery: number,
  ascension: number,
): RunOut {
  const character = CHARACTERS[charIndex % CHARACTERS.length]!;
  const world = new World(seed);
  world.setForge(forge);
  world.setMastery(mastery);
  world.setAscension(ascension);
  world.reset(seed, character);
  world.setView(VIEW_HALF_W, VIEW_HALF_H);
  const rng = makeRng(seed ^ 0x5bf03635);
  const state = { heading: rng() * Math.PI * 2, cooldown: 0 };
  const steps = Math.ceil(SIM_SECONDS / FIXED_STEP);
  for (let i = 0; i < steps; i++) {
    if (world.phase === 'levelup') { chooseCard(world, rng); continue; }
    if (world.phase === 'boon' && world.pendingBoons) {
      world.chooseBoon(world.pendingBoons[0]!);
      continue;
    }
    if (world.phase === 'dead') break;
    driveInput(world, skill, rng, state, FIXED_STEP);
    world.step(FIXED_STEP);
    world.clearEvents();
  }
  return { time: world.time, kills: world.kills, level: world.level };
}

interface Account {
  gold: number;
  totalGold: number;
  forge: Record<string, number>;
  mastery: Record<string, number>;
  bestByAscension: Record<string, number>;
  ascension: number;
}

/** Buy every Forge level currently affordable, cheapest first. */
function spendForge(a: Account): void {
  for (;;) {
    let best: { id: string; cost: number } | null = null;
    for (const t of FORGE_TRACKS) {
      const c = forgeCost(t, a.forge[t.id] ?? 0);
      if (c === null || c > a.gold) continue;
      if (!best || c < best.cost) best = { id: t.id, cost: c };
    }
    if (!best) return;
    a.gold -= best.cost;
    a.forge[best.id] = (a.forge[best.id] ?? 0) + 1;
  }
}

function forgeDone(a: Account): boolean {
  return FORGE_TRACKS.every((t) => (a.forge[t.id] ?? 0) >= t.maxLevel);
}

function masteryDone(a: Account): boolean {
  return CHARACTERS.every((c) => masteryLevel(a.mastery[c.id] ?? 0).level >= MASTERY_MAX);
}

function simulateAccount(skill: Skill, label: string, rotate: boolean): void {
  const a: Account = { gold: 0, totalGold: 0, forge: {}, mastery: {}, bestByAscension: {}, ascension: 0 };
  let seed = 0x1234567;
  const marks: string[] = [];
  const charsSeen: string[] = [];
  let forgeAt = 0;
  let masteryAt = 0;
  let ladderAt = 0;
  let lastCharUnlock = 0;
  const times: number[] = [];
  const golds: number[] = [];
  const killLog: number[] = [];
  const lvlLog: number[] = [];
  const ascLog: number[] = [];

  for (let run = 1; run <= 400; run++) {
    // Character choice: a committed player rotates through what they own,
    // preferring the lowest-mastery unlocked character (the standing chase).
    const owned = CHARACTERS.filter((c) => a.totalGold >= c.unlockGold);
    let pickIdx = 0;
    if (rotate) {
      let lowest = Infinity;
      for (let i = 0; i < owned.length; i++) {
        const xp = a.mastery[owned[i]!.id] ?? 0;
        if (xp < lowest) { lowest = xp; pickIdx = CHARACTERS.indexOf(owned[i]!); }
      }
    } else {
      pickIdx = CHARACTERS.indexOf(owned[owned.length - 1]!);
    }
    const character = CHARACTERS[pickIdx]!;
    if (!charsSeen.includes(character.id)) { charsSeen.push(character.id); lastCharUnlock = run; }

    // Play at the highest tier unlocked — the tier pays the most.
    a.ascension = highestUnlocked(a.bestByAscension);
    const m = masteryLevel(a.mastery[character.id] ?? 0).level;
    seed = (seed * 1103515245 + 12345) >>> 0;
    const r = runOnce(seed, skill, pickIdx, a.forge, m, a.ascension);
    times.push(r.time);
    killLog.push(r.kills);
    lvlLog.push(r.level);
    ascLog.push(a.ascension);

    const goldMult = ASCENSIONS[a.ascension]!.gold;
    const gold = Math.floor(goldMult * goldFor(r.time, r.kills, r.level) * forgeGoldMult(a.forge));
    golds.push(gold);
    a.gold += gold;
    a.totalGold += gold;
    a.mastery[character.id] = (a.mastery[character.id] ?? 0) + masteryFor(r.time, r.kills, r.level, goldMult);
    const key = String(a.ascension);
    if (r.time > (a.bestByAscension[key] ?? 0)) a.bestByAscension[key] = r.time;

    const beforeForge = forgeDone(a);
    spendForge(a);
    if (!beforeForge && forgeDone(a)) { forgeAt = run; marks.push(`forge maxed @ run ${run}`); }
    if (!masteryAt && masteryDone(a)) { masteryAt = run; marks.push(`all mastery 10 @ run ${run}`); }
    if (!ladderAt && highestUnlocked(a.bestByAscension) >= MAX_ASCENSION) {
      ladderAt = run;
      marks.push(`ascension ${MAX_ASCENSION} unlocked @ run ${run}`);
    }
    if (forgeAt && masteryAt && ladderAt) break;
  }

  const med = (xs: number[]): number => {
    const s = xs.slice().sort((x, y) => x - y);
    return s[Math.floor(s.length / 2)] ?? 0;
  };
  console.log(`\n=== ${label} (${skill}, ${rotate ? 'rotating' : 'main-only'}) ===`);
  console.log(`  median run time  ${med(times).toFixed(0)}s   median gold/run ${med(golds).toFixed(0)}`);
  console.log(`  first 10 runs: times ${times.slice(0, 10).map((t) => t.toFixed(0)).join(',')}`);
  console.log(`  first 10 runs: gold  ${golds.slice(0, 10).join(',')}`);
  console.log(`  first 10 runs: kills ${killLog.slice(0, 10).join(',')}`);
  console.log(`  first 10 runs: lvl   ${lvlLog.slice(0, 10).join(',')}`);
  console.log(`  first 10 runs: asc   ${ascLog.slice(0, 10).join(',')}`);
  console.log(`  all six characters owned by run ${lastCharUnlock}`);
  for (const m of marks) console.log(`  ${m}`);
  console.log(`  forgeAt=${forgeAt} masteryAt=${masteryAt} ladderAt=${ladderAt} runsSimulated=${times.length}`);
  const perChar = CHARACTERS.map((c) => `${c.id}:${masteryLevel(a.mastery[c.id] ?? 0).level}`).join(' ');
  console.log(`  mastery at stop: ${perChar}`);
}

simulateAccount('average', 'AVERAGE PLAYER', true);
simulateAccount('good', 'GOOD PLAYER', true);
