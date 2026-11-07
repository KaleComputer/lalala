import { soundOutput } from "./extras/soundVolume";

// Call sounds on the session's context (unlocked in the user's tap) into its destination, the replies'
// path, so echo cancellation hears them as ours: Presence's connect cue (shared/sounds.mjs) and a
// thinking pulse per sweep pass, panned with the light. Far under the close-talk bar, and no two
// partials 85-400 Hz apart, so the comb (voiceComb.ts) never takes them for a voice.

// presence/callwave.js `beads`: pos = ((t % speed) / speed) * 1.3 - 0.15, with t the seconds since the
// wave was made plus 1.3 and speed 1.6 s (3 s with reduced motion). voiceSounds.test.ts keeps these
// in step with the copy.
const SWEEP_PERIOD_S = 1.6;
const SWEEP_REDUCED_PERIOD_S = 3;
const SWEEP_T0_S = 1.3;
const SWEEP_FROM = -0.15;
const SWEEP_SPAN = 1.3;

const sweep = { originMs: Number.NaN, periodS: SWEEP_PERIOD_S, showing: false };

/** The bar made its wave now: the sweep's clock starts here. */
export function startSweepClock(reduced: boolean): void {
  sweep.originMs = performance.now();
  sweep.periodS = reduced ? SWEEP_REDUCED_PERIOD_S : SWEEP_PERIOD_S;
}

/** Whether the bar shows the thinking beads (the pulse plays only then). */
export function showSweep(showing: boolean): void {
  sweep.showing = showing;
}

/** The pass of the sweep under way at `nowMs`: its index and start (performance time). */
function currentPass(nowMs: number): { readonly index: number; readonly startMs: number } | null {
  if (!Number.isFinite(sweep.originMs)) return null;
  const periodMs = sweep.periodS * 1000;
  const zeroMs = sweep.originMs - SWEEP_T0_S * 1000;
  const index = Math.floor((nowMs - zeroMs) / periodMs);
  return { index, startMs: zeroMs + index * periodMs };
}

// The pulse is built this far ahead of its pass, more than a Bluetooth headset's output latency.
const PULSE_AHEAD_MS = 700;
// After the user's close voice the pulse waits this long, so it never lands in his pause. His turn ends
// only after more quiet than this, so thinking's first pulse is never held back by it.
const PULSE_AFTER_VOICE_MS = 1_500;
// the user, 3 Nov: "very subtle, very in the background, smooth ... a good loading state". One low pure
// sine (no noise, no harmonics) about 45 dB under full scale, swelling and fading on a raised cosine.
const PULSE_TONE_HZ = 220;
const PULSE_PEAK = 0.0055;
// Of the pass: the swell peaks here, then fades out by the time the light leaves the room.
const PULSE_PEAK_AT = 0.4;
const PULSE_CURVE_POINTS = 64;
// Silencing fades over a few of these, so a cut pulse never clicks.
const FADE_S = 0.04;
// A pulse joined mid-pass (thinking just began) fades in this fast from where the swell is.
const JOIN_FADE_S = 0.03;

type Part = {
  readonly f?: number;
  readonly f2?: number;
  readonly type?: OscillatorType;
  readonly at?: number;
  readonly dur?: number;
  readonly peak?: number;
  readonly band?: number;
  readonly q?: number;
  readonly noise?: boolean;
  readonly crush?: number;
};

// Presence's connect cue and its trim (sounds.mjs CUES.connect, CUE_GAIN 1.4, LEVELS.on 0.9).
const CONNECT: ReadonlyArray<Part> = [
  { noise: true, dur: 0.14, peak: 0.05, band: 2400, q: 0.8, crush: 6 },
  { f: 880, at: 0.13, dur: 0.14, peak: 0.06, type: "triangle" },
  { f: 1318.5, at: 0.22, dur: 0.2, peak: 0.05, type: "triangle" },
  { f: 2637, at: 0.22, dur: 0.12, peak: 0.008 },
];
const CONNECT_GAIN = 1.4 * 0.9;
// A context still starting (iOS, as the microphone opens) plays the cue once it runs, within this.
const LATE_CUE_MS = 2_000;

type Pulse = {
  readonly duck: GainNode;
  readonly sources: ReadonlyArray<AudioScheduledSourceNode>;
  readonly endsAt: number;
};

/** The swell at `x` (0..1) of the pass: 0 to its peak and back on raised cosines, no corner anywhere. */
function swellAt(x: number): number {
  const phase =
    x < PULSE_PEAK_AT ? x / PULSE_PEAK_AT : 1 + (x - PULSE_PEAK_AT) / (1 - PULSE_PEAK_AT);
  return PULSE_PEAK * (0.5 - 0.5 * Math.cos(Math.PI * phase));
}

/** The swell from `x0` of the pass to its end. */
const swellFrom = (x0: number) =>
  Float32Array.from({ length: PULSE_CURVE_POINTS }, (_, index) =>
    swellAt(x0 + ((1 - x0) * index) / (PULSE_CURVE_POINTS - 1)),
  );
const PULSE_CURVE = swellFrom(0);

export class VoiceSounds {
  private readonly out: GainNode;
  private pulses: Pulse[] = [];
  /** The sweep pass whose pulse is built, or -1. */
  private builtPass = -1;
  private closeVoiceAt = Number.NEGATIVE_INFINITY;

  constructor(private readonly context: AudioContext) {
    this.out = context.createGain();
    this.out.connect(soundOutput(context));
  }

  /** The call is live. */
  connected(): void {
    const context = this.context;
    if (context.state === "running") return this.cue(CONNECT, CONNECT_GAIN);
    const asked = performance.now();
    const onState = () => {
      if (context.state !== "running") return;
      context.removeEventListener("statechange", onState);
      if (performance.now() - asked <= LATE_CUE_MS) this.cue(CONNECT, CONNECT_GAIN);
    };
    context.addEventListener("statechange", onState);
    window.setTimeout(() => context.removeEventListener("statechange", onState), LATE_CUE_MS);
  }

  /**
   * Once per microphone frame: whether the pulse may sound (nothing but the sweep on screen, the user
   * quiet) and whether someone talks close to the mic now. Builds the next pass ahead; silences
   * everything at once when it may not.
   */
  step(allowed: boolean, closeVoice: boolean): void {
    const context = this.context;
    const now = performance.now();
    if (closeVoice) this.closeVoiceAt = now;
    this.pulses = this.pulses.filter((pulse) => pulse.endsAt > context.currentTime);
    if (!allowed || !sweep.showing || closeVoice || context.state !== "running") {
      this.silence();
      return;
    }
    if (now - this.closeVoiceAt < PULSE_AFTER_VOICE_MS) return;
    const pass = currentPass(now);
    if (pass === null) return;
    // The pass on screen joins at once, where its light is (thinking just began); each next one is
    // built ahead of its start.
    const index = this.builtPass < pass.index ? pass.index : pass.index + 1;
    if (index === this.builtPass) return;
    const startMs = pass.startMs + (index - pass.index) * sweep.periodS * 1000;
    if (startMs - now > PULSE_AHEAD_MS) return;
    this.builtPass = index;
    // Heard with the sweep: the output timestamp carries the output's latency.
    const stamp = context.getOutputTimestamp?.();
    const at =
      stamp?.contextTime !== undefined && stamp.performanceTime
        ? stamp.contextTime + (startMs - stamp.performanceTime) / 1000
        : context.currentTime + (startMs - now) / 1000 - (context.outputLatency || 0);
    this.pulse(at, sweep.periodS);
  }

  /** Every pulse fades out now; the next pass builds again once the pulse is allowed. */
  silence(): void {
    this.builtPass = -1;
    if (this.pulses.length === 0) return;
    const at = this.context.currentTime;
    for (const pulse of this.pulses) {
      pulse.duck.gain.setTargetAtTime(0, at, FADE_S);
      for (const source of pulse.sources) source.stop(at + 8 * FADE_S);
    }
    this.pulses = [];
  }

  /**
   * One pass starting at `at` (context time): a soft swell, gone as the light leaves, panned with it.
   * A pass already under way joins where it is, fading in from the swell's level there.
   */
  private pulse(at: number, periodS: number): void {
    const context = this.context;
    const enter = at + (periodS * -SWEEP_FROM) / SWEEP_SPAN;
    const exit = at + (periodS * (1 - SWEEP_FROM)) / SWEEP_SPAN;
    const from = Math.max(at, context.currentTime + 0.01);
    if (from >= exit - 0.05) return;
    const x0 = (from - at) / (exit - at);

    const tone = context.createOscillator();
    tone.frequency.value = PULSE_TONE_HZ;
    const env = context.createGain();
    env.gain.value = 0;
    env.gain.setValueCurveAtTime(x0 === 0 ? PULSE_CURVE : swellFrom(x0), from, exit - from);
    // Its own node, so silencing never has to cut into the curve (Safari has no cancelAndHold).
    const duck = context.createGain();
    if (x0 > 0) {
      duck.gain.setValueAtTime(0, from);
      duck.gain.setTargetAtTime(1, from, JOIN_FADE_S);
    }
    tone.connect(env).connect(duck);
    let last: AudioNode = duck;
    if (typeof context.createStereoPanner === "function") {
      const panner = context.createStereoPanner();
      // The light runs from pos 0 (the left end) to 1 (the divider): pan -1 to +1 with it.
      const pos = SWEEP_FROM + (SWEEP_SPAN * (from - at)) / periodS;
      panner.pan.setValueAtTime(Math.min(1, Math.max(-1, 2 * pos - 1)), from);
      if (from < enter) panner.pan.setValueAtTime(-1, enter);
      panner.pan.linearRampToValueAtTime(1, exit);
      duck.connect(panner);
      last = panner;
    }
    last.connect(this.out);
    tone.start(from);
    tone.stop(exit + 0.05);
    this.pulses.push({ duck, sources: [tone], endsAt: exit + 0.05 });
  }

  /** A short cue (Presence's notes and noise bursts), now. */
  private cue(parts: ReadonlyArray<Part>, gain: number): void {
    const context = this.context;
    const trim = context.createGain();
    trim.gain.value = gain;
    trim.connect(this.out);
    const t0 = context.currentTime;
    for (const part of parts) {
      const t = t0 + (part.at ?? 0);
      const dur = part.dur ?? 0.12;
      const peak = part.peak ?? 0.06;
      const g = context.createGain();
      let source: AudioScheduledSourceNode;
      let head: AudioNode;
      if (part.noise) {
        const length = Math.ceil(context.sampleRate * dur);
        const buffer = context.createBuffer(1, length, context.sampleRate);
        const data = buffer.getChannelData(0);
        let held = 0;
        for (let index = 0; index < length; index += 1) {
          if (!part.crush || index % part.crush === 0) held = Math.random() * 2 - 1;
          data[index] = held * (Math.random() > 0.15 ? 1 : 0);
        }
        const noise = context.createBufferSource();
        noise.buffer = buffer;
        g.gain.setValueAtTime(peak, t);
        source = noise;
        head = noise;
      } else {
        const oscillator = context.createOscillator();
        oscillator.type = part.type ?? "sine";
        oscillator.frequency.setValueAtTime(part.f ?? 440, t);
        if (part.f2) oscillator.frequency.exponentialRampToValueAtTime(part.f2, t + dur);
        g.gain.setValueAtTime(0.0001, t);
        g.gain.exponentialRampToValueAtTime(peak, t + 0.008);
        source = oscillator;
        head = oscillator;
      }
      g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
      if (part.band || part.noise) {
        const band = context.createBiquadFilter();
        band.type = "bandpass";
        band.frequency.value = part.band ?? 3000;
        band.Q.value = part.q ?? (part.noise ? 1 : 4);
        head.connect(band);
        head = band;
      }
      head.connect(g).connect(trim);
      source.start(t);
      source.stop(t + dur + 0.02);
    }
  }
}
