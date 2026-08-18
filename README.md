# canli-arcade

> **Source-available, not open source.** Published to be read; see [LICENSE](LICENSE).
> Reuploading the game to a portal is not permitted.

Portal-games ecosystem. Target: CrazyGames first, then Poki / GameDistribution /
Yandex, then own domain.

**Live: https://canli-arcade.vercel.app**
`?perf` = live frame times · `?stats` = the funnel this device has produced

Game 1 is **Swarm**, a survivor-like.

## Run it

```bash
npm install
npm run dev        # localhost:5180, also on the LAN for phone testing
npm run build
npm run typecheck
npm run balance    # 600 headless runs: level-up pacing + determinism guard
npm run playtest   # ~2000 headless runs: content reach, build diversity, characters
npm run relay      # the arena relay, PORT=8787
npm run relay:smoke  # two sockets, one room
npm run netprobe   # real clients over a real relay: see "Multiplayer" below
```

## Layout

```
packages/core/      fixed-step loop, seeded RNG, object pool, spatial hash, input
packages/juice/     shake, hitstop, particles, damage numbers, shockwaves
packages/audio/     WebAudio engine, procedural synth, voice limiting
packages/portal/    portal abstraction + LocalPortal stub
packages/analytics/ funnel events, batched, pluggable transport
games/swarm/
  src/sim/          the simulation. NO pixi imports, ever (see below)
  src/sim/weapons.ts  weapon behaviour — every future weapon lands here
  src/render/       pixi v8 views, effects, results, HUD, overlays
  src/content/      every tuning number, weapon, character and achievement
  src/meta/         persistent progression, via the Portal
  src/audio/        sound design, mapped to the same sim events as the juice
  tools/balance.ts  pacing + determinism
  tools/playtest.ts large-scale content-reach sweep
```

## The two rules that matter

**1. `sim/` never imports pixi.** The simulation runs headless in Node, which is
what makes `npm run playtest` possible — and that harness has now caught, among
others: bosses that were literally unshootable, evolutions no player could ever
reach, and a difficulty curve where a novice and an expert died at the same
second. None of those were visible to judgement. All were obvious to
measurement. If this rule erodes, that capability dies with it.

**2. The sim is deterministic.** No `Math.random`, no `Date.now`, no wall-clock
reads inside `sim/`. A run is a pure function of (seed, inputs, choices). The
balance runner asserts it on every invocation.

## The standing bar

Retention, judged by three numbers: **run-2 rate, session length, next-day
return.** Anything that does not move one of those ranks below something that
does.

Through depth and mastery, never dark patterns. No energy timers, no FOMO
countdowns and no streak-loss threats. The front door contains exactly Solo and
Multiplayer; neither is hidden behind a death or a rotating mode control.

## Multiplayer

**Not the solo game with seven extra bodies.** Solo is *survive the tide*: one
life, and the question is how long you lasted. Multiplayer is a five-minute
match between people in which the tide is the terrain — you respawn, and the
most mass at the end wins.

That distinction was learned the hard way. The arena used to have solo's shape
— one life each — so every death permanently removed a combatant and an
eight-seat lobby could only shrink. Measured, it was down to a single seat by
110 seconds, with the rest of the match a solo farm. No tuning fixes a mode
that structurally empties itself.

| | Solo | Multiplayer |
| --- | --- | --- |
| shape | one life | 5-minute match, respawns |
| you win by | lasting | holding the most mass at the clock |
| death costs | the run | your mass, and three seconds |
| the danger is | the swarm | the other seven, with the swarm as terrain |

**Mass is your body.** It grows with what you have eaten, so the food chain is
readable across the arena without a number — and a bigger body is a bigger
target for a swarm whose whole threat model is contact. Growth buys the lead
and charges you for holding it.

**You take mass off each other.** Engage a rival and the drain runs toward
whoever is in better shape, ramping the longer you hold them and resetting if
you switch. Keyed on health rather than size deliberately: keyed on size, the
biggest player eats everyone and the lead compounds into a formality.

**Your weapons only hurt the rival you are engaged with.** Before that rule,
130 of 130 rival deaths in a 40-run sample came from another combatant's weapon
fire and zero from the swarm — eight bodies share one screen and every seat runs
auto-firing area weapons, so the lobby shredded itself by the thirty-second mark
with nobody choosing any of it.

**You can kill someone without shooting them.** Enemies keep chasing whoever
they are chasing until somebody is meaningfully closer, so a horde is something
you can gather, carry, and put on a rival.

Every seat is simulated by every client; something writes its input. That is the
whole architecture, and it is why a person can take over a seat mid-match with
no spawn, no queue and no lobby transition.

**One rule holds it together: every seat has exactly one authority.**

| seat | who owns its state |
| --- | --- |
| yours | you |
| another person's | them — their packets, including their death and who killed them |
| nobody's (AI) | the lowest-numbered player in the room |

Each half of that rule was added because measurement showed what happens
without it. This client's guess at a remote player's health used to be allowed
to kill them, so it banked bounties for eliminations the victim never
experienced. Every client used to grow its own copy of the AI seats, so four
people in one room were each shown a different finishing place.

Rooms stay open to newcomers for **45 seconds after they start**. Before that
they closed after 1.2s, which meant two people had to press MULTIPLAYER inside
the same 1.2 seconds or each play a lobby of bots — measured, three players
arriving 0s/2s/6s apart produced three rooms of one. A late joiner fast-forwards
their own copy of the run to the room clock (0.03ms a step, so 45 seconds costs
under a tenth of a second) and takes over the seat an AI was warming.

`npm run netprobe` runs real `ArenaSession`s against a real relay in real time
and measures the answers to the questions that decide whether any of this works
for actual people:

| scenario | what it proves |
| --- | --- |
| stagger | three players arriving 0s/2s/6s apart share one room |
| four-way | position error, rival identity, board agreement, phantom kills |
| blip | a 9s signal loss demotes a seat to AI and the return restores it |
| rematch | friends stay together, and last run's corpse never enters the new one |
| late-join | a joiner lands on the room's clock, alive, seen by the room |
| authority | a player is only ever killed by their own machine, and pays the killer |
| zombie | a socket that dies without closing does not hold a seat |

Current readings: remote position error **4.5u mean**, rival identity mismatch
**0/33,216 samples**, and with the fight frozen so every packet lands, all four
clients agree on the **exact finishing order**. Mass differs between them by
~0.3 of a unit — it became a continuously integrated quantity when the siphon
landed, so the check asserts order rather than bytes, and says why in place.

Measured across 40 matches and 24 races: all 40 reach the full clock, the lobby
holds **7.1-7.5 of 8 seats** deep into a match, the player spends 22 seconds of
300 dead, **677 rival eliminations** across 24 races, and **37.7% of all mass
changes hands between players** rather than coming off the field.

## Content

**7 weapons**, each mechanically distinct rather than a reskin: BOLT, ORBIT,
NOVA, CHAIN, MINES, AURA, SEEKER. Six slots, so a build is a set of choices.

**7 evolutions** — one for every weapon, each requiring a maxed weapon plus a
specific passive investment. Always offered when earned.

**6 characters**, unlocked by lifetime gold (0/250/700/1500/3000/6000). Each
starts with a *different weapon*, so a run plays differently from its first
second. Every one has a real trade-off; none is a strict upgrade.

**11 boss encounters**, sequenced across the run rather than exact repeats.
Each has a named health bar and a distinct pressure pattern.

**15 enemy types** including splitters, bombers, burrowers, shield weavers and
armoured bulwarks.

**12 achievements**, visible in a panel from the results screen — goals that
ask you to play differently rather than merely longer.

## Measured state

From `npm run playtest` (~2000 runs across 4 skill levels x 4 draft strategies
x 6 characters) and `npm run balance`:

| | value |
| --- | --- |
| first level-up | 11.3s (gated so it cannot interrupt the opening demo) |
| WARDEN reached / killed | 99% / 87% |
| LANCER reached / killed | 93% / 82% |
| BROODMOTHER reached / killed | 82% / 77% |
| HARBINGER reached / killed | 62% / 42% |
| runs seeing an evolution | 81% |
| runs filling + maxing a build | 0% |
| last new acquisition | p50 213s / p90 267s |
| character balance spread | 1.14x best-to-worst |
| enemies on screen | 26-59% (was 3-9%) |
| cold load to playable | ~1.7s, ~210 KB gzipped |

**There are no asset files in this project.** All art is canvas2D at boot, all
audio is synthesised at runtime. Art and audio are normally the bulk of a portal
build, and load-to-playable decides whether anyone ever sees them.

## Review history

Two multi-agent panels have played the live build end to end.

**Panel 1 — 12 expert lenses.** Returned 3 blocker / 8 fix-first / 0 ship. All
blockers are fixed:

- the first level-up fired at t=2.2s, freezing the opening demo and letting the
  first steering touch blind-buy an upgrade (cards commit on tap now, and level
  1 is a deliberate gate)
- any resize left layout permanently one event behind, soft-locking a reviewer
  out of a card draw — the handler read `app.screen` while Pixi queues its own
  resize to the next frame
- the revive countdown kept running during the ad, banking and scoring the run
  mid-video and stacking three live UI layers
- overlay timers were frame counts, not wall clock (a "5s" offer was 2.5s at
  120Hz)
- damage numbers covered 64% of the player, and there was no numeric HP at all
- the swarm was 3-9% on screen — the player outran everything

**Panel 2 — 6 domain experts + 8 player personas.** Behavioural psychologist,
retention designer, systems designer, UX researcher, difficulty analyst,
competitive analyst, plus personas from a 12-year-old on a phone to a genre
veteran to a low-end Android to a returning day-2 player. Its criticals, all
fixed and verified:

- **the joystick died after every level-up** if the thumb never lifted —
  `setEnabled(false)` cleared the pointer id, so `pointermove` early-returned
  and `pointerdown` never came again. Likely responsible for a large share of
  every low-survival measurement taken before it was found.
- **+REACH made ORBIT strictly worse** (0.15x damage at max stacks): it grew
  the orbit radius while the blade hit box stayed hardcoded, sweeping the
  blades out of the crowd that presses against the player. The 6000g character
  is built on ORBIT. `fireRateMult` was also a literal no-op on it.
- **evolved weapons re-entered the fresh pool** — evolution rewrites `id` in
  place, so the ownership check stopped matching. 26% of runs held duplicates;
  one held three SUPERNOVAs and could not die.
- **gems were destroyed at the pool cap** (28,744 of 43,584 in one run) and
  drifted slower than the player moves, so playing well starved you of XP. AFK
  reached level 24 by 2:00; expert kiting reached level 6. That one fact made
  the entire game bimodal.
- **bosses stacked** — the schedule fired on the clock alone, so an orphaned
  boss kept summoning with no bar and no name.
- 12 of 13 evaluators independently found the **boss bar painting over the HP
  number**, for the whole back half of every run.

## Known open issues

- **CrazyGames Preview QA is still required.** The v3 SDK adapter, ads, cloud
  save and gameplay/loading signals are implemented and covered by a mocked
  browser smoke test, but only the Developer Portal preview can validate the
  real hosted handshake and Basic-Launch ad-disabled behavior.
- **Analytics has no datastore.** Transport is pluggable — set `VITE_TRACK_URL`
  and events flow. Nothing was provisioned without the owner asking, so the
  funnel is per-device only.
- **The relay is not deployed.** Everything above is implemented and measured
  against a relay running locally. Until `VITE_RELAY_URL` points at a public
  `wss://` endpoint at build time, the shipped game's MULTIPLAYER is seven AI
  rivals and says so on the front door. This is the single largest gap between
  what the code does and what a player gets.
- **Multiplayer is casual, not ranked.** The relay sanitizes, rate-limits and
  heartbeats, but it is not an authoritative anti-cheat server. It never
  simulates anything, so a modified client can lie about its own mass. Do not
  market this as competitive ranked play.
- **Invites are half-built.** `?room=<id>` is honoured and rooms report their
  real joinability to the portal, but the CrazyGames invite-link listener is
  not wired, so the dedicated Multiplayer landing page is still a later phase.
- **Frame time needs a real-device check.** Every measurement so far is headless
  software rendering. Use `?perf` on an actual mid-range Android.
- **No human has played this.** Every judgement is mine or an agent's, and that
  is the largest single risk in the project.
