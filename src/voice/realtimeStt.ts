/**
 * Speech-to-text in this browser: Parakeet (browserSpeech/) transcribes the utterance again as it
 * grows, for partials, and whole when it is committed, in pieces of at most 20 s (sttPieces.ts): a
 * piece is transcribed once when it is cut, and only the rest after it again. Silero VAD hears every
 * mic frame: an utterance it heard no speech in is never transcribed, and its run of speech tells Tim
 * from noise and breath.
 */
import { openVad, startEars, transcribe } from "./browserSpeech/browser";
import { type Heard, PIECE_MAX, cutPiece, joinPieces } from "./sttPieces";

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

function pcmOf(audio: Int16Array, start: number, end: number): Float32Array<ArrayBuffer> {
  const pcm = new Float32Array(end - start);
  for (let i = start; i < end; i += 1) pcm[i - start] = audio[i]! / 0x8000;
  return pcm;
}

/** The utterance's pieces cut so far, each being transcribed, and where the rest of it starts. */
type Pieces = { starts: number[]; ends: number[]; heard: Promise<Heard>[]; rest: number };
const noPieces = (): Pieces => ({ starts: [], ends: [], heard: [], rest: 0 });

export class RealtimeStt {
  private utterance = new Int16Array(STT_SAMPLE_RATE * 4);
  private samples = 0;
  private pieces = noPieces();
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

  /** The call ended: Parakeet stays loaded for the next call (browserSpeech/browser.ts). */
  close(): void {
    this.discard();
    this.vad?.close();
    this.vad = null;
    this.inSpeech = false;
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
    if (this.samples + chunk.length > this.utterance.length) {
      const grown = new Int16Array(Math.max(this.utterance.length * 2, this.samples + chunk.length));
      grown.set(this.utterance.subarray(0, this.samples));
      this.utterance = grown;
    }
    this.utterance.set(chunk, this.samples);
    this.samples += chunk.length;
    while (this.samples - this.pieces.rest >= PIECE_MAX) this.cut();
    this.partial();
  }

  /** Drops the utterance in progress (it was noise or our own echo). */
  discard(): void {
    this.utterance = new Int16Array(STT_SAMPLE_RATE * 4);
    this.samples = 0;
    this.pieces = noPieces();
    this.partialAt = 0;
    this.speechWindows = 0;
    this.generation += 1;
  }

  /** Whether the utterance so far has speech in it (always, while the detector is not running). */
  private heardSpeech(): boolean {
    return !this.speechOnly || this.speechWindows >= MIN_SPEECH_WINDOWS;
  }

  /** Cuts the next piece off the rest and starts transcribing it. */
  private cut(): void {
    const pieces = this.pieces;
    const audio = this.utterance;
    const { end, next } = cutPiece((i) => audio[i]! / 0x8000, pieces.rest);
    const heard = transcribe(pcmOf(audio, pieces.rest, end));
    heard.catch(() => {});
    pieces.starts.push(pieces.rest);
    pieces.ends.push(end);
    pieces.heard.push(heard);
    pieces.rest = next;
  }

  /**
   * The pieces' transcripts and the rest's, joined. The load is the rest's own: the worker takes it
   * after the pieces before it.
   */
  private async heardAll(): Promise<string> {
    const { starts, ends, heard, rest } = this.pieces;
    const samples = this.samples;
    const asked = performance.now();
    const [{ each, at }, last] = await Promise.all([
      Promise.all(heard).then((each) => ({ each, at: performance.now() })),
      transcribe(pcmOf(this.utterance, rest, samples)),
    ]);
    this.load = (performance.now() - Math.max(asked, at)) / ((Math.max(1, samples - rest) / STT_SAMPLE_RATE) * 1000);
    return joinPieces([...each, last], [...starts, rest], [...ends, samples]);
  }

  private partial(every = PARTIAL_EVERY_SAMPLES): void {
    if (this.partialBusy || this.load > MAX_PARTIAL_LOAD) return;
    if (this.samples - this.partialAt < every || !this.heardSpeech()) return;
    this.partialBusy = true;
    this.partialAt = this.samples;
    const generation = this.generation;
    void this.heardAll()
      .then((text) => {
        if (generation === this.generation && text.trim() !== "") this.onPartial?.(text.trim());
      })
      .catch(() => {})
      .finally(() => {
        this.partialBusy = false;
      });
  }

  /** Ends the utterance and resolves with its transcript: its pieces' and the rest's, joined. */
  async commit(): Promise<string> {
    const heard = this.samples > 0 && this.heardSpeech() ? this.heardAll() : null;
    this.discard();
    if (heard === null) return "";
    this.committing += 1;
    try {
      return (await heard).trim();
    } finally {
      this.committing -= 1;
    }
  }
}
