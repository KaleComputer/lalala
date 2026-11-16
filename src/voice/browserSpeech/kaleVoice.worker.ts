// Kale's small voices (61 MB each: Kokoro's text side with Kale's own small decoder): the storyteller
// (Automatic) and kale-tts-1-tiny (Hazel's voice), one per worker, named by the load message. They run
// through Transformers.js the way kokoro-js runs Kokoro (StyleTextToSpeech2Model and its tokenizer),
// from the model folders lalala serves (public/models/<model>, which load the same way from any host).
// Transformers.js reports load and run errors; only the words come from Kale's own front end
// (matcha/kaleTts.js, as the warm voice). Credits: NOTICE.md.
import { G2p, G2pModel, normalizer, readTable } from "./matcha/kaleTts.js";
import { termsReplacer } from "./terms";

const TRANSFORMERS = "https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.8.1/dist/transformers.min.js";
const RATE = 24_000;
const STYLE = 256;
// Kokoro reads at most 512 ids, its two pads included.
const MAX_IDS = 510;
const PIECE_GAP_S = 0.06;
const PEAK = 0.95;
type FrontEndFiles = { g2pModel: string; lexicon: string; override: string; terms: string };
/**
 * Pronunciation front ends by accent tag: each voice's "accent" in its model's voices.json picks one,
 * as in the release's JS API. British English (en-gb, the d03 and d13 voices) plugs in here when the
 * british-16nov front end ships; until then its voices use en-us, said once in the log.
 */
const FRONT_ENDS: Record<string, FrontEndFiles | null> = {
  "en-us": {
    g2pModel: new URL("./matcha/g2p.bin", import.meta.url).href,
    lexicon: new URL("./matcha/lexicon.tsv", import.meta.url).href,
    override: new URL("./matcha/override.tsv", import.meta.url).href,
    terms: new URL("./matcha/terms.tsv", import.meta.url).href,
  },
  "en-gb": null,
};
type FrontEnd = {
  readonly accent: string;
  readonly g2p: G2p;
  readonly normalize: (text: string) => string;
};
const frontEnds = new Map<string, Promise<FrontEnd>>();
/** The front end for a voice's accent, built once per accent and kept. */
function frontEndFor(accent: string): Promise<FrontEnd> {
  const used = FRONT_ENDS[accent] ? accent : "en-us";
  if (used !== accent) postMessage({ type: "stage", stage: "frontend", accent, used });
  let built = frontEnds.get(used);
  if (!built) {
    const files = FRONT_ENDS[used]!;
    built = Promise.all([
      fetch(files.g2pModel).then((response) => response.arrayBuffer()),
      fetch(files.lexicon).then((response) => response.text()),
      fetch(files.override).then((response) => response.text()),
      fetch(files.terms).then((response) => response.text()),
    ]).then(([g2pModel, lexicon, override, terms]) => {
      const lex = readTable(lexicon);
      readTable(override, lex);
      return {
        accent: used,
        g2p: new G2p(lex, new G2pModel(g2pModel)),
        normalize: spokenWith(normalizer(lex), termsReplacer(terms)),
      };
    });
    frontEnds.set(used, built);
  }
  return built;
}

type Tensor = { readonly data: Float32Array; readonly dims: ReadonlyArray<number> };
type Transformers = {
  env: {
    allowLocalModels: boolean;
    allowRemoteModels: boolean;
    localModelPath: string;
    backends: { onnx: { wasm: { numThreads: number } } };
    version?: string;
  };
  StyleTextToSpeech2Model: {
    from_pretrained(
      id: string,
      options: object,
    ): Promise<((inputs: object) => Promise<{ waveform: Tensor }>) & { dispose(): Promise<unknown> }>;
  };
  AutoTokenizer: {
    from_pretrained(id: string, options?: object): Promise<(text: string, options?: object) => { input_ids: Tensor }>;
  };
  Tensor: new (type: string, data: Float32Array, dims: number[]) => unknown;
};
type Voice = {
  readonly hf: Transformers;
  readonly model: ((inputs: object) => Promise<{ waveform: Tensor }>) & { dispose(): Promise<unknown> };
  readonly tokenize: (text: string, options?: object) => { input_ids: Tensor };
  readonly name: string;
  readonly speed: number;
  /** Swapped by a "voice" message: another voice of the same model, no second copy of it. */
  voicepack: Float32Array;
  /** A model with all its voices in one graph takes a voice's own constants as inputs (voice_inputs.json). */
  extra: Record<string, unknown>;
  readonly voiceInputs: ReadonlyArray<{ readonly name: string; readonly dims: number[] }>;
  /** The front end of the voice's accent; a voice switch can change it. */
  frontEnd: FrontEnd;
  /** Each voice's accent tag from the model's voices.json (en-us when it has none). */
  readonly accents: Readonly<Record<string, string>>;
};
type Message = {
  type: string;
  id?: number;
  text?: string;
  device?: string;
  model?: string;
  voice?: string;
  threads?: number;
  speed?: number;
  /** The model's own bytes (settingsStore's SMALL_VOICES), for the download bar. */
  expected?: number;
};

let voice: Promise<Voice> | null = null;
let queue: Promise<unknown> = Promise.resolve();

async function load(
  device: string,
  name: string,
  voiceFile: string,
  speed: number,
  expected: number,
  threads?: number,
): Promise<Voice> {
  const hf = (await import(/* @vite-ignore */ TRANSFORMERS)) as Transformers;
  // Its runtime takes half the cores by default: 2 on Tim's iPhone, 4.8x real time against 7.3x
  // with all 4 (15 Nov). Every core, up to 4, as the direct runtime had.
  hf.env.backends.onnx.wasm.numThreads =
    threads ?? (self.crossOriginIsolated ? Math.min(4, navigator.hardwareConcurrency || 4) : 1);
  // Only lalala's own copy of the model, never a download from the Hub.
  hf.env.allowLocalModels = true;
  hf.env.allowRemoteModels = false;
  // A path, not a URL: Transformers.js only looks a full URL up remotely.
  hf.env.localModelPath = "/models/";
  const cached = await caches
    .open("transformers-cache")
    .then((cache) => cache.match(new URL(`/models/${name}/onnx/model.onnx`, self.location.origin).href))
    .then((hit) => hit !== undefined)
    .catch(() => false);
  postMessage({ type: "load", name, expected, cached });
  const files = new Map<string, { loaded: number; total: number }>();
  const progress = (info: { status?: string; file?: string; loaded?: number; total?: number }) => {
    if (info.status !== "progress" || !info.file || !info.total) return;
    files.set(info.file, { loaded: info.loaded ?? 0, total: info.total });
    let loaded = 0;
    for (const file of files.values()) loaded += file.loaded;
    postMessage({ type: "progress", loaded, total: Math.max(expected, loaded) });
  };
  const voiceInputs = await fetch(`${hf.env.localModelPath}${name}/voice_inputs.json`)
    .then((response) => (response.ok ? (response.json() as Promise<Voice["voiceInputs"]>) : []))
    .catch(() => []);
  const accents = await fetch(`${hf.env.localModelPath}${name}/voices.json`)
    .then((response) => (response.ok ? (response.json() as Promise<{ voices?: { id: string; accent?: string }[] }>) : {}))
    .then((list) => Object.fromEntries((list.voices ?? []).map((entry) => [entry.id, entry.accent ?? "en-us"])))
    .catch(() => ({}) as Record<string, string>);
  const [model, tokenize, [voicepack, extra], frontEnd] = await Promise.all([
    hf.StyleTextToSpeech2Model.from_pretrained(name, {
      dtype: "fp32",
      device,
      progress_callback: progress,
      // As the bench run that held on Tim's iPhone (15 Nov) and the warm voice: the optimizer's 32-bit
      // copies of the 16-bit text side cost a phone ~150 MB (WebKit) for ~5 % speed.
      session_options: { graphOptimizationLevel: "disabled" },
    }),
    hf.AutoTokenizer.from_pretrained(name),
    voiceFiles(hf, name, voiceFile, voiceInputs),
    frontEndFor(accents[voiceFile] ?? "en-us"),
  ]);
  const onnx = hf.env.backends.onnx as { wasm: { numThreads: number }; versions?: { web?: string } };
  postMessage({
    type: "stage",
    stage: "backend",
    device,
    threads: onnx.wasm.numThreads,
    ort: onnx.versions?.web ?? null,
    transformers: hf.env.version ?? null,
  });
  const ready: Voice = {
    hf,
    model,
    name,
    speed,
    tokenize,
    voicepack,
    extra,
    voiceInputs,
    frontEnd,
    accents,
  };
  await speak(ready, "Hi.");
  postMessage({ type: "ready" });
  return ready;
}

/** Technical terms as they are spoken (terms.tsv), then the text rules. */
const spokenWith =
  (rules: (text: string) => string, terms: (text: string) => string) => (text: string) =>
    rules(terms(text));

/** IPA in pieces Kokoro can read at once, cut at spaces (a sentence that long is rare). */
function pieces(ipa: string): string[] {
  const out: string[] = [];
  let rest = [...ipa];
  while (rest.length > MAX_IDS) {
    let cut = rest.lastIndexOf(" ", MAX_IDS);
    if (cut <= 0) cut = MAX_IDS;
    out.push(rest.slice(0, cut).join(""));
    rest = rest.slice(cut + 1);
  }
  out.push(rest.join(""));
  return out;
}

/** A voice's style table and, for a model holding several voices in one graph, its own constants. */
async function voiceFiles(
  hf: Transformers,
  name: string,
  voiceFile: string,
  voiceInputs: Voice["voiceInputs"],
): Promise<[Float32Array, Record<string, unknown>]> {
  const base = `/models/${name}/voices/${voiceFile}`;
  const read = (url: string) =>
    fetch(url).then((response) => {
      if (!response.ok) throw new Error(`${url}: ${response.status}`);
      return response.arrayBuffer();
    });
  const [pack, constants] = await Promise.all([
    read(`${base}.bin`),
    voiceInputs.length > 0 ? read(`${base}.extra.bin`) : Promise.resolve(new ArrayBuffer(0)),
  ]);
  const values = new Float32Array(constants);
  const extra: Record<string, unknown> = {};
  let at = 0;
  for (const input of voiceInputs) {
    const size = input.dims.reduce((product, dim) => product * dim, 1);
    extra[input.name] = new hf.Tensor("float32", values.slice(at, at + size), input.dims);
    at += size;
  }
  return [new Float32Array(pack), extra];
}

/** One IPA piece through the model, as kokoro-js's generate_from_ids: its tokens pick the style row. */
async function render(ready: Voice, ipa: string): Promise<Float32Array> {
  const { input_ids } = ready.tokenize(ipa, { truncation: true });
  const n = input_ids.dims.at(-1)! - 2;
  if (n <= 0) return new Float32Array(0);
  const row = Math.min(n, ready.voicepack.length / STYLE) - 1;
  const { waveform } = await ready.model({
    input_ids,
    style: new ready.hf.Tensor("float32", ready.voicepack.slice(row * STYLE, (row + 1) * STYLE), [1, STYLE]),
    speed: new ready.hf.Tensor("float32", Float32Array.from([ready.speed]), [1]),
    ...ready.extra,
  });
  return waveform.data;
}

/** A sentence (the player sends one at a time) as 24 kHz PCM. */
async function speak(ready: Voice, raw: string) {
  const started = performance.now();
  const ipa = ready.frontEnd.g2p.phonemes(ready.frontEnd.normalize(raw));
  const g2pMs = performance.now() - started;
  const parts: Float32Array[] = [];
  for (const piece of pieces(ipa)) {
    if (parts.length > 0) parts.push(new Float32Array(Math.round(PIECE_GAP_S * RATE)));
    parts.push(await render(ready, piece));
  }
  const samples = new Float32Array(parts.reduce((sum, part) => sum + part.length, 0));
  let at = 0;
  for (const part of parts) {
    samples.set(part, at);
    at += part.length;
  }
  // The storyteller's peaks reach ~0.98: brought under the warm voice's 0.95, never louder.
  let peak = 0;
  for (const sample of samples) peak = Math.max(peak, Math.abs(sample));
  if (peak > PEAK) for (let i = 0; i < samples.length; i++) samples[i] = (samples[i]! * PEAK) / peak;
  return { samples, timing: { g2pMs, modelMs: performance.now() - started - g2pMs } };
}

let device = "wasm";
let threads: number | undefined;
const start = (message: Message) => {
  voice = load(
    device,
    message.model ?? "kale-tts-1-nano",
    message.voice ?? "v7",
    message.speed ?? 1,
    message.expected ?? 0,
    threads,
  );
  voice.catch((error: unknown) => postMessage({ type: "failed", message: String(error) }));
};

self.onmessage = (event: MessageEvent<Message>) => {
  const message = event.data;
  if (voice === null) {
    device = message.device ?? "wasm";
    threads = message.threads;
    start(message);
    if (message.type === "load") return;
  }
  // Another model: its session is freed before the next loads into the memory it leaves, so this
  // worker never holds two (a second copy is what iOS ends a tab for, 15 Nov).
  if (message.type === "model") {
    queue = queue.then(async () => {
      try {
        const old = await voice!.catch(() => null);
        if (old?.name !== message.model) {
          await old?.model.dispose();
          start(message);
          await voice;
        }
        postMessage({ type: "text", id: message.id, text: "" });
      } catch (error) {
        postMessage({ type: "error", id: message.id, message: String(error) });
      }
    });
    return;
  }
  if (message.type === "voice") {
    queue = queue.then(async () => {
      try {
        const ready = await voice!;
        [[ready.voicepack, ready.extra], ready.frontEnd] = await Promise.all([
          voiceFiles(ready.hf, ready.name, message.voice!, ready.voiceInputs),
          frontEndFor(ready.accents[message.voice!] ?? "en-us"),
        ]);
        postMessage({ type: "text", id: message.id, text: "" });
      } catch (error) {
        postMessage({ type: "error", id: message.id, message: String(error) });
      }
    });
    return;
  }
  if (message.type !== "speak") return;
  queue = queue.then(async () => {
    try {
      const started = performance.now();
      const { samples, timing } = await speak(await voice!, message.text!);
      postMessage(
        {
          type: "audio",
          id: message.id,
          samples,
          rate: RATE,
          timing: { ...timing, totalMs: performance.now() - started },
        },
        { transfer: [samples.buffer] },
      );
    } catch (error) {
      postMessage({ type: "error", id: message.id, message: String(error) });
    }
  });
};
