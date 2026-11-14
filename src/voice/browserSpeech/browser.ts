// Speech in this browser, on both hosts: Parakeet
// listens, Kokoro speaks, each on ONNX in its own worker. Both load with the call and are terminated
// when it ends, so the page holds none of their memory between calls.
import type { VoiceBarModel } from "../VoiceBar";
import { voiceLog } from "../voiceLog";
import type { LoadMessage } from "./readout";

type Reply =
  | { type: "text"; id: number; text: string }
  | { type: "audio"; id: number; samples: Float32Array<ArrayBuffer>; rate: number }
  | { type: "error"; id: number; message: string };

const MODEL_FAILED = "The voice models didn't load.";

// A model that was loading when the page ended without a pagehide took the tab down with it (iOS
// ends a tab over its memory limit): for half a day that model runs on the Mac's speech service
// (scripts/lalala-speech.sh, via vite/voice.ts) instead, so a call works rather than crash again.
const LOADING = (name: string) => `lalala:loading:${name}`;
const DIED = (name: string) => `lalala:died:${name}`;
const DIED_FOR_MS = 12 * 60 * 60 * 1000;
const storage = (action: (store: Storage) => void) => {
  try {
    action(localStorage);
  } catch {
    // Private mode or storage off: no crash memory.
  }
};
const loadingNow = new Set<string>();
const markLoading = (name: string, on: boolean) =>
  storage((store) =>
    on ? store.setItem(LOADING(name), String(Date.now())) : store.removeItem(LOADING(name)),
  );
for (const name of ["parakeet", "kokoro"]) {
  storage((store) => {
    if (store.getItem(LOADING(name)) === null) return;
    store.removeItem(LOADING(name));
    store.setItem(DIED(name), String(Date.now()));
    voiceLog("system", "speech.died", { model: name });
  });
}
declare global {
  /** The app sets it: its server reaches the Mac's speech service (`npm run speech`). lalala.talk has none. */
  var __lalalaMacSpeech: boolean | undefined;
}
const hasMac = () => globalThis.__lalalaMacSpeech === true;
// A model that crashed this tab lately runs on the Mac instead, where there is one.
const onMac = (name: string) => {
  if (!hasMac()) return false;
  let died = 0;
  storage((store) => (died = Number(store.getItem(DIED(name)) ?? 0)));
  return Date.now() - died < DIED_FOR_MS;
};
// The page ending on purpose (a reload, going away) or hiding is no crash.
const onPageHide = () => {
  for (const name of loadingNow) markLoading(name, false);
};
window.addEventListener("pagehide", onPageHide);
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden") onPageHide();
  else for (const name of loadingNow) markLoading(name, true);
});

const memory = () => {
  const heap = (performance as Performance & { memory?: { usedJSHeapSize: number } }).memory;
  return heap ? { heapMB: Math.round(heap.usedJSHeapSize / 1e6) } : {};
};

/** One model worker: its load state for the readout, and request/reply by id. */
function modelWorker(key: string, spawn: () => Worker, onSettled: () => void = () => {}) {
  let worker: Worker | null = null;
  let download: { name: string; loaded: number; total: number; cached: boolean } | null = null;
  let isReady = false;
  let failed = false;
  let markReady: () => void = () => {};
  let markFailed: (error: Error) => void = () => {};
  let ready = Promise.resolve();
  const waiting = new Map<
    number,
    { resolve: (reply: Reply) => void; reject: (error: Error) => void }
  >();
  let nextId = 1;

  const arm = () => {
    ready = new Promise<void>((resolve, reject) => {
      markReady = resolve;
      markFailed = reject;
    });
    ready.catch(() => {});
  };
  let startedAt = 0;
  let loggedTenth = -1;
  const settle = () => {
    loadingNow.delete(key);
    markLoading(key, false);
    onSettled();
  };
  const fail = (cause: string) => {
    console.warn("lalala: a speech model didn't load", cause);
    voiceLog("system", "speech.failed", { model: key, message: cause, ...memory() });
    settle();
    failed = true;
    markFailed(new Error(MODEL_FAILED));
  };
  const release = () => {
    loadingNow.delete(key);
    markLoading(key, false);
    worker?.terminate();
    worker = null;
    download = null;
    isReady = false;
    failed = false;
    for (const pending of waiting.values()) pending.reject(new Error("closed"));
    waiting.clear();
    markFailed(new Error("closed"));
  };
  // A failed model loads again on the next ask (the bar says "tap to retry").
  const start = () => {
    if (failed) release();
    if (worker !== null) return worker;
    arm();
    startedAt = performance.now();
    loggedTenth = -1;
    loadingNow.add(key);
    markLoading(key, true);
    const spawned = spawn();
    worker = spawned;
    spawned.onmessage = ({ data }: MessageEvent<LoadMessage | Reply>) => {
      if (data.type === "load") {
        download = { name: data.name, loaded: 0, total: data.expected, cached: data.cached };
        voiceLog("system", "speech.load", {
          model: key,
          name: data.name,
          expected: data.expected,
          cached: data.cached,
          ...memory(),
        });
      } else if (data.type === "stage") {
        const { type: _type, ...detail } = data;
        voiceLog("system", "speech.stage", {
          model: key,
          ...detail,
          ms: Math.round(performance.now() - startedAt),
          ...memory(),
        });
      } else if (data.type === "progress") {
        const tenth = Math.floor((data.loaded / Math.max(1, data.total)) * 10);
        if (tenth !== loggedTenth) {
          loggedTenth = tenth;
          voiceLog("system", "speech.progress", {
            model: key,
            loaded: data.loaded,
            total: data.total,
          });
        }
        if (download) {
          download = {
            ...download,
            loaded: data.loaded,
            total: Math.max(download.total, data.total),
          };
        }
      } else if (data.type === "ready") {
        voiceLog("system", "speech.ready", {
          model: key,
          ms: Math.round(performance.now() - startedAt),
          ...memory(),
        });
        isReady = true;
        settle();
        markReady();
      } else if (data.type === "failed") {
        fail(data.message);
      } else {
        const pending = waiting.get(data.id);
        waiting.delete(data.id);
        if (data.type === "error") pending?.reject(new Error(data.message));
        else pending?.resolve(data);
      }
    };
    // A worker that cannot even load (its script, its runtime) fails the model, not the page.
    spawned.onerror = (event) => fail(event.message || "the model's worker failed to load");
    spawned.postMessage({ type: "load" });
    return spawned;
  };

  return {
    start,
    release,
    started: () => worker !== null,
    ready: () => isReady,
    loading: () => worker !== null && !isReady && !failed,
    /** Its download row; null until a download from the network is known (cached files only load). */
    model(): VoiceBarModel | null {
      if (download === null || download.cached) return null;
      const { name, loaded, total } = download;
      if (isReady || loaded >= total) {
        const size = loaded > 0 ? loaded : total;
        return { name, loaded: size, total: size, done: isReady };
      }
      return { name, loaded, total, done: false };
    },
    async ask(message: Record<string, unknown>, transfer: Transferable[] = []): Promise<Reply> {
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

// A phone speaks with the Mac's Kokoro: the WASM one there took over 20 s per sentence (iPhone, 13 Nov).
// Phones speak through the Mac where there is one: Kokoro in a phone tab costs it most of its memory.
const phone = /iPhone|iPad|iPod|Android/.test(navigator.userAgent);
// Read at each call: the app sets __lalalaMacSpeech after this module has loaded.
const onPhone = () => phone && hasMac();
// Spelled out at each call: bundlers only turn this exact form into a worker of its own.
const ears = modelWorker(
  "parakeet",
  () => new Worker(new URL("./parakeet.worker.ts", import.meta.url), { type: "module" }),
);
const voice = modelWorker(
  "kokoro",
  () => new Worker(new URL("./kokoro.worker.ts", import.meta.url), { type: "module" }),
);

async function mac(path: string, init: RequestInit): Promise<Response> {
  const response = await fetch(path, { method: "POST", ...init });
  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as { error?: unknown };
    throw new Error(typeof body.error === "string" ? body.error : `speech ${response.status}`);
  }
  return response;
}

function wavOf(pcm: Float32Array): Blob {
  const data = new DataView(new ArrayBuffer(44 + pcm.length * 2));
  const text = (at: number, value: string) => {
    for (let i = 0; i < value.length; i += 1) data.setUint8(at + i, value.charCodeAt(i));
  };
  text(0, "RIFF");
  data.setUint32(4, 36 + pcm.length * 2, true);
  text(8, "WAVE");
  text(12, "fmt ");
  data.setUint32(16, 16, true);
  data.setUint16(20, 1, true);
  data.setUint16(22, 1, true);
  data.setUint32(24, 16_000, true);
  data.setUint32(28, 32_000, true);
  data.setUint16(32, 2, true);
  data.setUint16(34, 16, true);
  text(36, "data");
  data.setUint32(40, pcm.length * 2, true);
  for (let i = 0; i < pcm.length; i += 1) {
    data.setInt16(44 + i * 2, Math.max(-1, Math.min(1, pcm[i]!)) * 0x7fff, true);
  }
  return new Blob([data.buffer], { type: "audio/wav" });
}

// Best-effort storage goes under disk pressure, and with it a finished 1.25 GB download. persist()
// lives on the page only (not in workers); Chrome and Safari answer it without asking.
let persisted = false;
const persistDownloads = () => {
  if (persisted) return;
  persisted = true;
  void navigator.storage
    ?.persist?.()
    .then((granted) => voiceLog("system", "speech.persist", { granted }))
    .catch(() => {});
};

/** Parakeet loads (once per call) so the first utterance does not wait for it. */
export const startEars = () => {
  if (onMac("parakeet")) voiceLog("system", "speech.mac", { model: "parakeet" });
  else {
    persistDownloads();
    ears.start();
  }
};
export const releaseEars = () => ears.release();
/** Kokoro loads with the call while it is the reply voice; another reply voice frees it. */
export const startKokoro = () => {
  if (onPhone() || onMac("kokoro")) voiceLog("system", "speech.mac", { model: "kokoro" });
  else voice.start();
};
export const releaseKokoro = () => voice.release();

/** 16 kHz PCM, transcribed by Parakeet. The buffer moves to its worker. */
export async function transcribe(pcm: Float32Array<ArrayBuffer>): Promise<string> {
  if (onMac("parakeet")) {
    const response = await mac("/__lalala/stt?engine=local", {
      headers: { "content-type": "audio/wav" },
      body: wavOf(pcm),
    });
    const body = (await response.json()) as { text?: unknown };
    return typeof body.text === "string" ? body.text : "";
  }
  const reply = await ears.ask({ type: "transcribe", pcm }, [pcm.buffer]);
  return reply.type === "text" ? reply.text : "";
}

/**
 * Silero VAD on the mic, in its own worker: `listen` takes 512-sample windows of 16 kHz PCM and
 * `onProbability` gets each one's speech probability. Not ready (or failed), it hears nothing.
 */
export function openVad(onProbability: (probability: number) => void) {
  const worker = new Worker(new URL("./vad.worker.ts", import.meta.url), { type: "module" });
  let ready = false;
  worker.onmessage = ({ data }: MessageEvent<{ type: string; p?: number; message?: string }>) => {
    if (data.type === "ready") ready = true;
    else if (data.type === "p") onProbability(data.p ?? 0);
    else if (data.type === "failed")
      console.warn("lalala: the voice detector didn't load", data.message);
  };
  worker.onerror = (event) => console.warn("lalala: the voice detector failed", event.message);
  worker.postMessage({ type: "load" });
  return {
    ready: () => ready,
    listen: (window: Float32Array<ArrayBuffer>) =>
      worker.postMessage({ type: "frame", pcm: window }, [window.buffer]),
    close: () => worker.terminate(),
  };
}

/** One sentence as 24 kHz PCM from Kokoro; it reads misaki's `[word](/phonemes/)` markup. */
export async function kokoroSpeak(text: string): Promise<Float32Array<ArrayBuffer>> {
  if (onPhone() || onMac("kokoro")) {
    const response = await mac("/__lalala/tts?engine=local", {
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text, format: "pcm" }),
    });
    // 16-bit little-endian 24 kHz PCM.
    const bytes = await response.arrayBuffer();
    const view = new DataView(bytes, 0, bytes.byteLength - (bytes.byteLength % 2));
    const samples = new Float32Array(view.byteLength / 2);
    for (let i = 0; i < samples.length; i += 1) samples[i] = view.getInt16(i * 2, true) / 0x8000;
    return samples;
  }
  const reply = await voice.ask({ type: "speak", text });
  if (reply.type !== "audio") throw new Error("Kokoro returned no audio");
  return reply.samples;
}

/** A model is still downloading or loading; a reload now would throw that away (callGuard). */
export const speechLoading = (): boolean => ears.loading() || voice.loading();

/**
 * The models this call is downloading, for the bar's readout; empty while they only load from disk (or
 * before a worker has said which), null once all are ready.
 */
export function speechProgress(): ReadonlyArray<VoiceBarModel> | null {
  const loading = [ears, voice].filter((model) => model.started());
  if (loading.every((model) => model.ready())) return null;
  return loading.map((model) => model.model()).filter((model) => model !== null);
}
