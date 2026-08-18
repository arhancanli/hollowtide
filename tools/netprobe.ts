/**
 * Network forensics for the Live Arena.
 *
 * The existing relay smoke test proves two sockets can exchange a packet, and
 * the browser smoke proves two tabs that press PLAY in the same millisecond see
 * each other move. Neither answers the questions that decide whether
 * multiplayer works for actual people:
 *
 *   - do two players who tap MULTIPLAYER a few seconds apart meet at all?
 *   - what happens to a seat after a phone loses signal for three seconds?
 *   - do both clients agree on who is winning, and on who killed whom?
 *   - does the relay leak rooms when a socket dies without closing?
 *
 * So this runs REAL ArenaSessions against a REAL relay, each driving a real
 * eight-seat World in real time, and measures the answers.
 *
 *   npx tsx tools/netprobe.ts            # every scenario
 *   npx tsx tools/netprobe.ts stagger    # one of them
 */

import { WebSocket as NodeWebSocket } from 'ws';
import { once } from 'node:events';
import { FIXED_STEP } from '@arcade/core';
import { startRelay } from '../packages/relay/src/relay.js';
import { ArenaSession, type MatchResult } from '../games/swarm/src/net/session.js';
import { World } from '../games/swarm/src/sim/world.js';
import { RivalBrain } from '../games/swarm/src/sim/seatai.js';
import { CHARACTERS } from '../games/swarm/src/content/characters.js';
import { LOBBY_SIZE, makeRivals } from '../games/swarm/src/content/rivals.js';

// ArenaSession is browser code by design; give it the browser global.
(globalThis as { WebSocket?: unknown }).WebSocket = NodeWebSocket;

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

interface Failure {
  scenario: string;
  detail: string;
}

const failures: Failure[] = [];
const notes: string[] = [];

function check(scenario: string, ok: boolean, detail: string): void {
  if (!ok) failures.push({ scenario, detail });
}

/** One simulated person: their own browser, their own world, their own socket. */
class Client {
  readonly session = new ArenaSession();
  readonly world: World;
  private driver: RivalBrain;
  /** Set false to simulate a phone that stopped transmitting. */
  transmitting = true;
  seed = 0;
  /** Rival eliminations this client believes happened, by victim name. */
  readonly claimed: Array<{ victim: string; killer: string; at: number }> = [];

  constructor(readonly name: string, readonly skillIndex: number) {
    this.world = new World(1);
    this.driver = new RivalBrain(
      makeRivals(1000 + skillIndex, 8)[skillIndex % 8]!,
      1000 + skillIndex,
      0,
    );
  }

  /** Seconds of somebody else's run this client had to replay on arrival. */
  caughtUp = 0;

  /** Matchmaking without building the run, so a scenario can delay that. */
  async matchOnly(url: string): Promise<MatchResult | null> {
    return this.session.match(url, 4500, this.name);
  }

  async match(url: string): Promise<number | null> {
    const result = await this.matchOnly(url);
    this.begin(result?.seed ?? 990_000 + this.skillIndex, result?.elapsed ?? 0);
    return result?.seed ?? null;
  }

  /** Mirror of main.ts startRun(): seats first, then bind, then reset. */
  begin(seed: number, elapsed = 0): void {
    this.seed = seed;
    const ids = this.session.seatIds();
    const roster = makeRivals(seed, LOBBY_SIZE);
    this.world.enterArena(
      ids.map((id) => roster[id] ?? roster[0]!),
      CHARACTERS,
      { seed, ids, self: this.session.seatId },
    );
    this.session.bindHumans(this.world);
    this.world.reset(seed, CHARACTERS[this.skillIndex % CHARACTERS.length]!);
    this.world.setView(320, 240);
    this.driver = new RivalBrain(
      roster[Math.max(0, this.session.seatId)] ?? roster[0]!,
      seed,
      Math.max(0, this.session.seatId),
    );
    this.caughtUp = 0;
    if (elapsed > 1) {
      const target = Math.min(45, elapsed);
      let simulated = 0;
      let guard = 0;
      while (simulated < target && guard++ < 20_000) {
        if (this.world.phase === 'dead') break;
        this.step(FIXED_STEP, false);
        simulated += FIXED_STEP;
      }
      this.world.takeOverSeat();
      this.caughtUp = simulated;
    }
  }

  step(dt: number, networked = true): void {
    const w = this.world;
    if (w.phase === 'dead') {
      // A dead client keeps publishing. This is what tells everyone else the
      // death happened and who to pay for it — the game's own loop does not
      // stop on death either, and an earlier version of this probe returned
      // here and "proved" that deaths never propagate.
      if (networked && this.transmitting) this.session.update(w, dt, false);
      return;
    }
    if (w.phase === 'levelup') {
      const offer = w.pendingCards ?? [];
      if (offer.length) {
        const id = this.driver.pickCard(offer);
        // Gated on `transmitting` like everything else. A phone in a tunnel
        // does not deliver its card pick either, and leaving this ungated let
        // a "silent" client prove it was alive by levelling up — which is
        // correct behaviour in the game and a broken model in the probe.
        if (networked && this.transmitting) this.session.sendCard(id);
        w.chooseUpgrade(id);
      }
      return;
    }
    if (w.phase === 'boon') {
      const offer = w.pendingBoons ?? [];
      if (offer.length) {
        const id = this.driver.pickBoon(offer);
        if (networked && this.transmitting) this.session.sendBoon(id);
        w.chooseBoon(id);
      }
      return;
    }
    this.driver.think(w, w.player, dt);
    w.input.x = w.player.input.x;
    w.input.y = w.player.input.y;
    w.step(dt);
    for (const ev of w.events) {
      if (ev.type === 'rivalDown') {
        this.claimed.push({ victim: ev.name, killer: ev.killer, at: w.time });
      }
    }
    w.clearEvents();
    if (!networked) return;
    if (this.transmitting) this.session.update(w, dt, false);
    this.session.sweep();
  }

  /** The seat this client believes belongs to `name`, or -1. */
  seatOf(name: string): number {
    return this.world.players.findIndex((p) => p.name === name);
  }
}

/** Advance every client in wall-clock real time, because the network is real. */
async function race(clients: Client[], seconds: number, onTick?: (t: number) => void): Promise<void> {
  const started = Date.now();
  let simulated = 0;
  while (Date.now() - started < seconds * 1000) {
    const target = (Date.now() - started) / 1000;
    let guard = 0;
    while (simulated < target && guard++ < 240) {
      for (const c of clients) c.step(FIXED_STEP);
      simulated += FIXED_STEP;
    }
    onTick?.(simulated);
    await sleep(8);
  }
}

/**
 * Stop the fight but keep the sockets pumping.
 *
 * Separates the two reasons two screens can disagree. While everyone is
 * playing, a board read on four machines at the same instant will differ
 * simply because a packet is in flight — that is latency, and no amount of
 * design removes it. Freeze the simulation, let the packets land, and any
 * disagreement that survives is a genuine difference of opinion about the
 * game state, which is a defect.
 */
async function settle(clients: Client[], ms: number): Promise<void> {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    // Stepped with dt = 0. A packet is not applied when it arrives; it is
    // applied when the seat's brain next runs, inside the step. Pumping the
    // sockets without stepping leaves every delivered snapshot sitting unread
    // and reports the resulting staleness as a disagreement — which it did,
    // intermittently, until this line existed. Zero dt advances no clock,
    // spawns nothing and moves nobody; it only lets the brains read their post.
    for (const c of clients) {
      // Inbound: a delivered packet is only read when the seat's brain runs.
      c.step(0);
      // Outbound: publishing is rate-limited on accumulated dt, so a zero-dt
      // step sends nothing. Without this the owner of a seat sat on its latest
      // value and the probe reported the resulting staleness as divergence.
      c.session.update(c.world, 1 / 60, false);
    }
    await sleep(16);
  }
}

async function withRelay<T>(fn: (url: string, relay: ReturnType<typeof startRelay>) => Promise<T>): Promise<T> {
  const relay = startRelay(0);
  await once(relay.http, 'listening');
  const address = relay.http.address();
  if (!address || typeof address !== 'object') throw new Error('relay did not bind');
  const url = `ws://127.0.0.1:${address.port}`;
  try {
    return await fn(url, relay);
  } finally {
    await new Promise<void>((resolve) => relay.wss.close(() => resolve()));
    await new Promise<void>((resolve) => relay.http.close(() => resolve()));
  }
}

async function health(relay: ReturnType<typeof startRelay>): Promise<{ rooms: number; players: number }> {
  const address = relay.http.address();
  if (!address || typeof address !== 'object') throw new Error('no address');
  const res = await fetch(`http://127.0.0.1:${address.port}/health`);
  return (await res.json()) as { rooms: number; players: number };
}

/**
 * SCENARIO 1 — two people who do not tap at the same instant.
 *
 * This is the ordinary case and the one the existing tests never cover: the
 * smoke test drives both tabs from one script, so they always arrive together.
 */
async function stagger(): Promise<void> {
  const S = 'stagger';
  await withRelay(async (url, relay) => {
    const raw: NodeWebSocket[] = [];
    const joins: Array<Record<string, unknown>> = [];
    const open = async (name: string, waitMs: number): Promise<void> => {
      await sleep(waitMs);
      const socket = new NodeWebSocket(`${url}?name=${name}`);
      raw.push(socket);
      socket.on('message', (data) => {
        const msg = JSON.parse(String(data)) as Record<string, unknown>;
        if (msg.t === 'joined') joins.push({ name, ...msg });
      });
      await once(socket, 'open');
    };

    await open('EARLY', 0);
    await open('LATE_2S', 2_000);
    await open('LATE_6S', 4_000);
    await sleep(600);

    const rooms = joins.map((j) => String(j.room));
    notes.push(`${S}: rooms joined = ${JSON.stringify(rooms)}`);
    check(
      S,
      new Set(rooms).size === 1,
      `three players arriving 0s/2s/6s apart landed in ${new Set(rooms).size} different rooms — ` +
        `they never meet. rooms=${JSON.stringify(rooms)}`,
    );

    const live = await health(relay);
    notes.push(`${S}: /health = ${JSON.stringify(live)}`);
    for (const s of raw) s.close();
    await sleep(200);
  });
}

/**
 * SCENARIO 2 — a real four-player race, measured end to end.
 */
async function fourWay(): Promise<void> {
  const S = 'four-way';
  await withRelay(async (url) => {
    const clients = [0, 1, 2, 3].map((i) => new Client(`RACER${i}`, i));
    const seeds = await Promise.all(clients.map((c) => c.match(url)));

    check(S, seeds.every((s) => s !== null), `matchmaking returned null for ${seeds.filter((s) => s === null).length}/4 clients`);
    check(S, new Set(seeds).size === 1, `clients disagreed on the seed: ${JSON.stringify(seeds)}`);
    const rooms = clients.map((c) => c.session.state.room);
    check(S, new Set(rooms).size === 1, `clients landed in different rooms: ${JSON.stringify(rooms)}`);

    for (const c of clients) {
      check(
        S,
        c.session.state.humans.length === 3,
        `${c.name} sees ${c.session.state.humans.length} live peers, expected 3`,
      );
    }

    // Every client should be able to name every other client's seat.
    for (const c of clients) {
      for (const other of clients) {
        if (c === other) continue;
        check(S, c.seatOf(other.name) > 0, `${c.name} has no seat named ${other.name}`);
      }
    }

    let worstDrift = 0;
    let driftSamples = 0;
    let driftTotal = 0;
    let charMismatch = 0;
    let charChecks = 0;
    /**
     * Board agreement, sampled continuously rather than once at the end.
     *
     * One end-of-race snapshot cannot tell a real disagreement from two seats
     * crossing between packets. A rate can: `boardTicks` counts every sample,
     * `rankSplit` counts samples where any player's place differs across
     * machines, and `materialSplit` counts only the ones where the two seats
     * that swapped were more than five mass apart — i.e. not a photo finish.
     */
    let boardTicks = 0;
    let rankSplit = 0;
    let materialSplit = 0;

    await race(clients, 25, () => {
      boardTicks++;
      for (const person of clients) {
        const views = clients.map((c) => {
          const seat = c === person ? 0 : c.seatOf(person.name);
          const order = c.world.standings();
          const at = order.findIndex((q) => q.index === seat);
          return { place: at + 1, score: order[at]?.arenaScore ?? 0, neighbour: order[at + 1]?.arenaScore ?? 0 };
        });
        if (new Set(views.map((v) => v.place)).size === 1) continue;
        rankSplit++;
        if (views.some((v) => Math.abs(v.score - v.neighbour) > 5)) materialSplit++;
      }
      for (const c of clients) {
        for (const other of clients) {
          if (c === other) continue;
          const seat = c.seatOf(other.name);
          if (seat < 1) continue;
          const mine = c.world.players[seat]!;
          const truth = other.world.player;
          const d = Math.hypot(mine.x - truth.x, mine.y - truth.y);
          worstDrift = Math.max(worstDrift, d);
          driftTotal += d;
          driftSamples++;
          charChecks++;
          if (mine.character.id !== truth.character.id) charMismatch++;
        }
      }
    });

    notes.push(
      `${S}: remote position error mean ${(driftTotal / Math.max(1, driftSamples)).toFixed(1)}u, ` +
        `worst ${worstDrift.toFixed(0)}u over ${driftSamples} samples`,
    );
    check(S, worstDrift < 400, `a remote player was drawn up to ${worstDrift.toFixed(0)} units from where they actually are`);

    notes.push(`${S}: remote character identity mismatched on ${charMismatch}/${charChecks} samples`);
    check(S, charMismatch === 0, `remote players render as the wrong character on ${((charMismatch / Math.max(1, charChecks)) * 100).toFixed(0)}% of samples`);

    /**
     * Standings agreement.
     *
     * Two questions, and only one of them matters. A photo finish between two
     * AI seats can resolve differently on two machines because each machine
     * simulates them — that is inherent to filling empty seats locally, and it
     * is invisible unless you hold two phones side by side. What must never
     * disagree is a CLEAR lead, and where the PEOPLE placed, because those are
     * what the results screen tells someone they achieved.
     */
    // Seat zero carries no name — it is "YOU" on every screen — so resolve it
    // to the client's own handle before comparing leaders across machines.
    const leaders = clients.map((c) => {
      const top = c.world.standings()[0];
      if (!top) return '?';
      return top.index === 0 ? c.name : top.name;
    });
    const gaps = clients.map((c) => {
      const s = c.world.standings();
      return (s[0]?.arenaScore ?? 0) - (s[1]?.arenaScore ?? 0);
    });
    const clearGap = Math.min(...gaps) > 5;
    notes.push(
      `${S}: leader per client = ${JSON.stringify(leaders)}; top-two gap = ` +
        `${gaps.map((g) => g.toFixed(0)).join('/')}`,
    );
    check(
      S,
      !clearGap || new Set(leaders).size === 1,
      `clients disagree on who is leading despite a clear gap: ${JSON.stringify(leaders)}`,
    );

    // How far apart the clients' copies of the AI seats drifted. This is the
    // thing that used to move people's finishing places around.
    let aiDrift = 0;
    const reference = clients[0]!;
    for (let local = 1; local < LOBBY_SIZE; local++) {
      const seat = reference.world.players[local];
      if (!seat || seat.live) continue;
      for (const other of clients.slice(1)) {
        const mirror = other.world.players.find((p) => p.name === seat.name);
        if (!mirror) continue;
        aiDrift = Math.max(aiDrift, Math.abs(mirror.arenaScore - seat.arenaScore));
      }
    }
    notes.push(`${S}: worst disagreement about an AI rival's MASS = ${aiDrift.toFixed(0)}`);

    // Where each PERSON placed, according to every client.
    let placementDisagreements = 0;
    for (const person of clients) {
      const places = clients.map((c) => {
        const seat = c === person ? 0 : c.seatOf(person.name);
        return c.world.standings().findIndex((q) => q.index === seat) + 1;
      });
      if (new Set(places).size > 1) placementDisagreements++;
      notes.push(`${S}: ${person.name} placed ${JSON.stringify(places)} across the four clients`);
    }
    notes.push(`${S}: final-snapshot placement disagreements = ${placementDisagreements}/4`);

    const splitPct = (100 * rankSplit) / Math.max(1, boardTicks * clients.length);
    const materialPct = (100 * materialSplit) / Math.max(1, boardTicks * clients.length);
    notes.push(
      `${S}: mid-fight board reads differed on ${splitPct.toFixed(2)}% of samples ` +
        `(${materialPct.toFixed(2)}% with a gap over 5 mass) — this includes packets in flight`,
    );

    // Now the real question, with the fight frozen and the packets landed.
    await settle(clients, 700);
    let settledSplit = 0;
    const settledBoards: string[] = [];
    for (const c of clients) {
      settledBoards.push(
        c.world.standings().map((p) => `${p.seatId}:${Math.round(p.arenaScore)}`).join(' '),
      );
    }
    for (const b of settledBoards) if (b !== settledBoards[0]) settledSplit++;
    notes.push(`${S}: settled board, seat:mass in order — ${settledBoards[0]}`);
    check(
      S,
      settledSplit === 0,
      `with the fight frozen and every packet delivered, ${settledSplit} of ${clients.length} clients ` +
        `still hold a different scoreboard:\n      ${settledBoards.join('\n      ')}`,
    );

    // Phantom eliminations: A says B died; B says B is alive.
    let phantom = 0;
    let realDowns = 0;
    for (const c of clients) {
      for (const claim of c.claimed) {
        const victim = clients.find((o) => o.name === claim.victim);
        if (!victim) continue;
        realDowns++;
        if (victim.world.player.alive) phantom++;
      }
    }
    notes.push(`${S}: eliminations of a HUMAN seat = ${realDowns}, of which phantom (victim never died) = ${phantom}`);
    check(S, phantom === 0, `${phantom} of ${realDowns} human eliminations were phantom: the killer scored a bounty for a kill that never happened on the victim's machine`);

    const scores = clients.map((c) => Math.round(c.world.player.arenaScore));
    notes.push(`${S}: final MASS per client = ${JSON.stringify(scores)}`);

    // What each client thinks the OTHERS' scores are, vs the truth.
    let scoreErr = 0;
    for (const c of clients) {
      for (const other of clients) {
        if (c === other) continue;
        const seat = c.seatOf(other.name);
        if (seat < 1) continue;
        scoreErr = Math.max(scoreErr, Math.abs(c.world.players[seat]!.arenaScore - other.world.player.arenaScore));
      }
    }
    notes.push(`${S}: worst disagreement about a rival's MASS = ${scoreErr.toFixed(0)}`);

    for (const c of clients) c.session.disconnect();
    await sleep(200);
  });
}

/**
 * SCENARIO 3 — a three-second signal drop, which is a normal Tuesday on mobile.
 */
async function blip(): Promise<void> {
  const S = 'blip';
  await withRelay(async (url) => {
    const a = new Client('STEADY', 0);
    const b = new Client('FLAKY', 1);
    await Promise.all([a.match(url), b.match(url)]);
    check(S, a.session.state.humans.length === 1, 'clients did not pair');

    await race([a, b], 6);
    const beforeSeat = a.seatOf('FLAKY');
    check(S, beforeSeat > 0, 'STEADY never saw FLAKY');
    const humansBefore = a.session.state.humans.length;

    // The phone goes through a tunnel. The socket stays open; packets stop.
    //
    // Long enough that the demotion is certain: staleness accrues in SIMULATED
    // time, and a client sitting on a level-up card screen is not stepping its
    // world, so a four-second wall-clock gap sometimes never tripped it. A
    // recovery test that never demoted anything proves nothing.
    b.transmitting = false;
    // Measured in SIMULATED seconds, not wall-clock ones: staleness accrues
    // inside the step, and a client sitting on a level-up card screen is not
    // stepping. A fixed nine-second wall-clock wait sometimes never tripped the
    // timer at all, and a recovery test that never demoted anything is a test
    // of nothing.
    const silentFrom = a.world.time;
    const deadline = Date.now() + 30_000;
    while (a.world.time - silentFrom < 6 && Date.now() < deadline) {
      // STEADY is the instrument here, not the subject, and a dead instrument
      // stops stepping — which stops the staleness timer it is supposed to be
      // measuring and turned this scenario into an intermittent false failure.
      a.world.player.hp = a.world.player.maxHp;
      await race([a, b], 1);
    }
    check(
      S,
      a.world.time - silentFrom >= 6,
      `only ${(a.world.time - silentFrom).toFixed(1)}s of silence elapsed before the deadline — ` +
        'this scenario did not run',
    );
    const humansDuring = a.session.state.humans.length;
    notes.push(
      `${S}: after ${(a.world.time - silentFrom).toFixed(1)}s of simulated silence ` +
        `STEADY counts ${humansDuring} live peers (was ${humansBefore})`,
    );
    check(
      S,
      humansDuring === 0,
      'the silent player was never handed back to the AI, so this scenario did not test recovery at all',
    );

    // Signal returns.
    b.transmitting = true;
    await race([a, b], 5);
    const humansAfter = a.session.state.humans.length;
    const seatAfter = a.seatOf('FLAKY');
    const liveAfter = a.world.players[beforeSeat]?.live === true;
    notes.push(
      `${S}: after reconnecting, STEADY counts ${humansAfter} live peers; ` +
        `FLAKY's seat is ${liveAfter ? 'a person again' : 'still an AI'}; named seat = ${seatAfter}`,
    );
    check(S, liveAfter, 'the returning player was never marked live again in the simulation');
    check(
      S,
      humansAfter === 1,
      `a ${4}s packet gap permanently demoted a live player to AI for the rest of the match ` +
        `(peers ${humansBefore} -> ${humansDuring} -> ${humansAfter})`,
    );

    a.session.disconnect();
    b.session.disconnect();
    await sleep(200);
  });
}

/**
 * SCENARIO 4 — rematch. Two people finish a race and both hit PLAY AGAIN.
 */
async function rematch(): Promise<void> {
  const S = 'rematch';
  await withRelay(async (url) => {
    const a = new Client('FRIEND_A', 0);
    const b = new Client('FRIEND_B', 1);
    await Promise.all([a.match(url), b.match(url)]);
    const room1 = a.session.state.room;
    check(S, room1 === b.session.state.room, 'first match did not pair the friends');
    await race([a, b], 3);

    /**
     * A dies first, which is the ordinary way a run ends.
     *
     * This is the part that matters. A client that has finished a run is still
     * connected, and between the relay starting the next room and the client
     * building the next run it was publishing the CORPSE from the last one:
     * `alive: false`, at last run's coordinates. Every peer ran a full
     * elimination on a player who was about to be perfectly healthy — banner,
     * bounty, and their mass spilled on the floor as free experience for
     * whoever spawned nearby. The symptom was a card screen at t=0.22s.
     */
    (a.world as unknown as { killPlayer(): void }).killPlayer();
    await race([a, b], 1.5);

    /**
     * Both press PLAY AGAIN, and the loop never stops while they do.
     *
     * The pump matters as much as the rematch: the game keeps stepping and
     * publishing through matchmaking, so the window between "the room has
     * started" and "this client has built the run" is a window in which a
     * client is live on the socket with last run's world still loaded. An
     * earlier version of this scenario awaited matchmaking with nothing
     * stepping, never published anything in that window, and passed happily
     * with the defect reintroduced.
     *
     * B builds its run as soon as matchmaking resolves. A waits — an ad, a slow
     * phone, a promise turn — and is the one holding a corpse.
     */
    a.claimed.length = 0;
    b.claimed.length = 0;
    /**
     * The invariant: nobody dies in the opening seconds of a fresh match.
     *
     * Counting elimination events is not enough to catch this. A corpse
     * published with no killer names nobody, so it raises no banner — it just
     * quietly buries a live opponent and spills their mass on the floor, which
     * is the part that actually changes the game.
     */
    let watching = false;
    let earlyDeaths = 0;
    let spilledGems = 0;
    const pump = race([a, b], 7, () => {
      if (!watching || b.world.time > 2.5) return;
      for (const p of b.world.players) if (!p.alive) earlyDeaths++;
      spilledGems = Math.max(spilledGems, b.world.gems.count);
    });
    const settledA = a.matchOnly(url);
    await sleep(2_500);
    const settledB = b.matchOnly(url).then((r) => {
      b.begin(r?.seed ?? 1, r?.elapsed ?? 0);
      b.claimed.length = 0;
      watching = true;
    });
    await Promise.all([settledA, settledB]);
    // A is still on the results screen with last run's dead world in memory.
    await sleep(1_500);
    a.begin(a.session.seed ?? 1, a.session.joinedAt);
    await pump;

    notes.push(
      `${S}: in the first 2.5s of the new match FRIEND_B saw ${earlyDeaths} dead-seat readings ` +
        `and a peak of ${spilledGems} gems on the field`,
    );
    check(
      S,
      earlyDeaths === 0,
      `a seat was dead ${earlyDeaths} readings into the opening 2.5 seconds of a fresh match — ` +
        "the previous run's corpse was published into it",
    );

    const humanNames = new Set(['FRIEND_A', 'FRIEND_B']);
    const ghosts = [...a.claimed, ...b.claimed].filter((c) => humanNames.has(c.victim));
    notes.push(
      `${S}: eliminations of a live player in the first 3s of the rematch = ${ghosts.length}` +
        (ghosts.length ? ` (${JSON.stringify(ghosts)})` : ''),
    );
    check(
      S,
      ghosts.length === 0,
      `the previous run's corpse was published into the new match: ${JSON.stringify(ghosts)}`,
    );
    for (const c of [a, b]) {
      // Skipped for a client that legitimately fast-forwarded into a running
      // room: a late joiner is SUPPOSED to arrive several levels in, and this
      // check flagged that as free experience.
      if (c.caughtUp > 0) continue;
      check(
        S,
        c.world.player.level <= 3,
        `${c.name} reached level ${c.world.player.level} in the first 3 seconds ` +
          `without catching up to a running room — something handed it free experience`,
      );
    }
    const room2A = a.session.state.room;
    const room2B = b.session.state.room;
    notes.push(`${S}: rematch rooms = ${room2A} / ${room2B}`);
    check(
      S,
      room2A === room2B,
      `two friends who both pressed PLAY AGAIN 2.5s apart were split into different rooms (${room2A} vs ${room2B})`,
    );

    a.session.disconnect();
    b.session.disconnect();
    await sleep(200);
  });
}

/**
 * SCENARIO 5 — walking into a match that is already running.
 *
 * The interesting part is not whether the socket connects, it is whether the
 * joiner ends up on the same CLOCK. A player who joins a two-minute-old room
 * and starts their own run at zero fights minute-one waves next to people
 * fighting minute-three ones, inside a ring drawn at a different radius.
 */
async function lateJoin(): Promise<void> {
  const S = 'late-join';
  await withRelay(async (url) => {
    const early = new Client('EARLY_BIRD', 0);
    await early.match(url);
    await race([early], 10);

    const late = new Client('LATECOMER', 2);
    const seed = await late.match(url);
    check(S, seed !== null, 'a joiner could not enter a running room at all');
    check(
      S,
      early.session.state.room === late.session.state.room,
      `joiner opened its own room instead of entering the running one ` +
        `(${early.session.state.room} vs ${late.session.state.room})`,
    );
    notes.push(`${S}: joiner replayed ${late.caughtUp.toFixed(1)}s to catch up`);

    const clockGap = Math.abs(early.world.time - late.world.time);
    notes.push(
      `${S}: clocks after join — early ${early.world.time.toFixed(1)}s, ` +
        `late ${late.world.time.toFixed(1)}s (gap ${clockGap.toFixed(1)}s)`,
    );
    check(S, clockGap < 3, `joiner is ${clockGap.toFixed(1)}s out of step with the room it joined`);

    await race([early, late], 6);
    check(S, early.seatOf('LATECOMER') > 0, 'the running client never saw the joiner arrive');
    check(S, late.seatOf('EARLY_BIRD') > 0, 'the joiner never saw the player already in the room');
    check(S, late.world.player.alive, 'the joiner inherited a dead seat');
    notes.push(
      `${S}: joiner arrived at level ${late.world.player.level} with ` +
        `${late.world.player.weapons.length} weapons`,
    );

    /**
     * The invite path: a link that names a room has to land in that room.
     *
     * Same mechanism the rematch uses, reached the way a shared link reaches it
     * — ?room=<id> on the URL, handed to the session before matchmaking.
     */
    const invited = new Client('INVITED', 4);
    invited.session.preferRoom(early.session.state.room);
    await invited.match(url);
    notes.push(
      `${S}: an invite to ${early.session.state.room} landed in ${invited.session.state.room}`,
    );
    check(
      S,
      invited.session.state.room === early.session.state.room,
      `an invite link to a live room put the player somewhere else ` +
        `(${invited.session.state.room} instead of ${early.session.state.room})`,
    );
    check(
      S,
      invited.session.roomJoinable || invited.session.state.humans.length >= 7,
      'a room inside its join window did not report itself as joinable to the portal',
    );

    early.session.disconnect();
    late.session.disconnect();
    invited.session.disconnect();
    await sleep(200);
  });
}

/**
 * SCENARIO 6 — who is allowed to kill a person.
 *
 * Each client simulates every seat, including the ones people are sitting in,
 * so each client holds a GUESS about a remote player's health between packets.
 * If that guess is allowed to kill, the local client banks a bounty and
 * announces an elimination for a death the victim never experienced.
 */
async function authority(): Promise<void> {
  const S = 'authority';
  await withRelay(async (url) => {
    const hunter = new Client('HUNTER', 3);
    const prey = new Client('PREY', 1);
    await Promise.all([hunter.match(url), prey.match(url)]);
    const seat = hunter.seatOf('PREY');
    check(S, seat > 0, 'HUNTER never saw PREY');

    // Drive the local copy of PREY to the brink on every tick. Anything that
    // can kill a seat locally will now do so.
    let phantomDeaths = 0;
    await race([hunter, prey], 12, () => {
      const local = hunter.world.players[seat];
      if (!local) return;
      if (local.alive) local.hp = Math.min(local.hp, 0.5);
      if (!local.alive && prey.world.player.alive) phantomDeaths++;
    });
    notes.push(
      `${S}: with PREY's local health pinned at 0.5 for 12s, HUNTER declared it dead ` +
        `${phantomDeaths > 0 ? 'while it was still alive' : 'never'}`,
    );
    check(S, phantomDeaths === 0, `HUNTER killed a player its own simulation invented (${phantomDeaths} ticks dead-while-alive)`);

    // Now a real death, reported by the owner, must land and pay the killer.
    prey.world.players[0]!.lastHitBy = prey.seatOf('HUNTER');
    prey.world.players[0]!.lastHitAt = prey.world.time;
    // killPlayer is private to the sim; the browser smoke test reaches it the
    // same way, because there is no other way to stage a death on demand.
    (prey.world as unknown as { killPlayer(): void }).killPlayer();
    const before = hunter.world.player.pvpKills;
    await race([hunter, prey], 3);
    const localPrey = hunter.world.players[seat]!;
    notes.push(
      `${S}: after PREY's own machine reported the death — seen dead by HUNTER: ${!localPrey.alive}; ` +
        `HUNTER credited ${hunter.world.player.pvpKills - before} elimination(s)`,
    );
    check(S, !localPrey.alive, 'a real death reported by its owner never reached the other client');
    check(
      S,
      hunter.world.player.pvpKills > before,
      'the killer named by the victim was never paid the elimination',
    );

    hunter.session.disconnect();
    prey.session.disconnect();
    await sleep(200);
  });
}

/**
 * SCENARIO 7 — a player who is NOT the room owner kills an AI rival.
 *
 * The seats nobody is sitting in belong to the lowest-numbered client, so on
 * everybody else's machine an AI is a copy they are not allowed to bury: two
 * clients holding different funerals is what moves a person's finishing place
 * between screens. But the shooter's own screen is the only honest account of
 * their own shots, so the kill is claimed rather than discarded, and the owner
 * runs the death for everyone.
 *
 * Written because the first version of this shipped as dead code: a full
 * four-way race relayed exactly zero claims, for the ordinary reason that no AI
 * dies in the first twenty-five seconds.
 */
async function claim(): Promise<void> {
  const S = 'claim';
  await withRelay(async (url) => {
    const owner = new Client('ROOM_OWNER', 0);
    const guest = new Client('GUEST_GUN', 2);
    await Promise.all([owner.match(url), guest.match(url)]);
    await race([owner, guest], 4);

    // An AI seat both clients can see, chosen by shared seat number so both
    // are talking about the same rival.
    const target = guest.world.players.find((p) => p.index > 0 && !p.live && p.alive);
    if (!target) throw new Error('no AI seat to shoot');
    const mirror = owner.world.players.find((p) => p.seatId === target.seatId);
    if (!mirror) throw new Error('the owner does not have that seat');
    notes.push(`${S}: guest is shooting shared seat ${target.seatId} (${target.name})`);

    // The guest's fight lands a killing blow. It does not own the seat.
    target.lastHitBy = 0;
    target.lastHitAt = guest.world.time;
    const pvpBefore = guest.world.player.pvpKills;
    (guest.world as unknown as { hurtSeat(p: unknown, d: number, i: number): void })
      .hurtSeat(target, 99_999, 0);

    const buriedLocally = !target.alive;
    notes.push(
      `${S}: immediately after the killing blow the guest ${buriedLocally ? 'buried it itself' : 'held it at ' + Math.round(target.hp) + 'hp and claimed the kill'}`,
    );
    check(S, !buriedLocally, 'a client buried a seat it does not own instead of claiming the kill');

    await race([owner, guest], 2.5);
    await settle([owner, guest], 500);

    notes.push(
      `${S}: after the claim — owner sees it ${mirror.alive ? 'alive' : 'dead'}, ` +
        `guest sees it ${target.alive ? 'alive' : 'dead'}, ` +
        `guest credited ${guest.world.player.pvpKills - pvpBefore} elimination(s)`,
    );
    check(S, !mirror.alive, 'the owner never ran the death the guest claimed');
    check(S, !target.alive, 'the guest never saw the kill it claimed land');
    check(
      S,
      guest.world.player.pvpKills > pvpBefore,
      'the player who actually fired the killing shot was not credited with it',
    );

    owner.session.disconnect();
    guest.session.disconnect();
    await sleep(200);
  });
}

/**
 * SCENARIO 8 — a socket that dies without closing, which is what a phone in a
 * lift does. Does the relay ever reclaim the seat?
 */
async function zombie(): Promise<void> {
  const S = 'zombie';
  await withRelay(async (url, relay) => {
    const sockets: NodeWebSocket[] = [];
    for (let i = 0; i < 3; i++) {
      const s = new NodeWebSocket(`${url}?name=ZOMBIE${i}`);
      sockets.push(s);
      await once(s, 'open');
    }
    await sleep(300);
    const before = await health(relay);

    // Kill the underlying connections without a close handshake.
    for (const s of sockets) s.terminate();
    await sleep(3_000);
    const after = await health(relay);
    notes.push(`${S}: /health before=${JSON.stringify(before)} 3s after terminate=${JSON.stringify(after)}`);
    check(
      S,
      after.players === 0,
      `${after.players} seats are still held by sockets that no longer exist — the relay has no liveness check, so seats and rooms leak`,
    );
  });
}

async function main(): Promise<void> {
  const only = process.argv[2];
  const all: Array<[string, () => Promise<void>]> = [
    ['stagger', stagger],
    ['four-way', fourWay],
    ['blip', blip],
    ['rematch', rematch],
    ['late-join', lateJoin],
    ['authority', authority],
    ['claim', claim],
    ['zombie', zombie],
  ];
  for (const [name, fn] of all) {
    if (only && only !== name) continue;
    process.stdout.write(`\n── ${name} ──\n`);
    try {
      await fn();
    } catch (err) {
      failures.push({ scenario: name, detail: `threw: ${(err as Error).message}` });
    }
  }

  console.log('\n=== NETPROBE NOTES ===');
  for (const n of notes) console.log(`  ${n}`);
  console.log('\n=== NETPROBE FAILURES ===');
  if (failures.length === 0) {
    console.log('  none');
  } else {
    for (const f of failures) console.log(`  [${f.scenario}] ${f.detail}`);
  }
  process.exit(failures.length === 0 ? 0 : 1);
}

void main();
