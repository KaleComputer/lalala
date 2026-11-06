// Kokoro off the main thread, so the page stays smooth while a sentence renders.
import { KokoroTTS } from "kokoro-js";

const MODEL = "onnx-community/Kokoro-82M-v1.0-ONNX";
let model: Promise<KokoroTTS> | null = null;
let queue: Promise<unknown> = Promise.resolve();

async function load() {
  const gpu = (navigator as Navigator & { gpu?: { requestAdapter(): Promise<unknown> } }).gpu;
  const webgpu = gpu ? (await gpu.requestAdapter().catch(() => null)) !== null : false;
  const tts = await KokoroTTS.from_pretrained(MODEL, {
    dtype: webgpu ? "fp32" : "q8",
    device: webgpu ? "webgpu" : "wasm",
    progress_callback: (p: { status: string; progress?: number }) => {
      if (p.status === "progress") postMessage({ type: "progress", progress: p.progress ?? 0 });
    },
  });
  postMessage({ type: "ready", device: webgpu ? "webgpu" : "wasm" });
  return tts;
}

self.onmessage = (event: MessageEvent<{ type: string; id?: number; text?: string; voice?: string }>) => {
  const message = event.data;
  model ??= load();
  if (message.type !== "speak") return;
  queue = queue.then(async () => {
    try {
      const tts = await model!;
      const audio = await tts.generate(message.text!, { voice: (message.voice ?? "af_heart") as "af_heart" });
      const samples = audio.audio as Float32Array;
      postMessage({ type: "audio", id: message.id, samples, rate: audio.sampling_rate }, {
        transfer: [samples.buffer],
      });
    } catch (error) {
      postMessage({ type: "error", id: message.id, message: String(error) });
    }
  });
};
