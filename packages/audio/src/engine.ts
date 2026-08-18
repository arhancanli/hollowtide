/**
 * Procedural audio engine.
 *
 * Everything is synthesised at runtime — there are no audio files anywhere in
 * this project. For a portal game that is not a compromise, it is the right
 * answer: audio assets are usually the single largest thing in the bundle, and
 * load-to-playable is the metric that decides whether a player ever hears them.
 * A full sound bank costs zero bytes here.
 *
 * Browsers block audio until a real gesture, which is why the opening two
 * seconds of the game are designed to work in silence and why `unlock()` hangs
 * off the player's first touch.
 */

export interface ToneOptions {
  freq: number;
  /** Sweep to this frequency over the note. Omit to hold. */
  endFreq?: number;
  type?: OscillatorType;
  attack?: number;
  decay?: number;
  gain?: number;
  /** -1 left .. 1 right */
  pan?: number;
  delay?: number;
}

export interface NoiseOptions {
  duration: number;
  gain?: number;
  filterFreq?: number;
  filterEndFreq?: number;
  q?: number;
  type?: BiquadFilterType;
  pan?: number;
  delay?: number;
}

/**
 * Hard ceiling on simultaneous voices.
 *
 * At swarm density kills can land dozens of times a second. Without a cap the
 * result is both a wall of noise and a real CPU cost — and the sound stops
 * conveying anything because everything is always playing.
 */
const MAX_VOICES = 18;

export class AudioEngine {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private compressor: DynamicsCompressorNode | null = null;
  private noiseBuffer: AudioBuffer | null = null;
  /**
   * Scheduled end time of each voice slot, in context time.
   *
   * This used to be a single integer incremented on claim and decremented in
   * `onended`. That is unfixable by inspection: mute, suspend/resume and
   * garbage-collected nodes all break the pairing, and a measured session
   * drifted 9 → −18. Once negative the cap never rejects again and the mix
   * stacks unbounded, which is the usual cause of phone audio crackle.
   *
   * A slot is free when its end time has passed, so the state is derived from
   * the clock rather than from callback bookkeeping. It cannot drift, it
   * self-heals across suspend/resume, and it never allocates.
   */
  private readonly voiceEnds = new Float64Array(MAX_VOICES);
  private muted = false;
  private volume = 0.8;

  get ready(): boolean {
    return this.ctx !== null && this.ctx.state === 'running';
  }

  get context(): AudioContext | null {
    return this.ctx;
  }

  get now(): number {
    return this.ctx ? this.ctx.currentTime : 0;
  }

  /** Call from a real user gesture. Safe to call repeatedly. */
  unlock(): void {
    if (!this.ctx) {
      const Ctor: typeof AudioContext | undefined =
        window.AudioContext ??
        (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!Ctor) return;
      try {
        this.ctx = new Ctor();
      } catch {
        return; // audio unavailable; the game must still run
      }
      this.master = this.ctx.createGain();
      this.master.gain.value = this.muted ? 0 : this.volume;
      // A limiter between the mix and the speaker. Even with the voice cap,
      // eighteen simultaneous envelopes can sum past 1.0 and clip — which on a
      // phone is heard as crackle and blamed on the game being broken.
      // Aggressive ratio, fast attack: this is a safety net, not a compressor
      // anyone should hear working.
      this.compressor = this.ctx.createDynamicsCompressor();
      this.compressor.threshold.value = -8;
      this.compressor.knee.value = 6;
      this.compressor.ratio.value = 12;
      this.compressor.attack.value = 0.002;
      this.compressor.release.value = 0.12;
      this.master.connect(this.compressor);
      this.compressor.connect(this.ctx.destination);
      this.noiseBuffer = this.makeNoiseBuffer(this.ctx);
    }
    if (this.ctx.state === 'suspended') void this.ctx.resume();
  }

  setMuted(muted: boolean): void {
    this.muted = muted;
    if (this.master && this.ctx) {
      this.master.gain.setTargetAtTime(muted ? 0 : this.volume, this.ctx.currentTime, 0.02);
    }
  }

  get isMuted(): boolean {
    return this.muted;
  }

  /** Duck the mix, e.g. while an ad is playing. Portals require this. */
  setVolume(v: number): void {
    this.volume = v;
    if (this.master && this.ctx && !this.muted) {
      this.master.gain.setTargetAtTime(v, this.ctx.currentTime, 0.02);
    }
  }

  private makeNoiseBuffer(ctx: AudioContext): AudioBuffer {
    const len = Math.floor(ctx.sampleRate * 0.5);
    const buffer = ctx.createBuffer(1, len, ctx.sampleRate);
    const data = buffer.getChannelData(0);
    // Deterministic fill so the noise texture is identical every session.
    let s = 0x2545f491;
    for (let i = 0; i < len; i++) {
      s ^= s << 13;
      s ^= s >>> 17;
      s ^= s << 5;
      data[i] = ((s >>> 0) / 4294967296) * 2 - 1;
    }
    return buffer;
  }

  /**
   * Reserve a slot until `endTime`, or refuse if all are busy.
   * Returns false when there is no room, exactly like the old counter did.
   */
  private claimVoice(endTime: number): boolean {
    if (!this.ready || this.muted) return false;
    const now = this.ctx!.currentTime;
    for (let i = 0; i < MAX_VOICES; i++) {
      if (this.voiceEnds[i]! <= now) {
        this.voiceEnds[i] = endTime;
        return true;
      }
    }
    return false;
  }

  /** Live voice count, derived — exposed so probes can assert it never drifts. */
  get activeVoices(): number {
    if (!this.ctx) return 0;
    const now = this.ctx.currentTime;
    let n = 0;
    for (let i = 0; i < MAX_VOICES; i++) if (this.voiceEnds[i]! > now) n++;
    return n;
  }

  private makeOutput(pan: number): AudioNode {
    const ctx = this.ctx!;
    if (pan === 0 || !ctx.createStereoPanner) return this.master!;
    const panner = ctx.createStereoPanner();
    panner.pan.value = Math.max(-1, Math.min(1, pan));
    panner.connect(this.master!);
    return panner;
  }

  tone(o: ToneOptions): void {
    if (!this.ready) return;
    const ctx = this.ctx!;
    const t = ctx.currentTime + (o.delay ?? 0);
    const attack = o.attack ?? 0.004;
    const decay = o.decay ?? 0.12;
    const peak = o.gain ?? 0.2;
    if (!this.claimVoice(t + attack + decay + 0.02)) return;

    const osc = ctx.createOscillator();
    osc.type = o.type ?? 'sine';
    osc.frequency.setValueAtTime(o.freq, t);
    if (o.endFreq !== undefined) {
      // Exponential ramps cannot cross or reach zero.
      osc.frequency.exponentialRampToValueAtTime(Math.max(1, o.endFreq), t + attack + decay);
    }

    const env = ctx.createGain();
    env.gain.setValueAtTime(0.0001, t);
    env.gain.exponentialRampToValueAtTime(Math.max(0.0002, peak), t + attack);
    env.gain.exponentialRampToValueAtTime(0.0001, t + attack + decay);

    osc.connect(env);
    env.connect(this.makeOutput(o.pan ?? 0));
    osc.start(t);
    osc.stop(t + attack + decay + 0.02);
    // Only frees the graph now — the slot frees itself when its end time passes.
    osc.onended = () => {
      env.disconnect();
    };
  }

  noise(o: NoiseOptions): void {
    if (!this.ready) return;
    const ctx = this.ctx!;
    const t = ctx.currentTime + (o.delay ?? 0);
    const peak = o.gain ?? 0.2;
    if (!this.claimVoice(t + o.duration + 0.02)) return;

    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuffer;
    src.loop = true;

    const filter = ctx.createBiquadFilter();
    filter.type = o.type ?? 'bandpass';
    filter.frequency.setValueAtTime(o.filterFreq ?? 1200, t);
    if (o.filterEndFreq !== undefined) {
      filter.frequency.exponentialRampToValueAtTime(Math.max(20, o.filterEndFreq), t + o.duration);
    }
    filter.Q.value = o.q ?? 1;

    const env = ctx.createGain();
    env.gain.setValueAtTime(0.0001, t);
    env.gain.exponentialRampToValueAtTime(Math.max(0.0002, peak), t + 0.006);
    env.gain.exponentialRampToValueAtTime(0.0001, t + o.duration);

    src.connect(filter);
    filter.connect(env);
    env.connect(this.makeOutput(o.pan ?? 0));
    src.start(t);
    src.stop(t + o.duration + 0.02);
    src.onended = () => {
      filter.disconnect();
      env.disconnect();
    };
  }

  /** Stack tones into a chord. Used for the level-up sting. */
  chord(freqs: readonly number[], o: Omit<ToneOptions, 'freq'> = {}): void {
    for (let i = 0; i < freqs.length; i++) {
      this.tone({ ...o, freq: freqs[i]!, delay: (o.delay ?? 0) + i * 0.035 });
    }
  }
}

/**
 * Rate limiter for sounds that can fire many times per frame.
 *
 * Without this, a dense wave produces one continuous roar in which no
 * individual kill is audible — the sound stops being feedback and becomes
 * texture.
 */
export class RateLimiter {
  private last = new Map<string, number>();

  constructor(private readonly intervalMs: number) {}

  allow(key: string, nowMs: number, interval = this.intervalMs): boolean {
    const prev = this.last.get(key);
    if (prev !== undefined && nowMs - prev < interval) return false;
    this.last.set(key, nowMs);
    return true;
  }
}
