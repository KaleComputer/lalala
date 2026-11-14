// Parakeet TDT 0.6B v2 (parakeet.js): fp16 encoder on WebGPU, int8 on WASM without it. Files go to
// IndexedDB in pieces and the encoder's weights reach the runtime as external data read from disk a
// slice at a time: buffered whole, the 1.25 GB file ended a phone's tab (13 Nov).
import { externalGraph } from "./onnxExternal";
import { trackFiles } from "./readout";
import { downloadFile, isDownloaded, keepDownloads } from "./resumableFetch";

const PARAKEET_JS = "https://cdn.jsdelivr.net/npm/parakeet.js@1.4.4/+esm";
const REPO = "ysdede/parakeet-tdt-0.6b-v2-onnx";
const BASE = `https://huggingface.co/${REPO}/resolve/main/`;
const DECODER = "decoder_joint-model.int8.onnx";

type Model = {
  transcribe(
    pcm: Float32Array,
    rate: number,
    options: object,
  ): Promise<{ utterance_text?: string }>;
};
type ParakeetModule = {
  fromUrls(config: {
    encoderUrl: string;
    encoderDataUrl: Uint8Array;
    decoderUrl: string;
    tokenizerUrl: string;
    filenames: { encoder: string; decoder: string };
    backend: string;
  }): Promise<Model>;
};
type Build = {
  readonly backend: "webgpu-hybrid" | "wasm";
  readonly encoder: string;
  readonly expected: number;
};

const WEBGPU: Build = {
  backend: "webgpu-hybrid",
  encoder: "encoder-model.fp16.onnx",
  expected: 1_248_000_000,
};
const WASM: Build = {
  backend: "wasm",
  encoder: "encoder-model.int8.onnx",
  expected: 661_000_000,
};

let model: Promise<Model> | null = null;
let queue: Promise<unknown> = Promise.resolve();

const stage = (name: string, data: Record<string, unknown> = {}) =>
  postMessage({ type: "stage", stage: name, ...data });

async function hasWebGpu() {
  const gpu = (navigator as Navigator & { gpu?: { requestAdapter(): Promise<unknown> } }).gpu;
  if (!gpu) return false;
  const adapter = (await gpu.requestAdapter().catch(() => null)) as {
    features?: { has(name: string): boolean };
  } | null;
  return adapter?.features?.has("shader-f16") === true;
}

/**
 * The runtime reads mounted external data only through `byteLength` and `subarray` (one tensor at a
 * time, synchronously, in this worker), so this hands it each slice straight from the disk-backed blob.
 */
declare const FileReaderSync: new () => { readAsArrayBuffer(blob: Blob): ArrayBuffer };

function blobBytes(blob: Blob): Uint8Array {
  const bytes = new Uint8Array(0);
  Object.defineProperties(bytes, {
    byteLength: { value: blob.size },
    subarray: {
      value: (start = 0, end = blob.size) =>
        new Uint8Array(new FileReaderSync().readAsArrayBuffer(blob.slice(start, end))),
    },
  });
  return bytes;
}

/** `keep`: the builds whose files stay on disk, this one and (after WebGPU failed) the GPU one. */
async function loadBuild(parakeet: ParakeetModule, build: Build, keep: readonly Build[] = [build]) {
  postMessage({
    type: "load",
    name: `parakeet 0.6b${build.backend === "wasm" ? "" : " gpu"}`,
    expected: build.expected,
    cached: await isDownloaded(BASE + build.encoder),
  });
  // Files of another build (int8 after fp16, or the other way) would only fill the phone's storage.
  // A WebGPU failure keeps the fp16 files: it may pass, and they are 1.25 GB to fetch again.
  await keepDownloads(BASE, [...keep.map(({ encoder }) => BASE + encoder), BASE + DECODER]).catch(
    () => {},
  );
  // parakeet.js's own cache, from before these downloads.
  indexedDB.deleteDatabase("parakeet-cache-db");
  const progress = trackFiles((loaded, total) => postMessage({ type: "progress", loaded, total }));
  const download = (file: string) =>
    downloadFile(BASE + file, (loaded, total) => progress({ file, loaded, total }));
  const encoder = await download(build.encoder);
  const decoder = await download(DECODER);
  stage("graph");
  const graph = await externalGraph(encoder, `${build.encoder}.data`);
  stage("session", { graphBytes: graph.size });
  const encoderUrl = URL.createObjectURL(graph);
  const decoderUrl = URL.createObjectURL(decoder);
  try {
    const loaded = await parakeet.fromUrls({
      encoderUrl,
      encoderDataUrl: blobBytes(encoder),
      decoderUrl,
      tokenizerUrl: `${BASE}vocab.txt`,
      filenames: { encoder: build.encoder, decoder: DECODER },
      backend: build.backend,
    });
    stage("warmup");
    // One short pass compiles the GPU shaders, so the first utterance is not the slow one.
    await loaded.transcribe(new Float32Array(16_000), 16_000, {});
    return loaded;
  } finally {
    URL.revokeObjectURL(encoderUrl);
    URL.revokeObjectURL(decoderUrl);
  }
}

async function load() {
  const parakeet = (await import(/* @vite-ignore */ PARAKEET_JS)) as ParakeetModule;
  let loaded: Model;
  if (await hasWebGpu()) {
    try {
      loaded = await loadBuild(parakeet, WEBGPU);
    } catch (error) {
      stage("webgpu-failed", { message: String(error) });
      loaded = await loadBuild(parakeet, WASM, [WEBGPU, WASM]);
    }
  } else {
    loaded = await loadBuild(parakeet, WASM);
  }
  postMessage({ type: "ready" });
  return loaded;
}

self.onmessage = (event: MessageEvent<{ type: string; id?: number; pcm?: Float32Array }>) => {
  const message = event.data;
  if (model === null) {
    model = load();
    model.catch((error: unknown) => postMessage({ type: "failed", message: String(error) }));
  }
  if (message.type !== "transcribe") return;
  queue = queue.then(async () => {
    try {
      const result = await (await model!).transcribe(message.pcm!, 16_000, {});
      postMessage({ type: "text", id: message.id, text: (result.utterance_text ?? "").trim() });
    } catch (error) {
      postMessage({ type: "error", id: message.id, message: String(error) });
    }
  });
};
