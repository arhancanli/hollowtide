/**
 * Where does a run go flat?
 *
 * The owner played it and said the middle sags. Four blind tuning passes have
 * failed on this project before and one forensic tool found the answer in a
 * single run, so this measures the shape of a run rather than guessing at it.
 *
 * A run is interesting when things HAPPEN to you: a level-up to spend, a new
 * weapon, an evolution, a boss, a near-death, a rival going down. So bucket the
 * run into ten-second slices and count events per slice. A sag is a slice where
 * the rate collapses — and the fix depends entirely on WHICH rate collapses,
 * which is the thing nobody can guess.
 *
 *   npm run pacingprobe
 */
import { FIXED_STEP } from '@arcade/core';
import { CHARACTERS } from '../src/content/characters.js';
import { LOBBY_SIZE, makeRivals } from '../src/content/rivals.js';
import { RivalBrain } from '../src/sim/seatai.js';
import { World } from '../src/sim/world.js';
import { threatTierAt } from '../src/content/waves.js';

const RUNS = 40;
const CAP = 320;
const BUCKET = 10;
const N = Math.ceil(CAP / BUCKET);

const levelUps = new Float64Array(N);
const newThings = new Float64Array(N);
const evolutions = new Float64Array(N);
const bossOn = new Float64Array(N);
const hurt = new Float64Array(N);
const nearDeath = new Float64Array(N);
const rivalDowns = new Float64Array(N);
const handoffs = new Float64Array(N);
const enemyCount = new Float64Array(N);
const massHeld = new Float64Array(N);
const alive = new Float64Array(N);
const samples = new Float64Array(N);
const levelAt = new Float64Array(N);
const xpRate = new Float64Array(N);
const rivalLives: number[] = [];
let aliveAtEnd = 0;
const deadLevel: number[] = [];
const deadWeapons: number[] = [];
const deadKills: number[] = [];
const deadCrowd: number[] = [];
const deadSkill: number[] = [];
const playerAt30: number[] = [];
let killedByPlayer = 0;
let killedByWorld = 0;
let killedBySeatZero = 0;
let playerDown = 0;
let matchesFinished = 0;

for (let run = 0; run < RUNS; run++) {
  const seed = 40_009 + run * 7_331;
  const profiles = makeRivals(seed, LOBBY_SIZE);
  const world = new World(seed);
  // Measured in the ARENA, because that is the mode being judged. The strongest
  // policy drives seat zero: the world stops stepping when the local player
  // dies, and a weak driver would report the whole back half as empty.
  const strongest = profiles.slice().sort((a, b) => b.skill - a.skill)[0]!;
  world.enterArena(profiles.slice(1), CHARACTERS, { seed });
  world.reset(seed, CHARACTERS[run % CHARACTERS.length]!);
  world.setView(320, 240);
  const driver = new RivalBrain(strongest, seed, 0);
  let lastHp = world.player.hp;
  const deathSeen = world.players.map(() => false);

  for (let step = 0; step < CAP / FIXED_STEP; step++) {
    if (world.phase === 'dead') break;
    const b = Math.min(N - 1, Math.floor(world.time / BUCKET));
    if (world.player.respawnIn > 0) playerDown += FIXED_STEP;

    if (world.phase === 'levelup') {
      const offer = world.pendingCards ?? [];
      if (offer.length) {
        levelUps[b]! += 1;
        const before = world.player.weapons.length;
        world.chooseUpgrade(driver.pickCard(offer));
        if (world.player.weapons.length > before) newThings[b]! += 1;
      }
      continue;
    }
    if (world.phase === 'boon') {
      const offer = world.pendingBoons ?? [];
      if (offer.length) {
        newThings[b]! += 1;
        world.chooseBoon(driver.pickBoon(offer));
      }
      continue;
    }
    driver.think(world, world.player, FIXED_STEP);
    world.step(FIXED_STEP);

    for (const ev of world.events) {
      if (ev.type === 'evolved') evolutions[b]! += 1;
      else if (ev.type === 'rivalDown') rivalDowns[b]! += 1;
      else if (ev.type === 'handoff') handoffs[b]! += 1;
    }
    world.clearEvents();

    const hp = world.player.hp;
    if (hp < lastHp) hurt[b]! += lastHp - hp;
    if (hp / Math.max(1, world.player.maxHp) < 0.3) nearDeath[b]! += FIXED_STEP;
    lastHp = hp;

    if (step % 30 === 0) {
      samples[b]! += 1;
      enemyCount[b]! += world.enemies.count;
      massHeld[b]! += world.player.arenaScore;
      levelAt[b]! += world.player.level;
      xpRate[b]! += world.player.xp / Math.max(1, world.player.xpNeeded);
      if (world.activeBossName) bossOn[b]! += 1;
      alive[b]! += world.players.reduce((n, p) => n + (p.alive ? 1 : 0), 0);
      if (b === 3) playerAt30.push(world.player.level);
      for (const q2 of world.players) if (q2.alive) deathSeen[q2.index] = false;
      for (const q2 of world.players) {
        if (q2.index === 0 || q2.alive || deathSeen[q2.index]) continue;
        deathSeen[q2.index] = true;
        rivalLives.push(q2.diedAt);
        // What state were they in when they went down? A rival that dies at
        // level 2 holding one weapon is not dying because it steers badly.
        deadLevel.push(q2.level);
        deadWeapons.push(q2.weapons.length);
        deadKills.push(q2.kills);
        deadSkill.push((q2.brain as { profile?: { skill: number } })?.profile?.skill ?? -1);
        let touching = 0;
        for (const e of world.enemies.active) {
          if (e.hp <= 0) continue;
          const dx = e.x - q2.x;
          const dy = e.y - q2.y;
          if (dx * dx + dy * dy < 90 * 90) touching++;
        }
        deadCrowd.push(touching);
        // WHO killed them. lastHitBy is only ever set by another combatant's
        // damage, so this separates "a person shot me" from everything else.
        const claimed = q2.lastHitBy >= 0 && world.time - q2.lastHitAt <= 5;
        if (claimed) killedByPlayer++;
        else killedByWorld++;
        if (claimed && q2.lastHitBy === 0) killedBySeatZero++;
      }
    }
  }
  aliveAtEnd += world.players.reduce((n, p) => n + (p.alive ? 1 : 0), 0);
  if (world.time >= 300) matchesFinished++;
}

const per = (a: Float64Array, i: number): number => a[i]! / RUNS;
const avg = (a: Float64Array, i: number): number => a[i]! / Math.max(1, samples[i]!);
const bar = (v: number, scale: number): string => '#'.repeat(Math.max(0, Math.round(v * scale)));

console.log(`PACING PROBE — ${RUNS} arena runs, per 10-second slice, averaged`);
console.log('');
console.log(' time | lvlup  new  evo  boss%  dmg  lowHP  kills  hordes | enemies  mass  alive  lvl  xp% | events');
console.log('------|-----------------------------------------------------|----------------------|-------');
for (let i = 0; i < N; i++) {
  if (samples[i]! === 0) break;
  // "Something happened to me" — the rate that decides whether a slice is dull.
  const events = per(levelUps, i) + per(evolutions, i) + per(rivalDowns, i)
    + per(handoffs, i) + per(newThings, i);
  console.log(
    `${String(i * BUCKET).padStart(4)}s |` +
    `${per(levelUps, i).toFixed(1).padStart(6)}` +
    `${per(newThings, i).toFixed(1).padStart(5)}` +
    `${per(evolutions, i).toFixed(2).padStart(5)}` +
    `${(100 * avg(bossOn, i)).toFixed(0).padStart(6)}%` +
    `${per(hurt, i).toFixed(0).padStart(5)}` +
    `${per(nearDeath, i).toFixed(1).padStart(7)}` +
    `${per(rivalDowns, i).toFixed(2).padStart(7)}` +
    `${per(handoffs, i).toFixed(2).padStart(8)}` +
    ` |${avg(enemyCount, i).toFixed(0).padStart(8)}` +
    `${avg(massHeld, i).toFixed(0).padStart(6)}` +
    `${avg(alive, i).toFixed(1).padStart(6)}` +
    `${avg(levelAt, i).toFixed(0).padStart(5)}` +
    `${avg(xpRate, i).toFixed(2).padStart(6)}` +
    ` | ${bar(events, 6)}`,
  );
}
console.log('');
const sortedLives = rivalLives.slice().sort((a, b) => a - b);
const q = (f: number): number => sortedLives[Math.floor(sortedLives.length * f)] ?? 0;
console.log(`RIVAL LIFETIMES over ${RUNS} runs (${rivalLives.length} deaths recorded)`);
console.log(`  p10 ${q(0.1).toFixed(0)}s   p25 ${q(0.25).toFixed(0)}s   median ${q(0.5).toFixed(0)}s   p75 ${q(0.75).toFixed(0)}s   p90 ${q(0.9).toFixed(0)}s`);
const mean = (xs: number[]): number => xs.reduce((a, b) => a + b, 0) / Math.max(1, xs.length);
console.log(`  at the moment they died: level ${mean(deadLevel).toFixed(1)}, ` +
  `${mean(deadWeapons).toFixed(1)} weapons, ${mean(deadKills).toFixed(0)} kills, ` +
  `${mean(deadCrowd).toFixed(1)} enemies within 90u`);
const deaths = killedByPlayer + killedByWorld;
console.log(`  killed by another COMBATANT: ${killedByPlayer} of ${deaths} ` +
  `(${(100 * killedByPlayer / Math.max(1, deaths)).toFixed(0)}%), of which ` +
  `${killedBySeatZero} by the local player`);
console.log(`  killed by the WORLD (swarm, tide, ring): ${killedByWorld} of ${deaths}`);
console.log(`  mean skill of the dead: ${mean(deadSkill).toFixed(2)} (profiles run 0.05-0.98)`);
console.log(`  the PLAYER at 30s for comparison: level ${mean(playerAt30).toFixed(1)}`);
console.log(`  matches that reached the full clock: ${matchesFinished}/${RUNS}`);
console.log(`  seconds the player spent dead per match: ${(playerDown / RUNS).toFixed(1)}`);
console.log(`  deaths per match across the lobby: ${(rivalLives.length / RUNS).toFixed(1)}`);
console.log(`  seats still alive when the run ended: ${(aliveAtEnd / RUNS).toFixed(1)} of 8`);
console.log('');
console.log(`threat tier at 30s/90s/180s/270s: ${threatTierAt(30)} / ${threatTierAt(90)} / ${threatTierAt(180)} / ${threatTierAt(270)}`);
