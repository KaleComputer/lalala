// Silero VAD v5 on ONNX (WASM): speech probability for each 32 ms of the mic, so breath, noise and
// steps never count as Tim. Its own worker: Parakeet's runs can take a while and must not delay it.
const ORT = "https://cdn.jsdelivr.net/npm/onnxruntime-web@1.24.1/dist/ort.wasm.min.mjs";
const ORT_DIST = "https://cdn.jsdelivr.net/npm/onnxruntime-web@1.24.1/dist/";
const MODEL = "https://cdn.jsdelivr.net/npm/@ricky0123/vad-web@0.0.29/dist/silero_vad_v5.onnx";
const WINDOW = 512;
// The model's own wrapper feeds the last 64 samples of the previous window in front of each one.
const CONTEXT = 64;

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

let run: Promise<(window: Float32Array) => Promise<number>> | null = null;
let queue: Promise<unknown> = Promise.resolve();

async function load() {
  const ort = (await import(/* @vite-ignore */ ORT)) as Ort;
  ort.env.wasm.wasmPaths = ORT_DIST;
  ort.env.wasm.numThreads = 1;
  const session = await ort.InferenceSession.create(MODEL, { executionProviders: ["wasm"] });
  const sr = new ort.Tensor("int64", BigInt64Array.from([16_000n]), []);
  let state = new ort.Tensor("float32", new Float32Array(2 * 128), [2, 1, 128]);
  const input = new Float32Array(CONTEXT + WINDOW);
  postMessage({ type: "ready" });
  return async (window: Float32Array) => {
    input.copyWithin(0, WINDOW);
    input.set(window, CONTEXT);
    const out = await session.run({
      input: new ort.Tensor("float32", input.slice(), [1, CONTEXT + WINDOW]),
      state,
      sr,
    });
    state = out.stateN!;
    return out.output!.data[0] ?? 0;
  };
}

self.onmessage = (event: MessageEvent<{ type: string; pcm?: Float32Array }>) => {
  if (run === null) {
    run = load();
    run.catch((error: unknown) => postMessage({ type: "failed", message: String(error) }));
  }
  const pcm = event.data.pcm;
  if (event.data.type !== "frame" || pcm === undefined) return;
  queue = queue.then(async () => {
    try {
      postMessage({ type: "p", p: await (await run!)(pcm) });
    } catch {
      // A window the model could not take; the next one goes on.
    }
  });
};
