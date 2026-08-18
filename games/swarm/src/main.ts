import { Application } from 'pixi.js';
import { ArenaSession, type MatchResult } from './net/session.js';
import { FIXED_STEP, InputController, Loop } from '@arcade/core';
import { RivalBrain } from './sim/seatai.js';
import { createPortal } from '@arcade/portal';
import {
  Analytics,
  ConsoleTransport,
  HttpTransport,
  NullTransport,
  type Transport,
} from '@arcade/analytics';
import { Sfx } from './audio/sfx.js';
import { World } from './sim/world.js';
import type { Card } from './content/upgrades.js';
import { MAX_WEAPONS, WEAPONS, orbitBladeRadius, orbitRingRadius } from './content/weapons.js';
import { goldFor } from './content/unlocks.js';
import { CHARACTERS, charactersCrossed } from './content/characters.js';
import { ACHIEVEMENTS, newlyEarned, type RunStats } from './content/achievements.js';
import { MetaStore } from './meta/store.js';
import { View } from './render/view.js';
import { Hud } from './render/hud.js';
import { BoonOverlay, CardOverlay } from './render/overlays.js';
import { LOBBY_SIZE, makeRivals } from './content/rivals.js';
import { Effects } from './render/effects.js';
import { ResultsScreen, ReviveOffer } from './render/results.js';
import { AchievementsPanel } from './render/achievements-panel.js';
import { PerfOverlay } from './render/perf.js';
import { StatsOverlay } from './render/stats.js';
import { LoadoutRail } from './render/loadout.js';
import { ForgePanel } from './render/forge-panel.js';
import { FORGE_BY_ID, FORGE_COSTS, FORGE_TRACKS, forgeCost, forgeGoldMult, forgeTotalCost } from './content/forge.js';
import { ABILITIES } from './content/abilities.js';
import { ASCENSIONS, MAX_ASCENSION, highestUnlocked } from './content/ascension.js';
import { masteryFor, masteryLevel, masteryTotalCost } from './content/mastery.js';
import { ModeSelectScreen, type GameMode } from './render/mode-select.js';

/**
 * Host layer: owns the canvas, the loop, and the wiring between sim and view.
 *
 * There is one intentional front door: Solo or Multiplayer. It replaces the
 * hidden three-mode cycle that made Arena practically undiscoverable.
 */
async function boot(): Promise<void> {
  const bootStart = performance.now();
  const portal = await createPortal();
  portal.loadingStart();

  const params = new URLSearchParams(location.search);
  // Transport is a build-time decision, not a code change. Point TRACK_URL at a
  // collector and the same instrumentation starts aggregating across players.
  const trackUrl = import.meta.env.VITE_TRACK_URL as string | undefined;
  const transport: Transport = trackUrl
    ? new HttpTransport(trackUrl)
    : import.meta.env.PROD
      ? new NullTransport()
      : new ConsoleTransport();
  const analytics = new Analytics(transport, portal.name);

  const app = new Application();
  await app.init({
    background: 0x2b2620,
    resizeTo: window,
    antialias: true,
    autoDensity: true,
    resolution: Math.min(window.devicePixelRatio || 1, 2),
    autoStart: false, // we drive rendering from our own fixed-step loop
  });

  const host = document.getElementById('app') ?? document.body;
  host.appendChild(app.canvas);
  app.canvas.style.touchAction = 'none';

  /**
   * Covers the canvas from the instant an ad is requested until its callback.
   *
   * The SDK overlay blocks input once a video starts, but the auction before
   * it is asynchronous. Without this shield a fast second tap could pick a
   * card during a reroll or decline a revive while its ad was still loading.
   */
  const adShield = document.createElement('div');
  adShield.textContent = 'AD LOADING…';
  adShield.setAttribute('aria-live', 'polite');
  adShield.style.cssText = [
    'position:absolute',
    'inset:0',
    'z-index:10',
    'display:none',
    'align-items:center',
    'justify-content:center',
    'background:rgba(5,7,15,.38)',
    'color:#e8f0ff',
    'font:800 13px system-ui,-apple-system,Segoe UI,Roboto,sans-serif',
    'letter-spacing:2px',
    'touch-action:none',
  ].join(';');
  host.appendChild(adShield);

  const meta = new MetaStore(portal);
  await meta.load();

  const sfx = new Sfx();

  const view = new View(app.renderer);
  const effects = new Effects(view.textures);
  view.attachEffects(effects);

  const hud = new Hud();
  const loadout = new LoadoutRail();
  const cards = new CardOverlay();
  const boons = new BoonOverlay();
  const results = new ResultsScreen();
  const modeSelect = new ModeSelectScreen();
  const revive = new ReviveOffer();
  const achievements = new AchievementsPanel();
  const forge = new ForgePanel();
  // Add ?perf to the URL for a live frame-time readout — on a phone, worst-case
  // frames and thermal throttling are what matter, and neither is visible here.
  const perf = new PerfOverlay(params.has('perf'));
  const stats = new StatsOverlay(params.has('stats'));

  app.stage.addChild(view.stage);
  app.stage.addChild(hud.container);
  app.stage.addChild(loadout.container);
  app.stage.addChild(cards.container);
  app.stage.addChild(boons.container);
  app.stage.addChild(revive.container);
  app.stage.addChild(results.container);
  app.stage.addChild(modeSelect.container);
  app.stage.addChild(achievements.container);
  app.stage.addChild(forge.container);
  app.stage.addChild(perf.container);
  app.stage.addChild(stats.container);

  const input = new InputController(app.canvas);
  input.attach();

  // Seeds are drawn out here, never inside the sim — the sim must stay a pure
  // function of its seed so runs stay reproducible and replayable.
  const newSeed = (): number => (Date.now() >>> 0) || 1;
  const world = new World(newSeed());
  world.setForge(meta.current.forge);
  world.setAscension(meta.current.ascension);
  world.setMastery(masteryLevel(meta.masteryXp(meta.character.id)).level);
  world.reset(newSeed(), meta.character);

  /**
   * Which card draw is currently on screen, by reference.
   *
   * Deliberately not a phase diff: choosing an upgrade can immediately trigger
   * the next level-up in the same tick during a dense wave, so phase goes
   * levelup -> playing -> levelup between two steps. A diff sees no change and
   * leaves the previous draw on screen. Comparing the pendingCards reference
   * catches every draw, including chained ones.
   */
  let shownCards: readonly Card[] | null = null;
  let deathHandled = false;
  let pendingGold = 0;
  let frame = 0;
  let hit15 = false;
  let hit60 = false;
  let adInFlight = false;
  let abilitySent = false;
  /** Rate limit on horde-handoff calls, in sim seconds. */
  let lastHandoffCall = -99;
  /** Seconds this client has been in the current match. */
  let arenaSeconds = 0;

  /**
   * Teaching the arena, one beat at a time, in the moment it applies.
   *
   * Three mechanics were added to this mode — mass as a body, the siphon, and
   * dying as a cost rather than an ending — and none of them were explained
   * anywhere. A player would watch their number fall with a red thread
   * attached to it and have no way to learn what that was. A mechanic nobody
   * understands is a mechanic that does not exist.
   *
   * The rules these follow, which is most of why they work:
   *  - Fired by the SITUATION, never by a timer, so the sentence and the thing
   *    it describes are on screen together.
   *  - Once ever, persisted across sessions and merged across devices. A
   *    tutorial that repeats is noise.
   *  - One line on the banner that is already there. No modal, no pause, no
   *    dismiss button — the match does not stop to talk to you.
   */
  const teach = (id: string, message: string): void => {
    if (meta.hasTaught(id)) return;
    meta.markTaught(id);
    hud.announceArena(message, 2);
  };

  /** Checked once a frame while an arena match is running. */
  const teachArena = (dt: number): void => {
    if (!arenaMode || world.phase !== 'playing') return;
    arenaSeconds += dt;
    const me = world.player;

    /**
     * What the number even is, before anything else is explained.
     *
     * Measured against the first version: the siphon lesson beat this one to
     * the screen, so a new player was told they were "draining" something
     * before being told what mass was. Counted from THIS client's time in the
     * match rather than the world clock, because a late joiner inherits a room
     * clock of forty seconds and would have missed the window entirely.
     */
    if (!meta.hasTaught('arena.mass')) {
      if (arenaSeconds > 2) {
        teach('arena.mass', 'MASS IS YOUR SIZE  ·  MOST MASS AT THE CLOCK WINS');
      }
      return;
    }
    // The first time you are actually taking from somebody.
    if (me.siphonLock > 1.2 && me.siphonTarget > 0) {
      const who = (world.players[me.siphonTarget]?.name || 'THEM').toUpperCase();
      teach('arena.siphon', `DRAINING ${who}  ·  STAY ON THEM AND IT GROWS`);
      return;
    }
    // The first time somebody is taking from you.
    for (const s2 of world.siphons) {
      if (s2.from !== 0) continue;
      const who = (world.players[s2.to]?.name || 'A RIVAL').toUpperCase();
      teach('arena.drained', `${who} IS DRAINING YOU  ·  BREAK AWAY OR FIGHT BACK`);
      return;
    }
    // The first time a rival is worth hunting because they are hurt.
    // ANY hurt rival, not just a human one. Gating this on `live` meant it
    // could never fire in a lobby of AI — which is every lobby until the relay
    // is deployed, and most of them afterwards.
    for (const q of world.players) {
      if (q.index === 0 || !q.alive) continue;
      if (q.hp / Math.max(1, q.maxHp) < 0.4) {
        teach('arena.prey', 'A RIVAL IS HURT  ·  GET CLOSE AND TAKE IT');
        return;
      }
    }
  };
  const setAdInFlight = (busy: boolean, label = 'AD LOADING…'): void => {
    adInFlight = busy;
    adShield.textContent = label;
    adShield.style.display = busy ? 'flex' : 'none';
  };
  /**
   * Arena mode: the same run, shared with seven other combatants.
   *
   * A flag rather than a separate world, because the arena IS the run — solo is
   * a lobby of one. That is the whole reason the refactor was worth doing: no
   * second simulation to keep in step, and no mode that silently drifts out of
   * balance with the one people actually play.
   */
  let arenaMode = false;
  const relayUrl = (import.meta.env?.VITE_RELAY_URL as string | undefined) ?? '';
  const session = new ArenaSession();
  /**
   * ?room=<id> asks matchmaking for a specific room.
   *
   * This is how a shared link puts two people in the same match. It is a
   * PREFERENCE, never a requirement: a link to a room that has filled up or
   * closed its window falls through to ordinary matchmaking, so the worst case
   * is a normal game rather than a dead end.
   */
  const invitedRoom = params.get('room');
  if (invitedRoom) session.preferRoom(invitedRoom);
  results.setArenaOnline(!!relayUrl);
  modeSelect.setOnline(!!relayUrl);
  session.attach(world);
  /**
   * Seats held by people, last time we looked.
   *
   * Kept so the arrival of a real person can be announced. With a 45-second
   * join window most people who meet in this game meet MID-RUN, and the moment
   * a stranger drops into seat four is the single most valuable event the mode
   * produces — it was previously indistinguishable from nothing happening.
   * Their departure is announced too, because a seat that suddenly starts
   * playing like a bot has an explanation and the player deserves it.
   */
  let lastLive: number[] = [];
  session.onState = (state) => {
    const live = state.humans.length + (state.status === 'live' ? 1 : 0);
    hud.setArenaNetwork(state.status, live);
    if (arenaMode && state.status === 'live' && world.time > 1) {
      for (const seat of state.humans) {
        if (lastLive.includes(seat)) continue;
        const who = world.players[seat]?.name || 'A PLAYER';
        hud.announceArena(`${who.toUpperCase()} JOINED  ·  A REAL PLAYER`, 1);
      }
      for (const seat of lastLive) {
        if (state.humans.includes(seat)) continue;
        const who = world.players[seat]?.name || 'A PLAYER';
        hud.announceArena(`${who.toUpperCase()} DROPPED  ·  AI TOOK THE SEAT`, 1);
      }
    }
    lastLive = state.humans.slice();
    const online = !!relayUrl && state.status !== 'offline';
    results.setArenaOnline(online);
    modeSelect.setOnline(online);
    // Reported honestly: true only while the relay would actually accept a
    // friend into this room. See ArenaSession.roomJoinable.
    portal.setRoom?.(state.room || null, session.roomJoinable);
  };

  const resize = (): void => {
    // Read the WINDOW, not app.screen.
    //
    // Pixi's ResizePlugin registers its own listener during app.init(), i.e.
    // before ours, and only QUEUES the real resize to the next rAF. A handler
    // that reads app.screen therefore always sees the previous size and is
    // never called again — so after a rotation the layout stayed permanently
    // one event behind, the player rendered off-screen, taps landed at stale
    // coordinates, and one reviewer got locked out of a card draw for the rest
    // of the session with no pause or menu to escape through.
    const w = window.innerWidth;
    const h = window.innerHeight;
    if (app.renderer.width !== w || app.renderer.height !== h) {
      app.renderer.resize(w, h);
    }
    view.resize(w, h);
    effects.resize(w, h);
    hud.resize(w, h);
    loadout.resize(w, h);
    cards.resize(w, h);
    boons.resize(w, h);
    if (world.phase === 'levelup' && world.pendingCards) cards.show(world.pendingCards, true, world.banishesLeft);
    results.resize(w, h);
    modeSelect.resize(w, h);
    revive.resize(w, h);
    achievements.resize(w, h);
    forge.resize(w, h);
    perf.resize(w, h);
    stats.resize(w, h);
    world.setView(view.viewHalfW, view.viewHalfH);
  };
  // Deferred to the next frame so Pixi's own queued resize has landed, and
  // re-run once more after orientation settles — mobile browsers report stale
  // dimensions for a beat after a rotation.
  let resizePending = false;
  const scheduleResize = (): void => {
    if (resizePending) return;
    resizePending = true;
    requestAnimationFrame(() => {
      resizePending = false;
      resize();
    });
  };
  resize();
  window.addEventListener('resize', scheduleResize);
  window.addEventListener('orientationchange', () => {
    scheduleResize();
    setTimeout(scheduleResize, 250);
  });
  window.visualViewport?.addEventListener('resize', scheduleResize);

  /**
   * The FIRST run never goes through startRun().
   *
   * The game deliberately boots straight into play with no menu, so startRun()
   * only ever runs on a restart — which meant the ability button rendered
   * nameless and white for every brand-new player, i.e. for exactly the session
   * that decides whether they stay. Same call, hoisted to boot.
   */
  {
    const ab0 = ABILITIES[meta.character.ability];
    hud.setAbility(ab0.name, ab0.desc, ab0.color);
    // Teach it until they have actually used one, ever.
    hud.setTeachAbility(!meta.current.abilityUsed);
  }

  // Only ever on a player's genuine first run.
  hud.setHint(meta.current.runs === 0);

  input.onFirstInput = () => {
    hud.setHint(false);
    // Browsers block audio until a real gesture, which is exactly why the
    // opening two seconds are designed to work in silence — the game demos its
    // own loop before it is allowed to make a sound.
    sfx.unlock();
    portal.gameplayStart();
    analytics.firstInput();
  };

  /**
   * The single entry point for the ability, shared by the on-screen button, the
   * second-finger gesture and the Space key. Routing all three through one
   * function is what stops the three paths drifting apart.
   */
  const fireAbility = (): void => {
    if (world.phase !== 'playing' || adInFlight) return;
    if (world.useAbility()) {
      abilitySent = true;
      sfx.ability();
      // First press ever retires the teaching beat permanently.
      if (!meta.current.abilityUsed) {
        meta.markAbilityUsed();
        hud.setTeachAbility(false);
      }
    } else {
      // A soft thunk on a dead press. Silence would teach the player nothing
      // about why the button did not work.
      sfx.uiTap();
    }
  };
  input.onAbility = fireAbility;
  hud.onAbility = fireAbility;

  /**
   * Cloud save, on the player's terms.
   *
   * Full Launch requires progress to link to the portal account. It does NOT
   * require nagging: the prompt lives on the results screen behind an explicit
   * tap, never at boot, because an auth modal in front of a portal player who
   * has not played yet costs more than the save is worth. Signing in merges
   * upward, so it can only ever add to what they already have.
   */
  let playerName = 'GUEST';
  portal.onAuthChanged?.(() => {
    void meta.reloadAndMerge().then(() => {
      results.setSignedIn(true);
      hud.setMuted(meta.current.muted);
    });
    void portal.getUser().then((u) => { playerName = u?.name || 'GUEST'; });
  });
  void portal.getUser().then((u) => {
    playerName = u?.name || 'GUEST';
    results.setSignedIn(!!u);
  });
  results.onSignIn = (): void => {
    sfx.uiTap();
    void portal.promptSignIn?.().then(async (u) => {
      if (!u) return;
      await meta.reloadAndMerge();
      results.setSignedIn(true);
      analytics.track('forge_bought', { signedIn: 1 });
    });
  };

  sfx.setMuted(meta.current.muted);
  hud.setMuted(sfx.muted);
  hud.onToggleMute = () => {
    sfx.unlock();
    sfx.setMuted(!sfx.muted);
    meta.setMuted(sfx.muted);
    hud.setMuted(sfx.muted);
    if (!sfx.muted) sfx.uiTap();
  };

  /**
   * Explicit pause when the tab is hidden.
   *
   * Relying on the browser throttling rAF is not enough: a backgrounded tab
   * that keeps stepping burns a run the player cannot see, and mobile web is
   * interrupted constantly. The loop is stopped outright and resumed on return.
   */
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      loop.stop();
      input.release();
      sfx.engine.setVolume(0);
      portal.gameplayStop();
    } else {
      // Returning to the tab must not bring the game mix back over an ad that
      // is still being requested or shown.
      sfx.engine.setVolume(adInFlight ? 0 : 0.8);
      loop.start();
      if (world.phase === 'playing' && !adInFlight) portal.gameplayStart();
    }
  });

  window.addEventListener('keydown', (e) => {
    if (adInFlight) return;
    if (modeSelect.container.visible) {
      if (e.key === '1' || e.key.toLowerCase() === 's' || e.key === 'Enter') modeSelect.select('solo');
      else if (e.key === '2' || e.key.toLowerCase() === 'm') modeSelect.select('multiplayer');
      return;
    }
    if (e.key === '1' || e.key === '2' || e.key === '3') {
      (boons.container.visible ? boons : cards).pickByIndex(Number(e.key) - 1);
    }
  });

  cards.onPick = (id: string): void => {
    sfx.uiTap();
    session.sendCard(id);
    analytics.track('level_up', { level: world.level, card: id });
    world.chooseUpgrade(id);
    syncOverlays();
  };

  /**
   * The longest slice of somebody else's run this client will ever replay.
   *
   * The relay's join window is the same number. Bounded because the seat a
   * joiner inherits was drafted by an AI, and a head start is a gift while an
   * entire strategy somebody else chose is a stranger's save file.
   */
  const MAX_CATCHUP = 45;

  /**
   * Put a late joiner on the same clock as the room they just walked into.
   *
   * Without this, joining a running match meant playing minute one while
   * everyone else played minute two: a different wave tier, a different boss, a
   * ring at a different radius, and rivals who look like they are cheating
   * because they are simply further in. The simulation costs 0.03ms a step, so
   * catching up 45 seconds is under a tenth of a second of work — cheap enough
   * to do behind the same shield that covers matchmaking.
   *
   * The seat is played by the ordinary rival policy while it catches up and
   * then handed over, which is exactly what the other clients have been
   * watching happen. Returns the seconds actually replayed.
   */
  const catchUp = (elapsed: number, seed: number): number => {
    const target = Math.min(MAX_CATCHUP, elapsed);
    if (!(target > 1)) return 0;
    const mySeat = Math.max(0, session.seatId);
    const profile = makeRivals(seed, LOBBY_SIZE)[mySeat];
    if (!profile) return 0;
    const driver = new RivalBrain(profile, seed, mySeat);
    let simulated = 0;
    let guard = 0;
    while (simulated < target && guard++ < 20_000) {
      if (world.phase === 'dead') break;
      if (world.phase === 'levelup') {
        const offer = world.pendingCards ?? [];
        if (offer.length === 0) break;
        world.chooseUpgrade(driver.pickCard(offer));
        continue;
      }
      if (world.phase === 'boon') {
        const offer = world.pendingBoons ?? [];
        if (offer.length === 0) break;
        world.chooseBoon(driver.pickBoon(offer));
        continue;
      }
      driver.think(world, world.player, FIXED_STEP);
      world.input.x = world.player.input.x;
      world.input.y = world.player.input.y;
      world.step(FIXED_STEP);
      world.clearEvents();
      simulated += FIXED_STEP;
    }
    world.input.x = 0;
    world.input.y = 0;
    world.takeOverSeat();
    return simulated;
  };

  const startRun = (match?: MatchResult): void => {
    sfx.uiTap();
    sfx.reset();
    hit15 = false;
    hit60 = false;
    const runSeed = arenaMode && match ? match.seed : newSeed();
    /**
     * Seats are filled BEFORE reset, or they open the run a level behind: the
     * reset is what builds each combatant's opening weapon and stats.
     *
     * Profiles are drawn for all eight SHARED seats and then handed out by
     * shared number, not by local index. Every client seats itself at zero, so
     * indices differ on every screen; identity cannot.
     */
    const ids = arenaMode ? session.seatIds() : [];
    const roster = arenaMode ? makeRivals(runSeed, LOBBY_SIZE) : [];
    const profiles = ids.map((id) => roster[id] ?? roster[0]!).filter(Boolean);
    world.enterArena(profiles, CHARACTERS, { seed: runSeed, ids, self: session.seatId });
    if (arenaMode) session.bindHumans(world);
    world.reset(runSeed, meta.character);
    world.setView(view.viewHalfW, view.viewHalfH);
    effects.clear();
    shownCards = null;
    deathHandled = false;
    pendingGold = 0;
    results.hide();
    modeSelect.hide();
    revive.hide();
    achievements.hide();
    forge.hide();
    cards.hide();
    // Re-read the Forge every run: a player who just bought MIGHT must feel it
    // on the very next run, not the one after.
    world.setForge(meta.current.forge);
    // Difficulty is chosen BEFORE reset, so the tier shapes starting health and
    // the boss schedule rather than being applied to a run already in progress.
    world.setAscension(meta.current.ascension);
    world.setMastery(masteryLevel(meta.masteryXp(meta.character.id)).level);
    // Everything that shapes the run is now applied, so a late joiner can be
    // fast-forwarded onto the room's clock with the run they would have had.
    const joinedLate = arenaMode && match ? catchUp(match.elapsed, runSeed) : 0;
    const ab = ABILITIES[meta.character.ability];
    hud.setAbility(ab.name, ab.desc, ab.color);
    hud.setTeachAbility(!meta.current.abilityUsed);
    hud.setPlayVisible(true);
    arenaSeconds = 0;
    hud.beginRun(arenaMode);
    if (arenaMode && relayUrl && match === undefined && session.state.status === 'offline') {
      hud.announceArena('LIVE MATCH UNAVAILABLE  ·  7 AI RIVALS JOINED', 1);
    } else if (joinedLate > 0) {
      // The most confusing moment in the mode — sixth place ten seconds in —
      // and the only thing that explains it. It outranks the commentary.
      hud.announceArena(`JOINED AT ${mmss(joinedLate)}  ·  YOU TOOK A LIVE SEAT`, 2);
    }
    loadout.setVisible(true);
    input.setEnabled(true);
    portal.gameplayStart();
    analytics.runStart();
  };

  const showResults = (): void => {
    revive.hide();
    forge.hide();
    hud.setPlayVisible(false); // panel owns the screen; mute stays reachable
    loadout.setVisible(false);
    const before = meta.current.totalGold;
    const charId = world.character.id;
    const isBest = meta.recordRun(world.time, pendingGold, charId);
    const crossed = charactersCrossed(before, meta.current.totalGold);

    const stats: RunStats = {
      timeSec: world.time,
      level: world.level,
      kills: world.kills,
      weaponsHeld: world.player.weapons.length,
      evolutions: world.evolutionsThisRun,
      bossesKilled: world.bossKindsKilled.length,
      bossKindsKilled: world.bossKindsKilled.slice(),
      damageTaken: world.damageTaken,
      characterId: charId,
      revived: world.revivesUsed > 0,
    };
    const earned = newlyEarned(stats, meta.current.achievements);
    if (earned.length > 0) meta.awardAchievements(earned.map((a) => a.id));
    for (const a of earned) analytics.track('level_up', { achievement: a.id });

    if (isBest || crossed.length > 0 || earned.length > 0) portal.happyMoment();

    /**
     * Mastery is awarded for the character that was actually played.
     *
     * Read BEFORE the character can be changed on the results screen — the chip
     * strip is right there, and crediting whatever is selected when the player
     * taps PLAY AGAIN would pay the wrong character.
     */
    const playedId = world.character.id;
    const gained = meta.addMastery(
      playedId,
      masteryFor(world.time, world.kills, world.level, world.goldMult),
    );
    if (gained > 0) {
      portal.happyMoment();
      analytics.track('forge_bought', { mastery: playedId, level: masteryLevel(meta.masteryXp(playedId)).level });
    }
    results.setMastery(playedId, masteryLevel(meta.masteryXp(playedId)));

    // Record the run at the tier it was played on, so the ladder can unlock.
    const climbed = meta.recordAscension(world.ascension, world.time);
    if (climbed && ascensionCeiling() > world.ascension) {
      portal.happyMoment();
      analytics.track('forge_bought', { ascensionUnlocked: ascensionCeiling() });
    }
    syncAscension();
    results.setForgeAffordable(forgeAffordable());
    const lastAttacker = world.time - world.player.lastHitAt <= 5
      ? world.players[world.player.lastHitBy]
      : undefined;
    /**
     * A match does not end because you died — it ends on the clock. So the
     * line under the result reports how the five minutes went rather than what
     * killed you, which in a mode with respawns is not even a meaningful
     * question.
     */
    const deathCause = arenaMode
      ? `${world.player.deaths} DOWN  ·  ${world.player.pvpKills} TAKEN`
      : lastAttacker && lastAttacker.index !== 0
        ? `${(lastAttacker.name || 'A RIVAL').toUpperCase()} CLAIMED YOU`
        : world.tideDamage > world.player.maxHp * 0.25
          ? 'THE TIDE TOOK YOU'
          : 'THE SWARM CLOSED IN';
    const arenaPlace = world.players.length > 1
      ? world.standings().findIndex((q) => q.index === 0) + 1
      : 0;
    const arenaRecord = arenaMode
      ? meta.recordArena(world.player.arenaScore, arenaPlace, world.player.pvpKills)
      : { massBest: false, placeBest: false };
    if (arenaMode) {
      analytics.track('arena_end', {
        place: arenaPlace,
        mass: Math.floor(world.player.arenaScore),
        pvpKills: world.player.pvpKills,
      });
    }
    results.show({
      time: world.time,
      level: world.level,
      kills: world.kills,
      bestTime: meta.current.bestTime,
      isBest,
      goldEarned: pendingGold,
      totalGoldBefore: before,
      totalGoldAfter: meta.current.totalGold,
      canDoubleGold: pendingGold > 0,
      crossed,
      earned,
      achievementsHeld: meta.current.achievements.length,
      achievementsTotal: ACHIEVEMENTS.length,
      arenaMode,
      // Where the run finished in the lobby. Computed here rather than read
      // off the HUD, because the HUD is showing a LIVE standing and the one a
      // player wants at the end is where they placed when they went down.
      arenaPlace,
      arenaSeats: world.players.length,
      arenaLeader: world.players.length > 1 ? (world.standings()[0]?.name || 'you') : '',
      // Distance to first place, or the margin you won by. Computed from the
      // same standings the board was showing a second ago.
      arenaGap: (() => {
        if (world.players.length <= 1) return 0;
        const board = world.standings();
        const top = board[0];
        if (!top) return 0;
        return top.index === 0
          ? top.arenaScore - (board[1]?.arenaScore ?? top.arenaScore)
          : top.arenaScore - world.player.arenaScore;
      })(),
      arenaScore: world.player.arenaScore,
      pvpKills: world.player.pvpKills,
      arenaStreak: world.player.arenaStreak,
      deathCause,
      arenaBestMass: meta.current.arenaBestMass,
      arenaWins: meta.current.arenaWins,
      arenaMassBest: arenaRecord.massBest,
      selectedCharacter: meta.current.character,
      totalGold: meta.current.totalGold,
    });
  };

  const chooseMode = (mode: GameMode, fromResults = false): void => {
    sfx.uiTap();
    const multiplayer = mode === 'multiplayer';
    analytics.track('mode_selected', { mode, fromResults });
    if (arenaMode && !multiplayer) session.disconnect();
    arenaMode = multiplayer;
    if (fromResults) {
      results.setMode(arenaMode);
      return;
    }
    modeSelect.hide();
    if (arenaMode && relayUrl) {
      setAdInFlight(true, 'FINDING RIVALS…');
      void session.match(relayUrl, 4500, playerName).then((result) => {
        setAdInFlight(false);
        startRun(result ?? undefined);
      });
    } else {
      startRun();
    }
  };

  results.onSelectSolo = (): void => {
    chooseMode('solo', true);
  };
  results.onSelectMultiplayer = () => chooseMode('multiplayer', true);
  modeSelect.onSelect = (mode) => chooseMode(mode);

  results.onOpenAchievements = (): void => {
    sfx.uiTap();
    achievements.show(meta.current.achievements);
  };
  achievements.onClose = (): void => {
    sfx.uiTap();
    achievements.hide();
  };

  /** True when the player can afford at least one Forge level. */
  function forgeAffordable(): boolean {
    const gold = meta.current.gold;
    return FORGE_TRACKS.some((t) => {
      const c = forgeCost(t, meta.forgeLevel(t.id));
      return c !== null && gold >= c;
    });
  }

  /** How high the player has climbed, recomputed from their record. */
  const ascensionCeiling = (): number => highestUnlocked(meta.current.bestByAscension);

  const syncAscension = (): void => {
    results.setAscension(meta.current.ascension, ascensionCeiling());
  };

  results.onAscension = (delta: number): void => {
    const next = Math.max(0, Math.min(ascensionCeiling(), meta.current.ascension + delta));
    if (next === meta.current.ascension) return;
    sfx.uiTap();
    meta.setAscension(next);
    world.setAscension(next);
    syncAscension();
  };

  results.onOpenForge = (): void => {
    sfx.uiTap();
    forge.show(meta.current.gold, meta.current.forge);
  };
  forge.onClose = (): void => {
    sfx.uiTap();
    forge.hide();
    results.setForgeAffordable(forgeAffordable());
  };
  forge.onBuy = (trackId: string): void => {
    const track = FORGE_BY_ID.get(trackId);
    if (!track) return;
    const cost = forgeCost(track, meta.forgeLevel(trackId));
    if (cost === null) return;
    if (!meta.buyForge(trackId, cost)) return;
    sfx.uiTap();
    // A purchase is a genuine moment of progress, and the portal wants to know.
    portal.happyMoment();
    analytics.track('forge_bought', { track: trackId, level: meta.forgeLevel(trackId), cost });
    forge.show(meta.current.gold, meta.current.forge);
  };

  results.onSelectCharacter = (id: string): void => {
    sfx.uiTap();
    meta.selectCharacter(id);
    results.setSelected(id);
  };

  results.onRestart = (): void => {
    if (adInFlight) return;
    analytics.track('restart_tapped');
    /**
     * The interstitial, at the ONLY moment it belongs: the boundary between one
     * run ending and the next beginning.
     *
     * `showMidgame()` previously had zero call sites anywhere in the game — the
     * highest-volume placement on a portal title was not merely unimplemented,
     * nothing ever asked for it. The adapter enforces a three-minute floor
     * internally, so this can fire on every restart without becoming ad spam,
     * and a player who restarts quickly simply gets 'unavailable'.
     *
     * The new run starts after the request resolves. Starting it immediately
     * made the simulation continue behind a real ad, which both spends the
     * player's run and violates the portal's ad requirements.
     */
    setAdInFlight(true, arenaMode && relayUrl ? 'FINDING RIVALS…' : 'AD LOADING…');
    portal.gameplayStop();
    sfx.engine.setVolume(0);
    const match = arenaMode && relayUrl
      ? session.match(relayUrl, 4500, playerName)
      : Promise.resolve<MatchResult | null>(null);
    void Promise.all([portal.showMidgame(), match]).then(([res, matched]) => {
      analytics.adResult('midgame_restart', res);
      setAdInFlight(false);
      sfx.engine.setVolume(0.8);
      startRun(matched ?? undefined);
    });
  };

  results.onDoubleGold = (): void => {
    if (adInFlight) return;
    setAdInFlight(true);
    portal.gameplayStop();
    sfx.engine.setVolume(0);
    void portal.showRewarded().then((res) => {
      setAdInFlight(false);
      sfx.engine.setVolume(0.8);
      // Grant on 'failed' too. A rewarded ad that does not pay out costs a
      // rounding error in revenue and a player who feels cheated.
      analytics.adResult('double_gold', res);
      if (res === 'skipped' || res === 'unavailable') return;
      const before = meta.current.totalGold;
      meta.addGold(pendingGold);
      results.applyDoubleGold(
        meta.current.totalGold,
        pendingGold,
        charactersCrossed(before, meta.current.totalGold),
      );
    });
  };

  revive.onAccept = (): void => {
    if (adInFlight) return;
    setAdInFlight(true);
    portal.gameplayStop();
    sfx.engine.setVolume(0);
    void portal.showRewarded().then((res) => {
      setAdInFlight(false);
      sfx.engine.setVolume(0.8);
      if (res === 'skipped' || res === 'unavailable') {
        showResults();
        return;
      }
      analytics.adResult('revive', res);
      world.revive();
      analytics.revived();
      revive.hide();
      hud.setPlayVisible(true);
      loadout.setVisible(true);
      deathHandled = false;
      input.setEnabled(true);
      portal.gameplayStart();
    });
  };

  revive.onDecline = showResults;

  /**
   * Reroll the level-up draw for an ad.
   *
   * The third rewarded surface, and the one with the highest natural opt-in
   * rate in this genre: it is offered at the exact moment the player already
   * wants something they did not get, which is the only honest way to sell an
   * ad. Once per level-up, and the offer disappears entirely if no ad is
   * available, so it never becomes a dead button.
   */
  boons.onPick = (id: string): void => {
    sfx.uiTap();
    session.sendBoon(id);
    world.chooseBoon(id);
    boons.hide();
    // A boss can die during a level-up chain, so re-sync rather than assume.
    syncOverlays();
  };

  cards.onBanish = (id: string): void => {
    if (!world.banishCard(id)) return;
    sfx.uiTap();
    analytics.track('forge_bought', { banish: id, left: world.banishesLeft });
    if (world.pendingCards) {
      shownCards = world.pendingCards;
      cards.show(world.pendingCards, false, world.banishesLeft);
    }
  };

  cards.onSkip = (): void => {
    sfx.uiTap();
    world.skipCards();
    shownCards = null;
    cards.hide();
    syncOverlays();
  };

  cards.onReroll = (): void => {
    if (adInFlight || world.phase !== 'levelup') return;
    // Never play an ad the redraw cannot honour. The opening level-up serves a
    // fixed hand that ignores the RNG, so a reroll there is guaranteed to
    // return the same three cards — and every run contains exactly one.
    if (!world.canReroll()) return;
    setAdInFlight(true);
    portal.gameplayStop();
    sfx.engine.setVolume(0);
    void portal.showRewarded().then((res) => {
      sfx.engine.setVolume(0.8);
      setAdInFlight(false);
      analytics.adResult('card_reroll', res);
      // Grant on 'failed' as well — same rule as every other rewarded surface.
      if (res === 'skipped' || res === 'unavailable') {
        // The ad never ran, so the player keeps their reroll.
        cards.restoreReroll();
        return;
      }
      const rerolled = world.rerollCards();
      if (!rerolled) {
        // The redraw could not run, so the player keeps the charge they paid
        // for rather than the game pocketing it.
        cards.restoreReroll();
        return;
      }
      if (world.pendingCards) {
        shownCards = world.pendingCards;
        cards.show(world.pendingCards, false, world.banishesLeft);
      }
    });
  };

  function syncOverlays(): void {
    /**
     * The boon screen owns the frame while it is up.
     *
     * A boss dying inside a level-up chain can leave both pending, and showing
     * the card draft on top of the boon offer would hand the player two modal
     * decisions stacked on each other. The boon takes precedence because it is
     * the rarer, heavier choice — the cards are still there when it resolves.
     */
    if (world.phase === 'boon' && world.pendingBoons) {
      if (!boons.container.visible) {
        input.setEnabled(false);
        portal.gameplayStop();
        cards.hide();
        shownCards = null;
        boons.show(world.pendingBoons);
      }
      return;
    }
    if (boons.container.visible) {
      boons.hide();
      if (world.phase === 'playing') {
        input.setEnabled(true);
        portal.gameplayStart();
      }
    }

    if (world.phase === 'levelup' && world.pendingCards) {
      if (shownCards !== world.pendingCards) {
        shownCards = world.pendingCards;
        input.setEnabled(false);
        portal.gameplayStop();
        cards.show(world.pendingCards, true, world.banishesLeft);
      }
    } else if (shownCards !== null) {
      shownCards = null;
      cards.hide();
      if (world.phase === 'playing') {
        input.setEnabled(true);
        portal.gameplayStart();
      }
    }

    if (world.phase === 'dead' && !deathHandled) {
      deathHandled = true;
      input.setEnabled(false);
      portal.gameplayStop();
      // GREED multiplies the payout — the one Forge track whose effect is felt
      // on the results screen rather than in the run, which is deliberate: it is
      // the track that makes a run feel like it fed the next one.
      pendingGold = Math.floor(world.goldMult *
        goldFor(world.time, world.kills, world.level) * forgeGoldMult(meta.current.forge),
      );
      analytics.runEnd(world.time, world.level, world.kills, world.revivesUsed > 0);
      // The revive offer only appears if a revive is actually available;
      // otherwise go straight to results rather than showing a dead button.
      // Competitive deaths go straight to placement and rematch. A five-second
      // revive offer between losing and seeing who won destroys the fast
      // "again" loop Multiplayer depends on; Solo keeps the optional save.
      if (arenaMode) {
        showResults();
      } else if (world.revivesUsed === 0) {
        revive.show(5);
        analytics.adAccepted('revive');
      } else {
        showResults();
      }
    }
  }

  const loop = new Loop({
    step: (dt) => {
      if (modeSelect.container.visible) return;
      // Hit stop freezes the SIM only. Effects keep animating below, otherwise
      // the freeze reads as the game locking up instead of a hit landing.
      if (effects.hitstop.consume(dt)) return;
      world.input.x = input.dir.x;
      world.input.y = input.dir.y;
      world.step(dt);
      if (arenaMode) {
        session.update(world, dt, abilitySent);
        session.sweep();
      }
      abilitySent = false;
      effects.consume(world.events, world.player.x, world.player.y);
      sfx.consume(world.events, performance.now());

      for (let i = 0; i < world.events.length; i++) {
        const ev = world.events[i]!;
        if (ev.type === 'weaponGained') analytics.track('weapon_gained', { id: ev.id });
        else if (ev.type === 'evolved') analytics.track('evolved', { id: ev.id });
        else if (ev.type === 'bossSpawned') analytics.track('boss_spawned', { name: ev.name });
        else if (ev.type === 'bossKilled') analytics.track('boss_killed');
        else if (ev.type === 'respawned') {
          if (ev.seat !== 0) continue;
          if (!meta.hasTaught('arena.death')) {
            meta.markTaught('arena.death');
            hud.announceArena('DYING COSTS YOUR MASS, NOT YOUR MATCH  ·  GO GET IT BACK', 2);
          } else {
            hud.announceArena('BACK IN  ·  YOUR MASS IS ON THE FLOOR', 2);
          }
        }
        else if (ev.type === 'matchOver') {
          hud.announceArena(
            ev.winner === 'YOU'
              ? `YOU TOOK THE MATCH  ·  ${ev.mass} MASS`
              : `${ev.winner.toUpperCase()} TOOK THE MATCH  ·  ${ev.mass} MASS`,
            3,
          );
        }
        else if (ev.type === 'handoff') {
          /**
           * You put a horde on somebody, or somebody put one on you.
           *
           * Announced because it is otherwise invisible: forty enemies quietly
           * changing their minds looks exactly like forty enemies. This is the
           * only feedback teaching the deepest interaction in the mode — that
           * you can kill a person without ever shooting at them — so it has to
           * be said out loud the first time it happens.
           */
          const them = ev.from === 0 ? world.players[ev.to] : world.players[ev.from];
          const who = (them?.name || 'A RIVAL').toUpperCase();
          const now = world.time;
          if (now - lastHandoffCall > 8) {
            if (ev.from === 0) {
              lastHandoffCall = now;
              hud.announceArena(`YOU PUT ${ev.count} ON ${who}`, 1);
            } else if (ev.to === 0) {
              lastHandoffCall = now;
              hud.announceArena(`${who} PUT ${ev.count} ON YOU`, 1);
            }
          }
          analytics.track('rival_down', { handoff: ev.count });
        }
        else if (ev.type === 'rivalDown') {
          hud.announceArena(`${ev.killer.toUpperCase()} TOOK ${ev.name.toUpperCase()}  +${ev.bounty}`);
          analytics.track('rival_down', { rival: ev.name, bounty: ev.bounty });
        }
      }
      world.clearEvents();

      // Run milestones. 15s and 60s are the two the portal funnel turns on.
      teachArena(dt);

      if (!hit15 && world.time >= 15) {
        hit15 = true;
        analytics.runMilestone(15);
      }
      if (!hit60 && world.time >= 60) {
        hit60 = true;
        analytics.runMilestone(60);
      }
    },
    render: (alpha, frameDt) => {
      syncOverlays();

      // REAL frame time, not a hardcoded 1/60. Every overlay timer, the juice
      // and the audio bed all read this; driving them from a constant made them
      // frame counts, so the 5s revive offer was 2.5s at 120Hz and 10s at 30fps.
      const dt = Math.min(frameDt, 0.1);
      frame++;
      effects.emitTrails(world.enemies.active, frame);
      effects.update(dt);
      cards.update(dt);
      sfx.update(dt, world.enemies.count, world.phase === 'playing' && !modeSelect.container.visible);
      if (revive.update(dt)) showResults();
      results.update(dt);

      view.render(world, alpha, effects.shake.offset.x, effects.shake.offset.y, frameDt);
      effects.render();
      hud.setViewScale(view.worldScale);
      hud.update(world, input, frameDt);
      loadout.update(world);
      // Re-reported every frame because it expires on a clock rather than on an
      // event; the adapter drops the call unless the answer actually changed.
      if (arenaMode) portal.setRoom?.(session.state.room || null, session.roomJoinable);
      perf.update(world.enemies.count, effects.hitstop.active);
      stats.update(analytics.local, dt * 1000, analytics.sessionMs, analytics.runsThisSessionCount);
      app.renderer.render(app.stage);
    },
  });

  portal.loadingStop();
  analytics.loadComplete(performance.now() - bootStart);
  input.setEnabled(false);
  hud.setPlayVisible(false);
  loadout.setVisible(false);
  modeSelect.show();
  loop.start();

  // Exposed for poking at during tuning.
  // Overlay state is exposed so automated checks can wait on the actual UI
  // rather than on timing guesses — a test that taps blind will silently hit
  // whatever happens to be under the cursor and report a bug that is not there.
  Object.assign(window, {
    __swarm: {
      getWorld: () => world,
      loop,
      view,
      meta,
      effects,
      sfx,
      analytics,
      // Geometry the renderer and the sim must agree on, exposed so a probe can
      // assert they still do. These drifted apart once and cost a weapon its
      // damage at max +REACH while the screen showed it working.
      geom: { WEAPONS, orbitRingRadius, orbitBladeRadius },
      ui: () => ({
        cards: cards.container.visible,
        revive: revive.container.visible,
        results: results.container.visible,
        achievements: achievements.container.visible,
        forge: forge.container.visible,
        modeSelect: modeSelect.container.visible,
      }),
    },
    // Meta and economy, exposed so a probe can assert gold is actually a
    // currency rather than a score that only ever increases.
    __swarmPortal: portal,
    __swarmMeta: meta,
    __swarmChars: CHARACTERS,
    // The class itself, so a probe can build a genuinely fresh world and prove
    // that two runs of one seed agree for the right reason rather than because
    // they happen to share leaked state.
    __swarmWorld: World,
    // The arena, exposed so a probe can run a full eight-seat lobby headless
    // and check that it produces a fight rather than a queue.
    __swarmArena: { makeRivals, LOBBY_SIZE, CHARACTERS },
    __swarmSession: session,
    __swarmMastery: { masteryFor, masteryLevel, masteryTotalCost },
    __swarmAbilities: ABILITIES,
    __swarmGeom: { WEAPONS, MAX_WEAPONS },
    __swarmHud: hud,
    __swarmLoadout: loadout,
    __swarmResults: results,
    __swarmMode: modeSelect,
    // Exposed for the portal lifecycle smoke test. The test invokes the same
    // callback as the Pixi button while screenshots cover its hit geometry.
    __swarmRevive: revive,
    __swarmForge: {
      FORGE_TRACKS,
      FORGE_COSTS,
      forgeCost,
      forgeTotalCost,
      forgeGoldMult,
      goldFor,
    },
  });
}

function mmss(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

void boot();
