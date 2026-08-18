import assert from 'node:assert/strict';
import { once } from 'node:events';
import { WebSocket } from 'ws';
import { startRelay } from '../packages/relay/src/relay.js';

type Msg = Record<string, unknown>;

function inbox(socket: WebSocket) {
  const messages: Msg[] = [];
  const waiters: Array<() => void> = [];
  socket.on('message', (raw) => {
    messages.push(JSON.parse(String(raw)) as Msg);
    for (const wake of waiters.splice(0)) wake();
  });
  return async (predicate: (msg: Msg) => boolean, timeoutMs = 4000): Promise<Msg> => {
    const until = Date.now() + timeoutMs;
    while (Date.now() < until) {
      const found = messages.find(predicate);
      if (found) return found;
      await Promise.race([
        new Promise<void>((resolve) => waiters.push(resolve)),
        new Promise<void>((resolve) => setTimeout(resolve, 50)),
      ]);
    }
    throw new Error(`relay message timeout; received ${JSON.stringify(messages)}`);
  };
}

async function main(): Promise<void> {
  const relay = startRelay(0);
  await once(relay.http, 'listening');
  const address = relay.http.address();
  assert(address && typeof address === 'object');
  const url = `ws://127.0.0.1:${address.port}`;

  const a = new WebSocket(`${url}?name=Astra%20Pilot`);
  // Exercise relay-side sanitization as well as ordinary Unicode names.
  const b = new WebSocket(`${url}?name=%3Cscript%3E%E9%BE%99`);
  const nextA = inbox(a);
  const nextB = inbox(b);
  await Promise.all([once(a, 'open'), once(b, 'open')]);

  const [joinedA, joinedB] = await Promise.all([
    nextA((m) => m.t === 'joined'),
    nextB((m) => m.t === 'joined'),
  ]);
  assert.equal(joinedA.room, joinedB.room);
  assert.equal(joinedA.seed, joinedB.seed);
  assert.notEqual(joinedA.seat, joinedB.seat);
  assert.deepEqual(
    joinedB.players,
    [
      { seat: joinedA.seat, name: 'Astra Pilot' },
      { seat: joinedB.seat, name: 'script龙' },
    ],
  );

  const [startA, startB] = await Promise.all([
    nextA((m) => m.t === 'start'),
    nextB((m) => m.t === 'start'),
  ]);
  assert.deepEqual(startA.humans, startB.humans);
  assert.equal((startA.humans as number[]).length, 2);
  assert.deepEqual(startA.players, startB.players);

  a.send(JSON.stringify({
    t: 'state', x: 12.3, y: -8.1, dx: 0.75, dy: -0.5,
    hp: 99, max: 140, lv: 4, k: 23, score: 812, pvp: 3, streak: 2,
    alive: true, time: 12, a: 1,
    injected: 'must-not-survive',
  }));
  const state = await nextB((m) => m.t === 'state');
  assert.equal(state.seat, joinedA.seat);
  assert.equal(state.dx, 0.75);
  assert.equal(state.score, 812);
  assert.equal(state.pvp, 3);
  assert.equal(state.injected, undefined);

  a.close();
  const left = await nextB((m) => m.t === 'left');
  assert.equal(left.seat, joinedA.seat);

  b.close();
  await Promise.all([
    new Promise<void>((resolve) => relay.wss.close(() => resolve())),
    new Promise<void>((resolve) => relay.http.close(() => resolve())),
  ]);

  console.log(`relay smoke: 2 clients matched in ${joinedA.room}; state and disconnect relayed safely`);
}

void main();
