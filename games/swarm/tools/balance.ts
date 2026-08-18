import { FIXED_STEP } from '@arcade/core';
import { Stall } from './_phases.js';
import { World } from '../src/sim/world.js';

/**
 * Headless balance runner.
 *
 * This is the entire payoff for keeping sim/ free of Pixi imports: thousands of
 * runs execute in seconds, so the XP curve gets measured rather than guessed.
 *
 * The number that matters most: the first level-up must land around 8s for a
 * competent player and no later than ~12s for someone who barely moves. If a
 * confused player does not reach their first card, they never see the core
 * loop at all, and everything downstream in the funnel collapses.
 *
 *   npm run balance -w @arcade/swarm
 */

type Policy = 'passive' | 'wander' | 'kite';

interface RunResult {
  firstLevelUp: number | null;
  secondLevelUp: number | null;
  thirdLevelUp: number | null;
  died: number | null;
  levelAt60: number;
  killsAt60: number;
  hpAt60: number;
}

// Long enough to actually observe the late curve the difficulty work targets.
const SIM_SECONDS = 200;
const RUNS_PER_POLICY = 200;
/**
 * A real phone in portrait (414x860 CSS at the clamped 0.8625 world scale),
 * NOT a square. The first pass measured against 420x420 and therefore missed
 * that portrait spawning left the screen empty for the first ten seconds.
 * Measure the shape players actually hold.
 */
const VIEW_HALF_W = 240;
const VIEW_HALF_H = 498;

function driveInput(world: World, policy: Policy, t: number): void {
  const p = world.player;

  if (policy === 'passive') {
    world.input.x = 0;
    world.input.y = 0;
    return;
  }

  if (policy === 'wander') {
    // Slow drift, no threat awareness. Stands in for a player who is moving
    // but has not yet worked out that enemies are dangerous.
    const a = Math.sin(t * 0.37) * 2.4 + Math.cos(t * 0.11) * 1.7;
    world.input.x = Math.cos(a);
    world.input.y = Math.sin(a);
    return;
  }

  // Kite: run from the local centroid of the nearest few enemies.
  let cx = 0;
  let cy = 0;
  let n = 0;
  let nearest = Infinity;
  const list = world.enemies.active;
  for (let i = 0; i < list.length; i++) {
    const e = list[i]!;
    if (e.hp <= 0) continue;
    const dx = e.x - p.x;
    const dy = e.y - p.y;
    const d2 = dx * dx + dy * dy;
    if (d2 > 220 * 220) continue;
    if (d2 < nearest) nearest = d2;
    cx += dx;
    cy += dy;
    n++;
  }
  if (n === 0) {
    world.input.x = 0;
    world.input.y = 0;
    return;
  }
  const len = Math.hypot(cx, cy) || 1;
  world.input.x = -cx / len;
  world.input.y = -cy / len;
}

function chooseCard(world: World): void {
  const cards = world.pendingCards;
  if (!cards || cards.length === 0) return;
  // Model the expected player: evolutions first (nobody passes one up), then
  // new weapons, then weapon levels, then passives.
  const pick =
    cards.find((c) => c.kind === 'evolution') ??
    cards.find((c) => c.kind === 'weapon' && c.levelLabel === '') ??
    cards.find((c) => c.kind === 'weapon') ??
    cards[0]!;
  world.chooseUpgrade(pick.id);
}

function runOnce(seed: number, policy: Policy): RunResult {
  const world = new World(seed);
  world.setView(VIEW_HALF_W, VIEW_HALF_H);

  const levelTimes: number[] = [];
  let died: number | null = null;
  let levelAt60 = 1;
  let killsAt60 = 0;
  let hpAt60 = 0;
  let captured60 = false;

  const steps = Math.ceil(SIM_SECONDS / FIXED_STEP);
  const stall = new Stall();
  for (let i = 0; i < steps; i++) {
    stall.check(world);
    const t = world.time;

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
      chooseCard(world);
      continue; // resolve the choice before advancing time
    }
    if (world.phase === 'dead') {
      if (died === null) died = t;
      break;
    }

    driveInput(world, policy, t);
    world.step(FIXED_STEP);

    for (const ev of world.events) {
      if (ev.type === 'levelUp') levelTimes.push(world.time);
      if (ev.type === 'died') died = ev.time;
    }
    world.clearEvents();

    if (!captured60 && world.time >= 60) {
      captured60 = true;
      levelAt60 = world.level;
      killsAt60 = world.kills;
      hpAt60 = world.player.hp;
    }
  }

  return {
    firstLevelUp: levelTimes[0] ?? null,
    secondLevelUp: levelTimes[1] ?? null,
    thirdLevelUp: levelTimes[2] ?? null,
    died,
    levelAt60,
    killsAt60,
    hpAt60,
  };
}

function pct(values: number[], p: number): number {
  if (values.length === 0) return NaN;
  const sorted = values.slice().sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.round((p / 100) * (sorted.length - 1))));
  return sorted[idx]!;
}

function fmt(v: number): string {
  return Number.isFinite(v) ? v.toFixed(2) : '  -- ';
}

function summarise(policy: Policy, results: RunResult[]): void {
  const first = results.map((r) => r.firstLevelUp).filter((v): v is number => v !== null);
  const second = results.map((r) => r.secondLevelUp).filter((v): v is number => v !== null);
  const third = results.map((r) => r.thirdLevelUp).filter((v): v is number => v !== null);
  const deaths = results.map((r) => r.died).filter((v): v is number => v !== null);
  const reached60 = results.filter((r) => r.died === null || r.died >= 60).length;

  const avg = (a: number[]): number => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN);

  console.log(`\n── ${policy.toUpperCase()} ${'─'.repeat(52 - policy.length)}`);
  console.log(`  level-up 1     p10 ${fmt(pct(first, 10))}s  p50 ${fmt(pct(first, 50))}s  p90 ${fmt(pct(first, 90))}s`);
  console.log(`  level-up 2     p10 ${fmt(pct(second, 10))}s  p50 ${fmt(pct(second, 50))}s  p90 ${fmt(pct(second, 90))}s`);
  console.log(`  level-up 3     p10 ${fmt(pct(third, 10))}s  p50 ${fmt(pct(third, 50))}s  p90 ${fmt(pct(third, 90))}s`);
  console.log(`  reached 60s    ${((reached60 / results.length) * 100).toFixed(1)}%`);
  console.log(`  death time     p10 ${fmt(pct(deaths, 10))}s  p50 ${fmt(pct(deaths, 50))}s  p90 ${fmt(pct(deaths, 90))}s`);
  console.log(`  at 60s         level ${avg(results.map((r) => r.levelAt60)).toFixed(1)}   kills ${avg(results.map((r) => r.killsAt60)).toFixed(0)}   hp ${avg(results.map((r) => r.hpAt60)).toFixed(0)}`);
}

function main(): void {
  const policies: Policy[] = ['passive', 'wander', 'kite'];
  const started = process.hrtime.bigint();
  let total = 0;

  console.log(`Swarm balance — ${RUNS_PER_POLICY} runs x ${SIM_SECONDS}s per policy`);
  console.log('Target: first level-up ~8s for a competent player, <=12s for a passive one.');

  for (const policy of policies) {
    const results: RunResult[] = [];
    for (let i = 0; i < RUNS_PER_POLICY; i++) {
      results.push(runOnce(1000 + i * 7919, policy));
      total++;
    }
    summarise(policy, results);
  }

  const ms = Number(process.hrtime.bigint() - started) / 1e6;
  console.log(`\n${total} runs in ${ms.toFixed(0)}ms (${(ms / total).toFixed(1)}ms/run)\n`);

  // Determinism guard. If this ever trips, replays, ghosts and leaderboard
  // validation are all silently broken, and every number above is noise.
  const a = runOnce(424242, 'kite');
  const b = runOnce(424242, 'kite');
  const same = JSON.stringify(a) === JSON.stringify(b);
  console.log(same ? '✓ determinism: identical runs from identical seeds' : '✗ DETERMINISM BROKEN');
  if (!same) process.exitCode = 1;
}

main();
