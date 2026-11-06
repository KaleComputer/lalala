import type { VoiceBarAnalysis, VoiceBarState } from "../../src/voice/presenceBar";

// The live demo on lalala.talk, all in the browser: Web Speech hears, Chrome's built-in model (or a small
// Qwen on WebGPU, or a few canned lines) answers, Kokoro speaks. Nothing loads before the user taps call.

const SYSTEM = `You are lalala, speaking in a live demo on the lalala.talk website. lalala is an open-source, voice-first canvas for coding agents. You talk to it; a brain thread answers out loud in a sentence or two and hands the real work to coding agents such as Claude Code and Codex, through harnesses like T3 Code, so it is always free to keep listening. Results show up as cards on an endless canvas: lists, comparisons, diagrams, small tools, even games. On a Mac, speech stays local: Parakeet transcribes and Kokoro speaks. This demo runs entirely in the visitor's browser. Answer in one or two short spoken sentences, plain words only, no markdown, no lists, no emoji.`;

const GREETING = "Hi, I'm lalala. Ask me anything.";

const CANNED: ReadonlyArray<readonly [RegExp, string]> = [
  [/\b(local|privat|privacy|cloud|server|offline)/i, "On a Mac your speech stays local: Parakeet listens and Kokoro speaks, right on your machine."],
  [/\b(agent|claude|codex|delegat|work|cod)/i, "I answer in a sentence and hand the real work to coding agents like Claude Code and Codex, so I can keep listening."],
  [/\b(canvas|card|draw|diagram|game)/i, "Anything worth looking at lands as a card on an endless canvas, from lists and diagrams to little tools and games."],
  [/\b(open|source|github|free|pric|cost|licen)/i, "lalala is open source under the MIT license, and it uses the agent subscriptions you already have."],
  [/\b(install|start|try|download|mac|set ?up)/i, "Grab it from GitHub, connect it to a harness like T3 Code, and start talking."],
  [/\b(who|what|lalala|you)\b/i, "I'm lalala, a voice-first canvas for coding agents. You talk, I answer out loud, and agents do the work."],
];
const FALLBACK = "I'm only a small demo here, but the real lalala hands questions like that to your coding agents.";

const VOICE = "af_heart";
const FIRST_SENTENCE_MS = 20_000;
const TTS_MODEL = "onnx-community/Kokoro-82M-v1.0-ONNX";
const QWEN_MODEL = "onnx-community/Qwen2.5-0.5B-Instruct";

type Brain = { readonly name: string; reply(text: string, onSentence: (sentence: string) => void): Promise<void> };

type Progress = { status: string; file?: string; loaded?: number; total?: number };

/** Download progress over many files, as one fraction. */
function progressOf(label: string, report: (message: string) => void) {
  const files = new Map<string, { loaded: number; total: number }>();
  return (info: Progress) => {
    if (info.status !== "progress" || !info.file || !info.total) return;
    files.set(info.file, { loaded: info.loaded ?? 0, total: info.total });
    let loaded = 0;
    let total = 0;
    for (const file of files.values()) {
      loaded += file.loaded;
      total += file.total;
    }
    report(`${label} ${Math.floor((loaded / total) * 100)}%`);
  };
}

/** Splits streamed text into whole sentences as they complete. */
function sentenceSplitter(onSentence: (sentence: string) => void) {
  let buffer = "";
  return {
    push(chunk: string) {
      buffer += chunk;
      let match: RegExpMatchArray | null;
      while ((match = buffer.match(/^([\s\S]*?[.!?])(\s+)/)) !== null) {
        const sentence = match[1].trim();
        buffer = buffer.slice(match[0].length);
        if (sentence) onSentence(sentence);
      }
    },
    end() {
      const rest = buffer.trim();
      buffer = "";
      if (rest) onSentence(rest);
    },
  };
}

const clean = (text: string) => text.replace(/[*_#`>|~]/g, "").replace(/\s+/g, " ").trim();

type ChromeModel = {
  availability(options?: object): Promise<string>;
  create(options?: object): Promise<{ promptStreaming(text: string): ReadableStream<string> & AsyncIterable<string> }>;
};

async function chromeBrain(): Promise<Brain | null> {
  const api = (globalThis as { LanguageModel?: ChromeModel }).LanguageModel;
  if (!api) return null;
  const options = {
    expectedInputs: [{ type: "text", languages: ["en"] }],
    expectedOutputs: [{ type: "text", languages: ["en"] }],
  };
  // Only a model already on the device: a first download is gigabytes, too much for a demo tap.
  if ((await api.availability(options).catch(() => "unavailable")) !== "available") return null;
  const session = await api.create({
    ...options,
    initialPrompts: [{ role: "system", content: SYSTEM }],
  });
  return {
    name: "Gemini Nano",
    async reply(text, onSentence) {
      const split = sentenceSplitter((sentence) => onSentence(clean(sentence)));
      // Chrome streams deltas today; older builds streamed the whole text so far.
      let previous = "";
      for await (const chunk of session.promptStreaming(text)) {
        // Chromium without the model ships an echo stub.
        if (chunk.startsWith("On-device model is not available")) throw new Error("no model");
        const delta = chunk.startsWith(previous) && previous.length > 0 ? chunk.slice(previous.length) : chunk;
        previous = chunk.startsWith(previous) ? chunk : previous + chunk;
        split.push(delta);
      }
      split.end();
    },
  };
}

async function qwenBrain(report: (message: string) => void): Promise<Brain> {
  const { pipeline, TextStreamer } = await import("@huggingface/transformers");
  const generator = await pipeline("text-generation", QWEN_MODEL, {
    dtype: "q4f16",
    device: "webgpu",
    progress_callback: progressOf("qwen", report),
  });
  const history: Array<{ role: string; content: string }> = [{ role: "system", content: SYSTEM }];
  return {
    name: "Qwen 2.5 0.5B",
    async reply(text, onSentence) {
      history.push({ role: "user", content: text });
      let said = "";
      const split = sentenceSplitter((sentence) => onSentence(clean(sentence)));
      const streamer = new TextStreamer(generator.tokenizer, {
        skip_prompt: true,
        skip_special_tokens: true,
        callback_function: (chunk: string) => {
          said += chunk;
          split.push(chunk);
        },
      });
      await generator(history, { max_new_tokens: 90, do_sample: false, streamer });
      split.end();
      history.push({ role: "assistant", content: said });
      // Keep the prompt short: the system line and the last few turns.
      if (history.length > 9) history.splice(1, 2);
    },
  };
}

const cannedBrain: Brain = {
  name: "canned answers",
  async reply(text, onSentence) {
    onSentence(CANNED.find(([pattern]) => pattern.test(text))?.[1] ?? FALLBACK);
  },
};

type Recognition = EventTarget & {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  start(): void;
  stop(): void;
  abort(): void;
  onresult: ((event: { results: ArrayLike<ArrayLike<{ transcript: string }> & { isFinal: boolean }> }) => void) | null;
  onend: (() => void) | null;
  onerror: ((event: { error: string }) => void) | null;
};

const recognitionClass = () =>
  (globalThis as { SpeechRecognition?: new () => Recognition; webkitSpeechRecognition?: new () => Recognition })
    .SpeechRecognition ??
  (globalThis as { webkitSpeechRecognition?: new () => Recognition }).webkitSpeechRecognition ??
  null;

export const canHear = () => recognitionClass() !== null;

export type DemoView = { readonly state: VoiceBarState; readonly message: string | null };

/** One call: mic, ears, brain and voice, from the tap that starts it to the tap that ends it. */
export class VoiceDemo {
  private context: AudioContext | null = null;
  private stream: MediaStream | null = null;
  private input: AnalyserNode | null = null;
  private output: AnalyserNode | null = null;
  private recognition: Recognition | null = null;
  private brain: Brain | null = null;
  private tts: { generate(text: string, options: { voice: string }): Promise<{ audio: Float32Array; sampling_rate: number }> } | null = null;
  private ended = false;
  private muted = false;
  private lastSource: Promise<void> = Promise.resolve();
  private playEnd = 0;
  private busy = false;
  private readonly spectrum = {
    input: new Uint8Array(1024),
    output: new Uint8Array(1024),
    inputWave: new Float32Array(2048),
    outputWave: new Float32Array(2048),
    rate: 48_000,
  };

  constructor(private readonly show: (view: DemoView) => void) {}

  async start() {
    this.show({ state: "connecting", message: "opening the mic" });
    // Made in the tap, so the browser lets it play.
    const context = new AudioContext();
    this.context = context;
    this.output = context.createAnalyser();
    this.output.fftSize = 2048;
    this.output.connect(context.destination);
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true },
      });
      this.input = context.createAnalyser();
      this.input.fftSize = 2048;
      context.createMediaStreamSource(this.stream).connect(this.input);
    } catch {
      // No mic: the call still talks, and the input tab takes typing.
    }
    if (this.ended) return;
    const report = (message: string) => !this.ended && this.show({ state: "connecting", message });
    const webgpu = "gpu" in navigator && (await (navigator as { gpu: { requestAdapter(): Promise<unknown> } }).gpu.requestAdapter().catch(() => null)) !== null;
    const phone = window.matchMedia("(pointer: coarse)").matches;
    try {
      report("loading the voice");
      const { KokoroTTS } = await import("kokoro-js");
      // WebGPU wants the full-precision model; the small quantized one runs on WASM and suits phones.
      const gpu = webgpu && !phone;
      this.tts = (await KokoroTTS.from_pretrained(TTS_MODEL, {
        dtype: gpu ? "fp32" : "q8",
        device: gpu ? "webgpu" : "wasm",
        progress_callback: progressOf("voice", report),
      })) as unknown as VoiceDemo["tts"];
      if (this.ended) return;
      report("waking the brain");
      this.brain =
        (await chromeBrain().catch(() => null)) ??
        (webgpu && !phone ? await qwenBrain(report).catch(() => null) : null) ??
        cannedBrain;
    } catch (error) {
      if (this.ended) return;
      console.error(error);
      this.show({ state: "error", message: "this browser could not load the voice" });
      return;
    }
    if (this.ended) return;
    await this.say([GREETING], `brain: ${this.brain.name}`);
    this.listen();
  }

  stop() {
    this.ended = true;
    this.recognition?.abort();
    this.recognition = null;
    for (const track of this.stream?.getTracks() ?? []) track.stop();
    void this.context?.close().catch(() => {});
    this.context = null;
    this.input = null;
    this.output = null;
  }

  setMuted(muted: boolean) {
    this.muted = muted;
    for (const track of this.stream?.getAudioTracks() ?? []) track.enabled = !muted;
    if (muted) this.recognition?.abort();
    else if (!this.busy) this.listen();
  }

  /** Something typed in the input tab: answered like something said. */
  ask(text: string) {
    const said = text.trim();
    if (!said || this.ended || this.brain === null || this.busy) return;
    this.recognition?.abort();
    void this.answer(said);
  }

  analysis(): VoiceBarAnalysis | null {
    const context = this.context;
    if (context === null || this.output === null) return null;
    const spectrum = this.spectrum;
    spectrum.rate = context.sampleRate;
    let micLevel = 0;
    if (this.input !== null && !this.muted) {
      this.input.getByteFrequencyData(spectrum.input);
      this.input.getFloatTimeDomainData(spectrum.inputWave);
      micLevel = rms(spectrum.inputWave);
    } else {
      spectrum.input.fill(0);
      spectrum.inputWave.fill(0);
    }
    this.output.getByteFrequencyData(spectrum.output);
    this.output.getFloatTimeDomainData(spectrum.outputWave);
    return {
      levels: { input: Math.min(1, micLevel * 3), output: Math.min(1, rms(spectrum.outputWave) * 3) },
      spectrum,
    };
  }

  private listen() {
    if (this.ended || this.muted) return;
    const Recognition = recognitionClass();
    if (Recognition === null) {
      this.show({ state: "listening", message: "no speech recognition here: type in the input tab" });
      return;
    }
    const recognition = new Recognition();
    this.recognition = recognition;
    recognition.lang = "en-US";
    recognition.continuous = false;
    recognition.interimResults = true;
    let heard = "";
    let final = false;
    this.show({ state: "listening", message: null });
    recognition.onresult = (event) => {
      heard = Array.from(event.results, (result) => result[0]?.transcript ?? "").join("");
      final = Array.from(event.results).every((result) => result.isFinal);
      this.show({ state: "hearing", message: heard || null });
    };
    let broken = false;
    recognition.onerror = (event) => {
      if (event.error === "no-speech" || event.error === "aborted") return;
      broken = true;
      this.show({ state: "listening", message: "speech recognition is off here: type in the input tab" });
    };
    recognition.onend = () => {
      if (this.recognition !== recognition) return;
      this.recognition = null;
      if (this.ended || this.muted || this.busy || broken) return;
      if (heard.trim() && (final || heard.trim().length > 1)) void this.answer(heard.trim());
      else this.listen();
    };
    try {
      recognition.start();
    } catch {
      this.show({ state: "listening", message: "type in the input tab" });
    }
  }

  private async answer(text: string) {
    const brain = this.brain;
    if (brain === null) return;
    this.busy = true;
    this.show({ state: "thinking", message: text });
    const sentences: string[] = [];
    let wake: (() => void) | null = null;
    let done = false;
    // A brain that fails or stalls before its first sentence hands the turn to the canned lines.
    let first = false;
    let dropped = false;
    const push = (sentence: string) => {
      first = true;
      sentences.push(sentence);
      wake?.();
    };
    const fallback = () => {
      dropped = true;
      return first ? undefined : cannedBrain.reply(text, push);
    };
    const thinking = Promise.race([
      brain.reply(text, (sentence) => !dropped && push(sentence)),
      new Promise<never>((_, reject) => setTimeout(() => !first && reject(new Error("stalled")), FIRST_SENTENCE_MS)),
    ])
      .catch(fallback)
      .finally(() => {
        done = true;
        wake?.();
      });
    // Speak each sentence as soon as the brain finishes it.
    const queue = (async function* () {
      let at = 0;
      while (true) {
        if (at < sentences.length) yield sentences[at++];
        else if (done) return;
        else await new Promise<void>((resolve) => (wake = resolve));
      }
    })();
    await this.say(queue);
    await thinking;
    this.busy = false;
    this.listen();
  }

  private async say(sentences: Iterable<string> | AsyncIterable<string>, note: string | null = null) {
    const context = this.context;
    if (context === null || this.tts === null) return;
    if (context.state !== "running") await context.resume().catch(() => {});
    for await (const sentence of sentences) {
      if (this.ended || !sentence) return;
      const audio = await this.tts.generate(sentence, { voice: VOICE });
      if (this.ended || this.context === null || this.output === null) return;
      const buffer = context.createBuffer(1, audio.audio.length, audio.sampling_rate);
      buffer.copyToChannel(audio.audio as Float32Array<ArrayBuffer>, 0);
      const source = context.createBufferSource();
      source.buffer = buffer;
      source.connect(this.output);
      const at = Math.max(context.currentTime + 0.05, this.playEnd);
      source.start(at);
      this.playEnd = at + buffer.duration;
      this.lastSource = new Promise((resolve) => (source.onended = () => resolve()));
      this.show({ state: "speaking", message: note ?? sentence });
    }
    // The last sentence ends before listening again, so the recognizer never hears the reply.
    await this.lastSource;
  }
}

function rms(samples: Float32Array) {
  let sum = 0;
  for (const sample of samples) sum += sample * sample;
  return Math.sqrt(sum / samples.length);
}
