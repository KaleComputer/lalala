// Llama Matcha, Kale's own voice and the phones' reply voice: a Matcha-TTS model trained from scratch
// on Maya1 audio of 149 voices, voice f40warm baked in, with Vocos fine-tuned on Maya1 audio. On the
// CPU (WASM), about 19x faster than Kokoro's q8 build in Safari: acoustic weights stored in 8 bits,
// the vocoder's in 16 (it is the part 8 bits hurt). Files ship with lalala (matcha/), the runtime
// comes from the CDN. "Built with Llama": NOTICE.md and the settings' credits.
import { Voice, normalize } from "./matcha/kaleTts.js";

const ORT = "https://cdn.jsdelivr.net/npm/onnxruntime-web@1.24.1/dist/ort.wasm.min.mjs";
const CACHE = "lalala-matcha";
const RATE = 24_000;

// Spelled out at each file: bundlers only emit an asset for this exact form.
const FILES = {
  model: new URL("./matcha/llama-matcha-f40warm.onnx", import.meta.url).href,
  vocoder: new URL("./matcha/vocos-maya-noclip-g0485.onnx", import.meta.url).href,
  g2pModel: new URL("./matcha/g2p.bin", import.meta.url).href,
  tokens: new URL("./matcha/tokens.txt", import.meta.url).href,
  lexicon: new URL("./matcha/lexicon.tsv", import.meta.url).href,
  override: new URL("./matcha/override.tsv", import.meta.url).href,
};
const EXPECTED = 49_300_000;
// The voice's own settings (its package's candidate.json): a little slower, less random.
const LENGTH_SCALE = 1.17;
const NOISE_SCALE = 0.3;
// The vocoder's gain (0.485) keeps every bench line at or under 0.85; this only catches a stray louder one.
const PEAK = 0.95;

type Ort = {
  env: { wasm: { wasmPaths: string; numThreads: number } };
};

let voice: Promise<Voice> | null = null;
let queue: Promise<unknown> = Promise.resolve();

/** Each file from this browser's cache, else the network (then cached); bytes reported as they come. */
async function fetchAll(onBytes: (loaded: number, total: number) => void) {
  const cache = await caches.open(CACHE).catch(() => null);
  const urls = Object.values(FILES);
  // A new build's files have new names: the old ones only fill the device's storage.
  if (cache !== null) {
    for (const old of await cache.keys()) if (!urls.includes(old.url)) void cache.delete(old);
  }
  const hits = await Promise.all(urls.map((url) => cache?.match(url) ?? undefined));
  const cached = hits.every((hit) => hit !== undefined);
  postMessage({ type: "load", name: "llama matcha", expected: EXPECTED, cached });
  const loaded = new Map<string, number>();
  const report = () => {
    let sum = 0;
    for (const bytes of loaded.values()) sum += bytes;
    onBytes(sum, Math.max(EXPECTED, sum));
  };
  const bodies = await Promise.all(
    urls.map(async (url, at) => {
      const hit = hits[at];
      if (hit !== undefined) return hit.arrayBuffer();
      const response = await fetch(url);
      if (!response.ok || response.body === null) throw new Error(`download ${response.status}`);
      const reader = response.body.getReader();
      const parts: Uint8Array<ArrayBuffer>[] = [];
      let size = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        parts.push(value);
        size += value.byteLength;
        loaded.set(url, size);
        report();
      }
      const blob = new Blob(parts);
      void cache?.put(url, new Response(blob)).catch(() => {});
      return blob.arrayBuffer();
    }),
  );
  const text = (at: number) => new TextDecoder().decode(bodies[at]);
  return {
    model: bodies[0]!,
    vocoder: bodies[1]!,
    g2pModel: bodies[2]!,
    tokens: text(3),
    lexicon: text(4),
    override: text(5),
  };
}

async function load() {
  const ort = (await import(/* @vite-ignore */ ORT)) as Ort;
  ort.env.wasm.wasmPaths = ORT.slice(0, ORT.lastIndexOf("/") + 1);
  // Cross-origin isolated pages (both hosts) run the WASM on several threads.
  ort.env.wasm.numThreads = self.crossOriginIsolated
    ? Math.min(4, navigator.hardwareConcurrency || 4)
    : 1;
  const files = await fetchAll((loaded, total) => postMessage({ type: "progress", loaded, total }));
  postMessage({ type: "stage", stage: "session", threads: ort.env.wasm.numThreads });
  const loaded = await Voice.load(ort, files, {
    sessionOptions: { executionProviders: ["wasm"], graphOptimizationLevel: "all" },
  });
  await loaded.speakSentence("Hi.", { lengthScale: LENGTH_SCALE, noiseScale: NOISE_SCALE });
  postMessage({ type: "ready" });
  return loaded;
}

/** 22,050 Hz to the player's 24 kHz (Catmull-Rom between samples). */
function resample(pcm: Float32Array, from: number): Float32Array<ArrayBuffer> {
  const out = new Float32Array(Math.floor((pcm.length * RATE) / from));
  const step = from / RATE;
  const at = (i: number) => pcm[Math.min(pcm.length - 1, Math.max(0, i))]!;
  for (let i = 0; i < out.length; i++) {
    const x = i * step;
    const k = Math.floor(x);
    const t = x - k;
    const p0 = at(k - 1);
    const p1 = at(k);
    const p2 = at(k + 1);
    const p3 = at(k + 2);
    out[i] =
      p1 +
      0.5 * t * (p2 - p0 + t * (2 * p0 - 5 * p1 + 4 * p2 - p3 + t * (3 * (p1 - p2) + p3 - p0)));
  }
  return out;
}

self.onmessage = (event: MessageEvent<{ type: string; id?: number; text?: string }>) => {
  const message = event.data;
  if (voice === null) {
    voice = load();
    voice.catch((error: unknown) => postMessage({ type: "failed", message: String(error) }));
  }
  if (message.type !== "speak") return;
  queue = queue.then(async () => {
    try {
      const ready = await voice!;
      const text = normalize(message.text!);
      const started = performance.now();
      const { pcm, ms } = await ready.speakSentence(text, {
        lengthScale: LENGTH_SCALE,
        noiseScale: NOISE_SCALE,
      });
      const samples = resample(pcm, ready.sampleRate);
      let peak = 0;
      for (const sample of samples) peak = Math.max(peak, Math.abs(sample));
      if (peak > PEAK) for (let i = 0; i < samples.length; i++) samples[i] = (samples[i]! * PEAK) / peak;
      postMessage(
        {
          type: "audio",
          id: message.id,
          samples,
          rate: RATE,
          timing: { ...ms, totalMs: performance.now() - started },
        },
        { transfer: [samples.buffer] },
      );
    } catch (error) {
      postMessage({ type: "error", id: message.id, message: String(error) });
    }
  });
};
