// Kale's standalone 4-action full-duplex turn-policy ONNX model (`p2b_standalone_d160_sup`,
// 1.73 MB INT8) on WASM in its own worker. Runs only when `labs.duplexTurnPolicy` is enabled
// (default OFF), keeping zero memory/CPU cost when off.
import "./wasmMeter";
import {
  DUPLEX_ENC_SUBSAMPLE,
  DUPLEX_FRAME_SAMPLES,
  DUPLEX_N_MELS,
  DUPLEX_PROSODY_DIM,
  DUPLEX_SAMPLE_RATE,
  computeNemoMel,
  detectAcousticFilledPause,
  extractCausalProsody,
} from "../duplexFeatures";
import { applyDuplexDecision, type DuplexSystemState } from "../duplexTurn";

const ORT = "https://cdn.jsdelivr.net/npm/onnxruntime-web@1.24.1/dist/ort.wasm.min.mjs";
const ORT_DIST = "https://cdn.jsdelivr.net/npm/onnxruntime-web@1.24.1/dist/";
const MODEL_PATH = "/models/duplex-turn-policy/model.int8.onnx";

// Right-aligned streaming window: 2.56 s (T = 32 encoder frames @ 80 ms) matches the trained
// sweet spot (1.44–4.0 s) while keeping WASM inference fast (~5–15 ms on 1 thread).
const MAX_WINDOW_FRAMES = 32;
const MIN_WINDOW_FRAMES = 18; // 1.44 s minimum right-aligned context (padded on left if shorter)
const RING_SAMPLES = DUPLEX_SAMPLE_RATE * 4; // 4.0 s ring buffer

type Tensor = { readonly data: Float32Array };
type Ort = {
  env: { wasm: { wasmPaths: string; numThreads: number } };
  Tensor: new (type: string, data: unknown, dims: number[]) => Tensor;
  InferenceSession: {
    create(
      url: string,
      options: object,
    ): Promise<{ run(feeds: Record<string, Tensor>): Promise<Record<string, Tensor>> }>;
  };
};

type Runner = (wav: Float32Array, state: DuplexSystemState) => Promise<void>;

let runner: Promise<Runner> | null = null;
let busy = false;
let pendingState: DuplexSystemState | null = null;

// Circular 16 kHz Float32 audio buffer.
const ring = new Float32Array(RING_SAMPLES);
let writePos = 0;
let totalWritten = 0;

function appendSamples(pcm: Float32Array): void {
  const n = pcm.length;
  if (n >= RING_SAMPLES) {
    ring.set(pcm.subarray(n - RING_SAMPLES), 0);
    writePos = 0;
    totalWritten = RING_SAMPLES;
    return;
  }
  const first = Math.min(n, RING_SAMPLES - writePos);
  ring.set(pcm.subarray(0, first), writePos);
  if (first < n) ring.set(pcm.subarray(first), 0);
  writePos = (writePos + n) % RING_SAMPLES;
  totalWritten = Math.min(RING_SAMPLES, totalWritten + n);
}

function readWindow(sampleCount: number): Float32Array {
  const out = new Float32Array(sampleCount);
  const avail = Math.min(totalWritten, sampleCount);
  if (avail === 0) return out;
  // Right-align available audio so t_now is always at the end of the window.
  const dstStart = sampleCount - avail;
  const srcStart = (writePos - avail + RING_SAMPLES) % RING_SAMPLES;
  const first = Math.min(avail, RING_SAMPLES - srcStart);
  out.set(ring.subarray(srcStart, srcStart + first), dstStart);
  if (first < avail) out.set(ring.subarray(0, avail - first), dstStart + first);
  return out;
}

function resetBuffer(): void {
  ring.fill(0);
  writePos = 0;
  totalWritten = 0;
  pendingState = null;
}

async function load(): Promise<Runner> {
  const ort = (await import(/* @vite-ignore */ /* webpackIgnore: true */ /* turbopackIgnore: true */ ORT)) as Ort;
  ort.env.wasm.wasmPaths = ORT_DIST;
  ort.env.wasm.numThreads = 1;
  const modelUrl = new URL(MODEL_PATH, self.location.origin).href;
  const session = await ort.InferenceSession.create(modelUrl, { executionProviders: ["wasm"] });
  postMessage({ type: "ready" });

  return async (wav: Float32Array, state: DuplexSystemState) => {
    const t0 = performance.now();
    const encFrames = Math.max(
      MIN_WINDOW_FRAMES,
      Math.min(MAX_WINDOW_FRAMES, Math.floor(wav.length / DUPLEX_FRAME_SAMPLES)),
    );
    const { mel, frames: melFrames } = computeNemoMel(wav, encFrames * DUPLEX_ENC_SUBSAMPLE);
    const pros = extractCausalProsody(wav, encFrames);
    const acousticFiller = detectAcousticFilledPause(pros, encFrames);

    const out = await session.run({
      mel: new ort.Tensor("float32", mel, [1, DUPLEX_N_MELS, melFrames]),
      pros: new ort.Tensor("float32", pros, [1, encFrames, DUPLEX_PROSODY_DIM]),
      state: new ort.Tensor("int64", BigInt64Array.from([BigInt(state)]), [1]),
    });
    const logitsData = out.logits?.data;
    if (!logitsData || logitsData.length < 4) return;
    const decision = applyDuplexDecision(logitsData, state);
    postMessage({
      type: "decision",
      action: decision.action,
      probs: decision.probs,
      logits: decision.logits,
      state,
      acousticFiller,
      inferMs: Math.round((performance.now() - t0) * 10) / 10,
    });
  };
}

function pump(state: DuplexSystemState): void {
  if (runner === null) return;
  if (busy) {
    // Coalesce backlog: always evaluate the latest audio window rather than queueing stale frames.
    pendingState = state;
    return;
  }
  busy = true;
  const frames = Math.max(
    MIN_WINDOW_FRAMES,
    Math.min(MAX_WINDOW_FRAMES, Math.floor(totalWritten / DUPLEX_FRAME_SAMPLES)),
  );
  const wav = readWindow(frames * DUPLEX_FRAME_SAMPLES);
  void runner
    .then((run) => run(wav, state))
    .catch(() => {
      // Transient inference error on a single window; continue cleanly on the next chunk.
    })
    .finally(() => {
      busy = false;
      if (pendingState !== null) {
        const next = pendingState;
        pendingState = null;
        pump(next);
      }
    });
}

self.onmessage = (
  event: MessageEvent<{ type: string; pcm?: Float32Array; state?: DuplexSystemState }>,
) => {
  if (runner === null) {
    runner = load();
    runner.catch((error: unknown) => {
      runner = null;
      postMessage({ type: "failed", message: String(error) });
    });
  }
  if (event.data.type === "reset") {
    resetBuffer();
    return;
  }
  if (event.data.type !== "frame" || event.data.pcm === undefined) return;
  appendSamples(event.data.pcm);
  pump(event.data.state === 1 ? 1 : 0);
};
