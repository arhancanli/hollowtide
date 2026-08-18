# Hollowtide — CrazyGames submission

Everything a submission needs, and the short list of things only you can do.

---

## What only you can do

I cannot submit this. It needs your CrazyGames **developer account** and their
upload flow — a login, a form, and a human accepting their terms. The steps:

1. Create/sign in at <https://developer.crazygames.com>
2. **New game** → upload the build (see below) or point them at the live URL
3. Paste the metadata from this file
4. Upload `branding/cover-branded-1280x720.png` as the cover
5. Run their **QA tool** — it checks the SDK handshake, load time and ad calls.
   This is the step that catches integration mistakes, and we have had one
   already (see "Known history" below).

**Before you do any of that, please run the playtest.** Five people, phones, no
instructions from you, screen-recorded. Note the second each run ends and
whether they press PLAY AGAIN. It is the single largest unknown in the project
and no amount of headless measurement substitutes for it.

---

## Build

- Live: <https://canli-arcade.vercel.app>
- Local build: `npm run build --workspace=games/swarm` → `games/swarm/dist/`
- Upload-ready archive: `games/swarm/hollowtide-crazygames.zip`
- **~216 KB gzipped**, ~733 KB raw, zero external asset files (all art generated in
  code at boot, all audio synthesised). Portals measure bounce-during-load;
  this is a real advantage and should not be spent.

Pre-flight:

```bash
npm run verify        # detguard + full typecheck
npm run build --workspace=games/swarm
```

---

## Metadata

**Title:** Hollowtide

**Tagline:** Survive the endless tide.

**Short description** (~150 chars)

> Survive an endless tide alone, or fight seven rivals for the crown in a
> five-minute arena. Build wild weapon evolutions, eat what the fallen drop,
> and take the most mass before the clock. Free in browser.

**Full description**

> The tide is coming. Face it alone — or take it into a five-minute arena
> against seven rivals, where the swarm is only the terrain.
>
> MULTIPLAYER IS ITS OWN GAME. You respawn. Dying costs you everything you were
> carrying — it hits the floor for whoever is standing there — and three
> seconds. Your body grows with the mass you hold, so you can read the food
> chain across the arena at a glance, and being the biggest makes you the
> biggest target for a swarm that kills by touch. Get close to a wounded rival
> and their mass bleeds into yours, harder the longer you commit. Or gather a
> horde and put it on them, and kill someone without ever shooting at them.
> Most mass when the clock runs out takes the crown. Empty seats are filled by
> AI so a match is never a waiting room.
>
> Move to survive — your weapons fire themselves. Every level, choose one of
> three upgrades and shape a build out of what the run gives you. Max a weapon
> while holding the right passive and it **evolves** into something else
> entirely.
>
> Six characters, each with a different active ability: teleport through a
> crowd, shove everything back, rewind three seconds, or drag the whole swarm
> into a single point.
>
> Live Arena matches players on one escalating tide, shows their CrazyGames
> names, and keeps the fight moving with smart AI whenever a seat is empty.
>
> Fifteen enemy types that change how you fight, not just how hard. Armoured
> BULWARKS shrug off small hits. WEAVERS shield everything near them until you
> kill the weaver. BURROWERS go under the ground where no weapon can reach, and
> come up beneath you.
>
> Ten boss fights. Spend your gold in the Forge on upgrades that last forever.

**Genre:** Action / Roguelite / Horde survival
**Tags:** survival, roguelite, action, multiplayer, upgrades, bullet heaven, mobile
**Controls:** Drag anywhere to move · second finger, the button, or Space for your ability · 1/2/3 to pick a card
**Orientation:** Both. Portrait and landscape are both tested.
**Mobile:** Yes — designed touch-first.

---

## Art

| file | use |
|---|---|
| `branding/cover-branded-1280x720.png` | store cover |
| `branding/tile-292x172.png` | shelf tile (verify it reads at this size) |
| `branding/cover-1280x720.png` | clean gameplay, no title |
| `branding/portrait-780x1688.png` | mobile listing |

All rendered from the game at ~5 minutes with the HUD hidden, so the tile
promises what the game actually delivers. They live outside `dist/` and never
ship to players.

---

## SDK and ads

`packages/portal/` abstracts the portal; `CrazyGamesPortal` is the adapter.
The SDK is **loaded by us** at boot (`loadCrazyGamesSdk`), only when the host
looks like a portal or we are in an iframe, with a 4s timeout that falls back to
a fully playable local build.

Five ad surfaces:

| surface | type | where |
|---|---|---|
| Revive | rewarded | death screen |
| Double gold | rewarded | results |
| Card reroll | rewarded | level-up (refunded if the ad fails) |
| Interstitial | midgame | run boundary, 3-minute floor enforced in the adapter |
| happyMoment | signal | new best, unlock, Forge purchase |

Rewarded payouts are granted on `'failed'` as well as `'watched'` — an ad that
does not pay out costs a rounding error in revenue and a player who feels
cheated. Nothing is charged for an ad that never ran.

---

## Bugs this project has already shipped and fixed

Kept in the open on purpose. Both of these were live, both were found by
measurement rather than judgement, and both are the reason the harness below
exists. Anyone testing this build should know what has broken before.

- **The SDK was never loaded.** The adapter originally assumed the host page
  injected `window.CrazyGames`. It does not. On the live site `createPortal()`
  silently fell through to the local adapter: zero ads, no engagement signal,
  and `showRewarded()` resolving `'watched'` unconditionally — which also meant
  every difficulty number collected before the fix was measured with free
  infinite revives. Fixed; **please confirm via their QA tool**, since I cannot
  test a real SDK handshake from here.
- **No healing existed.** Until this pass there was no way to recover health at
  all. Players bled 140 → 37 HP in the first 45 seconds and reached the first
  boss half dead. Health drops from elites, heralds and bosses were the fix, and
  they moved the median run 65s → 212s on their own.

---

## Measured state

Run against a no-revive harness, 30 seeds, competent-but-not-expert play:

| metric | before | now |
|---|---|---|
| median run | 65s | **212s** |
| COLOSSUS reached | 0% | **50%** |
| HARBINGER reached | 0% | **27%** |
| runs with an evolution | 7% | **57%** |
| still loseable at 7min (full Forge) | — | yes, 8/8 died |

Content: 15 enemy kinds, last new kind at ~273s, 11 distinct boss fights with
zero exact repeats. Meta: 8 Forge tracks × 5 levels, ~19 runs to max.

Determinism: a four-minute run hashes identically on V8 and JavaScriptCore
across five seeds, guarded in CI by `npm run detguard`. This makes
server-verified leaderboards possible later — it is not used yet.

Multiplayer, across 24 races and 40 full matches: a lead change in every race,
36,296 PvP hits, 677 rival eliminations, and 37.7% of all mass changing hands
between players rather than coming off the field. Every match reaches its clock
and the lobby holds 7.1-7.5 of its 8 seats deep into one — it used to be down to
a single seat by 110 seconds. The player spends 22 seconds of 300 dead.

The network layer is measured separately by `npm run netprobe`, which runs real
clients against a real relay: three players arriving 0s/2s/6s apart share one
room, a joiner arriving ten seconds late lands on the room's clock to within
0.0s, remote position error is 4.5 units mean, rival identity mismatches on
0/33,216 samples, and with the fight frozen so every packet lands, four clients
hold a byte-identical scoreboard. Players are only ever killed by their own
machine — a client's guess at a remote player's health cannot bank a bounty for
a death that did not happen.

---

## Remaining launch gates

- **Human playtest.** The gate above is bot-measured. Bots have twice been the
  variable in this project.
- **The relay needs a production host. This is the gate that matters.** Live
  Arena is implemented and measured, but every measurement is against a relay
  on localhost. Until the portal build is compiled with a stable public
  `wss://` endpoint, MULTIPLAYER ships as seven AI rivals — honestly labelled on
  the front door, but not the mode described above.
- **Friends/invite flow is partly built.** Rooms now report their real
  joinability to the portal, stay open to newcomers for 45 seconds, and keep a
  group together across rounds; `?room=<id>` is honoured. The CrazyGames
  invite-link listener is still unwired, so do not request the dedicated
  Multiplayer landing page yet.
- **Bot skill labels are not a human difficulty model.** The final 1,920-run
  sweep put character spread at an acceptable 1.15× and ECLIPSE was not the
  weakest, but novice-policy runs outlived expert-policy runs. Use the required
  human playtest and live portal data before changing character balance.
- **Casual competition only.** The relay validates packet shape and rate but is
  not an authoritative anti-cheat server, so Multiplayer must not be marketed
  as a ranked esport.
