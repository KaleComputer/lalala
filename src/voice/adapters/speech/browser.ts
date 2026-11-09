// lalala.talk's speech: the app's models (Parakeet listens, Kokoro speaks) on ONNX in two workers,
// so no audio leaves the visitor's machine. Both load on the first call and stay cached.
import type { ModelProgress, SpeechAdapter } from "..";
import type { LoadMessage } from "./readout";

type Reply =
  | { type: "text"; id: number; text: string }
  | { type: "audio"; id: number; samples: Float32Array; rate: number }
  | { type: "error"; id: number; message: string };

const MODEL_FAILED = "The voice models didn't load.";

/** One model worker: its load state for the readout, and request/reply by id. */
function modelWorker(spawn: () => Worker) {
  let worker: Worker | null = null;
  let download: { name: string; loaded: number; total: number; cached: boolean } | null = null;
  let isReady = false;
  let failure: string | null = null;
  let markReady: () => void = () => {};
  let markFailed: (error: Error) => void = () => {};
  let ready = Promise.resolve();
  const arm = () => {
    ready = new Promise<void>((resolve, reject) => {
      markReady = resolve;
      markFailed = reject;
    });
    ready.catch(() => {});
  };
  arm();
  const waiting = new Map<number, { resolve: (reply: Reply) => void; reject: (error: Error) => void }>();
  let nextId = 1;

  // A failed model loads again on the next call (the bar says "tap to retry"); its error says what
  // failed in plain words, the cause stays in the console.
  const fail = (cause: string) => {
    console.warn("lalala: a voice model didn't load", cause);
    failure = cause;
    markFailed(new Error(MODEL_FAILED));
  };
  const start = () => {
    if (failure !== null) {
      worker?.terminate();
      worker = null;
      failure = null;
      download = null;
      arm();
    }
    if (worker !== null) return worker;
    worker = spawn();
    worker.onmessage = ({ data }: MessageEvent<LoadMessage | Reply>) => {
      if (data.type === "load") download = { name: data.name, loaded: 0, total: data.expected, cached: data.cached };
      else if (data.type === "progress" && download)
        download = { ...download, loaded: data.loaded, total: Math.max(download.total, data.total) };
      else if (data.type === "ready") {
        isReady = true;
        markReady();
      } else if (data.type === "failed") fail(data.message); else if ("id" in data) {
        const pending = waiting.get(data.id);
        waiting.delete(data.id);
        if (data.type === "error") pending?.reject(new Error(data.message));
        else pending?.resolve(data);
      }
    };
    // A worker that cannot even load (its script, its runtime) fails the model, not the page.
    worker.onerror = (event) => fail(event.message || "the model's worker failed to load");
    worker.postMessage({ type: "load" });
    return worker;
  };

  return {
    start,
    get loaded() {
      return ready;
    },
    failure: () => failure,
    ready: () => isReady,
    model(): ModelProgress | null {
      if (download === null) return null;
      const { name, loaded, total, cached } = download;
      // Bytes from the cache count as here; a ready model shows what it really took.
      if (cached || isReady || loaded >= total) {
        const size = loaded > 0 ? loaded : total;
        return { name, loaded: size, total: size, done: true };
      }
      return { name, loaded, total, done: false };
    },
    async ask(message: Record<string, unknown>, transfer: Transferable[] = []) {
      const target = start();
      await ready;
      const id = nextId++;
      return new Promise<Reply>((resolve, reject) => {
        waiting.set(id, { resolve, reject });
        target.postMessage({ ...message, id }, transfer);
      });
    },
  };
}

export function browserSpeech(): SpeechAdapter {
  // Spelled out at each call: bundlers only turn this exact form into a worker of its own.
  const ears = modelWorker(() => new Worker(new URL("./parakeet.worker.ts", import.meta.url), { type: "module" }));
  const voice = modelWorker(() => new Worker(new URL("./kokoro.worker.ts", import.meta.url), { type: "module" }));
  return {
    async listen() {
      // A call needs both: the voice loads alongside, so the first reply does not wait for it.
      ears.start();
      voice.start();
      let utterance: Int16Array[] = [];
      return {
        send: (pcm) => void utterance.push(pcm),
        async commit() {
          const chunks = utterance;
          utterance = [];
          let length = 0;
          for (const chunk of chunks) length += chunk.length;
          const pcm = new Float32Array(length);
          let at = 0;
          for (const chunk of chunks) for (const sample of chunk) pcm[at++] = sample / 0x8000;
          const reply = await ears.ask({ type: "transcribe", pcm }, [pcm.buffer]);
          return reply.type === "text" ? reply.text : "";
        },
        close: () => {
          utterance = [];
        },
      };
    },
    async *speak(text, signal) {
      const reply = await voice.ask({ type: "speak", text });
      if (signal.aborted || reply.type !== "audio") return;
      yield reply.samples;
    },
    progress() {
      if (ears.ready() && voice.ready()) return null;
      const models = [ears.model(), voice.model()].filter((model) => model !== null);
      return models.length > 0 ? models : null;
    },
  };
}
