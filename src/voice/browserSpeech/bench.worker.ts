// The speed bench (?bench=k10c, src/bench): one model on one ONNX Runtime backend, in a worker of its
// own that the page ends after the run, so only one model is ever in memory. Same front end, inputs
// and session settings as llamaKokoro.worker; WebGPU runs use ORT's WebGPU bundle.
import { G2p, G2pModel, normalizer, readTable } from "./matcha/kaleTts.js";

const BASE = "https://cdn.jsdelivr.net/npm/onnxruntime-web@1.24.1/dist/";
const STYLE = 256;
const RATE = 24_000;

export type BenchJob = {
  readonly model: string;
  readonly voicepack: string;
  readonly ids: string;
  readonly g2pModel: string;
  readonly lexicon: string;
  readonly override: string;
  readonly cache: string;
  readonly backend: "webgpu" | "wasm";
  readonly speed: number;
  readonly sentences: ReadonlyArray<string>;
  readonly runs: number;
};

type Tensor = { readonly data: Float32Array };
type Session = {
  run(feeds: Record<string, unknown>): Promise<Record<string, Tensor>>;
  release(): Promise<void>;
};
type Ort = {
  env: { wasm: { wasmPaths: string; numThreads: number }; versions?: Record<string, string> };
  InferenceSession: { create(model: Uint8Array, options: object): Promise<Session> };
  Tensor: new (type: string, data: BigInt64Array | Float32Array, dims: number[]) => unknown;
};

const median = (values: number[]) => {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
};
const round = (value: number, places = 0) => Math.round(value * 10 ** places) / 10 ** places;

/** Each file from the bench's cache (the live voice shares its cache, so it's usually there), else the network. */
async function fetchAll(urls: string[], cacheName: string) {
  const cache = await caches.open(cacheName).catch(() => null);
  let cached = true;
  const bodies = await Promise.all(
    urls.map(async (url) => {
      const hit = await cache?.match(url);
      if (hit) return hit.arrayBuffer();
      cached = false;
      const response = await fetch(url);
      if (!response.ok) throw new Error(`download ${response.status} ${url}`);
      const body = await response.arrayBuffer();
      // Awaited: the page ends this worker right after its run, which would drop a pending put.
      await cache?.put(url, new Response(body.slice(0))).catch(() => {});
      return body;
    }),
  );
  return { bodies, cached };
}

async function bench(job: BenchJob) {
  const started = performance.now();
  if (job.backend === "webgpu") {
    const gpu = (navigator as Navigator & { gpu?: { requestAdapter(): Promise<unknown> } }).gpu;
    const adapter = await gpu?.requestAdapter().catch(() => null);
    if (!adapter) {
      return { skipped: gpu ? "WebGPU has no adapter in this browser" : "no WebGPU in this browser" };
    }
  }
  const url = `${BASE}${job.backend === "webgpu" ? "ort.webgpu.min.mjs" : "ort.wasm.min.mjs"}`;
  const ort = (await import(/* @vite-ignore */ url)) as Ort;
  ort.env.wasm.wasmPaths = BASE;
  ort.env.wasm.numThreads = self.crossOriginIsolated
    ? Math.min(4, navigator.hardwareConcurrency || 4)
    : 1;
  const { bodies, cached } = await fetchAll(
    [job.model, job.voicepack, job.ids, job.g2pModel, job.lexicon, job.override],
    job.cache,
  );
  const fetchMs = performance.now() - started;
  const text = (at: number) => new TextDecoder().decode(bodies[at]);
  const sessionStarted = performance.now();
  // wasm as lalala ships it (optimizer off, for memory); WebGPU with ORT's default optimizations.
  const session = await ort.InferenceSession.create(new Uint8Array(bodies[0]!), {
    executionProviders: [job.backend],
    ...(job.backend === "wasm" ? { graphOptimizationLevel: "disabled" } : {}),
  });
  const sessionMs = performance.now() - sessionStarted;
  bodies[0] = new ArrayBuffer(0);
  const lex = readTable(text(4));
  readTable(text(5), lex);
  const g2p = new G2p(lex, new G2pModel(bodies[3]!));
  const normalize = normalizer(lex);
  const voicepack = new Float32Array(bodies[1]!);
  const toId = new Map(Object.entries(JSON.parse(text(2)) as Record<string, number>));

  const idsOf = (sentence: string) => {
    const ids = [0];
    for (const ch of g2p.phonemes(normalize(sentence))) {
      const id = toId.get(ch);
      if (id !== undefined) ids.push(id);
    }
    ids.push(0);
    return ids;
  };
  const render = async (ids: number[]) => {
    const n = ids.length - 2;
    const row = Math.min(n, voicepack.length / STYLE) - 1;
    const result = await session.run({
      input_ids: new ort.Tensor("int64", BigInt64Array.from(ids.map(BigInt)), [1, ids.length]),
      style: new ort.Tensor("float32", voicepack.slice(row * STYLE, (row + 1) * STYLE), [1, STYLE]),
      speed: new ort.Tensor("float32", Float32Array.from([job.speed]), [1]),
    });
    return new Float32Array(result.waveform!.data);
  };

  // The first call compiles the kernels (on WebGPU, the shaders): part of loading, as in the app.
  const warmStarted = performance.now();
  await render(idsOf("Hi."));
  const warmMs = performance.now() - warmStarted;
  const loadMs = performance.now() - started;
  postMessage({ type: "stage", stage: "loaded" });

  const firstIds = idsOf(job.sentences[0]!);
  const lineIds = idsOf(job.sentences.join(" "));
  const first: number[] = [];
  const line: number[] = [];
  let audio = new Float32Array(0);
  for (let run = 0; run < job.runs; run++) {
    // First sound: the text of the first sentence to its audio (the player speaks sentence by sentence).
    let at = performance.now();
    await render(idsOf(job.sentences[0]!));
    first.push(performance.now() - at);
    at = performance.now();
    audio = await render(lineIds);
    line.push(performance.now() - at);
    postMessage({ type: "stage", stage: `run ${run + 1}/${job.runs}` });
  }
  await session.release().catch(() => {});
  const audioS = audio.length / RATE;
  const lineMs = median(line);
  return {
    result: {
      cached,
      threads: ort.env.wasm.numThreads,
      ort: ort.env.versions?.web ?? null,
      fetchMs: round(fetchMs),
      sessionMs: round(sessionMs),
      warmMs: round(warmMs),
      loadMs: round(loadMs),
      firstSoundMs: round(median(first)),
      lineMs: round(lineMs),
      audioS: round(audioS, 2),
      realtime: round(audioS / (lineMs / 1000), 1),
      firstRunsMs: first.map((ms) => round(ms)),
      lineRunsMs: line.map((ms) => round(ms)),
      firstIds: firstIds.length - 2,
      lineIds: lineIds.length - 2,
    },
    audio,
  };
}

self.onmessage = (event: MessageEvent<BenchJob>) => {
  bench(event.data).then(
    (outcome) => {
      if ("skipped" in outcome) postMessage({ type: "skipped", reason: outcome.skipped });
      else
        postMessage(
          { type: "done", result: outcome.result, audio: outcome.audio },
          { transfer: [outcome.audio.buffer] },
        );
    },
    (error: unknown) => postMessage({ type: "failed", message: String(error) }),
  );
};
