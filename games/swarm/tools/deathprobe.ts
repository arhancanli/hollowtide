import { FIXED_STEP } from '@arcade/core';
import { Stall } from './_phases.js';
import { World } from '../src/sim/world.js';
import { CHARACTERS } from '../src/content/characters.js';
import { WEAPONS } from '../src/content/weapons.js';

/**
 * Death forensics.
 *
 * After four blind tuning passes failed to move a hard wall at ~180s, this
 * answers the only question that matters: in the last ten seconds before death,
 * what is actually on top of the player, how much is each source contributing,
 * and is the player's damage output keeping pace with what is arriving?
 *
 *   npm run deathprobe -w @arcade/swarm
 */

const VIEW_W = 240;
const VIEW_H = 498;
const SECONDS = 420;

interface Sample {
  t: number;
  hp: number;
  maxHp: number;
  onScreen: number;
  touching: number;
  dps: number;
  arrivingHp: number;
  level: number;
  kinds: Record<string, number>;
}

function rng(seed: number): () => number {
  let s = seed >>> 0 || 1;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), 1 | t);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function runOne(seed: number, charIndex: number) {
  const world = new World(seed);
  world.reset(seed, CHARACTERS[charIndex % CHARACTERS.length]!);
  world.setView(VIEW_W, VIEW_H);
  const r = rng(seed ^ 0x9e3779b9);
  let heading = r() * Math.PI * 2;
  let react = 0;

  const samples: Sample[] = [];
  let dmgWindow = 0;
  let killWindow = 0;
  const damageByKind: Record<string, number> = {};
  let lastHp = world.player.hp;

  const steps = Math.ceil(SECONDS / FIXED_STEP);
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
      const cards = world.pendingCards;
      if (cards && cards.length) {
        const evo = cards.find((c) => c.kind === 'evolution');
        const wep = cards.find((c) => c.kind === 'weapon');
        world.chooseUpgrade((evo ?? wep ?? cards[0]!).id);
      }
      continue;
    }
    if (world.phase === 'dead') break;

    // Competent kiting.
    react -= FIXED_STEP;
    if (react <= 0) {
      react = 0.1;
      const p = world.player;
      let cx = 0;
      let cy = 0;
      let n = 0;
      for (const e of world.enemies.active) {
        if (e.hp <= 0) continue;
        const dx = e.x - p.x;
        const dy = e.y - p.y;
        if (dx * dx + dy * dy > 240 * 240) continue;
        cx += dx;
        cy += dy;
        n++;
      }
      heading = n > 0 ? Math.atan2(-cy, -cx) + (r() - 0.5) * 0.4 : heading + (r() - 0.5) * 1.0;
    }
    world.input.x = Math.cos(heading);
    world.input.y = Math.sin(heading);

    world.step(FIXED_STEP);

    for (const ev of world.events) {
      if (ev.type === 'enemyHit') dmgWindow += ev.damage;
      if (ev.type === 'enemyKilled') killWindow++;
    }
    world.clearEvents();

    // Attribute HP loss to whatever is touching.
    if (world.player.hp < lastHp) {
      const lost = lastHp - world.player.hp;
      const p = world.player;
      let nearest = 'unknown';
      let bestD2 = Infinity;
      for (const e of world.enemies.active) {
        if (e.hp <= 0) continue;
        const dx = e.x - p.x;
        const dy = e.y - p.y;
        const d2 = dx * dx + dy * dy;
        if (d2 < bestD2) {
          bestD2 = d2;
          nearest = e.kind;
        }
      }
      // A hostile orb hit leaves nothing adjacent.
      if (bestD2 > 90 * 90) nearest = 'ranged/orb';
      damageByKind[nearest] = (damageByKind[nearest] ?? 0) + lost;
    }
    lastHp = world.player.hp;

    if (i % 60 === 0) {
      const p = world.player;
      let onScreen = 0;
      let touching = 0;
      let arrivingHp = 0;
      const kinds: Record<string, number> = {};
      for (const e of world.enemies.active) {
        if (e.hp <= 0) continue;
        const dx = e.x - p.x;
        const dy = e.y - p.y;
        if (Math.abs(dx) <= VIEW_W && Math.abs(dy) <= VIEW_H) {
          onScreen++;
          kinds[e.kind] = (kinds[e.kind] ?? 0) + 1;
        }
        const rr = e.radius + 14;
        if (dx * dx + dy * dy <= rr * rr) touching++;
        if (dx * dx + dy * dy <= 260 * 260) arrivingHp += e.hp;
      }
      samples.push({
        t: Math.round(world.time),
        hp: Math.round(p.hp),
        maxHp: Math.round(p.maxHp),
        onScreen,
        touching,
        dps: Math.round(dmgWindow),
        arrivingHp: Math.round(arrivingHp),
        level: world.level,
        kinds,
      });
      dmgWindow = 0;
      killWindow = 0;
    }
  }

  return {
    died: world.time,
    samples,
    damageByKind,
    weapons: world.player.weapons.map((w) => `${w.id}${w.level}`),
    level: world.level,
  };
}

function main(): void {
  const runs = [];
  for (let i = 0; i < 48; i++) runs.push(runOne(1000 + i * 7919, i));

  const deaths = runs.map((r) => r.died).sort((a, b) => a - b);
  console.log(`\nDEATH FORENSICS — ${runs.length} kiting runs`);
  console.log(`  death p10 ${deaths[4]!.toFixed(0)}s  p50 ${deaths[24]!.toFixed(0)}s  p90 ${deaths[43]!.toFixed(0)}s\n`);

  // What is doing the damage, across all runs?
  const total: Record<string, number> = {};
  for (const r of runs) {
    for (const [k, v] of Object.entries(r.damageByKind)) total[k] = (total[k] ?? 0) + v;
  }
  const sum = Object.values(total).reduce((a, b) => a + b, 0) || 1;
  console.log('DAMAGE SOURCES (share of all HP lost)');
  for (const [k, v] of Object.entries(total).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${k.padEnd(12)} ${((v / sum) * 100).toFixed(1).padStart(5)}%`);
  }

  // The shape of the last 40 seconds before death.
  console.log('\nTHE LAST 40 SECONDS (median across runs, aligned to death)');
  const offsets = [40, 30, 20, 10, 0];
  for (const off of offsets) {
    const rows = runs
      .map((r) => {
        const target = r.died - off;
        let best: Sample | null = null;
        for (const s of r.samples) if (!best || Math.abs(s.t - target) < Math.abs(best.t - target)) best = s;
        return best;
      })
      .filter(Boolean) as Sample[];
    if (!rows.length) continue;
    const med = (f: (s: Sample) => number) => {
      const v = rows.map(f).sort((a, b) => a - b);
      return v[Math.floor(v.length / 2)]!;
    };
    console.log(
      `  T-${String(off).padStart(2)}s  hp ${String(med((s) => s.hp)).padStart(3)}/${med((s) => s.maxHp)}` +
        `  onScreen ${String(med((s) => s.onScreen)).padStart(3)}` +
        `  touching ${med((s) => s.touching).toFixed(1).padStart(4)}` +
        `  arrivingHP ${String(med((s) => s.arrivingHp)).padStart(5)}` +
        `  dmgDealt/s ${String(med((s) => s.dps)).padStart(5)}` +
        `  lvl ${med((s) => s.level)}`,
    );
  }

  // Is player damage keeping up with arriving HP?
  console.log('\nPLAYER DPS vs ARRIVING HP (median over all samples, by time bucket)');
  const buckets = [30, 60, 90, 120, 150, 180, 240, 300, 360, 420];
  for (let i = 0; i < buckets.length; i++) {
    const lo = i === 0 ? 0 : buckets[i - 1]!;
    const hi = buckets[i]!;
    const rows: Sample[] = [];
    for (const r of runs) for (const s of r.samples) if (s.t > lo && s.t <= hi) rows.push(s);
    if (!rows.length) continue;
    const med = (f: (s: Sample) => number) => {
      const v = rows.map(f).sort((a, b) => a - b);
      return v[Math.floor(v.length / 2)]!;
    };
    const dps = med((s) => s.dps);
    const arriving = med((s) => s.arrivingHp);
    console.log(
      `  ${String(lo).padStart(3)}-${String(hi).padStart(3)}s  dps ${String(dps).padStart(5)}` +
        `  arrivingHP ${String(arriving).padStart(5)}` +
        `  clear-time ${(arriving / Math.max(1, dps)).toFixed(2)}s` +
        `  onScreen ${String(med((s) => s.onScreen)).padStart(3)}` +
        `  touching ${med((s) => s.touching).toFixed(1)}`,
    );
  }

  console.log('\nWEAPONS AT DEATH (first 6 runs)');
  for (const r of runs.slice(0, 6)) {
    console.log(`  ${r.died.toFixed(0)}s lvl${r.level}  ${r.weapons.join(' ')}`);
  }
  console.log('');
}

main();
