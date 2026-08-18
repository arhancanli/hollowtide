import { AudioEngine, RateLimiter } from '@arcade/audio';
import type { SimEvent } from '../sim/types.js';

/**
 * Sound design for Swarm.
 *
 * Two rules shape all of it:
 *
 * 1. NO per-shot sound. The weapon fires continuously and gets faster with
 *    upgrades; a shoot sound becomes a machine gun inside a minute and buries
 *    everything that actually matters. Impacts carry the weapon instead.
 *
 * 2. Everything high-frequency is rate limited. At swarm density kills land
 *    dozens of times a second, and unlimited feedback stops being feedback —
 *    it becomes a single flat roar in which nothing is legible.
 */

/** Semitone ratio. */
const ST = 1.059463;

/** Pentatonic-ish steps for the gem streak, so a fast run stays musical. */
const STREAK_STEPS = [0, 2, 4, 7, 9, 12, 14, 16, 19, 21, 24];

const STREAK_WINDOW = 0.65;

export class Sfx {
  readonly engine = new AudioEngine();

  private readonly limiter = new RateLimiter(60);
  private streak = 0;
  private streakTimer = 0;

  /** Adaptive bed state. */
  private bedTimer = 0;
  private bedStep = 0;
  private intensity = 0;

  unlock(): void {
    this.engine.unlock();
  }

  setMuted(muted: boolean): void {
    this.engine.setMuted(muted);
  }

  get muted(): boolean {
    return this.engine.isMuted;
  }

  reset(): void {
    this.streak = 0;
    this.streakTimer = 0;
    this.bedStep = 0;
  }

  consume(events: readonly SimEvent[], nowMs: number): void {
    if (!this.engine.ready) return;

    for (let i = 0; i < events.length; i++) {
      const ev = events[i]!;
      switch (ev.type) {
        case 'enemyHit': {
          if (ev.killed) break; // the kill sound covers it
          if (ev.kind === 'elite') {
            if (!this.limiter.allow('elitehit', nowMs, 70)) break;
            this.engine.tone({ freq: 180, endFreq: 90, type: 'square', decay: 0.07, gain: 0.1 });
            this.engine.noise({ duration: 0.05, gain: 0.07, filterFreq: 1800, q: 1.2 });
          } else {
            if (!this.limiter.allow('hit', nowMs, 45)) break;
            this.engine.noise({ duration: 0.03, gain: 0.035, filterFreq: 3200, q: 2 });
          }
          break;
        }

        case 'enemyKilled': {
          if (ev.kind === 'elite') {
            this.engine.tone({ freq: 130, endFreq: 44, type: 'sawtooth', decay: 0.34, gain: 0.2 });
            this.engine.noise({
              duration: 0.34,
              gain: 0.16,
              filterFreq: 1400,
              filterEndFreq: 160,
              type: 'lowpass',
            });
          } else if (this.limiter.allow('kill', nowMs, 55)) {
            // Small random-ish detune per kill so a stream of them reads as a
            // texture of distinct pops rather than one repeated sample.
            const wobble = 1 + ((nowMs % 7) - 3) * 0.02;
            this.engine.tone({
              freq: 320 * wobble,
              endFreq: 120,
              type: 'triangle',
              decay: 0.075,
              gain: 0.075,
            });
          }
          break;
        }

        /**
         * Your own death, in a mode where death is a cost rather than an end.
         *
         * Deliberately NOT the 'died' sting, which is a run ending. This is a
         * heavy downward drop — you lost everything you were carrying — that
         * resolves rather than trails off, because you are coming back in three
         * seconds and the sound has to leave room for that.
         */
        case 'respawned': {
          if (ev.seat !== 0) break;
          this.engine.chord([146.83, 220, 293.66], {
            type: 'triangle', attack: 0.006, decay: 0.5, gain: 0.12,
          });
          this.engine.tone({
            freq: 587.33, endFreq: 880, type: 'sine',
            attack: 0.01, decay: 0.34, gain: 0.09,
          });
          break;
        }

        /** The clock running out. The last thing a match says. */
        case 'matchOver': {
          this.engine.chord([261.63, 392, 523.25, 783.99], {
            type: 'triangle', attack: 0.01, decay: 1.1, gain: 0.15,
          });
          this.engine.noise({
            duration: 0.7, gain: 0.08, filterFreq: 3200, filterEndFreq: 300,
            type: 'bandpass', q: 0.8,
          });
          break;
        }

        /**
         * A horde changing hands. Rate-limited hard: the sim reports these far
         * more often than the banner shows them, and a celebration you hear
         * every few seconds stops being one.
         */
        case 'handoff': {
          if (ev.from !== 0 && ev.to !== 0) break;
          if (!this.limiter.allow('handoff', nowMs, 4000)) break;
          const mine = ev.from === 0;
          this.engine.noise({
            duration: 0.36, gain: 0.09,
            filterFreq: mine ? 700 : 2400, filterEndFreq: mine ? 2600 : 500,
            type: 'bandpass', q: 1.1,
          });
          this.engine.tone({
            freq: mine ? 330 : 220, endFreq: mine ? 494 : 165, type: 'triangle',
            attack: 0.008, decay: 0.3, gain: 0.08,
          });
          break;
        }

        case 'rivalDown': {
          this.engine.chord([196, 293.66, 392, 587.33], {
            type: 'triangle', attack: 0.004, decay: 0.58, gain: 0.13,
          });
          this.engine.noise({
            duration: 0.32, gain: 0.1, filterFreq: 2600, filterEndFreq: 260, type: 'bandpass', q: 0.9,
          });
          break;
        }

        case 'gemCollected': {
          // Rising pitch on a streak. The single most satisfying sound in the
          // genre: it turns collection into a phrase instead of a click.
          this.streakTimer = STREAK_WINDOW;
          const step = STREAK_STEPS[Math.min(this.streak, STREAK_STEPS.length - 1)]!;
          this.streak++;
          if (!this.limiter.allow('gem', nowMs, 28)) break;
          this.engine.tone({
            freq: 520 * Math.pow(ST, step),
            type: 'sine',
            attack: 0.002,
            decay: 0.1,
            gain: 0.055,
          });
          break;
        }

        case 'levelUp': {
          this.streak = 0;
          this.engine.chord([523.25, 659.25, 783.99, 1046.5], {
            type: 'triangle',
            attack: 0.006,
            decay: 0.5,
            gain: 0.11,
          });
          break;
        }

        case 'playerHit': {
          this.engine.tone({ freq: 150, endFreq: 55, type: 'sawtooth', decay: 0.22, gain: 0.22 });
          this.engine.noise({
            duration: 0.18,
            gain: 0.14,
            filterFreq: 900,
            filterEndFreq: 120,
            type: 'lowpass',
          });
          break;
        }

        case 'eliteSpawned':
        case 'heraldSpawned': {
          // A low warning swell — heard, not looked at. The player should feel
          // something arrive without taking their eyes off the swarm.
          this.engine.tone({ freq: 74, endFreq: 110, type: 'sawtooth', attack: 0.09, decay: 0.5, gain: 0.11 });
          break;
        }

        case 'revived': {
          this.engine.chord([392, 523.25, 659.25, 1046.5], {
            type: 'sine',
            attack: 0.01,
            decay: 0.8,
            gain: 0.13,
          });
          this.engine.noise({
            duration: 0.6,
            gain: 0.1,
            filterFreq: 300,
            filterEndFreq: 5000,
            type: 'bandpass',
            q: 0.7,
          });
          break;
        }

        case 'blast': {
          if (!this.limiter.allow('blast', nowMs, 90)) break;
          this.engine.tone({ freq: 96, endFreq: 40, type: 'sawtooth', decay: 0.24, gain: 0.15 });
          this.engine.noise({
            duration: 0.26, gain: 0.12, filterFreq: 1100, filterEndFreq: 130, type: 'lowpass',
          });
          break;
        }

        case 'chainArc': {
          if (!this.limiter.allow('chain', nowMs, 60)) break;
          // Bright, thin and short: electricity, not an explosion.
          this.engine.noise({
            duration: 0.13, gain: 0.075, filterFreq: 5200, filterEndFreq: 2400, q: 3,
          });
          break;
        }

        case 'bossSpawned': {
          // A long low approach. The player should hear it before they read it.
          this.engine.tone({ freq: 55, endFreq: 41, type: 'sawtooth', attack: 0.2, decay: 1.5, gain: 0.2 });
          this.engine.tone({ freq: 110, endFreq: 82, type: 'triangle', attack: 0.25, decay: 1.2, gain: 0.1 });
          break;
        }

        case 'bossKilled': {
          this.engine.chord([130.8, 196, 261.6, 392, 523.25], {
            type: 'triangle', attack: 0.01, decay: 1.1, gain: 0.14,
          });
          this.engine.noise({
            duration: 0.9, gain: 0.18, filterFreq: 2200, filterEndFreq: 90, type: 'lowpass',
          });
          break;
        }

        case 'evolved': {
          // The biggest sound in the game. Evolving is the payoff the whole
          // weapon system exists to deliver, and it should feel like one.
          this.engine.chord([261.6, 392, 523.25, 659.25, 1046.5], {
            type: 'triangle', attack: 0.008, decay: 0.9, gain: 0.13,
          });
          this.engine.noise({
            duration: 0.7, gain: 0.11, filterFreq: 400, filterEndFreq: 7000, type: 'bandpass', q: 0.8,
          });
          break;
        }

        case 'weaponGained': {
          this.engine.chord([392, 587.33], { type: 'sine', attack: 0.005, decay: 0.35, gain: 0.1 });
          break;
        }

        case 'died': {
          this.streak = 0;
          this.engine.tone({ freq: 220, endFreq: 40, type: 'sawtooth', attack: 0.01, decay: 1.1, gain: 0.24 });
          this.engine.noise({
            duration: 0.9,
            gain: 0.16,
            filterFreq: 1600,
            filterEndFreq: 70,
            type: 'lowpass',
          });
          break;
        }

        default:
          break;
      }
    }
  }

  /** UI tap. Deliberately dry and short — confirmation, not celebration. */
  uiTap(): void {
    this.engine.tone({ freq: 660, endFreq: 880, type: 'sine', attack: 0.002, decay: 0.05, gain: 0.07 });
  }

  /** Health pickup. Warm, rising, unmistakably a good thing. */
  heal(): void {
    this.engine.tone({ freq: 520, endFreq: 780, type: 'sine', attack: 0.006, decay: 0.2, gain: 0.13 });
    this.engine.tone({ freq: 780, endFreq: 1170, type: 'sine', attack: 0.008, decay: 0.24, gain: 0.08, delay: 0.05 });
  }

  /**
   * Ability fire. A rising sweep with a noise transient under it.
   *
   * Deliberately the most distinct sound in the game: it is the only thing the
   * player deliberately CAUSES, so it has to be instantly separable from the
   * constant bed of weapon fire and impacts. If the ability sounds like a
   * weapon, the player cannot tell whether their press registered.
   */
  ability(): void {
    this.engine.tone({ freq: 300, endFreq: 900, type: 'triangle', attack: 0.004, decay: 0.22, gain: 0.16 });
    this.engine.tone({ freq: 600, endFreq: 1800, type: 'sine', attack: 0.003, decay: 0.16, gain: 0.09, delay: 0.02 });
    this.engine.noise({ duration: 0.14, gain: 0.1, filterFreq: 900, filterEndFreq: 2600, q: 1.2 });
  }

  /**
   * Adaptive bed: a slow two-note pulse whose brightness tracks how much
   * pressure is on screen.
   *
   * Kept extremely restrained on purpose. It is a heartbeat, not a soundtrack —
   * it should register as rising tension without ever being something the
   * player notices as music competing with the impacts.
   */
  update(dt: number, enemyCount: number, alive: boolean): void {
    if (this.streakTimer > 0) {
      this.streakTimer -= dt;
      if (this.streakTimer <= 0) this.streak = 0;
    }

    if (!this.engine.ready || !alive) return;

    const target = Math.min(1, enemyCount / 90);
    this.intensity += (target - this.intensity) * Math.min(1, dt * 0.6);

    this.bedTimer -= dt;
    if (this.bedTimer > 0) return;

    // Tempo lifts with pressure: 0.62s per pulse when calm, 0.36s when swamped.
    this.bedTimer = 0.62 - this.intensity * 0.26;
    this.bedStep = (this.bedStep + 1) % 4;

    const root = this.bedStep === 2 ? 55 : 41.2; // A1 / E1
    this.engine.tone({
      freq: root,
      type: 'sine',
      attack: 0.02,
      decay: 0.3 + this.intensity * 0.1,
      gain: 0.05 + this.intensity * 0.09,
    });
    if (this.intensity > 0.45 && this.bedStep % 2 === 0) {
      this.engine.tone({
        freq: root * 4,
        type: 'triangle',
        attack: 0.01,
        decay: 0.14,
        gain: 0.012 + this.intensity * 0.022,
      });
    }
  }
}
