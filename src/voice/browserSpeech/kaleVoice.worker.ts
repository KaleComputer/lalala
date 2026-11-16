// Kale's small voices (61 MB each: Kokoro's text side with Kale's own small decoder): the storyteller
// (Automatic) and kale-tts-1-tiny (Hazel's voice), one per worker, named by the load message. They run
// through Transformers.js the way kokoro-js runs Kokoro (StyleTextToSpeech2Model and its tokenizer),
// from the model folders lalala serves (public/models/<model>, which load the same way from any host).
// Transformers.js reports load and run errors; only the words come from Kale's own front end
// (matcha/kaleTts.js, as the warm voice). Credits: NOTICE.md.
import { G2p, G2pModel, normalizer, readTable } from "./matcha/kaleTts.js";
import { BritishG2p, britishNormalizer } from "./matcha/enGb.js";
import { termsReplacer } from "./terms";

// Transformers.js 4.3.2 with onnxruntime-web 1.31.1 instead of its pinned 1.31.0-dev (faster wasm), built
// for the browser by esm.sh; the runtime's wasm comes from jsDelivr. The models are float32-only web
// graphs (release-draft make_web_graph.py): this runtime has no float->double Cast.
const TRANSFORMERS_GPU =
  "https://esm.sh/@huggingface/transformers@4.3.2?deps=onnxruntime-web@1.31.1,onnxruntime-common@1.31.1";

const RATE = 24_000;
const STYLE = 256;
// Kokoro reads at most 512 ids, its two pads included.
const MAX_IDS = 510;
const PIECE_GAP_S = 0.06;
const PEAK = 0.95;
type FrontEndFiles = {
  g2pModel: string;
  lexicon: string;
  override: string;
  terms: string;
  /** British G2p and dates (matcha/enGb.js) on top of the files. */
  british?: boolean;
};
/**
 * Pronunciation front ends by accent tag: each voice's "accent" in its model's voices.json picks one,
 * as in the release's JS API. A missing one falls back to en-us, said once in the log.
 */
const FRONT_ENDS: Record<string, FrontEndFiles | null> = {
  "en-us": {
    g2pModel: new URL("./matcha/g2p.bin", import.meta.url).href,
    lexicon: new URL("./matcha/lexicon.tsv", import.meta.url).href,
    override: new URL("./matcha/override.tsv", import.meta.url).href,
    terms: new URL("./matcha/terms.tsv", import.meta.url).href,
  },
  // British English (british-16nov: CMUdict-made list through Kale's us -> gb rules, Britfone 3.0.1),
  // for d03 and d13, fine-tuned on British ids (bundle-gb16).
  "en-gb": {
    g2pModel: new URL("./matcha/en-gb/g2p.bin", import.meta.url).href,
    lexicon: new URL("./matcha/en-gb/lexicon.tsv", import.meta.url).href,
    override: new URL("./matcha/en-gb/override.tsv", import.meta.url).href,
    terms: new URL("./matcha/en-gb/terms.tsv", import.meta.url).href,
    british: true,
  },
};
const frontEndReady = (accent: string) => FRONT_ENDS[accent] != null;
type FrontEnd = {
  readonly accent: string;
  readonly g2p: G2p;
  readonly normalize: (text: string) => string;
};
const frontEnds = new Map<string, Promise<FrontEnd>>();
/** The front end for a voice's accent, built once per accent and kept. */
function frontEndFor(accent: string): Promise<FrontEnd> {
  const used = frontEndReady(accent) ? accent : "en-us";
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
        g2p: files.british ? new BritishG2p(lex, new G2pModel(g2pModel)) : new G2p(lex, new G2pModel(g2pModel)),
        normalize: spokenWith(files.british ? britishNormalizer(lex) : normalizer(lex), termsReplacer(terms)),
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
  /** onnxruntime's WebGPU storage-buffer cache mode, when not its default. */
  gpuCache?: string;
  /** A bench run's id: log every step to the session log (WebGPU bench runs). */
  trace?: string;
  speed?: number;
  /** The model's own bytes (settingsStore's SMALL_VOICES), for the download bar. */
  expected?: number;
};

let voice: Promise<Voice> | null = null;
let queue: Promise<unknown> = Promise.resolve();


// Phones (and any CPU run): yesterday's working setup, onnxruntime-web's plain wasm build imported
// directly, no Transformers.js. Transformers.js always loads onnxruntime's WebGPU-capable build, and
// with it lalala's page went past Tim's iPhone limit next to the canvas (16 Nov; 3.8.1 and 4.3.2 both).
const ORT_DIRECT = "https://cdn.jsdelivr.net/npm/onnxruntime-web@1.24.1/dist/ort.wasm.min.mjs";
type DirectSession = {
  run(feeds: Record<string, unknown>): Promise<Record<string, Tensor>>;
  release(): Promise<void>;
};
type DirectOrt = {
  env: { wasm: { wasmPaths: string; numThreads: number }; versions?: { web?: string } };
  InferenceSession: { create(model: Uint8Array, options: object): Promise<DirectSession> };
  Tensor: new (type: string, data: BigInt64Array | Float32Array, dims: number[]) => Tensor;
};
const DIRECT_CACHE = "lalala-kale-voices";
// New weights behind the same file name (bundle-gb16, 16 Nov: British d03 and d13): a browser's
// copy from before is dropped once, from both caches, so it never runs old weights on new voice files.
const MODEL_REVISION = "gb16";
async function dropStaleModel(name: string): Promise<void> {
  const marker = new URL(`/models/${name}/.revision`, self.location.origin).href;
  const graph = new URL(`/models/${name}/onnx/model_web.onnx`, self.location.origin).href;
  try {
    const cache = await caches.open(DIRECT_CACHE);
    if ((await (await cache.match(marker))?.text()) === MODEL_REVISION) return;
    await cache.delete(graph);
    await (await caches.open("transformers-cache")).delete(graph);
    await cache.put(marker, new Response(MODEL_REVISION));
  } catch {
    // No Cache API (a private window): nothing was kept either.
  }
}

/** The model file from this browser's cache, else the network (then cached), its bytes reported as they come. */
async function modelBytes(url: string, expected: number, name: string): Promise<ArrayBuffer> {
  const cache = await caches.open(DIRECT_CACHE).catch(() => null);
  const hit = await cache?.match(url);
  postMessage({ type: "load", name, expected, cached: hit !== undefined });
  if (hit) return hit.arrayBuffer();
  const response = await fetch(url);
  if (!response.ok || response.body === null) throw new Error(`download ${response.status} ${url}`);
  const reader = response.body.getReader();
  const parts: Uint8Array<ArrayBuffer>[] = [];
  let loaded = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    parts.push(value);
    loaded += value.byteLength;
    postMessage({ type: "progress", loaded, total: Math.max(expected, loaded) });
  }
  const blob = new Blob(parts);
  await cache?.put(url, new Response(blob)).catch(() => {});
  return blob.arrayBuffer();
}

async function loadDirect(
  name: string,
  voiceFile: string,
  speed: number,
  expected: number,
  threads?: number,
): Promise<Voice> {
  await trace("runtime-import", { runtime: "onnxruntime-web 1.24.1 wasm" });
  const ort = (await import(/* @vite-ignore */ ORT_DIRECT)) as DirectOrt;
  ort.env.wasm.wasmPaths = ORT_DIRECT.slice(0, ORT_DIRECT.lastIndexOf("/") + 1);
  ort.env.wasm.numThreads =
    threads ?? (self.crossOriginIsolated ? Math.min(4, navigator.hardwareConcurrency || 4) : 1);
  await trace("runtime-ready");
  // Transformers.js's copies (desktops keep theirs) only fill a phone's storage.
  void caches.delete("transformers-cache").catch(() => {});
  const base = `/models/${name}/`;
  const json = <T>(file: string, fallback: T) =>
    fetch(base + file)
      .then((response) => (response.ok ? (response.json() as Promise<T>) : fallback))
      .catch(() => fallback);
  const [voiceInputs, voicesJson, tokenizer] = await Promise.all([
    json<Voice["voiceInputs"]>("voice_inputs.json", []),
    json<{ voices?: { id: string; accent?: string }[] }>("voices.json", {}),
    json<{ model: { vocab: Record<string, number> } }>("tokenizer.json", { model: { vocab: {} } }),
  ]);
  const accents = Object.fromEntries((voicesJson.voices ?? []).map((entry) => [entry.id, entry.accent ?? "en-us"]));
  const shim = { Tensor: ort.Tensor, env: { localModelPath: "/models/" } } as unknown as Transformers;
  const [bytes, [voicepack, extra], frontEnd] = await Promise.all([
    modelBytes(new URL(`${base}onnx/model_web.onnx`, self.location.origin).href, expected, name),
    voiceFiles(shim, name, voiceFile, voiceInputs),
    frontEndFor(accents[voiceFile] ?? "en-us"),
  ]);
  await trace("session-create", { device: "wasm" });
  // Unoptimized, as yesterday: the optimizer's 32-bit copies of the 16-bit text side cost a phone memory.
  const session = await ort.InferenceSession.create(new Uint8Array(bytes), {
    executionProviders: ["wasm"],
    graphOptimizationLevel: "disabled",
  });
  await trace("session-created");
  postMessage({
    type: "stage",
    stage: "backend",
    device: "wasm",
    threads: ort.env.wasm.numThreads,
    ort: ort.env.versions?.web ?? "1.24.1",
    transformers: null,
  });
  const vocab = tokenizer.model.vocab;
  const tokenize = (ipa: string) => {
    const ids = [0];
    for (const ch of ipa) {
      const id = vocab[ch];
      if (id !== undefined && id !== 0) ids.push(id);
    }
    ids.push(0);
    return { input_ids: new ort.Tensor("int64", BigInt64Array.from(ids.map(BigInt)), [1, ids.length]) };
  };
  const model = Object.assign(
    async (inputs: object) => (await session.run(inputs as Record<string, unknown>)) as { waveform: Tensor },
    { dispose: () => session.release() },
  );
  const ready: Voice = { hf: shim, model, name, speed, tokenize, voicepack, extra, voiceInputs, frontEnd, accents };
  await trace("warmup");
  await speak(ready, "Hi.");
  await trace("warmup-done");
  postMessage({ type: "ready" });
  return ready;
}

async function load(
  device: string,
  name: string,
  voiceFile: string,
  speed: number,
  expected: number,
  threads?: number,
): Promise<Voice> {
  // "gpu-if-available" (desktops): WebGPU where the browser has an adapter, else the CPU. Phones send
  // "wasm": WebGPU ended Tim's iPhone tab (15 Nov), a kill nothing can catch.
  if (device === "gpu-if-available") device = (await hasGpu()) ? "webgpu" : "wasm";
  await trace("worker", { device, model: name, voice: voiceFile, ...(device === "webgpu" ? await gpuDetails() : {}) });
  await dropStaleModel(name);
  if (device === "wasm") return loadDirect(name, voiceFile, speed, expected, threads);
  await trace("runtime-import");
  const hf = (await import(/* @vite-ignore */ TRANSFORMERS_GPU)) as Transformers;
  await trace("runtime-ready");
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
    .then((cache) => cache.match(new URL(`/models/${name}/onnx/model_web.onnx`, self.location.origin).href))
    .then((hit) => hit !== undefined)
    .catch(() => false);
  postMessage({ type: "load", name, expected, cached });
  // The old graphs (onnx/model.onnx) are never loaded again: free the phone's storage they hold.
  void caches
    .open("transformers-cache")
    .then(async (cache) => {
      for (const request of await cache.keys())
        if (/\/models\/[^/]+\/onnx\/model\.onnx$/.test(request.url)) await cache.delete(request);
    })
    .catch(() => {});
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
  await trace("session-create", { device });
  const [model, tokenize, [voicepack, extra], frontEnd] = await Promise.all([
    hf.StyleTextToSpeech2Model.from_pretrained(name, {
      dtype: "fp32",
      // The float32 web graph has its own name: a browser that cached the old onnx/model.onnx (same URL)
      // gave the new runtime the old double-precision graph ("Cast(13)", Tim's iPhone, 16 Nov).
      model_file_name: "model_web",
      device,
      progress_callback: progress,
      // As the bench run that held on Tim's iPhone (15 Nov) and the warm voice: the optimizer's 32-bit
      // copies of the 16-bit text side cost a phone ~150 MB (WebKit) for ~5 % speed.
      ...(device === "wasm" ? { session_options: { graphOptimizationLevel: "disabled" } } : {}),
      // WebGPU's buffer cache: onnxruntime keeps freed buffers by size ("bucket"), and every new
      // sentence length adds sizes. gpuCache picks another mode (disabled, lazyRelease, simple).
      ...(device === "webgpu" && gpuCache
        ? { session_options: { executionProviders: [{ name: "webgpu", storageBufferCacheMode: gpuCache }] } }
        : {}),
    }),
    hf.AutoTokenizer.from_pretrained(name),
    voiceFiles(hf, name, voiceFile, voiceInputs),
    frontEndFor(accents[voiceFile] ?? "en-us"),
  ]);
  await trace("session-created");
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
  await trace("warmup");
  await speak(ready, "Hi.");
  await trace("warmup-done");
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

/**
 * A WebGPU bench run (?bench=…&gpu) logs every step to the Mac's session log and waits for the server
 * to take it before the next risky one, so a tab that iOS kills still shows where it died.
 */
let traceId: string | null = null;
let gpuCache: string | null = null;
async function trace(step: string, data: Record<string, unknown> = {}) {
  if (traceId === null) return;
  const event = { t: new Date().toISOString(), who: "system", type: "bench.trace", bench: traceId, step, ...data };
  await fetch("/__lalala/log", {
    method: "POST",
    headers: { "content-type": "text/plain" },
    body: JSON.stringify([event]),
    keepalive: true,
  }).catch(() => {});
}

/** The adapter's identity, limits and features, for the trace. */
async function gpuDetails() {
  type Adapter = {
    info?: Record<string, unknown>;
    limits?: Record<string, number>;
    features?: Iterable<string>;
  };
  const gpu = (navigator as Navigator & { gpu?: { requestAdapter(): Promise<Adapter | null> } }).gpu;
  const adapter = await gpu?.requestAdapter().catch(() => null);
  if (!adapter) return { adapter: false };
  const limits = adapter.limits ?? {};
  return {
    adapter: true,
    vendor: adapter.info?.vendor ?? null,
    architecture: adapter.info?.architecture ?? null,
    description: adapter.info?.description ?? null,
    maxBufferSize: limits.maxBufferSize,
    maxStorageBufferBindingSize: limits.maxStorageBufferBindingSize,
    maxComputeWorkgroupStorageSize: limits.maxComputeWorkgroupStorageSize,
    maxComputeInvocationsPerWorkgroup: limits.maxComputeInvocationsPerWorkgroup,
    maxStorageBuffersPerShaderStage: limits.maxStorageBuffersPerShaderStage,
    features: [...(adapter.features ?? [])].join(","),
  };
}

async function hasGpu() {
  const gpu = (navigator as Navigator & { gpu?: { requestAdapter(): Promise<unknown> } }).gpu;
  return (await gpu?.requestAdapter().catch(() => null)) != null;
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
  await trace("run", { ids: n });
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
  voice.catch((error: unknown) => {
    void trace("failed", { message: String(error) });
    postMessage({ type: "failed", message: String(error) });
  });
};

self.onmessage = (event: MessageEvent<Message>) => {
  const message = event.data;
  if (voice === null) {
    device = message.device ?? "wasm";
    threads = message.threads;
    traceId = message.trace ?? null;
    // lazyRelease by default: the default "bucket" cache took WebKit's GPU process to 2.4 GB (Mac, 16 Nov).
    gpuCache = message.gpuCache ?? "lazyRelease";
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
