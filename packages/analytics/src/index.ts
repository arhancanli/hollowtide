/**
 * Funnel analytics.
 *
 * The point of this package is one question: WHERE do players leave? Every
 * decision after the soft launch depends on knowing whether they bounce at the
 * load screen, never touch the controls, quit at fifteen seconds, or play one
 * run and never start a second. Without that, every further design call is
 * guesswork dressed up as taste.
 *
 * The funnel is deliberately the same one CrazyGames judges on — session length
 * and return rate — so what we optimise locally is what buys traffic later.
 *
 * Transport is pluggable because the destination is not decided yet. The
 * instrumentation is the expensive part; pointing it at a datastore later is
 * a one-line change.
 */

export type EventName =
  | 'session_start'
  | 'load_complete'
  | 'first_input'
  | 'run_start'
  | 'mode_selected'
  | 'run_reached_15s'
  | 'run_reached_60s'
  | 'level_up'
  | 'weapon_gained'
  | 'evolved'
  | 'boss_spawned'
  | 'boss_killed'
  | 'rival_down'
  | 'arena_end'
  | 'run_end'
  | 'ad_offered'
  | 'ad_result'
  | 'revived'
  | 'restart_tapped'
  /**
   * Gold actually spent. The one event that says whether the meta-progression
   * is doing its job: a player who earns gold and never spends it has a score,
   * not a currency, which is precisely the failure this system was built to fix.
   */
  | 'forge_bought'
  | 'session_end';

export interface AnalyticsEvent {
  /** Event name. */
  e: EventName;
  /** Milliseconds since session start. */
  t: number;
  /** Event-specific payload. Kept small — this goes over the wire. */
  d?: Record<string, number | string | boolean>;
}

export interface Transport {
  send(sessionId: string, events: AnalyticsEvent[], meta: SessionMeta): void;
}

export interface SessionMeta {
  sessionId: string;
  startedAt: number;
  /** Coarse device info only. Nothing identifying. */
  screen: string;
  dpr: number;
  portrait: boolean;
  touch: boolean;
  lang: string;
  referrer: string;
  /** Which portal the build is running under. */
  portal: string;
}

/** Rolling counters kept on-device, so the funnel is readable without a server. */
export interface LocalFunnel {
  sessions: number;
  loads: number;
  firstInputs: number;
  runsStarted: number;
  reached15: number;
  reached60: number;
  secondRuns: number;
  totalRunMs: number;
  totalSessionMs: number;
  runsEnded: number;
  bestRunMs: number;
  lastSessionDay: string;
  distinctDays: number;
  returns: number;
  /**
   * Ad funnel. Reviewers flagged that ad outcomes were tracked as events but
   * never counted, so offer->accept->fill rates — the numbers that decide
   * whether the placements are worth anything — were invisible on device.
   */
  adsOffered: number;
  adsAccepted: number;
  adsWatched: number;
  adsFailed: number;
  revives: number;
}

const EMPTY_FUNNEL: LocalFunnel = {
  sessions: 0,
  loads: 0,
  firstInputs: 0,
  runsStarted: 0,
  reached15: 0,
  reached60: 0,
  secondRuns: 0,
  totalRunMs: 0,
  totalSessionMs: 0,
  runsEnded: 0,
  bestRunMs: 0,
  lastSessionDay: '',
  distinctDays: 0,
  returns: 0,
  adsOffered: 0,
  adsAccepted: 0,
  adsWatched: 0,
  adsFailed: 0,
  revives: 0,
};

const FUNNEL_KEY = 'arcade.funnel.v1';
const BATCH_SIZE = 24;
const FLUSH_INTERVAL_MS = 15000;

function dayKey(ts: number): string {
  return new Date(ts).toISOString().slice(0, 10);
}

/** Console transport — the default until a datastore is chosen. */
export class ConsoleTransport implements Transport {
  send(sessionId: string, events: AnalyticsEvent[]): void {
    // eslint-disable-next-line no-console
    console.info(`[analytics] ${sessionId}`, events);
  }
}

export class NullTransport implements Transport {
  send(): void {}
}

/**
 * HTTP transport. Uses sendBeacon where possible so the final batch survives
 * the tab closing — which is precisely when session_end fires, and precisely
 * the event that tells us how long people actually played.
 */
export class HttpTransport implements Transport {
  constructor(private readonly url: string) {}

  send(sessionId: string, events: AnalyticsEvent[], meta: SessionMeta): void {
    const body = JSON.stringify({ sessionId, meta, events });
    try {
      if (typeof navigator !== 'undefined' && navigator.sendBeacon) {
        navigator.sendBeacon(this.url, new Blob([body], { type: 'application/json' }));
        return;
      }
      void fetch(this.url, {
        method: 'POST',
        body,
        headers: { 'content-type': 'application/json' },
        keepalive: true,
      }).catch(() => {});
    } catch {
      // Analytics must never break the game. Silence is the correct failure.
    }
  }
}

export class Analytics {
  readonly meta: SessionMeta;

  private readonly transport: Transport;
  private readonly queue: AnalyticsEvent[] = [];
  private readonly start: number;
  private funnel: LocalFunnel = { ...EMPTY_FUNNEL };
  private flushTimer: ReturnType<typeof setInterval> | null = null;
  private runsThisSession = 0;
  private firstInputSent = false;
  private ended = false;

  constructor(transport: Transport, portal = 'local') {
    this.transport = transport;
    this.start = performance.now();

    const now = Date.now();
    this.meta = {
      sessionId: makeId(),
      startedAt: now,
      screen: typeof window !== 'undefined' ? `${window.innerWidth}x${window.innerHeight}` : '0x0',
      dpr: typeof window !== 'undefined' ? Math.round((window.devicePixelRatio || 1) * 100) / 100 : 1,
      portrait: typeof window !== 'undefined' ? window.innerHeight >= window.innerWidth : true,
      touch: typeof navigator !== 'undefined' ? navigator.maxTouchPoints > 0 : false,
      lang: typeof navigator !== 'undefined' ? navigator.language : '',
      referrer: typeof document !== 'undefined' ? shortReferrer(document.referrer) : '',
      portal,
    };

    this.loadFunnel();
    this.countSession(now);
    this.track('session_start');

    if (typeof window !== 'undefined') {
      this.flushTimer = setInterval(() => this.flush(), FLUSH_INTERVAL_MS);
      // 'visibilitychange' rather than 'unload': mobile browsers frequently
      // kill a backgrounded tab without ever firing unload, which would lose
      // the session length of every mobile player — most of the audience.
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'hidden') this.endSession();
      });
      window.addEventListener('pagehide', () => this.endSession());
    }
  }

  get local(): Readonly<LocalFunnel> {
    return this.funnel;
  }

  /** Elapsed time in THIS session. The stored total only lands on tab close. */
  get sessionMs(): number {
    return performance.now() - this.start;
  }

  get runsThisSessionCount(): number {
    return this.runsThisSession;
  }

  track(e: EventName, d?: Record<string, number | string | boolean>): void {
    this.queue.push({ e, t: Math.round(performance.now() - this.start), ...(d ? { d } : {}) });
    if (this.queue.length >= BATCH_SIZE) this.flush();
  }

  // ---- funnel-specific helpers, so call sites cannot drift from the schema --

  loadComplete(ms: number): void {
    this.funnel.loads++;
    this.track('load_complete', { ms: Math.round(ms) });
    this.save();
  }

  firstInput(): void {
    if (this.firstInputSent) return;
    this.firstInputSent = true;
    this.funnel.firstInputs++;
    this.track('first_input');
    this.save();
  }

  runStart(): void {
    this.runsThisSession++;
    this.funnel.runsStarted++;
    // "Did they start a SECOND run" is the single most predictive number for
    // whether a portal game retains at all.
    if (this.runsThisSession === 2) this.funnel.secondRuns++;
    this.track('run_start', { n: this.runsThisSession });
    this.save();
  }

  runMilestone(seconds: 15 | 60): void {
    if (seconds === 15) this.funnel.reached15++;
    else this.funnel.reached60++;
    this.track(seconds === 15 ? 'run_reached_15s' : 'run_reached_60s');
    this.save();
  }

  runEnd(timeSec: number, level: number, kills: number, revived: boolean): void {
    const ms = Math.round(timeSec * 1000);
    this.funnel.runsEnded++;
    this.funnel.totalRunMs += ms;
    this.funnel.bestRunMs = Math.max(this.funnel.bestRunMs, ms);
    this.track('run_end', { ms, level, kills, revived });
    this.save();
  }

  adOffered(placement: string): void {
    this.funnel.adsOffered++;
    this.track('ad_offered', { placement });
    this.save();
  }

  adAccepted(placement: string): void {
    this.funnel.adsAccepted++;
    this.track('ad_offered', { placement, accepted: true });
    this.save();
  }

  adResult(placement: string, result: string): void {
    if (result === 'watched') this.funnel.adsWatched++;
    else if (result === 'failed') this.funnel.adsFailed++;
    this.track('ad_result', { placement, result });
    this.save();
  }

  revived(): void {
    this.funnel.revives++;
    this.track('revived');
    this.save();
  }

  endSession(): void {
    if (this.ended) return;
    this.ended = true;
    const ms = Math.round(performance.now() - this.start);
    this.funnel.totalSessionMs += ms;
    this.track('session_end', { ms, runs: this.runsThisSession });
    this.save();
    this.flush();
    if (this.flushTimer) clearInterval(this.flushTimer);
  }

  flush(): void {
    if (this.queue.length === 0) return;
    const batch = this.queue.splice(0, this.queue.length);
    this.transport.send(this.meta.sessionId, batch, this.meta);
  }

  // ---------------------------------------------------------------- storage

  private countSession(now: number): void {
    this.funnel.sessions++;
    const today = dayKey(now);
    if (this.funnel.lastSessionDay !== today) {
      if (this.funnel.lastSessionDay !== '') this.funnel.returns++;
      this.funnel.distinctDays++;
      this.funnel.lastSessionDay = today;
    }
    this.save();
  }

  private loadFunnel(): void {
    try {
      const raw = localStorage.getItem(FUNNEL_KEY);
      if (!raw) return;
      this.funnel = { ...EMPTY_FUNNEL, ...(JSON.parse(raw) as Partial<LocalFunnel>) };
    } catch {
      this.funnel = { ...EMPTY_FUNNEL };
    }
  }

  private save(): void {
    try {
      localStorage.setItem(FUNNEL_KEY, JSON.stringify(this.funnel));
    } catch {
      // Storage blocked (private mode, portal iframe). Events still ship.
    }
  }
}

function makeId(): string {
  const buf = new Uint8Array(8);
  if (typeof crypto !== 'undefined' && crypto.getRandomValues) crypto.getRandomValues(buf);
  let out = '';
  for (let i = 0; i < buf.length; i++) out += buf[i]!.toString(16).padStart(2, '0');
  return out;
}

/** Host only. Full referrer URLs are needlessly identifying. */
function shortReferrer(ref: string): string {
  if (!ref) return '';
  try {
    return new URL(ref).host;
  } catch {
    return '';
  }
}
