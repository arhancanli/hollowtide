/**
 * Portal abstraction.
 *
 * Game code must NEVER call a portal SDK directly. Everything goes through this
 * interface, and each portal gets a thin adapter behind it. That is what lets
 * one build ship to CrazyGames, Poki, GameDistribution, Yandex and our own
 * domain without touching gameplay, and it is what lets the game run offline
 * during development.
 *
 * `createPortal()` picks the adapter at boot by feature detection, so the same
 * build runs on CrazyGames, on our own domain and on localhost.
 */

export type AdResult = 'watched' | 'skipped' | 'failed' | 'unavailable';

export interface PortalUser {
  id: string;
  name: string;
}

export interface Portal {
  readonly name: string;

  /** True when the host provides an account system we can save against. */
  readonly accountsAvailable?: boolean;
  /** Open the host's sign-in flow. Only ever from an explicit player action. */
  promptSignIn?(): Promise<PortalUser | null>;
  /** Called when the player signs in or out during a session. */
  onAuthChanged?(cb: () => void): void;

  /** Report multiplayer presence to the host's friends/join surface. */
  setRoom?(roomId: string | null, isJoinable?: boolean): void;

  /** Bracket the loading screen. Portals use these to time their own overlays. */
  loadingStart(): void;
  loadingStop(): void;

  /**
   * Bracket actual gameplay — call stop() before every menu, pause and ad, and
   * start() on resume. Not bookkeeping: these drive ad timing and, as far as
   * anyone outside CrazyGames can tell, feed the engagement signal that decides
   * how much traffic a game is given.
   */
  gameplayStart(): void;
  gameplayStop(): void;

  /** Flag a moment of genuine player delight (new best, big unlock). */
  happyMoment(): void;

  showRewarded(): Promise<AdResult>;
  showMidgame(): Promise<AdResult>;

  getUser(): Promise<PortalUser | null>;
  save(key: string, value: string): Promise<void>;
  load(key: string): Promise<string | null>;
}

/**
 * Development / own-domain adapter. No ads, localStorage persistence.
 *
 * showRewarded resolves 'watched' so the reward path stays testable. The real
 * adapters must ALSO grant the reward on 'failed' — a rewarded ad that does not
 * pay out costs a rounding error in revenue and a player who feels cheated.
 */
export class LocalPortal implements Portal {
  readonly name = 'local';
  readonly accountsAvailable = false;

  loadingStart(): void {}
  loadingStop(): void {}
  gameplayStart(): void {}
  gameplayStop(): void {}
  happyMoment(): void {}

  async showRewarded(): Promise<AdResult> {
    return 'watched';
  }

  async showMidgame(): Promise<AdResult> {
    return 'unavailable';
  }

  async getUser(): Promise<PortalUser | null> {
    return null;
  }

  async save(key: string, value: string): Promise<void> {
    try {
      localStorage.setItem(key, value);
    } catch {
      // Private browsing, quota, or a portal iframe with storage blocked.
      // Losing progress is bad; crashing the run is worse.
    }
  }

  async load(key: string): Promise<string | null> {
    try {
      return localStorage.getItem(key);
    } catch {
      return null;
    }
  }
}

/**
 * Pick an adapter for wherever this build happens to be running.
 *
 * Feature detection rather than a build flag: one artifact ships everywhere,
 * and a broken or absent SDK falls back to a fully playable local build instead
 * of a white screen. The CrazyGames path is only taken if `init()` actually
 * succeeds.
 */
export async function createPortal(): Promise<Portal> {
  const { CrazyGamesPortal, crazyGamesAvailable, loadCrazyGamesSdk } = await import(
    './crazygames.js'
  );
  // Only attempt the SDK where a portal could plausibly be hosting us. On our
  // own domain this is a wasted request and a 4-second worst-case delay on the
  // one metric — load-to-playable — that decides whether anyone plays at all.
  const host = typeof location !== 'undefined' ? location.hostname : '';
  const maybePortal =
    /crazygames|gamedistribution|poki|famobi|\.io$/i.test(host) ||
    (typeof window !== 'undefined' && window.self !== window.top);

  if (maybePortal || crazyGamesAvailable()) {
    if (crazyGamesAvailable() || (await loadCrazyGamesSdk())) {
      const cg = new CrazyGamesPortal();
      if (await cg.init()) return cg;
    }
  }
  return new LocalPortal();
}
