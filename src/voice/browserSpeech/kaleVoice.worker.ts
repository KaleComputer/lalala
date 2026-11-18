// Kale's small voices (61 MB each: Kokoro's text side with Kale's own small decoder): the storyteller
// (Automatic) and kale-tts-1-tiny (Hazel's voice), one per worker, named by the load message. They run
// through Transformers.js the way kokoro-js runs Kokoro (StyleTextToSpeech2Model and its tokenizer),
// from the model folders lalala serves (public/models/<model>, which load the same way from any host).
// Transformers.js reports load and run errors; only the words come from Kale's own front end
// (matcha/kaleTts.js, as the warm voice). Credits: NOTICE.md.
import "./wasmMeter";
import { G2p, G2pModel, normalizer, readTable } from "./matcha/kaleTts.js";
import { BritishG2p, britishNormalizer } from "./matcha/enGb.js";
import { EttinTokenizer, ettinInputs, wordIndex } from "./matcha/ettin.js";
import { webGpuWorks } from "./gpuTrial";
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
  Tensor: new (type: string, data: Float32Array | BigInt64Array, dims: number[]) => unknown;
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
  /** A model trained on Kokoro's own phoneme symbols (its voices.json says "phonemes": "kokoro-native"): ids come from
   *  knIPA over its tokenizer's vocabulary, not from the tokenizer (whose normalizer drops those symbols). */
  readonly kn: { readonly vocab: Readonly<Record<string, number>> } | null;
  /** The Ettin text side (the 10-voice kale-tts-1-tiny): its tokenizer, and the last sentence as context. */
  readonly ettin: { readonly tok: EttinTokenizer; prev: string } | null;
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
  /** The model's graph doesn't run on WebGPU: load it on the CPU. */
  cpuOnly?: boolean;
  /** On the CPU: "transformers" runs it through Transformers.js instead of onnxruntime-web directly (the bench). */
  runtime?: string;
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
  InferenceSession: { create(model: Uint8Array | string, options: object): Promise<DirectSession> };
  Tensor: new (type: string, data: BigInt64Array | Float32Array, dims: number[]) => Tensor;
};
const DIRECT_CACHE = "lalala-kale-voices";
/** One Identity node (onnx opset 13): only there to start onnxruntime's backend. */
const STARTER_MODEL = "CAg6NwoQCgF4EgF5IghJZGVudGl0eRIBdFoPCgF4EgoKCAgBEgQKAggBYg8KAXkSCgoICAESBAoCCAFCBAoAEA0=";
// New weights behind the same file name (16 Nov: bundle-gb16, then the release 10-voice nano and the
// Ettin tiny): a browser's copy from before is dropped once, from both caches, so it never runs old
// weights on new voice files.
const MODEL_REVISION = "r10-ettin";
/** A model whose graph changed again after that, by its own revision. */
const MODEL_REVISIONS: Record<string, string> = {
  "kale-tts-1-tiny-10-classic": "end-clamp",
  "kale-tts-1-tiny-10": "release-1902",
  "kale-tts-1-nano-10": "release-nano-base",
  "kale-tts-1-tiny-10-i8": "release-1151",
};

/**
 * A model over GitHub's 100 MB file limit ships in parts (onnx/model_web.parts.json lists them); it
 * is joined into one file here, cached as the whole.
 */
async function modelParts(name: string): Promise<string[] | null> {
  return fetch(`/models/${name}/onnx/model_web.parts.json`)
    .then((response) => (response.ok ? response.json() : null))
    .then((list: unknown) => (Array.isArray(list) && list.every((part) => typeof part === "string") ? list : null))
    .catch(() => null);
}
async function dropStaleModel(name: string): Promise<void> {
  const marker = new URL(`/models/${name}/.revision`, self.location.origin).href;
  const graph = new URL(`/models/${name}/onnx/model_web.onnx`, self.location.origin).href;
  try {
    const cache = await caches.open(DIRECT_CACHE);
    const revision = MODEL_REVISIONS[name] ?? MODEL_REVISION;
    if ((await (await cache.match(marker))?.text()) === revision) return;
    await cache.delete(graph);
    await (await caches.open("transformers-cache")).delete(graph);
    await cache.put(marker, new Response(revision));
  } catch {
    // No Cache API (a private window): nothing was kept either.
  }
}

/** The model file from this browser's cache, else the network (then cached), its download reported as it comes. */
async function modelBytes(url: string, expected: number, name: string): Promise<Uint8Array> {
  const cache = await caches.open(DIRECT_CACHE).catch(() => null);
  const hit = await cache?.match(url);
  postMessage({ type: "load", name, expected, cached: hit !== undefined, voice: loadingVoice });
  if (hit) return new Uint8Array(await hit.arrayBuffer());
  const files = (await modelParts(name))?.map((part) => new URL(part, url).href) ?? [url];
  // The whole model in one buffer: WebKit fails to read back a Blob of a model this size
  // ("Too much data buffered…", NotReadableError).
  const sizes = await Promise.all(
    files.map((file) =>
      fetch(file, { method: "HEAD" }).then((response) => Number(response.headers.get("content-length")) || 0),
    ),
  );
  const total = sizes.every((size) => size > 0) ? sizes.reduce((sum, size) => sum + size, 0) : 0;
  const chunks: Uint8Array<ArrayBuffer>[] = [];
  const whole = total > 0 ? new Uint8Array(total) : null;
  let loaded = 0;
  for (const file of files) {
    const response = await fetch(file);
    if (!response.ok || response.body === null) throw new Error(`download ${response.status} ${file}`);
    const reader = response.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (whole && loaded + value.byteLength <= total) whole.set(value, loaded);
      else chunks.push(value);
      loaded += value.byteLength;
      postMessage({ type: "progress", loaded, total: Math.max(expected, loaded) });
    }
  }
  const bytes = whole && loaded === total ? whole : new Uint8Array(await new Blob(chunks).arrayBuffer());
  chunks.length = 0;
  await cache?.put(url, new Response(bytes)).catch(() => {});
  return bytes;
}

let loadingVoice = "";
async function loadDirect(
  name: string,
  voiceFile: string,
  speed: number,
  expected: number,
  threads?: number,
): Promise<Voice> {
  voiceFile = await voiceIn(name, voiceFile);
  loadingVoice = voiceFile;
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
    json<{ voices?: { id: string; accent?: string }[]; phonemes?: string }>("voices.json", {}),
    json<{ model: { vocab: Record<string, number> } }>("tokenizer.json", { model: { vocab: {} } }),
  ]);
  const accents = Object.fromEntries((voicesJson.voices ?? []).map((entry) => [entry.id, entry.accent ?? "en-us"]));
  const shim = { Tensor: ort.Tensor, env: { localModelPath: "/models/" } } as unknown as Transformers;
  // onnxruntime's wasm backend starts before the model is read: with the 75 MB tiny already in this
  // worker, that start ran out of memory on Tim's iPhone (16 Nov). A 65-byte Identity model starts it.
  await (await ort.InferenceSession.create(Uint8Array.from(atob(STARTER_MODEL), (c) => c.charCodeAt(0)), {
    executionProviders: ["wasm"],
  })).release();
  const [modelFile, [voicepack, extra], frontEnd] = await Promise.all([
    modelBytes(new URL(`${base}onnx/model_web.onnx`, self.location.origin).href, expected, name),
    voiceFiles(shim, name, voiceFile, voiceInputs),
    frontEndFor(accents[voiceFile] ?? "en-us"),
  ]);
  await trace("session-create", { device: "wasm" });
  // Unoptimized, as yesterday: the optimizer's 32-bit copies of the 16-bit text side cost a phone memory.
  const session = await ort.InferenceSession.create(modelFile, {
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
  const ready: Voice = {
    ...{ hf: shim, model, name, speed, tokenize, voicepack, extra, voiceInputs, frontEnd, accents },
    kn: voicesJson.phonemes === "kokoro-native" ? { vocab: tokenizer.model.vocab } : null,
    ettin: await ettinFor(name),
  };
  await trace("warmup");
  await speak(ready, "Hi.");
  await trace("warmup-done");
  postMessage({ type: "ready" });
  return ready;
}

/** WebGPU where it loads and speaks its warm-up; any error there (caught) and the page goes to the CPU. */
async function load(
  device: string,
  name: string,
  voiceFile: string,
  speed: number,
  expected: number,
  threads?: number,
): Promise<Voice> {
  // A model in parts loads only through onnxruntime-web directly (Transformers.js wants one file).
  if (device === "gpu-if-available")
    device = (await modelParts(name)) === null && (await webGpuWorks()) ? "webgpu" : "wasm";
  if (device !== "webgpu") return loadOn(device, name, voiceFile, speed, expected, threads);
  try {
    return await loadOn("webgpu", name, voiceFile, speed, expected, threads);
  } catch (error) {
    // Not here: WebGPU's runtime is already in this worker's memory (both together ran Tim's iPhone
    // out of it, 16 Nov), so the page starts a fresh worker on the CPU.
    throw new Error(`${GPU_FAILED} ${String(error).slice(0, 300)}`);
  }
}
/** A failed WebGPU load says so first, for the page to load again on the CPU. */
const GPU_FAILED = "webgpu-failed:";

async function loadOn(
  device: string,
  name: string,
  voiceFile: string,
  speed: number,
  expected: number,
  threads?: number,
): Promise<Voice> {
  voiceFile = await voiceIn(name, voiceFile);
  await trace("worker", { device, model: name, voice: voiceFile, ...(device === "webgpu" ? await gpuDetails() : {}) });
  await dropStaleModel(name);
  if (device === "wasm" && runtime !== "transformers") return loadDirect(name, voiceFile, speed, expected, threads);
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
  postMessage({ type: "load", name, expected, cached, voice: voiceFile });
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
  const voicesList = await fetch(`${hf.env.localModelPath}${name}/voices.json`)
    .then((response) => (response.ok ? (response.json() as Promise<{ voices?: { id: string; accent?: string }[]; phonemes?: string }>) : {}))
    .catch(() => ({}) as { voices?: { id: string; accent?: string }[]; phonemes?: string });
  const accents = Object.fromEntries((voicesList.voices ?? []).map((entry) => [entry.id, entry.accent ?? "en-us"]));
  const knVocab = voicesList.phonemes === "kokoro-native"
    ? await fetch(`${hf.env.localModelPath}${name}/tokenizer.json`)
        .then((response) => response.json() as Promise<{ model: { vocab: Record<string, number> } }>)
        .then((t) => t.model.vocab)
    : null;
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
    ettin: await ettinFor(name),
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
    kn: knVocab ? { vocab: knVocab } : null,
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

/** A model with the Ettin text side ships Ettin's tokenizer next to it (ettin-tokenizer.json). */
async function ettinFor(name: string): Promise<Voice["ettin"]> {
  const json = await fetch(`/models/${name}/ettin-tokenizer.json`)
    .then((response) => (response.ok ? response.json() : null))
    .catch(() => null);
  return json?.model?.vocab ? { tok: new EttinTokenizer(json), prev: "" } : null;
}

/** A sentence's sound ids, without the pads. */
/**
 * Kokoro-native phoneme ids, exactly as the kale-tts-1 release runtime (release-draft/js/kale-tts.mjs knIPA): en-us: eɪ A, aɪ I,
 * aʊ W, oʊ O, ɔɪ Y, tʃ ʧ, dʒ ʤ, no ː, ɚ əɹ, ɝ ɜɹ, ɾ T; en-gb: the same pairs with əʊ Q, length marks kept, no rhotic / flap rules;
 * both: ə + l/n/m at a word end after a consonant -> ᵊ.
 */
const KN_PAIRS: Record<string, string> = { "eɪ": "A", "aɪ": "I", "aʊ": "W", "ɔɪ": "Y", "tʃ": "ʧ", "dʒ": "ʤ" };
const KN_VOW = new Set([..."aeiouɑɐɒæəɘɚɛɜɝɞɪɨʊʉʌɔøœɤɯʏyAIWOYᵊᵻ"]);
const KN_END = new Set([..." .,!?;:"]);
function knIPA(chars: string[], gb: boolean): string[] {
  const pairs: Record<string, string> = { ...KN_PAIRS, ...(gb ? { "əʊ": "Q" } : { "oʊ": "O" }) };
  const out: string[] = [];
  for (let i = 0; i < chars.length; ) {
    const two = chars[i] + (chars[i + 1] ?? "");
    if (pairs[two]) {
      out.push(pairs[two]);
      i += 2;
      continue;
    }
    const c = chars[i++];
    if (gb) {
      out.push(c);
      continue;
    }
    if (c === "ː") continue;
    if (c === "ɚ") out.push("ə", "ɹ");
    else if (c === "ɝ") out.push("ɜ", "ɹ");
    else if (c === "ɾ") out.push("T");
    else out.push(c);
  }
  for (let k = 1; k < out.length - 1; k++)
    if (out[k] === "ə" && "lnm".includes(out[k + 1]) && (k + 2 === out.length || KN_END.has(out[k + 2])) && !KN_VOW.has(out[k - 1]) &&
        !"ˈˌ".includes(out[k - 1]) && !/\s/.test(out[k - 1])) out[k] = "ᵊ";
  return out;
}

/** The model's input ids for some IPA, with the pads: through the tokenizer, or Kokoro-native for a kn model. */
function tokenIds(ready: Voice, ipa: string): Tensor {
  if (!ready.kn) return ready.tokenize(ipa, { truncation: true }).input_ids;
  const vocab = ready.kn.vocab;
  const syms = knIPA([...ipa].filter((c) => vocab[c] !== undefined), ready.frontEnd.accent === "en-gb");
  const ids = [0, ...syms.map((c) => vocab[c]).filter((x): x is number => x !== undefined && x !== 0), 0];
  return new ready.hf.Tensor("int64", BigInt64Array.from(ids.map(BigInt)), [1, ids.length]) as Tensor;
}

const idsOf = (ready: Voice, ipa: string) =>
  Array.from(tokenIds(ready, ipa).data as unknown as ArrayLike<bigint | number>, Number).slice(1, -1);

/**
 * The voice to load: the one asked for when the model's voices.json lists it, else the model's first.
 * A voice the model doesn't have must never load: the local server answers a missing file with the
 * app's page (status 200), and that page as a style table was a made-up voice (Tim, 16 Nov).
 */
const voiceLists = new Map<string, Promise<string[] | null>>();
async function voiceIn(name: string, wanted: string): Promise<string> {
  let list = voiceLists.get(name);
  if (!list) {
    list = fetch(`/models/${name}/voices.json`)
      .then((response) => (response.ok ? response.json() : null))
      .then((json: { voices?: { id: string }[] } | null) => json?.voices?.map((entry) => entry.id) ?? null)
      .catch(() => null);
    voiceLists.set(name, list);
  }
  const ids = await list;
  if (!ids || ids.length === 0 || ids.includes(wanted)) return wanted;
  postMessage({ type: "stage", stage: "voice-fallback", wanted, used: ids[0] });
  return ids[0]!;
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
      if (!response.ok || /text\/html/.test(response.headers.get("content-type") ?? ""))
        throw new Error(`${url}: not a voice file (${response.status})`);
      return response.arrayBuffer();
    });
  const [pack, constants] = await Promise.all([
    read(`${base}.bin`),
    voiceInputs.length > 0 ? read(`${base}.extra.bin`) : Promise.resolve(new ArrayBuffer(0)),
  ]);
  const wantedExtra = voiceInputs.reduce((sum, input) => sum + input.dims.reduce((a, b) => a * b, 1) * 4, 0);
  if (pack.byteLength === 0 || pack.byteLength % (STYLE * 4) !== 0 || constants.byteLength !== wantedExtra)
    throw new Error(`${base}: the voice files don't fit this model`);
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
type EttinFeeds = { readonly e: ReturnType<typeof ettinInputs>; readonly widx: number[] };
async function render(ready: Voice, ipa: string, words: EttinFeeds | null = null): Promise<Float32Array> {
  const input_ids = tokenIds(ready, ipa);
  const n = input_ids.dims.at(-1)! - 2;
  if (n <= 0) return new Float32Array(0);
  const row = Math.min(n, ready.voicepack.length / STYLE) - 1;
  await trace("run", { ids: n });
  const { waveform } = await ready.model({
    input_ids,
    style: new ready.hf.Tensor("float32", ready.voicepack.slice(row * STYLE, (row + 1) * STYLE), [1, STYLE]),
    speed: new ready.hf.Tensor("float32", Float32Array.from([ready.speed]), [1]),
    ...ready.extra,
    ...(words ? ettinTensors(ready, words) : {}),
  });
  return waveform.data;
}

/** The Ettin inputs as the release's kale-tts.mjs feeds them; widx also covers the two pads. */
function ettinTensors(ready: Voice, { e, widx }: EttinFeeds) {
  const T = ready.hf.Tensor;
  const big = (values: number[]) => BigInt64Array.from(values, BigInt);
  return {
    ettin_ids: new T("int64", big(e.ettin_ids), [1, e.S]),
    ettin_mask: new T("int64", big(e.ettin_mask), [1, e.S]),
    wavg: new T("float32", e.wavg, [1, e.W, e.S]),
    widx: new T("int64", big([widx[0] ?? 0, ...widx, widx.at(-1) ?? 0]), [1, widx.length + 2]),
  };
}

/** A sentence (the player sends one at a time) as 24 kHz PCM. */
async function speak(ready: Voice, raw: string) {
  const started = performance.now();
  const said = ready.frontEnd.normalize(raw);
  const ipa = ready.frontEnd.g2p.phonemes(said);
  // Ettin's word features: its sub-tokens of the sentence (the one before as context), and which word
  // each sound id belongs to, from the same words through the same g2p.
  let words: { e: ReturnType<typeof ettinInputs>; widx: number[]; all: number[] } | null = null;
  if (ready.ettin) {
    const list = said.split(/\s+/).filter(Boolean);
    const all = idsOf(ready, ipa);
    const per = list.map((word) => idsOf(ready, ready.frontEnd.g2p.phonemes(word)));
    words = { e: ettinInputs(ready.ettin.tok, said, ready.ettin.prev), widx: wordIndex(all, per, list.length), all };
    ready.ettin.prev = said;
  }
  const g2pMs = performance.now() - started;
  const parts: Float32Array[] = [];
  let idAt = 0;
  for (const piece of pieces(ipa)) {
    if (parts.length > 0) parts.push(new Float32Array(Math.round(PIECE_GAP_S * RATE)));
    if (!words) {
      parts.push(await render(ready, piece));
      continue;
    }
    // A piece drops the space it was cut at: find where its ids start in the sentence's.
    const ids = idsOf(ready, piece);
    while (idAt < words.all.length && words.all[idAt] !== ids[0]) idAt++;
    parts.push(await render(ready, piece, { e: words.e, widx: words.widx.slice(idAt, idAt + ids.length) }));
    idAt += ids.length;
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
let runtime: string | undefined;
const start = (message: Message) => {
  voice = load(
    // A model whose graph doesn't run on WebGPU loads on the CPU, also when swapped in here.
    message.cpuOnly ? "wasm" : device,
    message.model ?? "kale-tts-1-nano",
    message.voice ?? "",
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
    runtime = message.runtime;
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
        const id = await voiceIn(ready.name, message.voice ?? "");
        [[ready.voicepack, ready.extra], ready.frontEnd] = await Promise.all([
          voiceFiles(ready.hf, ready.name, id, ready.voiceInputs),
          frontEndFor(ready.accents[id] ?? "en-us"),
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
