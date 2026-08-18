import type { AdResult, Portal, PortalUser } from './index.js';

/**
 * CrazyGames adapter.
 *
 * The SDK is LOADED BY US, not injected by the host page.
 *
 * The first version of this file assumed injection, which is how some portals
 * work and is not how CrazyGames works. The consequence was total and silent:
 * `window.CrazyGames` was never defined, `createPortal()` fell through to
 * LocalPortal on the live site, and therefore zero ads ever rendered, the
 * gameplayStart/Stop engagement signal that decides traffic allocation was
 * never emitted, and `showRewarded()` resolved 'watched' unconditionally — which
 * also means every difficulty measurement taken against the live build was
 * taken with free unlimited revives. One missing script tag invalidated the
 * revenue, the distribution signal AND the balance data.
 *
 * Still written defensively: the SDK's shape has changed across major versions,
 * and it is absent entirely on our own domain and in local development. Every call is optional-chained and wrapped,
 * and any failure degrades to the same behaviour as LocalPortal rather than
 * taking the run down with it. A game that crashes because an ad call threw is
 * worth less than a game that silently shows no ads.
 */

interface CgAdCallbacks {
  adFinished?: () => void;
  adError?: (error?: unknown) => void;
  adStarted?: () => void;
}

interface CgSdk {
  init?: () => Promise<void>;
  game?: {
    loadingStart?: () => void;
    loadingStop?: () => void;
    gameplayStart?: () => void;
    gameplayStop?: () => void;
    happytime?: () => void;
    updateRoom?: (room: { roomId?: string; isJoinable?: boolean; inviteParams?: Record<string, string> }) => void;
    leftRoom?: () => void;
  };
  ad?: {
    requestAd?: (type: 'midgame' | 'rewarded', callbacks: CgAdCallbacks) => void;
  };
  user?: {
    getUser?: () => Promise<{ username?: string; userId?: string } | null>;
    /** Opens the portal's own sign-in flow. Never call it unprompted. */
    showAuthPrompt?: () => Promise<{ username?: string; userId?: string } | null>;
    /** Fires whenever the player signs in or out mid-session. */
    addAuthListener?: (cb: (user: unknown) => void) => void;
    isUserAccountAvailable?: boolean;
  };
  data?: {
    setItem?: (key: string, value: string) => void;
    getItem?: (key: string) => string | null;
  };
}

declare global {
  interface Window {
    CrazyGames?: { SDK?: CgSdk };
  }
}

/**
 * Shortest gap between interstitials, in milliseconds.
 *
 * Portal QA rejects for ad frequency, and it is one of the more common reasons.
 * Three minutes is comfortably inside every published guideline and still
 * catches the natural break a run boundary provides. The floor lives here
 * rather than at the call site so no future call site can bypass it.
 */
const MIDGAME_FLOOR_MS = 180_000;

const SDK_URL = 'https://sdk.crazygames.com/crazygames-sdk-v3.js';

/**
 * Inject the SDK and wait for it.
 *
 * Resolves false rather than rejecting on every failure path — a blocked
 * script, an offline player, an ad blocker, our own domain — because the game
 * must remain fully playable without it. The timeout matters: a portal SDK that
 * never loads must not hold the player on a loading screen, since load-to-
 * playable is the metric that decides whether they ever see the game.
 */
export function loadCrazyGamesSdk(timeoutMs = 4000): Promise<boolean> {
  if (typeof window === 'undefined') return Promise.resolve(false);
  if (window.CrazyGames?.SDK) return Promise.resolve(true);
  return new Promise<boolean>((resolve) => {
    let settled = false;
    const done = (ok: boolean): void => {
      if (settled) return;
      settled = true;
      resolve(ok);
    };
    const timer = setTimeout(() => done(false), timeoutMs);
    try {
      const el = document.createElement('script');
      el.src = SDK_URL;
      el.async = true;
      el.onload = () => {
        clearTimeout(timer);
        done(!!window.CrazyGames?.SDK);
      };
      el.onerror = () => {
        clearTimeout(timer);
        done(false);
      };
      document.head.appendChild(el);
    } catch {
      clearTimeout(timer);
      done(false);
    }
  });
}

export function crazyGamesAvailable(): boolean {
  return typeof window !== 'undefined' && !!window.CrazyGames?.SDK;
}

export class CrazyGamesPortal implements Portal {
  readonly name = 'crazygames';

  private sdk: CgSdk | null = null;
  private ready = false;
  private lastMidgame = 0;
  private reportedRoom = '';
  /** True between gameplayStart and gameplayStop, so we never double-fire. */
  private playing = false;

  /**
   * Must be awaited before the first ad call. Safe to call more than once, and
   * safe to skip — every other method tolerates `ready` being false.
   */
  async init(): Promise<boolean> {
    if (this.ready) return true;
    const sdk = window.CrazyGames?.SDK;
    if (!sdk) return false;
    this.sdk = sdk;
    try {
      await sdk.init?.();
      this.ready = true;
      return true;
    } catch {
      // An SDK that fails to initialise must not block the game from booting.
      this.sdk = null;
      return false;
    }
  }

  loadingStart(): void {
    try {
      this.sdk?.game?.loadingStart?.();
    } catch {
      /* never let telemetry break a boot */
    }
  }

  loadingStop(): void {
    try {
      this.sdk?.game?.loadingStop?.();
    } catch {
      /* ignore */
    }
  }

  /**
   * These two are not bookkeeping.
   *
   * As far as anyone outside CrazyGames can tell, the gameplay bracket feeds the
   * engagement signal that decides how much traffic a game is allocated — so a
   * game that never calls gameplayStop before its menus and ads is under-
   * reporting the only metric that buys distribution. Guarded against double
   * calls because the natural call sites (death, pause, ad, tab-hide) overlap.
   */
  gameplayStart(): void {
    if (this.playing) return;
    this.playing = true;
    try {
      this.sdk?.game?.gameplayStart?.();
    } catch {
      /* ignore */
    }
  }

  gameplayStop(): void {
    if (!this.playing) return;
    this.playing = false;
    try {
      this.sdk?.game?.gameplayStop?.();
    } catch {
      /* ignore */
    }
  }

  happyMoment(): void {
    try {
      this.sdk?.game?.happytime?.();
    } catch {
      /* ignore */
    }
  }

  setRoom(roomId: string | null, isJoinable = false): void {
    // Keyed on the FLAG as well as the id. Deduping on the id alone meant a
    // room that closed to newcomers went on advertising itself as joinable for
    // the rest of the match, which is the one thing the portal asks a game not
    // to do with this call.
    const next = roomId ? `${roomId}|${isJoinable ? 1 : 0}` : '';
    if (next === this.reportedRoom) return;
    this.reportedRoom = next;
    try {
      if (roomId) this.sdk?.game?.updateRoom?.({ roomId, isJoinable });
      else this.sdk?.game?.leftRoom?.();
    } catch {
      /* social presence must never interrupt the match */
    }
  }

  async showRewarded(): Promise<AdResult> {
    return this.requestAd('rewarded');
  }

  async showMidgame(): Promise<AdResult> {
    const now = Date.now();
    if (now - this.lastMidgame < MIDGAME_FLOOR_MS) return 'unavailable';
    const result = await this.requestAd('midgame');
    // Only start the clock on an ad that actually ran. Counting failures would
    // let one unfilled request suppress the next three minutes of inventory.
    if (result === 'watched') this.lastMidgame = now;
    return result;
  }

  private requestAd(type: 'midgame' | 'rewarded'): Promise<AdResult> {
    const request = this.sdk?.ad?.requestAd;
    if (!this.ready || !request) return Promise.resolve('unavailable');

    return new Promise<AdResult>((resolve) => {
      let settled = false;
      const done = (r: AdResult): void => {
        if (settled) return;
        settled = true;
        resolve(r);
      };

      // The portal signal must be stopped for the whole request, not just the
      // happy path. Resuming is deliberately owned by the call site: a
      // rewarded ad can return to a results screen, a revive, or a level-up
      // menu, and only the revive actually resumes gameplay immediately.
      this.gameplayStop();

      /**
       * Hard timeout.
       *
       * An SDK that neither finishes nor errors leaves the player staring at a
       * frozen game with no way out — the worst failure mode available here, and
       * one that ad SDKs genuinely produce when an ad network stalls. Resolving
       * as 'failed' hands control back; callers grant rewarded payouts on
       * 'failed' anyway, so a stall costs us an impression, never the player.
       */
      const timer = setTimeout(() => done('failed'), 20_000);
      const finish = (r: AdResult): void => {
        clearTimeout(timer);
        done(r);
      };

      try {
        request(type, {
          adFinished: () => finish('watched'),
          adError: () => finish('failed'),
        });
      } catch {
        finish('failed');
      }
    });
  }

  /**
   * Is a portal account system present at all.
   *
   * Full Launch requires progress and cloud saves to link to the CrazyGames
   * account, but a large share of players are signed out — so every path here
   * has to work without one, and the account is an upgrade rather than a gate.
   */
  get accountsAvailable(): boolean {
    return !!this.sdk?.user?.isUserAccountAvailable;
  }

  /**
   * Ask the player to sign in, at a moment they chose.
   *
   * Deliberately only ever called from an explicit tap. An unprompted auth
   * modal in the first ten seconds is the single fastest way to lose a portal
   * player, and it would also violate the one-click-to-gameplay rule.
   */
  async promptSignIn(): Promise<PortalUser | null> {
    try {
      const u = await this.sdk?.user?.showAuthPrompt?.();
      if (!u) return null;
      return { id: u.userId ?? '', name: u.username ?? '' };
    } catch {
      return null;
    }
  }

  /** Re-read progress when the player signs in or out mid-session. */
  onAuthChanged(cb: () => void): void {
    try {
      this.sdk?.user?.addAuthListener?.(() => cb());
    } catch {
      /* older SDK builds do not expose this */
    }
  }

  async getUser(): Promise<PortalUser | null> {
    try {
      const u = await this.sdk?.user?.getUser?.();
      if (!u) return null;
      return { id: u.userId ?? '', name: u.username ?? '' };
    } catch {
      return null;
    }
  }

  /**
   * Saves go to the portal's synced storage when it exists, and ALWAYS also to
   * localStorage.
   *
   * Belt and braces deliberately: portal storage syncs across a player's
   * devices, which is the whole point, but it is also the thing most likely to
   * be missing, throttled, or unavailable to a signed-out player. Losing a
   * player's unlocks is unrecoverable, and the cost of writing twice is nothing.
   */
  async save(key: string, value: string): Promise<void> {
    try {
      this.sdk?.data?.setItem?.(key, value);
    } catch {
      /* fall through to localStorage */
    }
    try {
      localStorage.setItem(key, value);
    } catch {
      /* private browsing or a storage-blocked iframe */
    }
  }

  async load(key: string): Promise<string | null> {
    try {
      const v = this.sdk?.data?.getItem?.(key);
      if (typeof v === 'string') return v;
    } catch {
      /* fall through */
    }
    try {
      return localStorage.getItem(key);
    } catch {
      return null;
    }
  }
}
