# Arena relay

Moves **inputs**, not world state. Every client simulates the whole eight-seat
arena from the same seed; this process only tells them what the other seats did.

That is only sound because the simulation is bit-identical across engines — see
`packages/core/src/detmath.ts` and `npm run detguard`. If a `Math.sin` ever gets
back into `games/swarm/src/sim/`, two browsers will drift apart and no amount of
work here will fix it.

## Run

    npm install
    npm run relay          # PORT=8787

Health check: `GET /health` → `{ ok, rooms, players }`

Production container (build from the repository root):

    docker build -f Dockerfile.relay -t hollowtide-relay .
    docker run --rm -p 8787:8787 hollowtide-relay

The image is two-stage: it compiles the relay and ships the JavaScript plus one
dependency (`ws`, which has none of its own). The runtime layer is ~250 KB and
runs `node`, not `tsx`.

Deploy it to a host with WebSocket support and TLS, and keep at least one
instance warm. Vercel's serverless functions are not a persistent WebSocket
host.

## Deploy to Fly

`fly.toml` in the repository root is ready. Only the first command needs a human:

    export PATH="$HOME/.fly/bin:$PATH"     # flyctl is installed there
    fly auth login                          # opens a browser — only you can do this
    fly launch --no-deploy --copy-config --name hollowtide-relay
    fly deploy
    curl https://hollowtide-relay.fly.dev/health     # expect {"ok":true,...}

Then rebuild the game against it — Vite embeds the URL at build time, so the
client must be recompiled whenever it changes:

    VITE_RELAY_URL=wss://hollowtide-relay.fly.dev npm run build

Two settings in `fly.toml` are load-bearing. `auto_stop_machines = "off"`,
because a relay that scales to zero drops every live match and wakes with no
memory of the rooms it was holding. And `primary_region = "fra"` — one region
means one set of players gets the short cable; change it if the audience turns
out to be mostly North American.

## Point the game at it

    VITE_RELAY_URL=wss://your-host:8787

With no URL set the game behaves exactly as it does today: solo, or an arena
filled entirely with AI. The network is an upgrade to the arena, never a
requirement for it.

## Cost

Eight seats at 20Hz is a few KB/s per room. A $5/mo box holds hundreds of rooms.
CrazyGames does not host multiplayer servers, so this has to live somewhere you
own.

Before building the portal client, set `VITE_RELAY_URL` to the public `wss://`
endpoint. Because Vite embeds this value at build time, changing it requires a
new client build.

## Verification

    npm run relay:smoke

The smoke test starts a real relay on an ephemeral port, matches two WebSocket
clients into one room, verifies their shared seed, relays a sanitized state
packet, and confirms disconnect propagation. The game client maps the relay's
global seats into its local world, where the owner is always seat zero.
