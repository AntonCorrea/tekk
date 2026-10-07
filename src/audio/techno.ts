/**
 * Techno
 *
 * The soundtrack and every sound effect, synthesised live with Web Audio. No
 * samples, no files to load, nothing to license: a kick is a sine sweeping
 * down, a hat is filtered noise, the bass is a sawtooth through a resonant
 * low-pass -- which is, more or less, how the machines that defined the genre
 * made them.
 *
 * The music has intensity LEVELS rather than tracks. Gameplay sets the level
 * (waiting, playing, holding the Core, the final seconds) and the pattern
 * gains or sheds layers on the next sixteenth, so the music always tracks how
 * tense the moment is without ever restarting.
 *
 * Timing uses the standard lookahead scheduler: a coarse JS timer wakes every
 * 25ms and schedules any notes due in the next ~120ms against the audio
 * clock, which is sample-accurate. Scheduling notes straight from a timer or
 * from requestAnimationFrame would drift and stutter under load.
 *
 * Browsers refuse to start audio before a user gesture, so `start()` must be
 * called from one (main.ts hooks the first key or click). Everything before
 * that is a silent no-op, and the beat clock still runs, so visuals pulse in
 * time either way.
 */

/** 0 waiting/results · 1 countdown/playing · 2 holding the Core or <30s left · 3 final 10s. */
export type Intensity = 0 | 1 | 2 | 3;

export interface Techno {
  /** Create and resume the audio context. Call from a user gesture; idempotent. */
  start(): void;
  setIntensity(level: Intensity): void;
  /** 1 on each kick, decaying toward 0 before the next. Drives beat-synced visuals. */
  beat(): number;
  toggleMute(): boolean;
  readonly muted: boolean;
  dispose(): void;
  sfx: {
    dash(): void;
    /** You took the Core from someone. */
    take(): void;
    /** You picked up a free Core. */
    pickup(): void;
    /** Someone took it from you, or you dropped it. */
    lose(): void;
    land(): void;
    /** A countdown tick; `final` is the GO. */
    count(final: boolean): void;
  };
}

const BPM = 130;
const SIXTEENTH = 60 / BPM / 4;
const BEAT = 60 / BPM;
const LOOKAHEAD = 0.12;
const TICK_MS = 25;

/** Semitone offsets from A1 per sixteenth; null rests. The acid line. */
const BASS: Array<number | null> = [0, null, 12, 0, null, 0, 10, null, 0, null, 12, 7, null, 3, 0, 5];
const A1 = 55;

const MUTE_KEY = 'takk.muted';

function readMuted(): boolean {
  try {
    return globalThis.localStorage?.getItem(MUTE_KEY) === '1';
  } catch {
    return false;
  }
}

function writeMuted(value: boolean): void {
  try {
    globalThis.localStorage?.setItem(MUTE_KEY, value ? '1' : '0');
  } catch {
    // Private mode or blocked storage: the toggle still works for this session.
  }
}

export function createTechno(): Techno {
  let ctx: AudioContext | null = null;
  let master: GainNode | null = null;
  let music: GainNode | null = null;
  let sfxBus: GainNode | null = null;
  let noise: AudioBuffer | null = null;

  let level: Intensity = 0;
  let muted = readMuted();
  let step = 0;
  let nextTime = 0;
  let timer = 0;

  // Audio-clock times of scheduled kicks, oldest first, for the beat readout.
  const kicks: number[] = [];
  // Before audio exists the beat runs off the page clock at the same tempo.
  const pageEpoch = performance.now();

  const MASTER_LEVEL = 0.5;

  // ------------------------------------------------------------------ voices

  const env = (gain: GainNode, t: number, peak: number, attack: number, decay: number): void => {
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.exponentialRampToValueAtTime(peak, t + attack);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + attack + decay);
  };

  const noiseSource = (t: number, duration: number): AudioBufferSourceNode => {
    const src = ctx!.createBufferSource();
    src.buffer = noise;
    // Random offset so consecutive hats are not the identical waveform.
    src.start(t, Math.random() * 0.5, duration + 0.05);
    return src;
  };

  const kick = (t: number, out: AudioNode, peak = 1): void => {
    const osc = ctx!.createOscillator();
    const gain = ctx!.createGain();
    osc.frequency.setValueAtTime(160, t);
    osc.frequency.exponentialRampToValueAtTime(46, t + 0.11);
    env(gain, t, peak, 0.002, 0.34);
    osc.connect(gain).connect(out);
    osc.start(t);
    osc.stop(t + 0.4);
  };

  const hat = (t: number, open: boolean, peak: number): void => {
    const hp = ctx!.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = open ? 6500 : 8000;
    const gain = ctx!.createGain();
    const length = open ? 0.17 : 0.035;
    env(gain, t, peak, 0.001, length);
    noiseSource(t, length).connect(hp).connect(gain).connect(music!);
  };

  const clap = (t: number, peak: number): void => {
    const bp = ctx!.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = 1400;
    bp.Q.value = 0.9;
    const gain = ctx!.createGain();
    // Three quick hits then a tail: the classic drum-machine clap smear.
    gain.gain.setValueAtTime(0.0001, t);
    for (let i = 0; i < 3; i++) {
      gain.gain.exponentialRampToValueAtTime(peak, t + i * 0.011 + 0.001);
      gain.gain.exponentialRampToValueAtTime(peak * 0.2, t + i * 0.011 + 0.009);
    }
    gain.gain.exponentialRampToValueAtTime(peak * 0.7, t + 0.036);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.2);
    noiseSource(t, 0.22).connect(bp).connect(gain).connect(music!);
  };

  const bass = (t: number, semitone: number, accent: boolean): void => {
    const osc = ctx!.createOscillator();
    osc.type = 'sawtooth';
    osc.frequency.value = A1 * 2 ** (semitone / 12);
    const lp = ctx!.createBiquadFilter();
    lp.type = 'lowpass';
    // The level IS the filter: closed and round while waiting, open and
    // squelching when you hold the Core.
    const cutoff = [320, 650, 1500, 2300][level]!;
    const resonance = [2, 5, 13, 17][level]!;
    lp.Q.value = resonance;
    lp.frequency.setValueAtTime(cutoff * (accent ? 4 : 2.4), t);
    lp.frequency.exponentialRampToValueAtTime(cutoff, t + SIXTEENTH * 0.9);
    const gain = ctx!.createGain();
    env(gain, t, accent ? 0.3 : 0.2, 0.004, SIXTEENTH * 0.85);
    osc.connect(lp).connect(gain).connect(music!);
    osc.start(t);
    osc.stop(t + SIXTEENTH);
  };

  // ---------------------------------------------------------------- sequencer

  const schedule = (s: number, t: number): void => {
    const onBeat = s % 4 === 0;

    if (level >= 1 && onBeat) {
      kick(t, music!);
      kicks.push(t);
      if (kicks.length > 8) kicks.shift();
    }
    // Offbeat open hat from the start; it is the "waiting" groove on its own.
    if (s % 4 === 2) hat(t, true, level === 0 ? 0.08 : 0.14);
    if (level >= 2 && !onBeat) hat(t, false, s % 2 === 0 ? 0.09 : 0.05);
    if (level >= 1 && (s === 4 || s === 12)) clap(t, level >= 2 ? 0.5 : 0.35);
    // Final seconds: a clap roll on the last beat of the bar.
    if (level >= 3 && s >= 13) clap(t, 0.25);

    const note = BASS[s];
    if (note !== null && note !== undefined) bass(t, note, s % 8 === 2);
  };

  const pump = (): void => {
    if (!ctx) return;
    while (nextTime < ctx.currentTime + LOOKAHEAD) {
      schedule(step, nextTime);
      nextTime += SIXTEENTH;
      step = (step + 1) % 16;
    }
  };

  // ---------------------------------------------------------------- sfx helpers

  const blip = (t: number, freq: number, type: OscillatorType, peak: number, length: number): void => {
    const osc = ctx!.createOscillator();
    osc.type = type;
    osc.frequency.value = freq;
    const gain = ctx!.createGain();
    env(gain, t, peak, 0.003, length);
    osc.connect(gain).connect(sfxBus!);
    osc.start(t);
    osc.stop(t + length + 0.05);
  };

  const sweep = (t: number, from: number, to: number, length: number, peak: number): void => {
    const bp = ctx!.createBiquadFilter();
    bp.type = 'bandpass';
    bp.Q.value = 1.4;
    bp.frequency.setValueAtTime(from, t);
    bp.frequency.exponentialRampToValueAtTime(to, t + length);
    const gain = ctx!.createGain();
    env(gain, t, peak, 0.01, length);
    noiseSource(t, length).connect(bp).connect(gain).connect(sfxBus!);
  };

  const live = (): boolean => ctx !== null && ctx.state === 'running';

  return {
    start() {
      if (ctx) {
        void ctx.resume();
        return;
      }
      const AudioCtor = globalThis.AudioContext;
      if (!AudioCtor) return;
      ctx = new AudioCtor();

      // Master -> compressor glues the mix and keeps a stack of SFX on top of
      // the kick from clipping.
      const comp = ctx.createDynamicsCompressor();
      comp.threshold.value = -14;
      comp.ratio.value = 4;
      master = ctx.createGain();
      master.gain.value = muted ? 0 : MASTER_LEVEL;
      master.connect(comp).connect(ctx.destination);
      music = ctx.createGain();
      music.gain.value = 0.8;
      music.connect(master);
      sfxBus = ctx.createGain();
      sfxBus.gain.value = 0.9;
      sfxBus.connect(master);

      noise = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
      const data = noise.getChannelData(0);
      for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;

      nextTime = ctx.currentTime + 0.05;
      step = 0;
      timer = window.setInterval(pump, TICK_MS);
      void ctx.resume();
    },

    setIntensity(next) {
      level = next;
    },

    beat() {
      let since: number;
      if (live()) {
        const now = ctx!.currentTime;
        let last = -Infinity;
        for (const k of kicks) if (k <= now) last = k;
        // No kick yet (waiting level): fall back to the tempo grid so the
        // arena still breathes in time with the hats.
        since = last === -Infinity ? (now % BEAT) : now - last;
      } else {
        since = ((performance.now() - pageEpoch) / 1000) % BEAT;
      }
      return Math.exp(-since * 7);
    },

    toggleMute() {
      muted = !muted;
      writeMuted(muted);
      if (master && ctx) master.gain.setTargetAtTime(muted ? 0 : MASTER_LEVEL, ctx.currentTime, 0.02);
      return muted;
    },

    get muted() {
      return muted;
    },

    sfx: {
      dash() {
        if (!live()) return;
        sweep(ctx!.currentTime, 500, 4200, 0.2, 0.45);
      },
      take() {
        if (!live()) return;
        const t = ctx!.currentTime;
        kick(t, sfxBus!, 1.2);
        sweep(t, 6000, 900, 0.25, 0.5);
        [440, 660, 880, 1320].forEach((f, i) => blip(t + i * 0.045, f, 'square', 0.12, 0.09));
      },
      pickup() {
        if (!live()) return;
        const t = ctx!.currentTime;
        [523, 659, 784, 1047].forEach((f, i) => blip(t + i * 0.05, f, 'triangle', 0.25, 0.12));
      },
      lose() {
        if (!live()) return;
        const t = ctx!.currentTime;
        const osc = ctx!.createOscillator();
        osc.type = 'sawtooth';
        osc.frequency.setValueAtTime(330, t);
        osc.frequency.exponentialRampToValueAtTime(70, t + 0.4);
        const lp = ctx!.createBiquadFilter();
        lp.type = 'lowpass';
        lp.frequency.value = 1400;
        const gain = ctx!.createGain();
        env(gain, t, 0.35, 0.005, 0.42);
        osc.connect(lp).connect(gain).connect(sfxBus!);
        osc.start(t);
        osc.stop(t + 0.5);
      },
      land() {
        if (!live()) return;
        kick(ctx!.currentTime, sfxBus!, 0.35);
      },
      count(final) {
        if (!live()) return;
        const t = ctx!.currentTime;
        blip(t, final ? 1320 : 880, 'square', final ? 0.2 : 0.14, final ? 0.3 : 0.1);
        if (final) sweep(t, 8000, 1500, 0.4, 0.3);
      },
    },

    dispose() {
      clearInterval(timer);
      void ctx?.close();
    },
  };
}
