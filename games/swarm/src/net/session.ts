import { RemoteBrain } from './remote.js';
import type { SeatBrain, World } from '../sim/world.js';

/** Client side of the live Arena survival race. */
export interface SessionState {
  connected: boolean;
  status: 'idle' | 'matching' | 'live' | 'rejoining' | 'offline';
  /** Local world seats driven by people other than this client. */
  humans: number[];
  room: string;
  latencyMs: number;
}

/** What matchmaking produced: the shared seed and how far in the room already is. */
export interface MatchResult {
  seed: number;
  /** Seconds of the shared run that happened before this client arrived. */
  elapsed: number;
}

const SEND_HZ = 15;
/** How often the room owner republishes the seats nobody is sitting in. */
const BOARD_HZ = 8;
const LOBBY_SIZE = 8;
/** Keep-alive and latency sample. Also stops idle proxies closing the socket. */
const PING_EVERY = 5;
/** How long a mid-run drop keeps trying to get its seat back before giving up. */
const REJOIN_ATTEMPTS = 4;
/** Matches PVP.claimWindow in the sim: how long a hit can still claim a kill. */
const CLAIM_WINDOW = 5;

/**
 * A room never blocks the game indefinitely. If the relay cannot form a match,
 * the caller receives null and starts the same eight-seat arena with AI.
 */
export class ArenaSession {
  private socket: WebSocket | null = null;
  private readonly brains = new Map<number, RemoteBrain>();
  private readonly fallbacks = new Map<number, SeatBrain>();
  private globalSeat = -1;
  private globalHumans: number[] = [];
  private readonly globalNames = new Map<number, string>();
  private sendAcc = 0;
  private pingAcc = 0;
  private boardAcc = 0;
  private world: World | null = null;
  private settleMatch: ((result: MatchResult | null) => void) | null = null;
  private matchTimer: ReturnType<typeof setTimeout> | null = null;
  private rejoinTimer: ReturnType<typeof setTimeout> | null = null;
  private rejoinsLeft = 0;
  private lastUrl = '';
  private lastName = 'GUEST';
  /** The room to ask for next time: a rematch should land on your friends. */
  private preferredRoom = '';
  /**
   * Whether this client's world belongs to the match it is connected to.
   *
   * There is a gap of a few hundred milliseconds between the relay saying the
   * room has started and this client actually building the run — the ad, the
   * start runway, one turn of the promise. The socket is live for all of it,
   * and without this flag the game happily published the PREVIOUS run during
   * that window: an old position, an old level, and `alive: false`, because the
   * previous run ended in death.
   *
   * The cost of that was not cosmetic. Every peer read the corpse as a real
   * death, ran the full elimination — banner, bounty, and the loser's mass
   * spilled onto the floor — and whoever happened to be standing there ate a
   * free level in the first quarter-second of the match. It was found by a
   * two-browser test freezing on a card screen at t=0.22s.
   */
  private armed = false;

  readonly state: SessionState = {
    connected: false,
    status: 'idle',
    humans: [],
    room: '',
    latencyMs: 0,
  };

  seed: number | null = null;
  /** Seconds of the shared run already elapsed when this client joined. */
  joinedAt = 0;
  /** Wall-clock instant after which this room stops accepting newcomers. */
  private roomOpenUntil = 0;
  onState: ((state: SessionState) => void) | null = null;

  attach(world: World): void {
    this.world = world;
  }

  /** Open a fresh matchmaking socket and resolve on the synchronized start. */
  match(url: string, timeoutMs = 4500, displayName = 'GUEST'): Promise<MatchResult | null> {
    this.disconnect();
    if (!url) return Promise.resolve(null);
    this.lastUrl = url;
    this.lastName = displayName;
    this.armed = false;
    this.state.status = 'matching';
    this.emitState();

    return new Promise<MatchResult | null>((resolve) => {
      this.settleMatch = resolve;
      this.matchTimer = setTimeout(() => {
        const stale = this.socket;
        this.socket = null;
        if (stale) {
          stale.onclose = null;
          stale.onerror = null;
          try { stale.close(); } catch { /* already gone */ }
        }
        this.finishMatch(null);
      }, timeoutMs);
      // A rematch asks for the room it just left. The relay hands it over when
      // that room still exists and still has space, which is what keeps a group
      // of friends together across rounds instead of scattering them.
      if (!this.open(url, displayName, this.preferredRoom, -1)) this.finishMatch(null);
    });
  }

  /**
   * Which shared seat number each local seat represents.
   *
   * Local seat 0 is always this client. Everything that has to look the same on
   * every screen — a rival's character, its behaviour profile, its random
   * stream — is keyed off these instead of the local index.
   */
  seatIds(): number[] {
    const ids: number[] = [];
    for (let local = 1; local < LOBBY_SIZE; local++) ids.push(this.toGlobalSeat(local));
    return ids;
  }

  /** This client's own shared seat number, or -1 when not in a room. */
  get seatId(): number {
    return this.globalSeat;
  }

  /**
   * Whether a friend could still be dropped into this room right now.
   *
   * Reported to the portal, which uses it to decide whether to offer this match
   * to somebody's friends. It has to be the truth at the moment it is asked:
   * a room advertised as joinable after its window has closed sends people to a
   * door that is locked.
   */
  get roomJoinable(): boolean {
    if (this.state.status !== 'live' || !this.state.room) return false;
    if (this.globalHumans.length >= LOBBY_SIZE) return false;
    return Date.now() < this.roomOpenUntil;
  }

  /**
   * Ask for a specific room on the next match — an invite link, or a rematch.
   *
   * The relay honours it when that room exists and still has space, and falls
   * back to ordinary matchmaking when it does not, so a stale link costs the
   * player a normal game rather than an error.
   */
  preferRoom(room: string): void {
    if (room) this.preferredRoom = room.slice(0, 64);
  }

  /**
   * Install remote brains after World.enterArena has created all eight seats.
   *
   * Also the moment this client is allowed to start talking about itself. See
   * `armed`.
   */
  bindHumans(world: World): void {
    this.world = world;
    this.armed = true;
    world.onSeatDownClaim = this.sendDownClaim;
    world.ownsRivalScores = this.isHost() || this.globalSeat < 0;
    this.brains.clear();
    this.fallbacks.clear();
    this.state.humans = [];
    for (const global of this.globalHumans) {
      if (global === this.globalSeat) continue;
      this.takeSeat(this.toLocalSeat(global));
    }
    this.emitState();
  }

  private open(url: string, displayName: string, room: string, seat: number): boolean {
    let socket: WebSocket;
    try {
      const endpoint = new URL(url);
      endpoint.searchParams.set('name', displayName.slice(0, 24));
      if (room) endpoint.searchParams.set('room', room);
      if (seat >= 0) endpoint.searchParams.set('seat', String(seat));
      socket = new WebSocket(endpoint.toString());
    } catch {
      return false;
    }
    this.socket = socket;
    socket.onopen = () => {
      this.state.connected = true;
      this.emitState();
      this.send({ t: 'ping', at: Date.now() });
    };
    socket.onmessage = (ev) => this.receive(String(ev.data));
    socket.onclose = () => this.drop();
    socket.onerror = () => this.drop();
    return true;
  }

  private receive(raw: string): void {
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return;
    }

    if (msg.t === 'joined') {
      this.globalSeat = finiteInt(msg.seat, -1);
      this.seed = finiteNumber(msg.seed, null);
      this.state.room = typeof msg.room === 'string' ? msg.room : '';
      this.preferredRoom = this.state.room;
      this.globalHumans = numberList(msg.humans);
      this.readPlayers(msg.players);
      // A rejoin lands back into a run already on screen, so the seat mapping
      // has to be rebuilt immediately — the relay may have handed us a
      // different seat, which renumbers everybody.
      if (this.state.status === 'rejoining' && this.world) this.bindHumans(this.world);
      this.emitState();
      return;
    }

    if (msg.t === 'start') {
      const seed = finiteNumber(msg.seed, this.seed);
      if (seed === null) return;
      this.seed = seed;
      this.globalHumans = numberList(msg.humans);
      this.readPlayers(msg.players);
      const rejoining = this.state.status === 'rejoining';
      this.state.status = 'live';
      this.rejoinsLeft = 0;
      if (this.matchTimer) clearTimeout(this.matchTimer);
      // How much of the shared run happened before we got here. Zero for the
      // players who opened the room; up to the relay's join window for anyone
      // who arrived while it was already running.
      this.joinedAt = Math.max(0, finiteNumber(msg.elapsedMs, 0) ?? 0) / 1000;
      const window = Math.max(0, finiteNumber(msg.joinableMs, 0) ?? 0);
      this.roomOpenUntil = Date.now() + Math.max(0, window - this.joinedAt * 1000);
      const delay = Math.max(0, Math.min(1500, finiteInt(msg.delayMs, 0)));
      if (rejoining) {
        // Already mid-run; there is nothing to start.
        this.matchTimer = null;
        if (this.world) this.bindHumans(this.world);
      } else {
        this.matchTimer = setTimeout(
          () => this.finishMatch({ seed, elapsed: this.joinedAt }),
          delay,
        );
      }
      this.emitState();
      return;
    }

    if (msg.t === 'pong') {
      const at = finiteNumber(msg.at, null);
      if (at !== null) this.state.latencyMs = Math.max(0, Date.now() - at);
      this.emitState();
      return;
    }

    if (msg.t === 'board') {
      // Only from the seat that owns them, and never applied to a seat a person
      // is holding — they speak for themselves.
      const from = finiteInt(msg.seat, -1);
      if (from < 0 || from === this.globalSeat || !this.isBoardOwner(from)) return;
      const world = this.world;
      if (!world || !Array.isArray(msg.b)) return;
      for (const row of msg.b as unknown[]) {
        if (!Array.isArray(row) || row.length < 6) continue;
        const seat = this.toLocalSeat(finiteInt(row[0], -1));
        if (seat <= 0) continue;
        world.applySeatRecord(seat, {
          score: finiteNumber(row[1], 0) ?? 0,
          level: finiteInt(row[2], 1),
          kills: finiteInt(row[3], 0),
          dead: finiteInt(row[4], 0) === 1,
          killer: this.toLocalSeat(finiteInt(row[5], -1)),
          hp: finiteNumber(row[6], 0) ?? 0,
          maxHp: finiteNumber(row[7], 0) ?? 0,
        });
      }
      return;
    }

    const global = finiteInt(msg.seat, -1);
    if (global < 0 || global === this.globalSeat) return;
    const seat = this.toLocalSeat(global);
    if (seat <= 0) return;

    if (msg.t === 'down') {
      this.applyDownClaim(global, msg);
      return;
    }
    if (msg.t === 'seated') {
      if (!this.globalHumans.includes(global)) this.globalHumans.push(global);
      if (typeof msg.name === 'string') this.globalNames.set(global, msg.name);
      this.takeSeat(seat);
      return;
    }
    if (msg.t === 'left') {
      this.globalHumans = this.globalHumans.filter((x) => x !== global);
      this.restoreSeat(seat);
      return;
    }

    /**
     * Any packet from a seat is proof somebody is sitting in it.
     *
     * A phone that loses signal for three seconds goes quiet, `sweep` hands its
     * seat back to the AI, and before this line every later packet from that
     * person was dropped on the floor because the seat no longer had a brain to
     * receive it. Measured: a four-second gap turned a live opponent into a bot
     * permanently, for the rest of the match, on the other player's screen.
     * Taking the seat again on the first packet back makes the demotion
     * temporary, which is what a tunnel actually is.
     */
    let brain = this.brains.get(seat);
    if (!brain && (msg.t === 'state' || msg.t === 'act')) {
      if (!this.globalHumans.includes(global)) this.globalHumans.push(global);
      this.takeSeat(seat);
      brain = this.brains.get(seat);
    }
    if (!brain) return;
    if (msg.t === 'state') {
      brain.apply({
        x: clampUnit(msg.dx),
        y: clampUnit(msg.dy),
        ability: msg.a === 1,
      });
      brain.applySnapshot({
        x: finiteNumber(msg.x, 0) ?? 0,
        y: finiteNumber(msg.y, 0) ?? 0,
        hp: finiteNumber(msg.hp, 0) ?? 0,
        maxHp: finiteNumber(msg.max, 1) ?? 1,
        level: finiteInt(msg.lv, 1),
        kills: finiteInt(msg.k, 0),
        arenaScore: finiteNumber(msg.score, 100) ?? 100,
        pvpKills: finiteInt(msg.pvp, 0),
        arenaStreak: finiteInt(msg.streak, 0),
        alive: msg.alive !== false,
        // The killer arrives as a shared seat number and has to be translated
        // into this client's numbering before the sim can pay anybody.
        killedBy: this.toLocalSeat(finiteInt(msg.by, -1)),
      });
    } else if (msg.t === 'act') {
      if (typeof msg.card === 'string') brain.applyCardChoice(msg.card);
      if (typeof msg.boon === 'string') brain.applyBoonChoice(msg.boon);
    }
  }

  /** Publish local input plus correction state at a modest fixed cadence. */
  update(world: World, dt: number, abilityFired: boolean): void {
    const s = this.socket;
    if (!s || s.readyState !== WebSocket.OPEN) return;
    this.pingAcc += dt;
    if (this.pingAcc >= PING_EVERY) {
      this.pingAcc = 0;
      // Also a keep-alive: an idle websocket behind a load balancer is a closed
      // websocket, and latency shown to the player has to be a live number.
      this.send({ t: 'ping', at: Date.now() });
    }
    if (this.state.status !== 'live' || !this.armed) return;

    /**
     * The room owner publishes the seats nobody is sitting in.
     *
     * The lowest-numbered client in the room, so every client picks the same
     * one without an election, and the choice survives anybody else leaving.
     * See World.applySeatRecord for why these seats need an owner at all.
     */
    // Recomputed every frame rather than cached: the owner changes the moment
    // the lowest-numbered player leaves, and a room with nobody writing the AI
    // seats freezes their scores for everyone left in it.
    const host = this.isHost();
    world.ownsRivalScores = host;
    this.boardAcc += dt;
    if (this.boardAcc >= 1 / BOARD_HZ) {
      this.boardAcc = 0;
      if (host) this.send({ t: 'board', b: this.aiBoard(world) });
    }

    this.sendAcc += dt;
    if (this.sendAcc < 1 / SEND_HZ && !abilityFired) return;
    this.sendAcc = 0;

    const p = world.player;
    // Who gets credit if this packet is the one that reports our death. Sent
    // from the victim's machine because it is the only one that knows.
    const claimant = p.lastHitBy >= 0 && world.time - p.lastHitAt <= CLAIM_WINDOW
      ? this.toGlobalSeat(p.lastHitBy)
      : -1;
    this.send({
      t: 'state',
      x: round(p.x, 10),
      y: round(p.y, 10),
      dx: round(p.input.x, 100),
      dy: round(p.input.y, 100),
      hp: round(p.hp, 10),
      max: round(p.maxHp, 10),
      lv: p.level,
      k: p.kills,
      score: round(p.arenaScore, 10),
      pvp: p.pvpKills,
      streak: p.arenaStreak,
      alive: p.alive,
      by: claimant,
      time: round(world.time, 10),
      a: abilityFired ? 1 : 0,
    });
  }

  /** True when `seat` is the room's lowest-numbered person, i.e. its owner. */
  private isBoardOwner(seat: number): boolean {
    for (const g of this.globalHumans) if (g < seat) return false;
    return true;
  }

  /** True when this client owns the seats nobody is sitting in. */
  private isHost(): boolean {
    if (this.globalSeat < 0) return false;
    for (const g of this.globalHumans) if (g < this.globalSeat) return false;
    return true;
  }

  /** [seat, score, level, kills, dead, killer, hp, maxHp] for every AI seat. */
  private aiBoard(world: World): number[][] {
    const rows: number[][] = [];
    for (let local = 1; local < world.players.length && local < LOBBY_SIZE; local++) {
      const p = world.players[local]!;
      if (p.live) continue;
      const claimed = p.lastHitBy >= 0 && world.time - p.lastHitAt <= CLAIM_WINDOW;
      rows.push([
        this.toGlobalSeat(local),
        Math.round(p.arenaScore),
        p.level,
        p.kills,
        p.alive ? 0 : 1,
        claimed ? this.toGlobalSeat(p.lastHitBy) : -1,
        Math.round(p.hp),
        Math.round(p.maxHp),
      ]);
    }
    return rows;
  }

  /**
   * Somebody else's fight killed a seat this client owns.
   *
   * Trusted, because the shooter's own screen is the only honest account of
   * their own shots, and because this is a casual arena with nothing to win by
   * lying — the relay validates shape, never claims. The owner runs the death
   * and republishes it, so every client converges on one funeral with one
   * killer named.
   */
  private applyDownClaim(fromGlobal: number, msg: Record<string, unknown>): void {
    const world = this.world;
    if (!world || !this.isHost()) return;
    const seat = this.toLocalSeat(finiteInt(msg.s, -1));
    if (seat <= 0) return;
    const target = world.players[seat];
    if (!target || !target.alive || target.live) return;
    const killerGlobal = finiteInt(msg.by, -1);
    const killer = killerGlobal >= 0 ? this.toLocalSeat(killerGlobal) : this.toLocalSeat(fromGlobal);
    world.reportSeatDown(target, killer);
  }

  /** Installed on the world so its damage paths can hand up a kill claim. */
  private readonly sendDownClaim = (seat: number, killer: number): void => {
    if (!this.armed || this.state.status !== 'live') return;
    this.send({
      t: 'down',
      s: this.toGlobalSeat(seat),
      by: killer >= 0 ? this.toGlobalSeat(killer) : -1,
    });
  };

  sendCard(id: string): void {
    if (this.armed) this.send({ t: 'act', card: id });
  }

  sendBoon(id: string): void {
    if (this.armed) this.send({ t: 'act', boon: id });
  }

  /** A quiet peer becomes an AI again; a stalled socket never leaves a statue. */
  sweep(): void {
    for (const [seat, brain] of this.brains) {
      if (brain.stale) this.restoreSeat(seat);
    }
  }

  disconnect(): void {
    this.armed = false;
    this.rejoinsLeft = 0;
    if (this.rejoinTimer) clearTimeout(this.rejoinTimer);
    this.rejoinTimer = null;
    const socket = this.socket;
    this.socket = null;
    if (socket) {
      socket.onclose = null;
      socket.onerror = null;
      try { socket.close(); } catch { /* already gone */ }
    }
    this.finishMatch(null);
    for (const seat of [...this.brains.keys()]) this.restoreSeat(seat);
    this.globalSeat = -1;
    this.globalHumans = [];
    this.globalNames.clear();
    this.seed = null;
    this.joinedAt = 0;
    this.roomOpenUntil = 0;
    this.state.connected = false;
    this.state.status = 'idle';
    this.state.humans = [];
    this.state.room = '';
    this.emitState();
  }

  private takeSeat(seat: number): void {
    if (seat <= 0 || seat >= LOBBY_SIZE || this.brains.has(seat)) return;
    const p = this.world?.players[seat];
    if (!p) return;
    if (p.brain) this.fallbacks.set(seat, p.brain);
    const brain = new RemoteBrain();
    this.brains.set(seat, brain);
    p.brain = brain;
    p.live = true;
    p.name = this.globalNames.get(this.toGlobalSeat(seat)) || `LIVE ${seat + 1}`;
    if (!this.state.humans.includes(seat)) this.state.humans.push(seat);
    this.state.humans.sort((a, b) => a - b);
    this.emitState();
  }

  private restoreSeat(seat: number): void {
    const p = this.world?.players[seat];
    const fallback = this.fallbacks.get(seat);
    if (p) {
      if (fallback) p.brain = fallback;
      p.live = false;
    }
    this.brains.delete(seat);
    this.fallbacks.delete(seat);
    this.state.humans = this.state.humans.filter((x) => x !== seat);
    this.emitState();
  }

  /** Global relay seat -> this client's world, where the owner is always 0. */
  private toLocalSeat(global: number): number {
    if (global < 0) return -1;
    // Not in a room: the local numbering IS the shared numbering, so an offline
    // arena and a networked one hand out the same identities.
    if (this.globalSeat < 0) return global;
    if (global === this.globalSeat) return 0;
    let local = 1;
    for (let g = 0; g < LOBBY_SIZE; g++) {
      if (g === this.globalSeat) continue;
      if (g === global) return local;
      local++;
    }
    return -1;
  }

  /** This client's world seat -> shared relay seat. */
  private toGlobalSeat(local: number): number {
    if (local < 0) return -1;
    if (this.globalSeat < 0) return local;
    if (local === 0) return this.globalSeat;
    let nextLocal = 1;
    for (let global = 0; global < LOBBY_SIZE; global++) {
      if (global === this.globalSeat) continue;
      if (nextLocal === local) return global;
      nextLocal++;
    }
    return -1;
  }

  private readPlayers(value: unknown): void {
    if (!Array.isArray(value)) return;
    for (const item of value) {
      if (!item || typeof item !== 'object') continue;
      const player = item as Record<string, unknown>;
      const seat = finiteInt(player.seat, -1);
      if (seat < 0 || seat >= LOBBY_SIZE || typeof player.name !== 'string') continue;
      this.globalNames.set(seat, player.name.slice(0, 24));
    }
  }

  private send(msg: unknown): void {
    const s = this.socket;
    if (s && s.readyState === WebSocket.OPEN) s.send(JSON.stringify(msg));
  }

  private finishMatch(result: MatchResult | null): void {
    if (this.matchTimer) clearTimeout(this.matchTimer);
    this.matchTimer = null;
    const settle = this.settleMatch;
    this.settleMatch = null;
    settle?.(result);
    if (result === null && this.state.status === 'matching') {
      this.state.status = 'offline';
      this.emitState();
    }
  }

  /**
   * The socket died. Whether that ends multiplayer depends on when.
   *
   * Before the run: fall through to the AI lobby, which is what the caller is
   * waiting for. Mid-run: a dropped socket on a phone is usually a lift, a lock
   * screen or a handover between cells, and treating it as "you are alone now,
   * permanently" throws away a match that is still there. So the seat is asked
   * for again, by room and by number, a few times before giving up.
   */
  private drop(): void {
    const wasLive = this.state.status === 'live' || this.state.status === 'rejoining';
    this.socket = null;
    this.state.connected = false;
    for (const seat of [...this.brains.keys()]) this.restoreSeat(seat);

    if (wasLive && this.lastUrl && this.preferredRoom) {
      // A fresh drop gets the full allowance; a failed rejoin keeps counting
      // down the one it is already spending.
      if (this.state.status !== 'rejoining') this.rejoinsLeft = REJOIN_ATTEMPTS;
      this.scheduleRejoin();
      return;
    }
    this.state.status = 'offline';
    this.finishMatch(null);
    this.emitState();
  }

  private scheduleRejoin(): void {
    if (this.rejoinsLeft <= 0) {
      this.state.status = 'offline';
      this.emitState();
      return;
    }
    const attempt = REJOIN_ATTEMPTS - this.rejoinsLeft;
    this.rejoinsLeft--;
    this.state.status = 'rejoining';
    this.emitState();
    if (this.rejoinTimer) clearTimeout(this.rejoinTimer);
    this.rejoinTimer = setTimeout(() => {
      this.rejoinTimer = null;
      if (this.state.status !== 'rejoining') return;
      if (!this.open(this.lastUrl, this.lastName, this.preferredRoom, this.globalSeat)) {
        this.scheduleRejoin();
      }
    }, 400 * (attempt + 1));
  }

  private emitState(): void {
    this.onState?.(this.state);
  }
}

function finiteNumber(value: unknown, fallback: number | null): number | null {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function finiteInt(value: unknown, fallback: number): number {
  const n = finiteNumber(value, null);
  return n === null ? fallback : Math.trunc(n);
}

function numberList(value: unknown): number[] {
  if (!Array.isArray(value)) return [];
  return value.map((x) => finiteInt(x, -1)).filter((x) => x >= 0 && x < LOBBY_SIZE);
}

function clampUnit(value: unknown): number {
  const n = finiteNumber(value, 0) ?? 0;
  return Math.max(-1, Math.min(1, n));
}

function round(value: number, scale: number): number {
  return Math.round(value * scale) / scale;
}
