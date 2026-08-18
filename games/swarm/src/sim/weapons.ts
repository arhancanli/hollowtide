import type { Player } from './world.js';
import { TAU, datan2, dcos, dhypot, dsin } from '@arcade/core';
import {
  WEAPONS,
  orbitBladeRadius,
  orbitRingRadius,
  weaponStat,
  type WeaponId,
} from '../content/weapons.js';
import type { Enemy, WeaponInstance } from './types.js';
import type { World } from './world.js';

/**
 * Weapon behaviour.
 *
 * Split from world.ts because this is the part that will keep growing — every
 * future weapon lands here and nowhere else. Still sim code: no Pixi, no
 * Math.random, no wall clock. Weapons emit events and the render, juice and
 * audio layers all read the same stream.
 *
 * Each weapon must play differently, not just hit differently. A weapon that
 * is "bolt but bigger numbers" makes the level-up card boring, which is the
 * one thing this whole system exists to prevent.
 */

const scratch: number[] = [];

export function tickWeapon(world: World, owner: Player, inst: WeaponInstance, dt: number): void {
  const def = WEAPONS[inst.id];
  const p = owner;

  // Orbit-family weapons are continuous; they advance every step rather than
  // waiting on a cooldown, and use the cooldown only as a damage tick rate.
  if (inst.id === 'orbit' || inst.id === 'vortex') {
    orbitTick(world, owner, inst, dt);
    return;
  }
  if (inst.id === 'aura' || inst.id === 'inferno') {
    auraTick(world, owner, inst, dt);
    return;
  }

  inst.cd -= dt;
  if (inst.cd > 0) return;
  inst.cd = weaponStat(def, def.cooldown, inst.level) / (p.fireRateMult * world.boonRateMult);

  /**
   * RESONANCE: every fourth activation fires twice.
   *
   * Implemented as an immediate second call rather than a queued shot, so the
   * doubled volley reads as one heavier attack instead of a stutter — and so it
   * inherits whatever MOMENTUM and FRENZY are doing at that instant.
   */
  if (world.consumeResonance()) {
    const again = inst.cd;
    inst.cd = 0;
    tickWeapon(world, owner, inst, 0);
    inst.cd = again;
  }

  switch (inst.id) {
    case 'bolt':
      fireBolt(world, owner, inst);
      break;
    case 'storm':
      fireStorm(world, owner, inst);
      break;
    case 'nova':
    case 'supernova':
      fireNova(world, owner, inst);
      break;
    case 'chain':
    case 'tempest':
      fireChain(world, owner, inst);
      break;
    case 'mines':
    case 'cluster':
      dropMines(world, owner, inst);
      break;
    case 'homing':
    case 'swarm':
      fireHoming(world, owner, inst);
      break;
    default:
      break;
  }
}

function dmg(world: World, owner: Player, inst: WeaponInstance): number {
  const def = WEAPONS[inst.id];
  // boonDamageMult is CONDITIONAL — MOMENTUM reads whether the player is moving
  // at this instant — so it is read per activation, never cached.
  return weaponStat(def, def.damage, inst.level) * owner.damageMult * world.boonDamageMultFor(owner);
}

function area(world: World, owner: Player, inst: WeaponInstance): number {
  const def = WEAPONS[inst.id];
  return weaponStat(def, def.size, inst.level) * owner.areaMult;
}

// ---------------------------------------------------------------- bolt

function fireBolt(world: World, owner: Player, inst: WeaponInstance): void {
  const def = WEAPONS[inst.id];
  const p = owner;
  const target = world.nearestEnemy(owner);
  if (!target) {
    inst.cd = 0.1; // nothing to shoot; retry soon rather than banking cooldown
    return;
  }
  const base = datan2(target.y - p.y, target.x - p.x);
  const count = weaponStat(def, def.count, inst.level) + p.projectileCount;
  const spread = 0.22;
  const start = base - ((count - 1) * spread) / 2;
  for (let i = 0; i < count; i++) {
    world.spawnProjectile('bolt', start + i * spread, dmg(world, owner, inst), {
      radius: weaponStat(def, def.size, inst.level),
      speed: 400 * world.boonSpeedMult,
      life: 0.9,
      color: def.color,
      pierce: world.boonPierceFor(owner),
    }, owner);
  }
}

/** Evolved bolt: a full ring, so crowding you is punished from every side. */
function fireStorm(world: World, owner: Player, inst: WeaponInstance): void {
  const def = WEAPONS[inst.id];
  const count = weaponStat(def, def.count, inst.level) + owner.projectileCount;
  const offset = inst.phase;
  inst.phase += 0.31; // rotate each volley so the gaps never line up
  if (inst.phase > TAU) inst.phase -= TAU;
  for (let i = 0; i < count; i++) {
    world.spawnProjectile('bolt', offset + (i / count) * TAU, dmg(world, owner, inst), {
      radius: weaponStat(def, def.size, inst.level),
      speed: 430 * world.boonSpeedMult,
      life: 1.0,
      color: def.color,
      pierce: world.boonPierceFor(owner),
    }, owner);
  }
}

// ---------------------------------------------------------------- orbit

function orbitTick(world: World, owner: Player, inst: WeaponInstance, dt: number): void {
  const def = WEAPONS[inst.id];
  const p = owner;
  const isVortex = inst.id === 'vortex';

  inst.phase += (isVortex ? 4.2 : 2.6) * dt;
  if (inst.phase > TAU) inst.phase -= TAU;

  const orbs = weaponStat(def, def.count, inst.level);
  /**
   * +REACH grows the BLADE, and barely moves the ring.
   *
   * Enemies converge on the player, so they are densest right up against it.
   * Scaling the orbit radius with areaMult therefore pushed the blades OUT of
   * the crowd: measured 0.15x damage at max REACH originally, and 0.00x once
   * the radius scaled cleanly — the card was strictly negative on this weapon
   * while promising the opposite. The ring gets a token 25% of the bonus so it
   * still visibly grows; the blade gets all of it, which is what actually
   * sweeps more enemies.
   */
  const radius = orbitRingRadius(def, inst.level, owner.areaMult);
  const damage = dmg(world, owner, inst);
  // fireRateMult MUST divide the tick. orbitTick never touches inst.cd, so the
  // stat was a literal no-op on this weapon — and ECLIPSE, the 6000g top
  // unlock, is built on ORBIT with fireRateMult as its signature stat.
  const tick = weaponStat(def, def.cooldown, inst.level) / p.fireRateMult;
  // Blade reach scales with areaMult too. Previously the ORBIT RING grew with
  // +REACH while the blade's own hit radius stayed hardcoded at 14, so
  // stacking REACH swept the blades through emptier space further from the
  // player the swarm converges on: measured 0.15x damage at max REACH, i.e.
  // the card actively made the weapon worse while promising the opposite.
  const blade = orbitBladeRadius(owner.areaMult);
  const list = world.enemies.active;

  for (let o = 0; o < orbs; o++) {
    const a = inst.phase + (o / orbs) * TAU;
    const ox = p.x + dcos(a) * radius;
    const oy = p.y + dsin(a) * radius;
    const n = world.queryEnemies(ox, oy, blade + 40, scratch);
    for (let k = 0; k < n; k++) {
      const e = list[scratch[k]!];
      if (!e || e.hp <= 0 || e.orbCd > 0) continue;
      const dx = e.x - ox;
      const dy = e.y - oy;
      const rr = e.radius + blade;
      if (dx * dx + dy * dy > rr * rr) continue;
      e.orbCd = tick;
      world.damageEnemy(e, damage, ox, oy);
    }
    world.damageRivalsInArea(owner, ox, oy, blade, damage);
  }

  // Vortex drags the swarm inward — it turns a defensive ring into a reason to
  // stand still and let them come, which is the identity this build leans on.
  if (!isVortex) return;
  const pull = 150 * dt;
  const n = world.queryEnemies(p.x, p.y, radius * 1.7, scratch);
  for (let k = 0; k < n; k++) {
    const e = list[scratch[k]!];
    if (!e || e.hp <= 0 || e.mass > 4) continue;
    const dx = p.x - e.x;
    const dy = p.y - e.y;
    const d = dhypot(dx, dy) || 1;
    if (d > radius * 1.7) continue;
    e.x += (dx / d) * pull;
    e.y += (dy / d) * pull;
  }
}

// ---------------------------------------------------------------- aura

function auraTick(world: World, owner: Player, inst: WeaponInstance, dt: number): void {
  const def = WEAPONS[inst.id];
  const p = owner;
  const radius = area(world, owner, inst);
  const damage = dmg(world, owner, inst);
  const tick = weaponStat(def, def.cooldown, inst.level) / p.fireRateMult;
  const list = world.enemies.active;

  inst.phase += dt;

  const n = world.queryEnemies(p.x, p.y, radius, scratch);
  for (let k = 0; k < n; k++) {
    const e = list[scratch[k]!];
    if (!e || e.hp <= 0 || e.auraCd > 0) continue;
    const dx = e.x - p.x;
    const dy = e.y - p.y;
    const rr = radius + e.radius;
    if (dx * dx + dy * dy > rr * rr) continue;
    e.auraCd = tick;
    world.damageEnemy(e, damage, p.x, p.y);
  }
  world.damageRivalsInArea(owner, p.x, p.y, radius, damage);
}

// ---------------------------------------------------------------- nova

function fireNova(world: World, owner: Player, inst: WeaponInstance): void {
  const def = WEAPONS[inst.id];
  const p = owner;
  const radius = area(world, owner, inst);
  const damage = dmg(world, owner, inst);
  const pulses = weaponStat(def, def.count, inst.level);
  const list = world.enemies.active;

  let hits = 0;
  const n = world.queryEnemies(p.x, p.y, radius, scratch);
  for (let k = 0; k < n; k++) {
    const e = list[scratch[k]!];
    if (!e || e.hp <= 0) continue;
    const dx = e.x - p.x;
    const dy = e.y - p.y;
    const rr = radius + e.radius;
    if (dx * dx + dy * dy > rr * rr) continue;
    world.damageEnemy(e, damage * pulses, p.x, p.y);
    hits++;
  }

  world.events.push({ type: 'blast', x: p.x, y: p.y, radius, color: def.color });
  world.damageRivalsInArea(owner, p.x, p.y, radius, damage * pulses);

  // Supernova pays back a sliver of health per victim, which is what makes
  // wading into a crowd a viable build rather than a mistake.
  if (inst.id === 'supernova' && hits > 0) {
    p.hp = Math.min(p.maxHp, p.hp + Math.min(8, hits * 0.6));
  }
}

// ---------------------------------------------------------------- chain

function fireChain(world: World, owner: Player, inst: WeaponInstance): void {
  const def = WEAPONS[inst.id];
  const p = owner;
  const jumps = weaponStat(def, def.count, inst.level);
  const range = area(world, owner, inst);
  const damage = dmg(world, owner, inst);
  const list = world.enemies.active;

  let fromX = p.x;
  let fromY = p.y;
  const points: number[] = [p.x, p.y];
  const hit = world.chainScratch;
  hit.clear();

  for (let j = 0; j < jumps; j++) {
    let best: Enemy | null = null;
    // Carry the index out of the loop rather than re-finding it with indexOf:
    // `scratch` is shared by every weapon and must never be appended to (writing
    // past `n` grew it ~690 entries/sec forever), and indexOf was an O(n) scan
    // for an index this loop already held.
    let bestIdx = -1;
    let bestD2 = range * range;
    const n = world.queryEnemies(fromX, fromY, range, scratch);
    for (let k = 0; k < n; k++) {
      const idx = scratch[k]!;
      const e = list[idx];
      if (!e || e.hp <= 0 || hit.has(idx)) continue;
      const dx = e.x - fromX;
      const dy = e.y - fromY;
      const d2 = dx * dx + dy * dy;
      if (d2 < bestD2) {
        bestD2 = d2;
        best = e;
        bestIdx = idx;
      }
    }
    if (!best) break;
    hit.add(bestIdx);

    points.push(best.x, best.y);
    world.damageEnemy(best, damage, fromX, fromY);
    fromX = best.x;
    fromY = best.y;
  }

  const rival = world.damageNearestRival(owner, fromX, fromY, range, damage);
  if (rival) points.push(rival.x, rival.y);

  if (points.length > 2) {
    world.events.push({ type: 'chainArc', points, color: def.color });
  } else {
    inst.cd = Math.min(inst.cd, 0.15);
  }
}

// ---------------------------------------------------------------- mines

function dropMines(world: World, owner: Player, inst: WeaponInstance): void {
  const def = WEAPONS[inst.id];
  const p = owner;
  const count = weaponStat(def, def.count, inst.level);
  /**
   * Lifetime pays for fire rate.
   *
   * The drop rate is divided by fireRateMult while the lifetime stayed a fixed
   * 9 seconds, so the steady-state population multiplied with it: at 6 RAPID
   * stacks that is 3 mines x 9s x 2.99 casts/sec = 80.7, and a probe measured
   * 78 alive with all 78 inside 130px of the player. The character vanished
   * under its own weapon. Holding lifetime x rate constant keeps the field
   * density the designer chose at every point on the fire-rate curve.
   */
  const life = Math.max(2.5, MINE_LIFE / p.fireRateMult);
  for (let i = 0; i < count; i++) {
    const a = world.rng.angle();
    // Drop them OUTSIDE the player sprite. The old ring started at 10px, i.e.
    // underneath the character, which is why the pile read as a smear.
    const r = world.rng.range(34, 74);
    world.spawnMine(
      p.x + dcos(a) * r,
      p.y + dsin(a) * r,
      dmg(world, owner, inst),
      area(world, owner, inst),
      def.color,
      life,
      owner,
    );
  }
}

/** Base seconds a mine persists at 1x fire rate. */
const MINE_LIFE = 9;

// ---------------------------------------------------------------- homing

function fireHoming(world: World, owner: Player, inst: WeaponInstance): void {
  const def = WEAPONS[inst.id];
  const count = weaponStat(def, def.count, inst.level) + owner.projectileCount;
  for (let i = 0; i < count; i++) {
    // Launch outward on a spread, then let the seeking do the work — firing
    // straight at the target makes it look like a slow bolt instead of a missile.
    const a = owner.aimAngle + (i - (count - 1) / 2) * 0.8;
    world.spawnProjectile('homing', a, dmg(world, owner, inst), {
      radius: weaponStat(def, def.size, inst.level),
      speed: 230,
      life: 2.4,
      color: def.color,
      turn: 5.5,
    }, owner);
  }
}

export function isEvolved(id: WeaponId): boolean {
  return WEAPONS[id].evolved === true;
}
