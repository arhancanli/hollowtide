/** SKEPTIC probe: is the power tax the CAUSE of the flat median? (delete after use) */
import { FIXED_STEP } from '@arcade/core';
import { World } from '../src/sim/world.js';
import { CHARACTERS } from '../src/content/characters.js';
import { WEAPONS } from '../src/content/weapons.js';

function makeRng(seed: number) { let s = seed >>> 0 || 1; return () => { s = (s + 0x6d2b79f5) | 0; let t = s; t = Math.imul(t ^ (t >>> 15), 1 | t); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

// Same card policy as tools/metaeffect.ts, so arms are comparable to it.
function run(seed: number, ci: number, f: Record<string, number>, m: number, a: number, taxOff: boolean) {
  const w = new World(seed);
  w.setForge(f); w.setMastery(m); w.setAscension(a);
  w.reset(seed, CHARACTERS[ci]!); w.setView(240, 498);
  const rng = makeRng(seed ^ 0x5bf03635); const st = { h: rng() * 6.28, cd: 0 };
  for (let i = 0; i < Math.ceil(900 / FIXED_STEP); i++) {
    if (taxOff) for (const s of (w as any).players) { s.powerHp = 1; s.powerDensity = 1; s.powerDamage = 1; }
    if (w.phase === 'levelup' && w.pendingCards) {
      const cs = w.pendingCards;
      const ev = cs.find((c) => c.kind === 'evolution');
      const en = cs.find((c) => c.kind === 'passive' && w.player.weapons.some((x) => WEAPONS[x.id].evolveWith === c.passiveId));
      const lv = cs.find((c) => c.kind === 'weapon' && c.levelLabel !== '');
      const fr = cs.find((c) => c.kind === 'weapon' && c.levelLabel === '');
      w.chooseUpgrade((ev ?? en ?? lv ?? fr ?? cs[0]!).id); continue;
    }
    if (w.phase === 'boon' && w.pendingBoons) { w.chooseBoon(w.pendingBoons[0]!); continue; }
    if (w.phase === 'dead') break;
    st.cd -= FIXED_STEP;
    if (st.cd <= 0) {
      st.cd = 0.22; const p = w.player; let cx = 0, cy = 0, n = 0; const l = w.enemies.active;
      for (let j = 0; j < l.length; j++) { const e = l[j]!; if (e.hp <= 0) continue; const dx = e.x - p.x, dy = e.y - p.y; if (dx * dx + dy * dy > 190 * 190) continue; cx += dx; cy += dy; n++; }
      st.h = n > 0 ? Math.atan2(-cy, -cx) + (rng() - 0.5) * 1.1 : st.h + (rng() - 0.5) * 1.2;
    }
    w.input.x = Math.cos(st.h); w.input.y = Math.sin(st.h); w.step(FIXED_STEP); w.clearEvents();
  }
  return w.time;
}

const MAX = { might: 5, vitality: 5, haste: 5, reach: 5, swiftness: 5, magnet: 5, greed: 5, growth: 5 };
const TAXED_ONLY = { might: 5, haste: 5, reach: 5 };
const UNTAXED_ONLY = { vitality: 5, swiftness: 5, magnet: 5, greed: 5, growth: 5 };
function pc(x: number[], p: number) { const s = x.slice().sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.max(0, Math.round(p / 100 * (s.length - 1))))]!; }

const cases: [string, Record<string, number>, number, number, boolean][] = [
  ['A fresh              tax ON ', {}, 0, 0, false],
  ['B maxed forge+m10    tax ON ', MAX, 10, 0, false],
  ['C fresh              tax OFF', {}, 0, 0, true],
  ['D maxed forge+m10    tax OFF', MAX, 10, 0, true],
  ['E MIGHT/HASTE/REACH only     ', TAXED_ONLY, 0, 0, false],
  ['F VIT/SWIFT/MAG/GRD/GRW only ', UNTAXED_ONLY, 0, 0, false],
  ['G mastery 10 only            ', {}, 10, 0, false],
];
for (const [name, f, m, a, taxOff] of cases) {
  const ts: number[] = [];
  for (let ci = 0; ci < 6; ci++) for (let s = 0; s < 6; s++) ts.push(run(3000 + s * 104729 + ci * 7919, ci, f, m, a, taxOff));
  console.log(`${name} n=${ts.length} p25=${pc(ts, 25).toFixed(0)}s p50=${pc(ts, 50).toFixed(0)}s p75=${pc(ts, 75).toFixed(0)}s p90=${pc(ts, 90).toFixed(0)}s max=${Math.max(...ts).toFixed(0)}s`);
}
