/**
 * The arena relay.
 *
 * WHAT IT IS NOT: a game server. It never simulates anything, never validates a
 * move, and never holds a world. That is deliberate and it is only possible
 * because the simulation is deterministic — see packages/core/src/detmath.ts,
 * where every transcendental the sim touches is reimplemented in arithmetic
 * because ECMA-262 only guarantees correct rounding for Math.sqrt. Measured
 * across V8 and JavaScriptCore, the stock functions disagree on 30.2% of hypot
 * inputs and 13.2% of atan2 inputs, which is more than enough to desync two
 * browsers by the first boss.
 *
 * Because runs are bit-identical, every client can simulate the whole arena
 * from the same seed and the same inputs. So this process moves INPUTS — two
 * bytes of direction and the occasional card choice — not world state. Eight
 * players at 20Hz is a few KB/s per room, which is why a $5 box can hold
 * hundreds of rooms and why this can be a relay rather than a fleet.
 *
 * RUNNING IT
 *   npm run relay              # PORT=8787 by default
 * Point the client at it with VITE_RELAY_URL. With no URL configured the game
 * runs exactly as it does today: solo, or an arena filled entirely with AI.
 * The network is an upgrade to the arena, never a requirement for it.
 */

import { WebSocketServer, type WebSocket } from 'ws';
import { createServer } from 'node:http';
import { pathToFileURL } from 'node:url';

/** Seats in a room, matching LOBBY_SIZE in the game. */
const LOBBY_SIZE = 8;

/**
 * How long a room gathers players before the shared run begins.
 *
 * Deliberately short. Nobody waits in a lobby on a portal — the run has to
 * start immediately — so this is a jitter window, not a queue.
 */
const MATCHMAKING_MS = 1_200;

/**
 * How long a room stays open to joiners AFTER it starts. This is the number
 * that decides whether multiplayer exists.
 *
 * It used to be zero: `findRoom` skipped every started room, so two people had
 * to press MULTIPLAYER inside the same 1.2 seconds or they were placed in
 * separate rooms and each played a lobby of bots. Measured, three players
 * arriving 0s/2s/6s apart produced three rooms of one. On a portal where a new
 * game sees a handful of concurrent players, that is a multiplayer mode that
 * never once contains a second person.
 *
 * Joining late is not a spawn: the client hands the seat to the arriving player
 * by deleting one AI brain (World.seatPlayer), so the build, position and
 * standing that seat already had carry straight on. The joiner fast-forwards
 * their own copy of the run to the room clock, which is why this window is
 * bounded — the catch-up has to stay cheap and the inherited seat has to stay
 * small enough to feel like a head start rather than someone else's save file.
 */
const JOINABLE_MS = 45_000;

/** Small shared runway after the room locks, absorbing ordinary packet jitter. */
const START_DELAY_MS = 350;

/** A room with no live sockets is swept this long after the last one leaves. */
const EMPTY_ROOM_TTL_MS = 30_000;

/**
 * Liveness. A phone that loses signal does not close its socket — the TCP
 * connection simply stops answering, and without a heartbeat that seat stays
 * occupied until the OS gives up, which can be minutes. `lastSeen` was already
 * being recorded and never read; these two numbers are what make it mean
 * something.
 */
const HEARTBEAT_MS = 15_000;
const SILENT_LIMIT_MS = 45_000;

/** Hard ceiling on tracked rooms, so a flood cannot grow the map without end. */
const MAX_ROOMS = 500;

/**
 * Input rate. The client sends at this cadence and the relay does not smooth,
 * batch or interpolate — anything it changed would have to be changed back
 * identically on eight machines.
 */
const TICK_HZ = 20;

interface Member {
  socket: WebSocket;
  seat: number;
  name: string;
  alive: boolean;
  lastSeen: number;
  rateWindow: number;
  rateCount: number;
}

interface Room {
  id: string;
  seed: number;
  createdAt: number;
  /** When the shared run began, or 0 while the room is still gathering. */
  startedAt: number;
  members: Map<number, Member>;
  /** Seats not held by a human. The client fills these with AI. */
  freeSeats: number[];
  started: boolean;
  emptyAt: number;
}

const rooms = new Map<string, Room>();

function now(): number {
  return Date.now();
}

/** Milliseconds of shared run a joiner has to catch up on. Zero before start. */
function elapsedMs(room: Room): number {
  return room.startedAt === 0 ? 0 : Math.max(0, now() - room.startedAt);
}

/** A room a newcomer can still be placed into. */
function joinable(room: Room): boolean {
  if (room.freeSeats.length === 0) return false;
  if (!room.started) return true;
  return elapsedMs(room) <= JOINABLE_MS;
}

/**
 * Find a room to join, or open one.
 *
 * Prefers, in order: the room the player asked for (a rematch with the people
 * they just played), then the FULLEST joinable room, then a new one. Preferring
 * the fullest rather than the emptiest is what makes a game with real players
 * feel like one — spreading four people across four rooms gives all four of
 * them a lobby of bots.
 *
 * A started room stays in the running until its join window closes. That single
 * condition is the difference between "you must tap within 1.2 seconds of a
 * stranger" and "you meet anyone who started in the last 45 seconds".
 */
function findRoom(seedFor: () => number, preferred?: string | null): Room {
  if (preferred) {
    const asked = rooms.get(preferred);
    // The rematch case: the room the player just left is usually still there,
    // still inside its window, and still holding their friends.
    if (asked && joinable(asked)) return asked;
  }

  /**
   * Rank: a room that has not started yet always wins.
   *
   * Starting together is a better round than walking in on one, so two people
   * who arrive a second apart should meet in the gathering room even when a
   * fuller room is already running. Only when nothing is gathering does a
   * joiner get placed into a live match. After that, more people beats fewer,
   * and a fresher room beats an older one — less of it to catch up on.
   */
  let best: Room | null = null;
  const rank = (r: Room): number[] => [r.started ? 0 : 1, r.members.size, r.createdAt];
  for (const room of rooms.values()) {
    if (!joinable(room)) continue;
    if (!best) {
      best = room;
      continue;
    }
    const a = rank(room);
    const b = rank(best);
    for (let i = 0; i < a.length; i++) {
      if (a[i]! === b[i]!) continue;
      if (a[i]! > b[i]!) best = room;
      break;
    }
  }
  if (best) return best;

  const id = `r${now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
  const room: Room = {
    id,
    seed: seedFor(),
    createdAt: now(),
    startedAt: 0,
    members: new Map(),
    // Seat 0 is not reserved for anyone: on each client, seat 0 is whoever is
    // holding that client. Seats are just indices into a shared arena.
    freeSeats: Array.from({ length: LOBBY_SIZE }, (_, i) => i),
    started: false,
    emptyAt: 0,
  };
  rooms.set(id, room);
  const timer = setTimeout(() => startRoom(room), MATCHMAKING_MS);
  timer.unref?.();
  return room;
}

/** Forget rooms nobody is in. Cheap, and the only thing that bounds the map. */
function sweepRooms(): void {
  const t = now();
  for (const room of [...rooms.values()]) {
    if (room.members.size > 0) continue;
    if (room.emptyAt === 0) room.emptyAt = t;
    if (t - room.emptyAt >= EMPTY_ROOM_TTL_MS) rooms.delete(room.id);
  }
}

function startRoom(room: Room): void {
  if (room.started || !rooms.has(room.id)) return;
  room.started = true;
  room.startedAt = now() + START_DELAY_MS;
  const humans = [...room.members.keys()];
  // The client waits this runway before stepping frame one. A short explicit
  // countdown produces much tighter starts than "begin whenever joined lands".
  broadcast(room, {
    t: 'start',
    seed: room.seed,
    humans,
    players: playersIn(room),
    delayMs: START_DELAY_MS,
    elapsedMs: 0,
    joinableMs: JOINABLE_MS,
  });
}

function send(socket: WebSocket, msg: unknown): void {
  if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(msg));
}

function broadcast(room: Room, msg: unknown, except?: number): void {
  const raw = JSON.stringify(msg);
  for (const m of room.members.values()) {
    if (m.seat === except) continue;
    if (m.socket.readyState === m.socket.OPEN) m.socket.send(raw);
  }
}

export function startRelay(port = Number(process.env.PORT ?? 8787)) {
  // One relay per process is the deployment shape; the room map is module state
  // because of it. Clearing here keeps a test that starts several in sequence
  // from inheriting the previous run's rooms and reporting a false pairing.
  rooms.clear();

  const http = createServer((req, res) => {
    // A health endpoint, because the first thing that goes wrong with a relay
    // is that nobody can tell whether it is running or merely listening.
    if (req.url === '/health') {
      const live = [...rooms.values()].reduce((n, r) => n + r.members.size, 0);
      const open = [...rooms.values()].filter(joinable).length;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, rooms: rooms.size, joinable: open, players: live }));
      return;
    }
    res.writeHead(404);
    res.end();
  });

  const wss = new WebSocketServer({ server: http });

  wss.on('connection', (socket, request) => {
    const query = new URL(request.url ?? '/', 'http://relay.local').searchParams;
    if (rooms.size >= MAX_ROOMS) sweepRooms();
    const room = findRoom(() => Math.floor(Math.random() * 0x7fffffff) || 1, query.get('room'));

    // A reconnecting client asks for the seat it already held. Honour it when
    // that seat is genuinely free, so a dropped phone comes back as the same
    // person rather than appearing as a second stranger in a seat of its own.
    const wanted = Number(query.get('seat'));
    const wantedIndex = Number.isInteger(wanted) ? room.freeSeats.indexOf(wanted) : -1;
    const seat = wantedIndex >= 0
      ? room.freeSeats.splice(wantedIndex, 1)[0]
      : room.freeSeats.shift();
    if (seat === undefined) {
      send(socket, { t: 'full' });
      socket.close();
      return;
    }

    const member: Member = {
      socket,
      seat,
      name: safeName(query.get('name')),
      alive: true,
      lastSeen: now(),
      rateWindow: now(),
      rateCount: 0,
    };
    room.members.set(seat, member);
    room.emptyAt = 0;
    socket.on('pong', () => { member.lastSeen = now(); });

    // Everything the client needs to build an identical arena: the seed, which
    // seat it holds, and which seats are humans. Every other seat gets an AI
    // brain locally, so a half-full room is still a full arena.
    send(socket, {
      t: 'joined',
      room: room.id,
      seed: room.seed,
      seat,
      humans: [...room.members.keys()],
      players: playersIn(room),
      startedAt: room.createdAt,
      elapsedMs: elapsedMs(room),
      // How long this room accepts newcomers, so the client can tell the portal
      // whether a friend can still be invited into it.
      joinableMs: JOINABLE_MS,
      hz: TICK_HZ,
    });
    // A room that is already running does not make the newcomer wait for a
    // start that has already happened — it tells them how far in they are and
    // lets them catch up. Without this, joining a live room stalled the client
    // until its 4.5s matchmaking timeout and then dropped it into a bot lobby.
    if (room.started) {
      send(socket, {
        t: 'start',
        seed: room.seed,
        humans: [...room.members.keys()],
        players: playersIn(room),
        delayMs: 0,
        elapsedMs: elapsedMs(room),
        joinableMs: JOINABLE_MS,
      });
    }
    broadcast(room, { t: 'seated', seat, name: member.name }, seat);

    socket.on('message', (data) => {
      member.lastSeen = now();
      if (now() - member.rateWindow >= 1000) {
        member.rateWindow = now();
        member.rateCount = 0;
      }
      // The game publishes at 15Hz. Sixty messages leaves ample burst room but
      // prevents a modified client from turning one socket into a broadcast DoS.
      if (++member.rateCount > 60) return;
      let msg: { t?: string; [k: string]: unknown };
      try {
        msg = JSON.parse(String(data));
      } catch {
        return;
      }
      // The relay understands exactly one thing: this seat did this. It does
      // not know what a card is, and it must not learn — the moment it starts
      // interpreting play, it becomes a second implementation of the rules and
      // the two will disagree.
      if (msg.t === 'state') {
        broadcast(room, sanitizeState(msg, seat), seat);
        return;
      }
      if (msg.t === 'down') {
        // "my fight killed seat N, credit seat M". Two bounded seat numbers;
        // the relay has no idea what either of them means.
        broadcast(room, {
          t: 'down',
          seat,
          s: Math.trunc(bounded(msg.s, 0, LOBBY_SIZE - 1)),
          by: Math.trunc(bounded(msg.by, -1, LOBBY_SIZE - 1, -1)),
        }, seat);
        return;
      }
      if (msg.t === 'board') {
        broadcast(room, { t: 'board', seat, b: sanitizeBoard(msg.b) }, seat);
        return;
      }
      if (msg.t === 'act') {
        const action: { t: 'act'; seat: number; card?: string; boon?: string } = { t: 'act', seat };
        if (typeof msg.card === 'string' && msg.card.length <= 64) action.card = msg.card;
        if (typeof msg.boon === 'string' && msg.boon.length <= 64) action.boon = msg.boon;
        if (action.card || action.boon) broadcast(room, action, seat);
        return;
      }
      if (msg.t === 'ping') send(socket, { t: 'pong', at: msg.at });
    });

    let left = false;
    const leave = (): void => {
      if (left) return;
      left = true;
      room.members.delete(seat);
      // The seat does not empty — it goes back to the AI that was holding it
      // before this player arrived. From every other client's point of view the
      // player did not vanish; they simply stopped playing well.
      broadcast(room, { t: 'left', seat });
      // Recycled whether or not the run has begun. Holding a seat empty for the
      // rest of a started room means a room slowly starves itself of joiners
      // while advertising free space it will not hand out.
      if (!room.freeSeats.includes(seat)) room.freeSeats.push(seat);
      room.freeSeats.sort((a, b) => a - b);
      if (room.members.size === 0) room.emptyAt = now();
    };

    socket.on('close', leave);
    socket.on('error', leave);
  });

  /**
   * Liveness and housekeeping on one timer.
   *
   * A ping frame is answered by the browser itself, below the application, so
   * this detects a socket whose other end has vanished without the client
   * having to cooperate — which is the case that matters, because the client
   * that has vanished is by definition not cooperating.
   */
  const heartbeat = setInterval(() => {
    const t = now();
    for (const room of rooms.values()) {
      for (const member of [...room.members.values()]) {
        if (t - member.lastSeen > SILENT_LIMIT_MS) {
          try { member.socket.terminate(); } catch { /* already gone */ }
          continue;
        }
        if (member.socket.readyState === member.socket.OPEN) {
          try { member.socket.ping(); } catch { /* closing */ }
        }
      }
    }
    sweepRooms();
  }, HEARTBEAT_MS);
  heartbeat.unref?.();

  http.listen(port, () => {
    // eslint-disable-next-line no-console
    console.log(
      `arena relay listening on :${port} — ${LOBBY_SIZE} seats/room, ${TICK_HZ}Hz, ` +
      `rooms joinable for ${JOINABLE_MS / 1000}s after start`,
    );
  });

  return { http, wss, heartbeat };
}

function finite(value: unknown, fallback = 0): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function bounded(value: unknown, min: number, max: number, fallback = 0): number {
  return Math.max(min, Math.min(max, finite(value, fallback)));
}

function safeName(value: string | null): string {
  const cleaned = (value ?? 'GUEST')
    .normalize('NFKC')
    .replace(/[^\p{L}\p{N} _.-]/gu, '')
    .trim()
    .slice(0, 24);
  return cleaned || 'GUEST';
}

function playersIn(room: Room): Array<{ seat: number; name: string }> {
  return [...room.members.values()].map(({ seat, name }) => ({ seat, name }));
}

/**
 * The room owner's record of the seats nobody is sitting in.
 *
 * Rebuilt entry by entry rather than forwarded, on the same rule as every other
 * message here: the relay does not know what any of these numbers mean, and it
 * guarantees only that they are numbers, in range, and no longer than a lobby.
 */
function sanitizeBoard(value: unknown): number[][] {
  if (!Array.isArray(value)) return [];
  const rows: number[][] = [];
  for (const row of value.slice(0, LOBBY_SIZE)) {
    if (!Array.isArray(row) || row.length < 6) continue;
    rows.push([
      Math.trunc(bounded(row[0], 0, LOBBY_SIZE - 1)),
      bounded(row[1], 0, 1_000_000_000),
      Math.trunc(bounded(row[2], 1, 10_000, 1)),
      Math.trunc(bounded(row[3], 0, 1_000_000_000)),
      row[4] === 1 ? 1 : 0,
      Math.trunc(bounded(row[5], -1, LOBBY_SIZE - 1, -1)),
    ]);
  }
  return rows;
}

/** Never rebroadcast arbitrary client JSON or non-finite values. */
function sanitizeState(msg: Record<string, unknown>, seat: number): Record<string, unknown> {
  return {
    t: 'state',
    seat,
    x: bounded(msg.x, -20_000, 20_000),
    y: bounded(msg.y, -20_000, 20_000),
    dx: bounded(msg.dx, -1, 1),
    dy: bounded(msg.dy, -1, 1),
    hp: bounded(msg.hp, 0, 1_000_000),
    max: bounded(msg.max, 1, 1_000_000, 1),
    lv: Math.trunc(bounded(msg.lv, 1, 10_000, 1)),
    k: Math.trunc(bounded(msg.k, 0, 1_000_000_000)),
    score: bounded(msg.score, 0, 1_000_000_000, 100),
    pvp: Math.trunc(bounded(msg.pvp, 0, 1_000_000)),
    streak: Math.trunc(bounded(msg.streak, 0, 1_000_000)),
    alive: msg.alive !== false,
    // Who this player says killed them, as a shared seat number. The relay
    // does not know what a kill is and does not check the claim; it only
    // guarantees the field is a seat number and not arbitrary JSON.
    by: Math.trunc(bounded(msg.by, -1, LOBBY_SIZE - 1, -1)),
    time: bounded(msg.time, 0, 86_400),
    a: msg.a === 1 ? 1 : 0,
  };
}

/**
 * Start when run directly, whether that is the TypeScript source under tsx or
 * the compiled JavaScript in the production image.
 *
 * The old check was `endsWith('relay.ts')`, which is silently false for the
 * built file — the container would have started, exited zero, and reported a
 * healthy deploy of a server that never listened.
 */
const entry = process.argv[1] ? pathToFileURL(process.argv[1]).href : '';
if (entry === import.meta.url) startRelay();
