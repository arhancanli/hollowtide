import type { Player, SeatBrain, World } from '../sim/world.js';
import type { Card } from '../content/upgrades.js';

/**
 * A seat driven by somebody else's keyboard.
 *
 * This is the whole client half of multiplayer, and it is small on purpose. It
 * implements the SAME SeatBrain interface the AI implements, so from the
 * simulation's point of view there is no such thing as a network player: there
 * are seats, and something writes their input. That is why a person can join
 * mid-run without a spawn, a countdown or a lobby transition — World.seatPlayer
 * swaps one brain for another and the build, position and standing that seat
 * already had carry straight on.
 *
 * WHY INPUTS AND NOT POSITIONS. The simulation is bit-identical across engines
 * (see packages/core/src/detmath.ts and `npm run detguard`), so every client
 * can run the entire eight-seat arena from one seed. Sending positions would be
 * ~40x the bandwidth AND would let a modified client teleport; sending inputs
 * means a cheater can only do things the game already permits.
 *
 * WHAT IT DOES WHEN THE NETWORK MISBEHAVES — which is most of the time on a
 * phone. It holds the last known input rather than zeroing it. A seat that
 * stops dead on every dropped packet reads as broken; a seat that keeps walking
 * for 200ms reads as a person with bad wifi. After `staleAfter` it hands the
 * seat back to the AI, so a player who closes their tab leaves behind an
 * opponent rather than a statue.
 */

export interface RemoteInput {
  x: number;
  y: number;
  /** Set when the remote player fired their ability this tick. */
  ability?: boolean;
}

/** Authoritative presentation state periodically published by a remote peer. */
export interface RemoteSnapshot {
  x: number;
  y: number;
  hp: number;
  maxHp: number;
  level: number;
  kills: number;
  arenaScore: number;
  pvpKills: number;
  arenaStreak: number;
  alive: boolean;
  /**
   * The seat this client believes killed them, in LOCAL numbering, or -1.
   *
   * Sent by the victim because the victim is the only machine that knows. A
   * kill claimed by the shooter's own simulation is a kill the victim never
   * experienced.
   */
  killedBy: number;
}

/** Seconds of silence before a remote seat is considered gone. */
const STALE_AFTER = 2.5;

export class RemoteBrain implements SeatBrain {
  readonly runsWhileDead = true;
  private x = 0;
  private y = 0;
  private ability = false;
  private silent = 0;
  /** Card and boon choices arrive as ids; until one does, nothing is picked. */
  private card: string | null = null;
  private boon: string | null = null;
  private snapshot: RemoteSnapshot | null = null;

  /** Set by the transport when a packet for this seat arrives. */
  apply(input: RemoteInput): void {
    this.x = input.x;
    this.y = input.y;
    if (input.ability) this.ability = true;
    this.silent = 0;
  }

  applyCardChoice(id: string): void {
    this.card = id;
  }

  applyBoonChoice(id: string): void {
    this.boon = id;
  }

  applySnapshot(snapshot: RemoteSnapshot): void {
    this.snapshot = snapshot;
    this.silent = 0;
  }

  /** True once this seat has gone quiet long enough to hand back to the AI. */
  get stale(): boolean {
    return this.silent > STALE_AFTER;
  }

  think(world: World, seat: Player, dt: number): void {
    this.silent += dt;
    // Hold the last input through a gap rather than zeroing it. Zeroing makes
    // every dropped packet look like the player let go of the stick.
    seat.input.x = this.x;
    seat.input.y = this.y;
    const snap = this.snapshot;
    if (snap) {
      // State packets correct network drift without visible teleporting. Large
      // gaps snap because interpolating a reconnect across the whole arena is
      // more misleading than acknowledging it immediately.
      const dx = snap.x - seat.x;
      const dy = snap.y - seat.y;
      const d2 = dx * dx + dy * dy;
      const correction = d2 > 240 * 240 ? 1 : Math.min(1, dt * 10);
      seat.x += dx * correction;
      seat.y += dy * correction;
      seat.maxHp = Math.max(1, snap.maxHp);
      seat.hp = Math.max(0, Math.min(seat.maxHp, snap.hp));
      seat.level = Math.max(1, snap.level | 0);
      seat.kills = Math.max(0, snap.kills | 0);
      seat.arenaScore = Math.max(0, snap.arenaScore);
      seat.pvpKills = Math.max(0, snap.pvpKills | 0);
      seat.arenaStreak = Math.max(0, snap.arenaStreak | 0);
      if (!snap.alive && seat.alive) {
        // Their machine says they are down, so here it counts: the killer they
        // named collects the bounty, the elimination is announced, and their
        // mass spills onto the floor for whoever is brave enough to stand in it.
        world.reportSeatDown(seat, snap.killedBy);
      } else if (snap.alive && !seat.alive) {
        seat.alive = true;
        seat.diedAt = -1;
      }
    }
    if (this.ability) {
      this.ability = false;
      world.useAbility(seat);
    }
  }

  /**
   * The card this seat's owner picked.
   *
   * Falls back to the first offer rather than stalling. A remote level-up that
   * waits for a packet would freeze that seat's progression for everyone
   * watching, and the seat is not allowed to be a worse opponent because
   * somebody's connection hiccuped at the wrong moment.
   */
  pickCard(cards: readonly Card[]): string {
    const chosen = this.card;
    this.card = null;
    if (chosen && cards.some((c) => c.id === chosen)) return chosen;
    return cards[0]?.id ?? '';
  }

  pickBoon(offer: readonly string[]): string {
    const chosen = this.boon;
    this.boon = null;
    if (chosen && offer.includes(chosen)) return chosen;
    return offer[0] ?? '';
  }
}
