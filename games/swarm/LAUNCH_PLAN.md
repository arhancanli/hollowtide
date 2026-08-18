# Hollowtide launch plan

This is the release path for a CrazyGames Basic Launch with Live Arena enabled,
followed by the extra social work required for the Multiplayer landing page.

## Current release decision

The game code is release-candidate quality when these three external gates pass:

1. Deploy the relay behind a stable `wss://` URL, configure a health check on
   `/health`, and complete a 60-minute two-device soak test.
2. Five first-time players complete an uncoached session on at least three
   phones and one desktop. No P0/P1 issue remains; at least four understand
   movement and at least three voluntarily start a second run.
3. CrazyGames Developer Portal Preview passes SDK, responsive layout, ads,
   cloud save, account-name display, and room-presence checks.

Without a relay URL, Solo and the eight-seat Multiplayer match remain fully
playable with seven AI rivals — the mode is a timed arena with respawns, so an
AI lobby is a complete game rather than a waiting room. The production multiplayer build must be compiled after the relay is
deployed:

```bash
VITE_RELAY_URL=wss://relay.example.com npm run build
```

## T-7 to T-5: deploy and soak multiplayer

- Build and deploy `Dockerfile.relay`; use one always-on instance initially.
- Require TLS and verify `https://relay.example.com/health` reports `ok: true`.
- Set alerts for process restarts, failed health checks, connection count and
  sustained CPU/memory pressure.
- Run `npm run relay:smoke`, then the real two-browser test:

```bash
python3 ~/.agents/skills/webapp-testing/scripts/with_server.py \
  --server "PORT=8787 npm run relay" --port 8787 \
  --server "VITE_RELAY_URL=ws://127.0.0.1:8787 npm run dev" --port 5180 \
  -- sh -c "python3 tools/multiplayer-smoke.py && python3 tools/latejoin-smoke.py"

python3 ~/.agents/skills/webapp-testing/scripts/with_server.py \
  --server "VITE_RELAY_URL=ws://127.0.0.1:8999 npm run dev" --port 5180 \
  -- python3 tools/offline-fallback-smoke.py
```

- Soak on two physical devices for 60 minutes: reconnect Wi-Fi, background a
  phone, close one client mid-run, and confirm every abandoned seat becomes AI.
- Load-test before promotion. The current relay rate-limits and sanitizes
  traffic but is not an authoritative anti-cheat server; do not market ranked
  competitive play.

## T-4: human playtest

- Test 390×844 portrait, short landscape phone, and 1280×720 desktop.
- Give no control explanation. Record time to first movement, first ability,
  first level-up, first death, mode selected, and whether Play Again is tapped.
- Pair two testers in Multiplayer and ask afterward whether they understood who was
  human, who won, and what happened when a player disconnected.
- Fix observed P0/P1 failures. Use the 1,920-run harness for balance guardrails,
  but do not treat bots as a substitute for people.

## T-3: release candidate

Run from the repository root:

```bash
npm run verify
npm run balance
npm run playtest
npm run deathprobe
npm run arenaprobe
npm run relay:smoke
npm run netprobe
VITE_RELAY_URL=wss://relay.example.com npm run build
python3 ~/.agents/skills/webapp-testing/scripts/with_server.py \
  --server "npm run dev" --port 5180 -- python3 tools/browser-smoke.py
```

Pass criteria:

- determinism, TypeScript (which now covers the relay and the tools, not just
  the game), 600-run balance, 1,920-run playtest, 24-race Multiplayer probe and
  all seven netprobe scenarios pass;
- production assets remain below 1 MB raw combined;
- desktop/mobile smoke has no console or page errors;
- rewarded and interstitial lifecycle remains stop → ad → start;
- two clients share room/seed, account names and MASS state, receive remote
  movement, report the room to CrazyGames and replace a departed person with AI;
- median kiting death remains near the measured 220 seconds, with late pressure
  visibly rising by threat tier.

Freeze `games/swarm/dist/`, regenerate `hollowtide-crazygames.zip`, and record
the relay/client version together. A client rollback must name a compatible
relay version.

## T-2: CrazyGames Preview

- Upload the contents of `games/swarm/dist/` and metadata from `SUBMISSION.md`.
- Test desktop, portrait and short landscape, including ads unavailable and an
  ad blocker.
- Confirm loading, gameplay, happy-time and ad events in the QA tool.
- Sign in, verify the CrazyGames username appears over the remote racer, earn
  gold, refresh and confirm cloud progress.
- Confirm Multiplayer reports its unique room through SDK `updateRoom` and calls
  `leftRoom` when leaving.
- Test a relay outage before matchmaking and during a run. Both must fall back
  to AI without blocking play.

Any Preview failure blocks submission.

## T-1 to T-0: submit Basic Launch

- Re-run `npm run verify && npm run relay:smoke` against the tagged candidate.
- Upload the candidate and all branding images; submit for Basic QA.
- Keep the previous client image and relay image available for rollback.
- During launch day, watch `/health`, restarts, browser errors, rating and
  CrazyGames engagement metrics. Roll back immediately for startup/input/save
  failure, uncloseable UI, simulation behind ads, or widespread disconnects.

## First 14 days

Track conversion (target ≥80%), average playtime (target ≥10 minutes), D1
retention (target 10–15%), second-run rate, Arena selection, matchmaking success,
human players per room, disconnect rate and AI fallback rate. Ship only crashes
and hard UX failures in days 1–3. From day 4 onward, make one measurable change
at a time against the weakest KPI.

## Multiplayer landing-page phase

The current Live Arena is suitable as an online feature in a Basic Launch, but
do not request the dedicated Multiplayer landing-page placement yet. CrazyGames
requires a fuller friends flow. Before applying:

- ~~make relay rooms joinable for longer than the current matchmaking window~~
  **done** — 45s after start, with the joiner fast-forwarded onto the room clock;
- ~~preserve friend groups in the same room across rounds~~ **done** — a rematch
  asks for the room it just left and the relay honours it while it has space;
- ~~report `isJoinable: true` only while a room can actually accept a friend~~
  **done** — reported from the live join window and free-seat count, and the
  adapter no longer swallows a change of the flag;
- consume invite parameters on boot and in the SDK room-join listener — HALF.
  `?room=<id>` is honoured as a matchmaking preference; the CrazyGames
  invite-link listener is not wired;
- support instant multiplayer entry and the portal invite flow;
- validate room size and rematch UX with real groups.

That phase is a separate release because it changes matchmaking semantics, not
just presentation.
