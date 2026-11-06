// Kokoro 82M on ONNX (kokoro-js): the app's voice, rendered off the page's thread.
import { KokoroTTS } from "kokoro-js";

import { trackFiles } from "./readout";

const MODEL = "onnx-community/Kokoro-82M-v1.0-ONNX";
const VOICE = "af_heart";
let model: Promise<KokoroTTS> | null = null;
let queue: Promise<unknown> = Promise.resolve();

async function cached(file: string) {
  try {
    const cache = await caches.open("transformers-cache");
    return (await cache.match(`https://huggingface.co/${MODEL}/resolve/main/${file}`)) !== undefined;
  } catch {
    return false;
  }
}

async function load() {
  const gpu = (navigator as Navigator & { gpu?: { requestAdapter(): Promise<unknown> } }).gpu;
  const webgpu = gpu ? (await gpu.requestAdapter().catch(() => null)) !== null : false;
  // WebGPU wants the full-precision model; the quantized one suits WASM.
  const dtype = webgpu ? "fp32" : "q8";
  postMessage({
    type: "load",
    name: "kokoro 82m",
    // The model and a voice, so the readout knows the size before the first byte.
    expected: webgpu ? 327_000_000 : 93_000_000,
    cached: await cached(webgpu ? "onnx/model.onnx" : "onnx/model_quantized.onnx"),
  });
  const tts = await KokoroTTS.from_pretrained(MODEL, {
    dtype,
    device: webgpu ? "webgpu" : "wasm",
    progress_callback: trackFiles((loaded, total) => postMessage({ type: "progress", loaded, total })),
  });
  // One short render compiles the shaders, so the first reply is not the slow one.
  await tts.generate("Hi.", { voice: VOICE });
  postMessage({ type: "ready" });
  return tts;
}

self.onmessage = (event: MessageEvent<{ type: string; id?: number; text?: string }>) => {
  const message = event.data;
  if (model === null) {
    model = load();
    model.catch((error) => postMessage({ type: "failed", message: String(error) }));
  }
  if (message.type !== "speak") return;
  queue = queue.then(async () => {
    try {
      const tts = await model!;
      const audio = await tts.generate(message.text!, { voice: VOICE });
      const samples = audio.audio as Float32Array;
      postMessage({ type: "audio", id: message.id, samples, rate: audio.sampling_rate }, { transfer: [samples.buffer] });
    } catch (error) {
      postMessage({ type: "error", id: message.id, message: String(error) });
    }
  });
};
