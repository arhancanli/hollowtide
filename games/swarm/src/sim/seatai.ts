import { Rng, TAU, datan2, dcos, dhypot, dsin } from '@arcade/core';
import type { Player, SeatBrain, World } from './world.js';
import type { WeaponInstance } from './types.js';
import type { Card } from '../content/upgrades.js';
import type { RivalProfile } from '../content/rivals.js';
import { WEAPONS } from '../content/weapons.js';

/**
 * The policy that drives a seat nobody is sitting in.
 *
 * This is the AI backfill. It exists because a browser player who lands in an
 * empty lobby leaves inside fifteen seconds, and a lobby that fills instantly
 * is the difference between a game with an arena and a game with a waiting
 * room. When a real player arrives, their brain is deleted and the same seat
 * carries on — see World.seatPlayer. There is no separate "bot entity" to swap
 * out, because a seat that behaved differently depending on who was in it would
 * be two implementations of the same game.
 *
 * WHAT IT IS ALLOWED TO DO. Exactly what a human can: write a movement vector,
 * fire the ability, pick a card, pick a boon. It never reads a field a player
 * cannot see, never moves a seat directly, and never gets a modifier a player
 * cannot earn. Everything that makes one rival better than another is a
 * behaviour — how fast it reacts, how close it lets the crowd get, how often it
 * simply chooses wrong.
 *
 * WHY IMPERFECTION IS THE POINT. A policy that responds on the exact frame and
 * never misreads a board is instantly legible as a machine, and once one
 * opponent reads as furniture the whole arena does. The reaction delay below is
 * not a handicap to make the player win — it is the thing that makes winning
 * mean something.
 */
export class RivalBrain implements SeatBrain {
  readonly profile: RivalProfile;
  private readonly rng: Rng;
  private sinceDecision = 0;
  private heading = 0;
  /** Cached steering, refreshed only on a decision — this IS the reaction lag. */
  private moveX = 0;
  private moveY = 0;
  /**
   * The seat's weapons as of the last step.
   *
   * Cached rather than passed in, so pickCard keeps exactly the signature a
   * remote player's input would satisfy — widening it so the AI can see more of
   * the world than the interface offers is the drift worth avoiding.
   */
  private seatWeapons: readonly WeaponInstance[] = [];
  private seatStacks: ReadonlyMap<string, number> = new Map();

  constructor(profile: RivalProfile, seed: number, seatIndex: number) {
    this.profile = profile;
    // Per-seat stream, so two rivals with the same skill still play differently
    // and the lobby does not move as a block.
    this.rng = new Rng((seed ^ (0x27d4eb2f + seatIndex * 0x9e3779b9)) >>> 0 || 1);
  }

  think(world: World, seat: Player, dt: number): void {
    this.seatWeapons = seat.weapons;
    this.seatStacks = seat.stacks;
    this.sinceDecision += dt;
    if (this.sinceDecision >= this.profile.reaction) {
      this.sinceDecision = 0;
      this.decide(world, seat);
    }
    seat.input.x = this.moveX;
    seat.input.y = this.moveY;
  }

  /**
   * Where to go.
   *
   * Three drives, in priority order: get out of a crowd, go where the
   * experience is, otherwise wander. A rival that only ever fled outran its own
   * levelling and died at level 13 with starting health — measured, in an
   * earlier version of this file's ancestor — so "retreat" has to be a response
   * to actual danger and not a default.
   */
  private decide(world: World, seat: Player): void {
    const nerve = this.profile.nerve;

    let cx = 0;
    let cy = 0;
    let n = 0;
    let danger = 0;
    for (const e of world.enemies.active) {
      if (e.hp <= 0) continue;
      const d = dhypot(e.x - seat.x, e.y - seat.y);
      if (d < nerve + 70) {
        cx += e.x;
        cy += e.y;
        n++;
        if (d < nerve) danger++;
      }
    }

    // The mistake: read the board correctly and then do the other thing.
    const errs = this.rng.next() < this.profile.mistake;

    if (danger >= 3 && n > 0 && !errs) {
      /**
       * Escape toward the emptiest arc — NOT away from the centre of the crowd.
       *
       * Running from the centroid is the obvious thing and it is fatal here,
       * because in a survivor-like the crowd surrounds you: the centroid of a
       * ring is the middle of the ring, which is where you are standing. The
       * escape vector collapses to nothing, the seat stops moving, and it is
       * eaten where it stands.
       *
       * Measured before this: rival lifetimes were p10 27s, median 31s, p90
       * 39s — an entire eight-seat lobby evaporating inside one twelve-second
       * window, at no particular difficulty event, simply as soon as the swarm
       * was dense enough to close a circle. Seven of the eight combatants in a
       * mode built around eight combatants were gone before the first boss.
       *
       * A person does not run from the middle of the crowd, they run at the
       * gap. This scores twelve headings by how much danger lies along each and
       * takes the quietest one, which is the same thing.
       */
      const ESCAPES = 12;
      let bestScore = Infinity;
      let bestX = this.moveX;
      let bestY = this.moveY;
      const horizon = nerve + 90;
      for (let i = 0; i < ESCAPES; i++) {
        const a = (i / ESCAPES) * TAU;
        const ax = dcos(a);
        const ay = dsin(a);
        let score = 0;
        for (const e of world.enemies.active) {
          if (e.hp <= 0) continue;
          const ex = e.x - seat.x;
          const ey = e.y - seat.y;
          const d = dhypot(ex, ey);
          if (d > horizon) continue;
          // Only what lies AHEAD of this heading counts against it, weighted by
          // how directly ahead and how close it is.
          const along = (ex * ax + ey * ay) / (d || 1);
          if (along <= 0.15) continue;
          score += along * (1 - d / horizon);
        }
        if (score < bestScore) {
          bestScore = score;
          bestX = ax;
          bestY = ay;
        }
      }
      this.moveX = bestX;
      this.moveY = bestY;
      this.heading = datan2(bestY, bestX);
      if (danger >= 4 && seat.abilityCd <= 0) world.useAbility(seat);
      return;
    }

    // Hunt a vulnerable rival or challenge the crown. This is the competitive
    // verb: without it, eight seats merely farm the same swarm in parallel.
    let prey: Player | null = null;
    let preyD = Infinity;
    for (const q of world.players) {
      if (q === seat || !q.alive) continue;
      const d = dhypot(q.x - seat.x, q.y - seat.y);
      const vulnerable = q.hp < q.maxHp * 0.58 || q.arenaScore <= seat.arenaScore * 1.15;
      const leader = world.standings()[0] === q;
      if (d < 520 && d < preyD && (vulnerable || (leader && seat.hp > seat.maxHp * 0.7))) {
        prey = q;
        preyD = d;
      }
    }
    if (prey && !errs && this.rng.next() < 0.38 + this.profile.skill * 0.48) {
      const dx = prey.x - seat.x;
      const dy = prey.y - seat.y;
      const d = dhypot(dx, dy) || 1;
      // Approach on a shallow flank so pursuit does not look like a bot
      // marching down a ruler and naturally sends projectiles across the prey.
      const flank = this.profile.skill * 0.24;
      this.moveX = dx / d - (dy / d) * flank;
      this.moveY = dy / d + (dx / d) * flank;
      return;
    }

    // Sweep for experience. Better rivals look further for it.
    const reach = 260 + this.profile.skill * 220;
    let gx = 0;
    let gy = 0;
    let gn = 0;
    for (const g of world.gems.active) {
      if (dhypot(g.x - seat.x, g.y - seat.y) < reach) {
        gx += g.x;
        gy += g.y;
        gn++;
      }
    }
    if (gn > 0 && !errs) {
      const dx = gx / gn - seat.x;
      const dy = gy / gn - seat.y;
      const d = dhypot(dx, dy) || 1;
      this.moveX = dx / d;
      this.moveY = dy / d;
      return;
    }

    this.heading += this.rng.range(-1.4, 1.4);
    this.moveX = dcos(this.heading);
    this.moveY = dsin(this.heading);
  }

  /** Weak rivals grab whatever is offered; strong ones pursue an evolution. */
  pickCard(cards: readonly Card[]): string {
    if (cards.length === 0) return '';
    if (!this.profile.drafts || this.rng.next() < this.profile.mistake) {
      return cards[Math.floor(this.rng.next() * cards.length) % cards.length]!.id;
    }
    const evo = cards.find((c) => c.kind === 'evolution');
    if (evo) return evo.id;
    // The passive that completes a maxed weapon — the actual evolution rule,
    // and the only reason a drafting rival looks like it has a plan.
    for (const c of cards) {
      if (c.kind !== 'passive' || !c.passiveId) continue;
      const passiveId = c.passiveId;
      const wants = this.seatWeapons.some((x) => {
        const d = WEAPONS[x.id];
        return (
          d.evolvesInto &&
          d.evolveWith === passiveId &&
          x.level >= d.maxLevel &&
          (this.seatStacks.get(passiveId) ?? 0) < (d.evolveStacks ?? 1)
        );
      });
      if (wants) return c.id;
    }
    // Deepen the weapon it already has the most of, rather than collecting one
    // level of everything. Written carelessly the first time — the loop tracked
    // no level at all and simply took the first weapon card on the list, which
    // is the "grab whatever is offered" policy the careless branch above
    // already covers, applied to the rivals that were supposed to draft well.
    let best = cards[0]!;
    let bestLevel = -1;
    for (const c of cards) {
      if (c.kind !== 'weapon') continue;
      const held = this.seatWeapons.find((x) => x.id === c.weaponId);
      const lv = held ? held.level : 0;
      if (lv > bestLevel) {
        bestLevel = lv;
        best = c;
      }
    }
    return best.id;
  }

  pickBoon(offer: readonly string[]): string {
    if (offer.length === 0) return '';
    const i = Math.floor(this.rng.next() * offer.length) % offer.length;
    return offer[i] ?? offer[0] ?? '';
  }
}
