// Speech in this browser, on both hosts: Parakeet
// listens, Kokoro (desktops) or Kale's own Matcha voice (phones) speaks, each on ONNX in its own worker.
// They start loading when the page opens and stay loaded for the page's life, across calls and tab
// hides: setting a model up takes seconds on a phone (Tim, 14 Nov: "always a cold start").
import type { VoiceBarModel } from "../VoiceBar";
import { autoRetrySeconds, replyVoice, sttModel } from "../settingsStore";
import { voiceLog } from "../voiceLog";
import type { LoadMessage } from "./readout";

type Reply =
  | { type: "text"; id: number; text: string }
  | {
      type: "audio";
      id: number;
      samples: Float32Array<ArrayBuffer>;
      rate: number;
      timing?: Record<string, number>;
    }
  | { type: "error"; id: number; message: string };

const MODEL_FAILED = "The voice models didn't load.";
export const NEEDS_WEBGPU = "Speech-to-text needs WebGPU";

// A model that was loading when the page ended without a pagehide took the tab down with it (iOS
// ends a tab over its memory limit): logged as speech.died on the next load, nothing else changes.
const LOADING = (name: string) => `lalala:loading:${name}`;
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
for (const name of ["parakeet", "kokoro", "matcha"]) {
  storage((store) => {
    if (store.getItem(LOADING(name)) === null) return;
    store.removeItem(LOADING(name));
    store.removeItem(`lalala:died:${name}`);
    voiceLog("system", "speech.died", { model: name });
  });
}
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

// One model loads at a time, in the order asked (Parakeet with the call, then Kokoro): Kokoro
// loading into WebGPU while Parakeet downloaded ended Tim's iPhone tab (14 Nov, three times).
let modelTurn: Promise<unknown> = Promise.resolve();

/** One model worker: its load state for the readout, and request/reply by id. */
function modelWorker(
  key: string,
  spawn: () => Worker,
  loadMessage: () => Record<string, unknown> = () => ({}),
) {
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
  };
  // iOS can refuse a model's WASM memory right after a reload ("RangeError: Out of memory", Tim's
  // iPhone, 14 Nov) and grant it seconds later: a failed load tries again on its own, twice.
  let retries = 0;
  let retryTimer = 0;
  const fail = (cause: string) => {
    console.warn("lalala: a speech model didn't load", cause);
    voiceLog("system", "speech.failed", { model: key, message: cause, retries, ...memory() });
    settle();
    failed = true;
    // A browser without what the model needs says so; anything else is the general line.
    markFailed(new Error(cause.includes(NEEDS_WEBGPU) ? cause.slice(cause.indexOf(NEEDS_WEBGPU)) : MODEL_FAILED));
    const every = autoRetrySeconds();
    if (every !== null && retries < 2 && !cause.includes(NEEDS_WEBGPU)) {
      retries += 1;
      retryTimer = window.setTimeout(() => {
        retryTimer = 0;
        if (failed) start();
      }, every * 1000);
    }
  };
  const release = () => {
    window.clearTimeout(retryTimer);
    retryTimer = 0;
    queued = false;
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
  let queued = false;
  // A failed model loads again on the next ask (the bar says "tap to retry").
  const start = () => {
    if (failed) release();
    if (worker !== null || queued) return;
    arm();
    queued = true;
    const turn = modelTurn.then(() => {
      if (!queued) return;
      queued = false;
      spawnNow();
      return ready.catch(() => {});
    });
    modelTurn = turn;
  };
  const spawnNow = () => {
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
        retries = 0;
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
    spawned.postMessage({ ...loadMessage(), type: "load" });
  };

  return {
    start,
    release,
    started: () => worker !== null || queued,
    ready: () => isReady,
    loading: () => (worker !== null || queued) && !isReady && !failed,
    /** Failed with no retry left: not loading any more (the next ask tries again). */
    gaveUp: () => failed && retryTimer === 0,
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
      start();
      await ready;
      const target = worker;
      if (target === null) throw new Error("closed");
      const id = nextId++;
      return new Promise<Reply>((resolve, reject) => {
        waiting.set(id, { resolve, reject });
        target.postMessage({ ...message, id }, transfer);
      });
    },
  };
}

// Spelled out at each call: bundlers only turn this exact form into a worker of its own.
const ears = modelWorker(
  "parakeet",
  () => new Worker(new URL("./parakeet.worker.ts", import.meta.url), { type: "module" }),
  // With the computer picked, the browser only hears while the computer doesn't answer: automatic.
  () => ({ model: sttModel() === "computer" ? "auto" : sttModel() }),
);
const kokoroBuild = () => {
  const picked = replyVoice();
  return picked === "kokoro-gpu" ? "gpu" : picked === "kokoro-cpu" ? "cpu" : "auto";
};
const voice = modelWorker(
  "kokoro",
  () => new Worker(new URL("./kokoro.worker.ts", import.meta.url), { type: "module" }),
  () => ({ build: kokoroBuild() }),
);
// A device that switches a model, or sends a task to the computer, frees the old one; the new one
// loads with the next utterance or sentence (the call's player asks for it).
let earsModel = sttModel();
let voiceBuild = kokoroBuild();
document.addEventListener("lalala:settings", () => {
  if (sttModel() !== earsModel) {
    earsModel = sttModel();
    ears.release();
    if (earsModel !== "computer" && speechPrewarmed) startEars();
  }
  if (kokoroBuild() !== voiceBuild) {
    voiceBuild = kokoroBuild();
    voice.release();
  }
});
const matcha = modelWorker(
  "matcha",
  () => new Worker(new URL("./matcha.worker.ts", import.meta.url), { type: "module" }),
);

let persisted = false;
const persistDownloads = () => {
  if (persisted) return;
  persisted = true;
  void navigator.storage
    ?.persist?.()
    .then((granted) => voiceLog("system", "speech.persist", { granted }))
    .catch(() => {});
};

// Debugging which model a device can't hold: `?speech=stt` loads only Parakeet (replies stay
// silent), `?speech=voice` only the reply voice (type in the bar to hear replies).
const only =
  typeof location === "undefined" ? null : new URLSearchParams(location.search).get("speech");
const earsOff = only === "voice";
const voiceOff = only === "stt";
if (only) voiceLog("system", "speech.only", { only });

// The computer running T3 (its speech service, through this app's server): picked per task in Settings.
// When it doesn't answer, this browser takes the task with its automatic model for a minute, then the
// next utterance or sentence asks the computer again.
const COMPUTER_PAUSE_MS = 60_000;
let computerDownUntil = 0;
const computerUp = () => Date.now() >= computerDownUntil;
const onComputer = {
  stt: () => sttModel() === "computer" && computerUp(),
  voice: () => replyVoice() === "computer" && computerUp(),
};
const computerFailed = (task: string, error: unknown) => {
  computerDownUntil = Date.now() + COMPUTER_PAUSE_MS;
  voiceLog("system", "speech.computer-down", { task, message: String(error) });
  document.dispatchEvent(new Event("lalala:computer-speech"));
};
/** The computer was picked but didn't answer lately: this browser stands in (Settings say so). */
export const computerStandIn = () => !computerUp();
let speechPrewarmed = false;

async function computer(path: string, init: RequestInit): Promise<Response> {
  // A phone between networks drops the odd request ("Load failed"): one retry keeps the words.
  const send = () => fetch(`/__lalala${path}`, { method: "POST", ...init });
  const response = await send().catch((cause: unknown) => {
    voiceLog("system", "speech.retry", { path, message: String(cause) });
    return new Promise<void>((resolve) => setTimeout(resolve, 800)).then(send);
  });
  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as { error?: unknown };
    throw new Error(
      typeof body.error === "string" ? body.error : "The computer's speech service didn't answer",
    );
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

/** Parakeet loads (once per call) so the first utterance does not wait for it. */
export const startEars = () => {
  if (earsOff || onComputer.stt()) return;
  persistDownloads();
  ears.start();
};
export const releaseEars = () => ears.release();
/** Kokoro loads with the call while it is the reply voice; another reply voice frees it. */
export const startKokoro = () => {
  if (!voiceOff && !onComputer.voice()) voice.start();
};
export const releaseKokoro = () => voice.release();
/** The same for Kale's Matcha voice. */
export const startMatcha = () => {
  if (!voiceOff) matcha.start();
};
export const releaseMatcha = () => matcha.release();

/** 16 kHz PCM, transcribed by Parakeet. The buffer moves to its worker. */
export async function transcribe(pcm: Float32Array<ArrayBuffer>): Promise<string> {
  if (earsOff) return "";
  if (onComputer.stt()) {
    try {
      const response = await computer("/stt", {
        headers: { "content-type": "audio/wav" },
        body: wavOf(pcm),
      });
      const body = (await response.json()) as { text?: unknown };
      return typeof body.text === "string" ? body.text : "";
    } catch (error) {
      computerFailed("stt", error);
    }
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
  if (voiceOff) return new Float32Array(0);
  // The computer's Kokoro, and a phone's stand-in Matcha, read plain text: the markup keeps the word.
  const plain = () => text.replace(/\[([^\]]+)\]\(\/[^)]*\/\)/g, "$1");
  if (onComputer.voice()) {
    try {
      const response = await computer("/tts", {
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: plain() }),
      });
      // 16-bit little-endian 24 kHz PCM.
      const bytes = await response.arrayBuffer();
      const view = new DataView(bytes, 0, bytes.byteLength - (bytes.byteLength % 2));
      const samples = new Float32Array(view.byteLength / 2);
      for (let i = 0; i < samples.length; i += 1) samples[i] = view.getInt16(i * 2, true) / 0x8000;
      return samples;
    } catch (error) {
      computerFailed("voice", error);
    }
  }
  // Standing in for the computer, a phone speaks with its automatic voice, Matcha.
  if (replyVoice() === "computer" && phone) return (await matchaSpeak(plain())).samples;
  const reply = await voice.ask({ type: "speak", text });
  if (reply.type !== "audio") throw new Error("Kokoro returned no audio");
  return reply.samples;
}

/** One sentence as 24 kHz PCM from Kale's Matcha voice, and how long its two models took. */
export async function matchaSpeak(
  text: string,
): Promise<{ samples: Float32Array<ArrayBuffer>; timing: Record<string, number> }> {
  if (voiceOff) return { samples: new Float32Array(0), timing: {} };
  const reply = await matcha.ask({ type: "speak", text });
  if (reply.type !== "audio") throw new Error("The voice returned no audio");
  return { samples: reply.samples, timing: reply.timing ?? {} };
}

/**
 * Starts the speech models as the page opens, one after the other (Parakeet, then the reply voice),
 * so a call finds them ready. A voice the user's cards registered loads with the call instead.
 */
export function prewarm() {
  speechPrewarmed = true;
  startEars();
  const voice = replyVoice();
  if (voice === "matcha") startMatcha();
  else if (voice.startsWith("kokoro")) startKokoro();
}

const phone = /iPhone|iPad|iPod|Android/.test(navigator.userAgent);

/** A model is still downloading or loading; a reload now would throw that away (callGuard). */
export const speechLoading = (): boolean =>
  ears.loading() || voice.loading() || matcha.loading();

/**
 * The models this call is downloading, for the bar's readout; empty while they only load from disk (or
 * before a worker has said which), null once all are ready.
 */
export function speechProgress(): ReadonlyArray<VoiceBarModel> | null {
  const loading = [ears, voice, matcha].filter((model) => model.started() && !model.gaveUp());
  if (loading.every((model) => model.ready())) return null;
  return loading.map((model) => model.model()).filter((model) => model !== null);
}

/**
 * Whether the computer running T3 can take a speech task: "ready", "loading" (its models are still
 * loading), "down" (this app's server can't reach it) or "absent" (this page has no route to it, as on
 * lalala.talk). Settings ask when they open; nothing here starts the service.
 */
export type ComputerSpeech = "ready" | "loading" | "down" | "absent";
export async function checkComputerSpeech(): Promise<ComputerSpeech> {
  try {
    const response = await fetch("/__lalala/local/health", { signal: AbortSignal.timeout(4_000) });
    if (!response.ok || !response.headers.get("content-type")?.includes("json")) return "absent";
    const body = (await response.json()) as { ready?: unknown; down?: unknown };
    return body.ready === true ? "ready" : body.down === true ? "down" : "loading";
  } catch {
    return "absent";
  }
}

/** This browser has WebGPU with 16-bit floats (the 0.6B on the GPU) / any WebGPU (Kokoro on the GPU). */
export async function checkGpu(): Promise<{ f16: boolean; any: boolean }> {
  const gpu = (navigator as Navigator & {
    gpu?: { requestAdapter(): Promise<{ features?: { has(name: string): boolean } } | null> };
  }).gpu;
  const adapter = gpu ? await gpu.requestAdapter().catch(() => null) : null;
  return { f16: adapter?.features?.has("shader-f16") === true, any: adapter !== null };
}
