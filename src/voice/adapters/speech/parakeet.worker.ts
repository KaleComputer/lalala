// Parakeet TDT 0.6B v2, the app's own speech-to-text model, on ONNX in the browser (parakeet.js).
// WASM int8: the WebGPU builds are fp16/fp32 encoders of 1.2-2.4 GB that run out of memory there.
import { fromHub } from "parakeet.js";

import { trackFiles } from "./readout";

const MODEL = "parakeet-tdt-0.6b-v2";
const REPO = "ysdede/parakeet-tdt-0.6b-v2-onnx";
type Model = Awaited<ReturnType<typeof fromHub>>;
let model: Promise<Model> | null = null;
let queue: Promise<unknown> = Promise.resolve();

/** parakeet.js keeps downloads in IndexedDB under these keys (its hub.js). */
function cached(file: string) {
  return new Promise<boolean>((resolve) => {
    const request = indexedDB.open("parakeet-cache-db", 1);
    request.onerror = () => resolve(false);
    request.onupgradeneeded = () => request.result.createObjectStore("file-store");
    request.onsuccess = () => {
      try {
        const get = request.result.transaction("file-store").objectStore("file-store").getKey(`hf-${REPO}-main--${file}`);
        get.onsuccess = () => resolve(get.result !== undefined);
        get.onerror = () => resolve(false);
      } catch {
        resolve(false);
      }
      request.result.close();
    };
  });
}

async function load() {
  postMessage({
    type: "load",
    name: "parakeet 0.6b",
    // The int8 encoder and decoder, so the readout knows the size before the first byte.
    expected: 661_000_000,
    cached: await cached("encoder-model.int8.onnx"),
  });
  const loaded = await fromHub(MODEL, {
    backend: "wasm",
    encoderQuant: "int8",
    decoderQuant: "int8",
    progress: trackFiles((bytes, total) => postMessage({ type: "progress", loaded: bytes, total })),
  });
  postMessage({ type: "ready" });
  return loaded;
}

self.onmessage = (event: MessageEvent<{ type: string; id?: number; pcm?: Float32Array }>) => {
  const message = event.data;
  if (model === null) {
    model = load();
    model.catch((error) => postMessage({ type: "failed", message: String(error) }));
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
