/**
 * Presence's voiced-sound check (presence/speech-constants.js): a voice is a comb of harmonics with a
 * pitch of 85 to 400 Hz; a footstep, a knock, traffic or wind is a few inharmonic modes or broadband
 * noise. Presence reads it on 1024 bins over 100 Hz to 8 kHz; the analyser here is resampled onto
 * those bins as Presence's mic.mjs `voiceRange` does.
 */
import { createSpeechGate } from "./presence/speech-constants";

const VOICE_LOW_HZ = 100;
const VOICE_HIGH_HZ = 8_000;
const PRESENCE_BINS = 1024;
// A window this long at most: a pitch that moves inside it smears the comb. Simulated, a voice
// gliding 20% per 100 ms (animated speech) read 0.42-0.66 on the old 128-171 ms windows, under the
// gate's 0.6, and 0.78-0.89 at 64-85 ms; steps, wind, a door, a plate stay under 0.5 on both.
const MAX_WINDOW_S = 0.1;

export class VoiceComb {
  readonly analyser: AnalyserNode;
  private readonly raw: Uint8Array<ArrayBuffer>;
  private readonly bins = new Uint8Array(PRESENCE_BINS);
  private readonly gate = createSpeechGate();
  private readonly hz: number;

  constructor(context: BaseAudioContext) {
    this.analyser = context.createAnalyser();
    const fftSize = 2 ** Math.floor(Math.log2(context.sampleRate * MAX_WINDOW_S));
    this.analyser.fftSize = Math.min(32_768, Math.max(1_024, fftSize));
    // Presence's MIC_ANALYSER smoothing: low, so an onset shows at once.
    this.analyser.smoothingTimeConstant = 0.35;
    this.raw = new Uint8Array(this.analyser.frequencyBinCount);
    this.hz = context.sampleRate / this.analyser.fftSize;
  }

  /** Whether a voice is sounding now (opens after ~80 ms of comb, lets go ~300 ms after it). */
  step(dtMs: number): boolean {
    this.analyser.getByteFrequencyData(this.raw);
    const raw = this.raw;
    const lo0 = Math.floor(VOICE_LOW_HZ / this.hz);
    const hi0 = Math.min(Math.ceil(VOICE_HIGH_HZ / this.hz), raw.length);
    const span = hi0 - lo0;
    for (let index = 0; index < PRESENCE_BINS; index += 1) {
      const position = (index / PRESENCE_BINS) * span;
      const lo = lo0 + Math.floor(position);
      const hi = Math.min(lo + 1, hi0 - 1);
      const fraction = position - Math.floor(position);
      this.bins[index] = Math.round((raw[lo] ?? 0) * (1 - fraction) + (raw[hi] ?? 0) * fraction);
    }
    this.gate.update(this.bins, dtMs / 1000);
    return this.gate.open;
  }
}
