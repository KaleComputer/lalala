/**
 * Speech-to-text in this browser: Parakeet (browserSpeech/) transcribes the utterance again as it
 * grows, for partials, and whole when it is committed. Silero VAD hears every mic frame: an utterance
 * it heard no speech in is never transcribed, and its run of speech tells Tim from noise and breath.
 */
import { openVad, releaseEars, startEars, transcribe } from "./browserSpeech/browser";

export const STT_SAMPLE_RATE = 16_000;
const VAD_WINDOW = 512;
const VAD_WINDOW_MS = (VAD_WINDOW / STT_SAMPLE_RATE) * 1000;
// Silero's own defaults: speech from 0.5 up, and it lasts until it falls under 0.35.
const SPEECH_ON = 0.5;
const SPEECH_OFF = 0.35;
// An utterance needs this much speech in it (~100 ms) to be transcribed at all.
const MIN_SPEECH_WINDOWS = 3;
// Speech heard just before an utterance began counts for it: its pre-roll carries that audio.
const PRE_ROLL_MS = 400;
// A partial for every this much more audio, while transcribing costs under this share of it in real
// time (WebGPU: ~100 ms for 5 s; single-thread WASM: ~1/3 of it, and partials would only queue).
const PARTIAL_EVERY_SAMPLES = STT_SAMPLE_RATE * 0.6;
const MAX_PARTIAL_LOAD = 0.25;
const PAUSE_PARTIAL_SAMPLES = STT_SAMPLE_RATE * 0.15;

function pcmOf(chunks: ReadonlyArray<Int16Array>, samples: number): Float32Array<ArrayBuffer> {
  const pcm = new Float32Array(samples);
  let at = 0;
  for (const chunk of chunks) for (const sample of chunk) pcm[at++] = sample / 0x8000;
  return pcm;
}

export class RealtimeStt {
  private utterance: Int16Array[] = [];
  private samples = 0;
  /** Bumped by discard and commit, so a partial of an earlier utterance is dropped. */
  private generation = 0;
  private vad: ReturnType<typeof openVad> | null = null;
  private window = new Float32Array(VAD_WINDOW);
  private filled = 0;
  private speechWindows = 0;
  private recentSpeech: number[] = [];
  private inSpeech = false;
  private speechRunMs = 0;
  private speechAt = Number.NEGATIVE_INFINITY;
  private partialAt = 0;
  private partialBusy = false;
  /** Transcribing time per audio time, from the last run. */
  private load = 0;
  private committing = 0;
  /** Interim text of the utterance so far. */
  onPartial: ((text: string) => void) | null = null;

  /** With the voice detector running, a transcript only ever comes from speech. */
  get speechOnly(): boolean {
    return this.vad?.ready() ?? false;
  }

  /** How long the voice detector has heard speech without a break, up to now (0 when not). */
  get voiceMs(): number {
    return this.inSpeech ? this.speechRunMs : 0;
  }

  /** The voice detector heard speech within `ms`. */
  voiceWithin(ms: number): boolean {
    return performance.now() - this.speechAt < ms;
  }

  /** A transcript is being made: a partial or a commit. */
  get busy(): boolean {
    return this.partialBusy || this.committing > 0;
  }

  /** Loads the models with the call, so the first utterance does not wait for them. */
  warm(): void {
    startEars();
    this.vad ??= openVad((probability) => this.onProbability(probability));
  }

  /** The call ended: the models and their memory go. */
  close(): void {
    this.discard();
    this.vad?.close();
    this.vad = null;
    this.inSpeech = false;
    releaseEars();
  }

  /** Every mic frame, in a turn or not: the voice detector keeps its state across them. */
  listen(chunk: Int16Array): void {
    const vad = this.vad;
    if (vad === null) return;
    for (const sample of chunk) {
      this.window[this.filled++] = sample / 0x8000;
      if (this.filled === VAD_WINDOW) {
        vad.listen(this.window);
        this.window = new Float32Array(VAD_WINDOW);
        this.filled = 0;
      }
    }
  }

  private onProbability(probability: number): void {
    const now = performance.now();
    if (probability >= SPEECH_ON || (this.inSpeech && probability >= SPEECH_OFF)) {
      this.speechRunMs = this.inSpeech ? this.speechRunMs + VAD_WINDOW_MS : VAD_WINDOW_MS;
      this.inSpeech = true;
      this.speechAt = now;
      if (this.samples > 0) this.speechWindows += 1;
      else this.recentSpeech = [...this.recentSpeech.filter((at) => now - at < PRE_ROLL_MS), now];
    } else {
      // A pause: his last words are read now, so the turn's end is decided on all of them.
      if (this.inSpeech && this.samples > 0) this.partial(PAUSE_PARTIAL_SAMPLES);
      this.inSpeech = false;
    }
  }

  push(chunk: Int16Array): void {
    if (this.samples === 0) {
      const now = performance.now();
      this.speechWindows = this.recentSpeech.filter((at) => now - at < PRE_ROLL_MS).length;
      this.recentSpeech = [];
    }
    this.utterance.push(chunk);
    this.samples += chunk.length;
    this.partial();
  }

  /** Drops the utterance in progress (it was noise or our own echo). */
  discard(): void {
    this.utterance = [];
    this.samples = 0;
    this.partialAt = 0;
    this.speechWindows = 0;
    this.generation += 1;
  }

  /** Whether the utterance so far has speech in it (always, while the detector is not running). */
  private heardSpeech(): boolean {
    return !this.speechOnly || this.speechWindows >= MIN_SPEECH_WINDOWS;
  }

  private partial(every = PARTIAL_EVERY_SAMPLES): void {
    if (this.partialBusy || this.load > MAX_PARTIAL_LOAD) return;
    if (this.samples - this.partialAt < every || !this.heardSpeech()) return;
    this.partialBusy = true;
    this.partialAt = this.samples;
    const generation = this.generation;
    const samples = this.samples;
    const started = performance.now();
    void transcribe(pcmOf(this.utterance, samples))
      .then((text) => {
        this.measure(started, samples);
        if (generation === this.generation && text.trim() !== "") this.onPartial?.(text.trim());
      })
      .catch(() => {})
      .finally(() => {
        this.partialBusy = false;
      });
  }

  private measure(started: number, samples: number): void {
    this.load = (performance.now() - started) / ((samples / STT_SAMPLE_RATE) * 1000);
  }

  /** Ends the utterance and resolves with its transcript, made from all of it at once. */
  async commit(): Promise<string> {
    const utterance = this.utterance;
    const samples = this.samples;
    const speech = this.heardSpeech();
    this.discard();
    if (samples === 0 || !speech) return "";
    this.committing += 1;
    const started = performance.now();
    try {
      const text = await transcribe(pcmOf(utterance, samples));
      this.measure(started, samples);
      return text.trim();
    } finally {
      this.committing -= 1;
    }
  }
}
