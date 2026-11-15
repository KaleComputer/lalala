// Kale's small voices (61 MB each: Kokoro's text side with Kale's own small decoder): the storyteller
// (Automatic) and kale-tts-1-tiny (Hazel's voice), one per worker, named by the load message. They run
// through Transformers.js the way kokoro-js runs Kokoro (StyleTextToSpeech2Model and its tokenizer),
// from the model folders lalala serves (public/models/<model>, which load the same way from any host).
// Transformers.js reports load and run errors; only the words come from Kale's own front end
// (matcha/kaleTts.js, as the warm voice). Credits: NOTICE.md.
import { G2p, G2pModel, normalizer, readTable } from "./matcha/kaleTts.js";

const TRANSFORMERS = "https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.8.1/dist/transformers.min.js";
const RATE = 24_000;
const STYLE = 256;
// Kokoro reads at most 512 ids, its two pads included.
const MAX_IDS = 510;
const PIECE_GAP_S = 0.06;
const PEAK = 0.95;
const EXPECTED = 66_100_000;
const FRONT_END = {
  g2pModel: new URL("./matcha/g2p.bin", import.meta.url).href,
  lexicon: new URL("./matcha/lexicon.tsv", import.meta.url).href,
  override: new URL("./matcha/override.tsv", import.meta.url).href,
};

type Tensor = { readonly data: Float32Array; readonly dims: ReadonlyArray<number> };
type Transformers = {
  env: {
    allowLocalModels: boolean;
    allowRemoteModels: boolean;
    localModelPath: string;
    backends: { onnx: { wasm: { numThreads: number } } };
  };
  StyleTextToSpeech2Model: {
    from_pretrained(id: string, options: object): Promise<(inputs: object) => Promise<{ waveform: Tensor }>>;
  };
  AutoTokenizer: {
    from_pretrained(id: string, options?: object): Promise<(text: string, options?: object) => { input_ids: Tensor }>;
  };
  Tensor: new (type: string, data: Float32Array, dims: number[]) => unknown;
};
type Voice = {
  readonly hf: Transformers;
  readonly model: (inputs: object) => Promise<{ waveform: Tensor }>;
  readonly tokenize: (text: string, options?: object) => { input_ids: Tensor };
  readonly voicepack: Float32Array;
  readonly g2p: G2p;
  readonly normalize: (text: string) => string;
};
type Message = {
  type: string;
  id?: number;
  text?: string;
  device?: string;
  model?: string;
  voice?: string;
  threads?: number;
};

let voice: Promise<Voice> | null = null;
let queue: Promise<unknown> = Promise.resolve();

async function load(device: string, name: string, voiceFile: string, threads?: number): Promise<Voice> {
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
  postMessage({ type: "load", name, expected: EXPECTED, cached });
  const files = new Map<string, { loaded: number; total: number }>();
  const progress = (info: { status?: string; file?: string; loaded?: number; total?: number }) => {
    if (info.status !== "progress" || !info.file || !info.total) return;
    files.set(info.file, { loaded: info.loaded ?? 0, total: info.total });
    let loaded = 0;
    for (const file of files.values()) loaded += file.loaded;
    postMessage({ type: "progress", loaded, total: Math.max(EXPECTED, loaded) });
  };
  const [model, tokenize, voicepack, g2pModel, lexicon, override] = await Promise.all([
    hf.StyleTextToSpeech2Model.from_pretrained(name, {
      dtype: "fp32",
      device,
      progress_callback: progress,
      // As the bench run that held on Tim's iPhone (15 Nov) and the warm voice: the optimizer's 32-bit
      // copies of the 16-bit text side cost a phone ~150 MB (WebKit) for ~5 % speed.
      session_options: { graphOptimizationLevel: "disabled" },
    }),
    hf.AutoTokenizer.from_pretrained(name),
    fetch(`${hf.env.localModelPath}${name}/voices/${voiceFile}.bin`).then((response) => response.arrayBuffer()),
    fetch(FRONT_END.g2pModel).then((response) => response.arrayBuffer()),
    fetch(FRONT_END.lexicon).then((response) => response.text()),
    fetch(FRONT_END.override).then((response) => response.text()),
  ]);
  postMessage({ type: "stage", stage: "backend", device, threads: hf.env.backends.onnx.wasm.numThreads });
  const lex = readTable(lexicon);
  readTable(override, lex);
  const ready: Voice = {
    hf,
    model,
    tokenize,
    voicepack: new Float32Array(voicepack),
    g2p: new G2p(lex, new G2pModel(g2pModel)),
    normalize: normalizer(lex),
  };
  await speak(ready, "Hi.");
  postMessage({ type: "ready" });
  return ready;
}

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

/** One IPA piece through the model, as kokoro-js's generate_from_ids: its tokens pick the style row. */
async function render(ready: Voice, ipa: string): Promise<Float32Array> {
  const { input_ids } = ready.tokenize(ipa, { truncation: true });
  const n = input_ids.dims.at(-1)! - 2;
  if (n <= 0) return new Float32Array(0);
  const row = Math.min(n, ready.voicepack.length / STYLE) - 1;
  const { waveform } = await ready.model({
    input_ids,
    style: new ready.hf.Tensor("float32", ready.voicepack.slice(row * STYLE, (row + 1) * STYLE), [1, STYLE]),
    speed: new ready.hf.Tensor("float32", Float32Array.from([1]), [1]),
  });
  return waveform.data;
}

/** A sentence (the player sends one at a time) as 24 kHz PCM. */
async function speak(ready: Voice, raw: string) {
  const started = performance.now();
  const ipa = ready.g2p.phonemes(ready.normalize(raw));
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

self.onmessage = (event: MessageEvent<Message>) => {
  const message = event.data;
  if (voice === null) {
    voice = load(
      message.device ?? "wasm",
      message.model ?? "kale-tts-1-tiny",
      message.voice ?? "hazel",
      message.threads,
    );
    voice.catch((error: unknown) => postMessage({ type: "failed", message: String(error) }));
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
