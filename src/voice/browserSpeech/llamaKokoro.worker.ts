// Llama Kokoro, Kale's warm voice (f40warm) and the Automatic reply voice on every device: Kokoro's text
// side, tuned on Maya1 audio of that voice, with Kale's own 8.4M decoder writing 24 kHz audio directly
// (no vocoder, no iSTFT). One ONNX graph (fp16 text side, 8-bit decoder), 67.6 MB. Its words come from
// Kale's front end (matcha/kaleTts.js: dizione's text rules, the word list, the G2p), the same as
// Hazel's. Tim picked it by ear on 15 Nov over Llama Matcha. Files ship with lalala (llamaKokoro/),
// the runtime comes from the CDN. "Built with Llama": NOTICE.md and the settings' credits.
import { G2p, G2pModel, normalizer, readTable } from "./matcha/kaleTts.js";

const ORT = "https://cdn.jsdelivr.net/npm/onnxruntime-web@1.24.1/dist/ort.wasm.min.mjs";
const CACHE = "lalala-llama-kokoro";
// Llama Matcha's files, cached on devices before 15 Nov: nothing loads them any more.
const OLD_CACHES = ["lalala-matcha"];
const RATE = 24_000;

// Spelled out at each file: bundlers only emit an asset for this exact form.
const FILES = {
  model: new URL("./llamaKokoro/llama-kokoro-f40warm.onnx", import.meta.url).href,
  voicepack: new URL("./llamaKokoro/voicepack-f40warm.f32", import.meta.url).href,
  ids: new URL("./llamaKokoro/ipa2kokoro.json", import.meta.url).href,
  g2pModel: new URL("./matcha/g2p.bin", import.meta.url).href,
  lexicon: new URL("./matcha/lexicon.tsv", import.meta.url).href,
  override: new URL("./matcha/override.tsv", import.meta.url).href,
};
const EXPECTED = 72_900_000;
// The voice's own settings (its package's config.json): its duration head reads ~10 % short, so 0.92.
const SPEED = 0.92;
const STYLE = 256;
// Kokoro reads at most 512 ids, its two pads included.
const MAX_IDS = 510;
const PIECE_GAP_S = 0.06;
// The decoder's raw peak stays at or under ~0.8 on the bench; this only catches a stray louder one.
const PEAK = 0.95;

type Tensor = { readonly data: Float32Array; readonly dims: ReadonlyArray<number> };
type Session = {
  run(feeds: Record<string, unknown>): Promise<Record<string, Tensor>>;
  release?(): Promise<void>;
};
type Ort = {
  env: { wasm: { wasmPaths: string; numThreads: number } };
  InferenceSession: { create(model: Uint8Array, options: object): Promise<Session> };
  Tensor: new (type: string, data: BigInt64Array | Float32Array, dims: number[]) => unknown;
};
type Voice = {
  readonly ort: Ort;
  readonly session: Session;
  readonly voicepack: Float32Array;
  readonly toId: Map<string, number>;
  readonly g2p: G2p;
  readonly normalize: (text: string) => string;
};

let voice: Promise<Voice> | null = null;
let queue: Promise<unknown> = Promise.resolve();

/** Each file from this browser's cache, else the network (then cached); bytes reported as they come. */
async function fetchAll(onBytes: (loaded: number, total: number) => void) {
  for (const old of OLD_CACHES) void caches.delete(old).catch(() => {});
  const cache = await caches.open(CACHE).catch(() => null);
  const urls = Object.values(FILES);
  // A new build's files have new names: the old ones only fill the device's storage.
  if (cache !== null) {
    for (const old of await cache.keys()) if (!urls.includes(old.url)) void cache.delete(old);
  }
  const hits = await Promise.all(urls.map((url) => cache?.match(url) ?? undefined));
  const cached = hits.every((hit) => hit !== undefined);
  postMessage({ type: "load", name: "llama kokoro", expected: EXPECTED, cached });
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
  return bodies;
}

async function load(): Promise<Voice> {
  const ort = (await import(/* @vite-ignore */ /* webpackIgnore: true */ /* turbopackIgnore: true */ ORT)) as Ort;
  ort.env.wasm.wasmPaths = ORT.slice(0, ORT.lastIndexOf("/") + 1);
  // Cross-origin isolated pages (both hosts) run the WASM on several threads.
  ort.env.wasm.numThreads = self.crossOriginIsolated
    ? Math.min(4, navigator.hardwareConcurrency || 4)
    : 1;
  const bodies = await fetchAll((loaded, total) => postMessage({ type: "progress", loaded, total }));
  const text = (at: number) => new TextDecoder().decode(bodies[at]);
  postMessage({ type: "stage", stage: "session", threads: ort.env.wasm.numThreads });
  // Unoptimized: the optimizer's 32-bit copies of the 16-bit text side left the page ~150 MB bigger
  // (WebKit, 15 Nov: ~0.95 GB with it as with Llama Matcha, ~1.1 GB without) for ~5 % speed.
  const session = await ort.InferenceSession.create(new Uint8Array(bodies[0]!), {
    executionProviders: ["wasm"],
    graphOptimizationLevel: "disabled",
  });
  // The runtime holds its own copy of the weights now: the download's goes.
  bodies[0] = new ArrayBuffer(0);
  const lex = readTable(text(4));
  readTable(text(5), lex);
  const ready: Voice = {
    ort,
    session,
    voicepack: new Float32Array(bodies[1]!),
    toId: new Map(Object.entries(JSON.parse(text(2)) as Record<string, number>)),
    g2p: new G2p(lex, new G2pModel(bodies[3]!)),
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

/** One IPA piece: ids (one per codepoint, a 0 pad at each end), the voice's style row, 24 kHz audio. */
async function render(ready: Voice, ipa: string): Promise<Float32Array> {
  const { ort, toId, voicepack } = ready;
  const ids = [0];
  for (const ch of ipa) {
    const id = toId.get(ch);
    if (id !== undefined) ids.push(id);
  }
  ids.push(0);
  const n = ids.length - 2;
  if (n <= 0) return new Float32Array(0);
  const row = Math.min(n, voicepack.length / STYLE) - 1;
  const result = await ready.session.run({
    input_ids: new ort.Tensor("int64", BigInt64Array.from(ids.map(BigInt)), [1, ids.length]),
    style: new ort.Tensor("float32", voicepack.slice(row * STYLE, (row + 1) * STYLE), [1, STYLE]),
    speed: new ort.Tensor("float32", Float32Array.from([SPEED]), [1]),
  });
  return result.waveform!.data;
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
  let peak = 0;
  for (const sample of samples) peak = Math.max(peak, Math.abs(sample));
  if (peak > PEAK) for (let i = 0; i < samples.length; i++) samples[i] = (samples[i]! * PEAK) / peak;
  return { samples, timing: { g2pMs, modelMs: performance.now() - started - g2pMs } };
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
