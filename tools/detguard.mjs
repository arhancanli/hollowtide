/**
 * Guard: no implementation-defined maths in the simulation path.
 *
 * ECMA-262 leaves sin/cos/tan/atan2/exp/pow/hypot "implementation-approximated",
 * and V8 and JavaScriptCore genuinely differ — measured on this project at up to
 * 30.2% of results for hypot, 13.2% for atan2, 10.5% for exp.
 *
 * One reintroduced call anywhere below is enough to make a run unreproducible
 * between a phone and a server, and NOTHING else in the test suite would notice:
 * the game would play perfectly on every device, and only the leaderboard would
 * quietly start rejecting honest iOS players. That is the exact shape of bug
 * this project has been bitten by before — a rule documented in a comment, with
 * no check that could fail.
 *
 * Run in CI. `npm run detguard`.
 */
import { readFileSync } from 'node:fs';

const SIM_PATHS = [
  'games/swarm/src/sim/world.ts',
  'games/swarm/src/sim/weapons.ts',
  'games/swarm/src/sim/types.ts',
  'games/swarm/src/content/waves.ts',
  'games/swarm/src/content/balance.ts',
  'games/swarm/src/content/weapons.ts',
  'games/swarm/src/content/upgrades.ts',
  'games/swarm/src/content/forge.ts',
  'games/swarm/src/content/characters.ts',
  'games/swarm/src/content/daily.ts',
  'games/swarm/src/content/unlocks.ts',
  'packages/core/src/math.ts',
  'packages/core/src/rng.ts',
  'packages/core/src/input.ts',
  'packages/core/src/spatial-hash.ts',
  'packages/core/src/pool.ts',
];

/**
 * sqrt, abs, floor, ceil, round, min, max, sign, trunc and imul are all exactly
 * specified by the standard, so they are safe and deliberately absent here.
 * Math.random is banned for a different reason — the sim must stay a pure
 * function of its seed.
 */
const BANNED =
  /Math\.(sin|cos|tan|asin|acos|atan|atan2|exp|expm1|log|log2|log10|log1p|pow|hypot|cbrt|sinh|cosh|tanh|random)\s*\(/;

let bad = 0;
let checked = 0;

for (const file of SIM_PATHS) {
  let src;
  try {
    src = readFileSync(file, 'utf8');
  } catch {
    continue;
  }
  checked++;
  const lines = src.split('\n');
  let inBlockComment = false;

  lines.forEach((line, i) => {
    const trimmed = line.trim();
    // These files discuss the banned functions by name constantly in their
    // documentation, so prose has to be excluded or the guard cries wolf and
    // gets switched off — which is worse than not having it.
    if (trimmed.startsWith('/*')) inBlockComment = true;
    const wasComment = inBlockComment || trimmed.startsWith('*') || trimmed.startsWith('//');
    if (trimmed.includes('*/')) inBlockComment = false;
    if (wasComment) return;

    const code = line.replace(/\/\/.*$/, '');
    const m = BANNED.exec(code);
    if (m) {
      console.error(
        `${file}:${i + 1}  Math.${m[1]} is implementation-defined — use the d* form from @arcade/core`,
      );
      console.error(`    ${trimmed}`);
      bad++;
    }
  });
}

if (bad > 0) {
  console.error(`\n${bad} implementation-defined math call(s) in the simulation path.`);
  console.error('A run containing these cannot be reproduced across browser engines,');
  console.error('which breaks replay verification and any leaderboard built on it.');
  process.exit(1);
}
console.log(`detguard: ${checked} simulation files clean — no engine-dependent maths.`);
