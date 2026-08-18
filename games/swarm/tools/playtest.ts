import { FIXED_STEP } from '@arcade/core';
import { Stall } from './_phases.js';
import { World } from '../src/sim/world.js';
import { WEAPONS, type WeaponId } from '../src/content/weapons.js';
import { BOSS_SCHEDULE } from '../src/content/balance.js';
import { CHARACTERS } from '../src/content/characters.js';

/**
 * Large-scale headless playtest.
 *
 * Answers the one part of "will people get bored" that is actually measurable
 * without humans: when does the game RUN OUT? Not whether it is fun — no
 * simulation can tell you that — but how long a run lasts, how far players get
 * through the authored content, whether any weapon is dead or dominant, and the
 * point at which there are no new cards left to draw.
 *
 * That last number is the real boredom proxy. Once a build is complete the
 * level-up card stops being a decision, and in this genre the card is the loop.
 *
 *   npm run playtest -w @arcade/swarm
 */

/** Skill archetypes. Movement is what this game is gated on. */
type Skill = 'novice' | 'average' | 'good' | 'expert';
/** How a player spends level-ups. Drives build diversity. */
type Draft = 'collector' | 'specialist' | 'evolution' | 'random';

const SIM_SECONDS = 420;
const RUNS_PER_COMBO = 20;
const VIEW_HALF_W = 240;
const VIEW_HALF_H = 498;

interface RunResult {
  character: string;
  died: number;
  /** Second after which the player never drops below 95% HP again. null = never safe. */
  unkillableAt: number | null;
  damageTaken: number;
  level: number;
  kills: number;
  bossesSeen: number;
  bossesKilled: number;
  weapons: WeaponId[];
  maxedWeapons: number;
  evolutions: number;
  /** Seconds at which no new card kind was available. null if never reached. */
  buildCompleteAt: number | null;
  /** Seconds at which the last NEW thing (weapon or evolution) was acquired. */
  lastNoveltyAt: number;
}

/** Cheap deterministic PRNG so the harness never touches the sim's stream. */
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

const SKILL: Record<Skill, { react: number; error: number; radius: number }> = {
  // react: seconds of steering lag. error: radians of aim noise.
  novice: { react: 0.42, error: 1.1, radius: 150 },
  average: { react: 0.22, error: 0.55, radius: 190 },
  good: { react: 0.1, error: 0.25, radius: 220 },
  expert: { react: 0.03, error: 0.08, radius: 260 },
};

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
    if (n > 0) {
      // Flee the local crowd, with skill-scaled aim error.
      state.heading = Math.atan2(-cy, -cx) + (rng() - 0.5) * 2 * cfg.error;
    } else {
      // Nothing near: sweep for gems rather than standing still, which is what
      // a real player does and what the earlier bots never modelled.
      state.heading += (rng() - 0.5) * 1.2;
    }
  }

  world.input.x = Math.cos(state.heading);
  world.input.y = Math.sin(state.heading);
}

function chooseCard(world: World, draft: Draft, rng: () => number): void {
  const cards = world.pendingCards;
  if (!cards || cards.length === 0) return;

  const evolution = cards.find((c) => c.kind === 'evolution');
  const fresh = cards.find((c) => c.kind === 'weapon' && c.levelLabel === '');
  const level = cards.find((c) => c.kind === 'weapon' && c.levelLabel !== '');

  let pick = cards[0]!;
  if (draft === 'collector') pick = evolution ?? fresh ?? level ?? cards[0]!;
  else if (draft === 'specialist') pick = evolution ?? level ?? fresh ?? cards[0]!;
  else if (draft === 'evolution') {
    // Chase evolution requirements: take the enabling passives on purpose.
    const enabling = cards.find(
      (c) =>
        c.kind === 'passive' &&
        world.player.weapons.some((w) => WEAPONS[w.id].evolveWith === c.passiveId),
    );
    pick = evolution ?? enabling ?? level ?? fresh ?? cards[0]!;
  } else {
    pick = cards[Math.floor(rng() * cards.length)]!;
  }
  world.chooseUpgrade(pick.id);
}

function runOnce(seed: number, skill: Skill, draft: Draft, charIndex: number): RunResult {
  const character = CHARACTERS[charIndex % CHARACTERS.length]!;
  const world = new World(seed);
  world.reset(seed, character);
  world.setView(VIEW_HALF_W, VIEW_HALF_H);
  const rng = makeRng(seed ^ 0x5bf03635);
  const state = { heading: rng() * Math.PI * 2, cooldown: 0 };

  let died = SIM_SECONDS;
  const hpTrace: Array<{ t: number; frac: number }> = [];
  let bossesSeen = 0;
  let bossesKilled = 0;
  let evolutions = 0;
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
      continue;
    }
    if (world.phase === 'dead') {
      died = world.time;
      break;
    }

    driveInput(world, skill, rng, state, FIXED_STEP);
    world.step(FIXED_STEP);
    if (i % 60 === 0) {
      hpTrace.push({ t: world.time, frac: world.player.hp / world.player.maxHp });
    }

    for (const ev of world.events) {
      if (ev.type === 'bossSpawned') bossesSeen++;
      else if (ev.type === 'bossKilled') bossesKilled++;
      else if (ev.type === 'evolved') {
        evolutions++;
        lastNoveltyAt = world.time;
      } else if (ev.type === 'weaponGained') lastNoveltyAt = world.time;
    }
    world.clearEvents();

    // Build complete = six weapons, all at max, nothing new left to acquire.
    if (buildCompleteAt === null && world.player.weapons.length >= 6) {
      const allMax = world.player.weapons.every(
        (w) => w.level >= WEAPONS[w.id].maxLevel || WEAPONS[w.id].evolved,
      );
      if (allMax) buildCompleteAt = world.time;
    }
  }

  // Unkillable = the last second at which HP ever dipped meaningfully again.
  let unkillableAt: number | null = null;
  for (let i = 0; i < hpTrace.length; i++) {
    let dips = false;
    for (let j = i + 1; j < hpTrace.length; j++) {
      if (hpTrace[j]!.frac < hpTrace[i]!.frac - 0.03) { dips = true; break; }
    }
    if (!dips && hpTrace.length - i > 20) { unkillableAt = hpTrace[i]!.t; break; }
  }

  const weapons = world.player.weapons.map((w) => w.id);
  return {
    character: character.id,
    died,
    unkillableAt,
    damageTaken: Math.round(world.damageTaken),
    level: world.level,
    kills: world.kills,
    bossesSeen,
    bossesKilled,
    weapons,
    maxedWeapons: world.player.weapons.filter(
      (w) => w.level >= WEAPONS[w.id].maxLevel || WEAPONS[w.id].evolved,
    ).length,
    evolutions,
    buildCompleteAt,
    lastNoveltyAt,
  };
}

function pct(values: number[], p: number): number {
  if (!values.length) return NaN;
  const s = values.slice().sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.round((p / 100) * (s.length - 1))))]!;
}

function fmt(v: number): string {
  return Number.isFinite(v) ? v.toFixed(1) : ' -- ';
}

function main(): void {
  const skills: Skill[] = ['novice', 'average', 'good', 'expert'];
  const drafts: Draft[] = ['collector', 'specialist', 'evolution', 'random'];
  const started = process.hrtime.bigint();

  const all: RunResult[] = [];
  const bySkill = new Map<Skill, RunResult[]>();
  const byDraft = new Map<Draft, RunResult[]>();
  const weaponPicks = new Map<string, number>();

  const byChar = new Map<string, RunResult[]>();
  let seed = 1;
  let charIndex = 0;
  for (const skill of skills) {
    for (const draft of drafts) {
      for (const _c of CHARACTERS) {
      for (let i = 0; i < RUNS_PER_COMBO; i++) {
        const r = runOnce((seed = (seed * 1103515245 + 12345) >>> 0), skill, draft, charIndex);
        if (!byChar.has(r.character)) byChar.set(r.character, []);
        byChar.get(r.character)!.push(r);
        all.push(r);
        if (!bySkill.has(skill)) bySkill.set(skill, []);
        if (!byDraft.has(draft)) byDraft.set(draft, []);
        bySkill.get(skill)!.push(r);
        byDraft.get(draft)!.push(r);
        for (const w of r.weapons) weaponPicks.set(w, (weaponPicks.get(w) ?? 0) + 1);
      }
      charIndex++;
      }
    }
  }

  const total = all.length;
  console.log(`\nSWARM PLAYTEST — ${total} runs (${skills.length} skills x ${drafts.length} draft strategies x ${RUNS_PER_COMBO})\n`);

  console.log('RUN LENGTH BY SKILL');
  for (const skill of skills) {
    const rs = bySkill.get(skill)!;
    const d = rs.map((r) => r.died);
    console.log(
      `  ${skill.padEnd(8)} p10 ${fmt(pct(d, 10))}s  p50 ${fmt(pct(d, 50))}s  p90 ${fmt(pct(d, 90))}s` +
        `   lvl ${fmt(rs.reduce((a, r) => a + r.level, 0) / rs.length)}` +
        `   kills ${(rs.reduce((a, r) => a + r.kills, 0) / rs.length).toFixed(0)}`,
    );
  }

  console.log('\nAUTHORED CONTENT REACHED (% of all runs)');
  for (let i = 0; i < BOSS_SCHEDULE.length; i++) {
    const b = BOSS_SCHEDULE[i]!;
    const seen = all.filter((r) => r.bossesSeen > i).length;
    const killed = all.filter((r) => r.bossesKilled > i).length;
    console.log(
      `  ${b.name.padEnd(12)} @${String(b.t).padStart(3)}s   reached ${((seen / total) * 100).toFixed(0)}%   killed ${((killed / total) * 100).toFixed(0)}%`,
    );
  }

  console.log('\nUNKILLABLE CURVE (owner: "after 3 minutes it is impossible to die")');
  {
    const survivors = all.filter((r) => r.died >= SIM_SECONDS - 1);
    const immortal = all.filter((r) => r.unkillableAt !== null);
    const onsets = immortal.map((r) => r.unkillableAt!);
    console.log(`  runs reaching the ${SIM_SECONDS}s cap alive   ${((survivors.length / total) * 100).toFixed(0)}%`);
    console.log(`  runs that became unkillable         ${((immortal.length / total) * 100).toFixed(0)}%`);
    if (onsets.length) {
      console.log(`  ...onset                            p10 ${fmt(pct(onsets, 10))}s  p50 ${fmt(pct(onsets, 50))}s`);
    }
    const dmg = all.map((r) => r.damageTaken);
    console.log(`  damage taken per run                p50 ${fmt(pct(dmg, 50))}  p90 ${fmt(pct(dmg, 90))}`);
  }

  console.log('\nBUILD PROGRESSION');
  const evolved = all.filter((r) => r.evolutions > 0).length;
  const complete = all.filter((r) => r.buildCompleteAt !== null);
  console.log(`  saw an evolution        ${((evolved / total) * 100).toFixed(0)}% of runs`);
  console.log(`  filled + maxed a build  ${((complete.length / total) * 100).toFixed(0)}% of runs`);
  if (complete.length) {
    const t = complete.map((r) => r.buildCompleteAt!);
    console.log(`  ...and did so at        p50 ${fmt(pct(t, 50))}s  p90 ${fmt(pct(t, 90))}s`);
  }
  const novelty = all.map((r) => r.lastNoveltyAt).filter((v) => v > 0);
  console.log(`  last NEW thing acquired p50 ${fmt(pct(novelty, 50))}s  p90 ${fmt(pct(novelty, 90))}s`);
  console.log(`  avg weapons held        ${(all.reduce((a, r) => a + r.weapons.length, 0) / total).toFixed(1)} of 6`);

  console.log('\nWEAPON PICK RATE (% of runs that ended holding it)');
  const picks = [...weaponPicks.entries()].sort((a, b) => b[1] - a[1]);
  for (const [id, n] of picks) {
    const share = (n / total) * 100;
    const bar = '#'.repeat(Math.round(share / 4));
    console.log(`  ${id.padEnd(10)} ${share.toFixed(0).padStart(3)}%  ${bar}`);
  }
  const starters = ['orbit', 'nova', 'chain', 'mines', 'aura', 'homing'];
  const dead = starters.filter((s) => ((weaponPicks.get(s) ?? 0) / total) * 100 < 25);
  if (dead.length) console.log(`  UNDER-PICKED (<25%): ${dead.join(', ')}`);

  console.log('\nRUN LENGTH BY DRAFT STRATEGY (is any build strictly better?)');
  for (const draft of drafts) {
    const d = byDraft.get(draft)!.map((r) => r.died);
    console.log(`  ${draft.padEnd(11)} p50 ${fmt(pct(d, 50))}s  p90 ${fmt(pct(d, 90))}s`);
  }

  const ms = Number(process.hrtime.bigint() - started) / 1e6;
  console.log('\nCHARACTER VIABILITY (is any one strictly best or dead?)');
  for (const c of CHARACTERS) {
    const rs = byChar.get(c.id);
    if (!rs || !rs.length) continue;
    const d = rs.map((r) => r.died);
    const evo = (rs.filter((r) => r.evolutions > 0).length / rs.length) * 100;
    console.log(
      `  ${c.name.padEnd(8)} p50 ${fmt(pct(d, 50))}s  p90 ${fmt(pct(d, 90))}s` +
        `   lvl ${fmt(rs.reduce((a, r) => a + r.level, 0) / rs.length)}` +
        `   evo ${evo.toFixed(0)}%`,
    );
  }
  const charMedians = CHARACTERS.map((c) => pct((byChar.get(c.id) ?? []).map((r) => r.died), 50)).filter(Number.isFinite);
  if (charMedians.length > 1) {
    const spread = Math.max(...charMedians) / Math.min(...charMedians);
    console.log(`  spread best/worst = ${spread.toFixed(2)}x  ${spread > 1.6 ? '<-- UNBALANCED' : '(acceptable)'}`);
  }

  console.log(`\n${total} runs in ${(ms / 1000).toFixed(1)}s\n`);
}

main();
