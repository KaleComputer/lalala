// Speech in this browser, on both hosts: Parakeet
// listens, Kale's warm voice Kale's Kokoro (Automatic, every device) or Kokoro 82M speaks, each on ONNX
// in its own worker.
// They start loading when the page opens and stay loaded for the page's life, across calls and tab
// hides: setting a model up takes seconds on a phone (Tim, 14 Nov: "always a cold start").
import type { VoiceBarModel } from "../VoiceBar";
import {
  SMALL_VOICES,
  TINY10_VOICE,
  modelVoice,
  autoRetrySeconds,
  defaultReplyVoice,
  isKaleVoice,
  isPhoneDevice,
  replyVoice,
  replyVoicePick,
  speechModelName,
  sttModel,
} from "../settingsStore";
import { voiceLog } from "../voiceLog";
import { gpuTrial } from "./gpuTrial";
import type { LoadMessage, WorkerMeter } from "./readout";
import { memoryMoment, registerMeter } from "../memoryTrail";
import { type ComputerSpeech, computerRoute } from "./computerRoute";

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
/** iOS refusing a model's memory ("RangeError: Out of memory"): it often grants it seconds later. */
const OUT_OF_MEMORY = /out of memory/i;
export const MEMORY_TEXT = "Not enough memory for this voice on this phone right now. Still trying.";
/** The worker's words when a model can't fit this browser's storage (parakeet.worker's NO_ROOM). */
const NO_ROOM = /Not enough storage for the voice models/;
const NO_ROOM_RETRY_S = 180;
export const NEEDS_WEBGPU = "needs WebGPU";

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
for (const name of ["parakeet", "kokoro", "kale-kokoro", "llama-kokoro"]) {
  storage((store) => {
    if (store.getItem(LOADING(name)) === null) return;
    store.removeItem(LOADING(name));
    store.removeItem(`lalala:died:${name}`);
    voiceLog("system", "speech.died", { model: name });
  });
}
// kale-tts-1-tiny took Tim's iPhone tab down on WebGPU (15 Nov), loading and right after it was
// ready: a kill no script can catch. A page that ends with a Kale voice in memory and no pagehide
// leaves this mark; the next load logs it and loads the same voice again (Tim, 16 Nov: no notice, no switch).
// The mark names its page, which holds a Web Lock for its life: another open lalala tab's mark is
// no crash, since the browser frees a page's locks only when the page is gone.
const VOICE_LIVE = "lalala:voice-live";
const PAGE = Math.random().toString(36).slice(2, 10);
const pageLock = (page: string) => `lalala:page:${page}`;
let liveVoice: string | null = null;
let lockHeld = false;
const markLive = (voice: string | null) => {
  storage((store) => (voice ? store.setItem(VOICE_LIVE, `${voice} ${PAGE}`) : store.removeItem(VOICE_LIVE)));
  if (voice === null || lockHeld || !navigator.locks) return;
  lockHeld = true;
  void navigator.locks.request(pageLock(PAGE), () => new Promise<never>(() => {}));
};
let died: string | null = null;
storage((store) => {
  died = store.getItem(VOICE_LIVE);
});
const crashChecked: Promise<void> =
  died === null
    ? Promise.resolve()
    : (navigator.locks?.query() ?? Promise.resolve({ held: [] }))
        .then(({ held }) => {
          const [voice, page] = died!.split(" ");
          if (held?.some((lock) => lock.name === pageLock(page ?? ""))) return;
          storage((store) => store.removeItem(VOICE_LIVE));
          voiceLog("system", "speech.died", { model: voice });
        })
        .catch(() => {});
let crashKnown = died === null;
void crashChecked.then(() => {
  crashKnown = true;
});
// The page ending on purpose (a reload, going away) or hiding is no crash.
const onPageHide = () => {
  for (const name of loadingNow) markLoading(name, false);
  markLive(null);
};
window.addEventListener("pagehide", onPageHide);
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden") onPageHide();
  else {
    for (const name of loadingNow) markLoading(name, true);
    markLive(liveVoice);
  }
});

const memory = () => {
  const heap = (performance as Performance & { memory?: { usedJSHeapSize: number } }).memory;
  return heap ? { heapMB: Math.round(heap.usedJSHeapSize / 1e6) } : {};
};

// Settings show each task's model state live: every change below bumps this and tells them.
let stateVersion = 0;
let loggedActive = "";
const notify = () => {
  stateVersion += 1;
  logActive();
  document.dispatchEvent(new Event("lalala:speech-state"));
};
export const speechStateVersion = () => stateVersion;
export const subscribeSpeechState = (listener: () => void) => {
  document.addEventListener("lalala:speech-state", listener);
  return () => document.removeEventListener("lalala:speech-state", listener);
};
export type ModelStatus = {
  readonly phase: "idle" | "downloading" | "loading" | "ready" | "failed";
  /** What the worker said it loads ("parakeet 110m", "kokoro 82m gpu"…), once it has. */
  readonly name: string | null;
  readonly loaded: number;
  readonly total: number;
  readonly error: string | null;
  /** When a failed load tries again on its own (Date.now() ms), or 0. */
  readonly retryAt: number;
};

// The largest speech-to-text build this page's storage took (parakeet.worker's storage-fallback):
// a retry starts there instead of filling the storage again.
let storageCeiling: string | null = null;

// One model loads at a time, in the order asked (Parakeet with the call, then Kokoro): Kokoro
// loading into WebGPU while Parakeet downloaded ended Tim's iPhone tab (14 Nov, three times).
let modelTurn: Promise<unknown> = Promise.resolve();

/** One model worker: its load state for the readout, and request/reply by id. */
function modelWorker(
  key: string,
  spawn: () => Worker,
  loadMessage: () => Record<string, unknown> = () => ({}),
  /** Hears every message from the worker, and its end (released or failed). */
  watch: {
    message?: (data: LoadMessage | Reply) => void;
    ended?: () => void;
    /** A smaller model to suggest when this one doesn't fit in memory (never switched to on its own). */
    smaller?: () => string | null;
  } = {},
) {
  let worker: Worker | null = null;
  let download: { name: string; loaded: number; total: number; cached: boolean } | null = null;
  let isReady = false;
  let failed = false;
  let markReady: () => void = () => {};
  let markFailed: (error: Error) => void = () => {};
  let ready = Promise.resolve();
  let waiting = new Map<
    number,
    { resolve: (reply: Reply) => void; reject: (error: Error) => void }
  >();
  let nextId = 1;
  let device: string | null = null;
  let meter: WorkerMeter | null = null;

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
  // iPhone, 14 Nov) and grant it seconds later: a failed load tries again on its own, at the
  // interval Settings set ("Retry when loading fails"), until it loads or that is turned off.
  let retries = 0;
  let retryTimer = 0;
  let retryAt = 0;
  let failure: string | null = null;
  const cancelRetry = () => {
    window.removeEventListener("focus", retryOnFocus);
    window.clearTimeout(retryTimer);
    retryTimer = 0;
    retryAt = 0;
  };
  /**
   * (Re)schedules a failed model's next try at the interval Settings set now; none when it's off.
   * A full storage never stops trying: quietly every few minutes, and whenever the page is back in
   * front (space may have been freed meanwhile).
   */
  const scheduleRetry = () => {
    cancelRetry();
    const noRoom = NO_ROOM.test(failure ?? "");
    const every = noRoom ? NO_ROOM_RETRY_S : autoRetrySeconds();
    // Retrying can't give a browser WebGPU.
    if (!failed || every === null || failure?.includes(NEEDS_WEBGPU)) return;
    if (noRoom) window.addEventListener("focus", retryOnFocus, { once: true });
    retryAt = Date.now() + every * 1000;
    retryTimer = window.setTimeout(() => {
      retryTimer = 0;
      retryAt = 0;
      if (failed) start();
    }, every * 1000);
  };
  const retryOnFocus = () => {
    if (failed && NO_ROOM.test(failure ?? "")) start();
  };
  const fail = (cause: string) => {
    watch.ended?.();
    console.warn("lalala: a speech model didn't load", cause);
    voiceLog("system", "speech.failed", { model: key, message: cause, retries, ...memory() });
    settle();
    failed = true;
    retries += 1;
    // A browser without what the model needs says so; anything else is the general line.
    const smaller = OUT_OF_MEMORY.test(cause) ? watch.smaller?.() : null;
    failure =
      cause.includes(NEEDS_WEBGPU) || NO_ROOM.test(cause)
        ? cause.replace(/^\w*Error:\s*/, "")
        : OUT_OF_MEMORY.test(cause)
          ? `${MEMORY_TEXT}${smaller ? ` ${smaller} is smaller: pick it in Settings.` : ""}`
          : MODEL_FAILED;
    markFailed(new Error(failure));
    scheduleRetry();
    notify();
  };
  const release = () => {
    watch.ended?.();
    cancelRetry();
    failure = null;
    queued = false;
    loadingNow.delete(key);
    markLoading(key, false);
    if (worker !== null) voiceLog("system", "speech.released", { model: key, ...(meter ?? {}) });
    worker?.terminate();
    worker = null;
    meter = null;
    device = null;
    download = null;
    isReady = false;
    failed = false;
    for (const pending of waiting.values()) pending.reject(new Error("closed"));
    waiting.clear();
    markFailed(new Error("closed"));
    notify();
  };
  /**
   * Frees the model once the utterance or sentence it is working on is done: the old worker finishes
   * its replies on its own while the next ask already starts the new one.
   */
  const releaseWhenIdle = () => {
    const old = worker;
    const pending = waiting;
    if (old === null || pending.size === 0) return release();
    worker = null;
    waiting = new Map();
    old.onmessage = ({ data }: MessageEvent<LoadMessage | Reply>) => {
      if (data.type !== "text" && data.type !== "audio" && data.type !== "error") return;
      const reply = pending.get(data.id);
      pending.delete(data.id);
      if (data.type === "error") reply?.reject(new Error(data.message));
      else reply?.resolve(data);
      if (pending.size === 0) old.terminate();
    };
    old.onerror = () => {
      for (const reply of pending.values()) reply.reject(new Error("closed"));
      old.terminate();
    };
    release();
  };
  let queued = false;
  // A failed model loads again on the next ask (the bar says "tap to retry").
  const start = () => {
    if (failed) release();
    if (worker !== null || queued) return;
    arm();
    queued = true;
    notify();
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
      if (data.type === "meter") {
        meter = data;
        memoryMoment(data.growingMB ? `${key}.wasm-grow` : null);
        return;
      }
      watch.message?.(data);
      if (data.type === "load") {
        download = { name: data.name, loaded: 0, total: data.expected, cached: data.cached };
        notify();
        voiceLog("system", "speech.load", {
          model: key,
          name: data.name,
          expected: data.expected,
          cached: data.cached,
          ...("voice" in data && data.voice ? { voice: data.voice } : {}),
          ...memory(),
        });
      } else if (data.type === "stage") {
        const { type: _type, ...detail } = data;
        if (detail.stage === "storage-fallback" && typeof detail.to === "string")
          storageCeiling = detail.to;
        if (detail.stage === "backend" && typeof detail.device === "string") device = detail.device;
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
          notify();
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
        notify();
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
    releaseWhenIdle,
    scheduleRetry,
    status(): ModelStatus {
      const phase =
        failed ? "failed"
        : isReady ? "ready"
        : worker === null && !queued ? "idle"
        : download !== null && !download.cached && download.loaded < download.total ? "downloading"
        : "loading";
      return {
        phase,
        name: download?.name ?? null,
        loaded: download?.loaded ?? 0,
        total: download?.total ?? 0,
        error: failed ? failure : null,
        retryAt,
      };
    },
    /** What this model holds now, for the memory trail; null while nothing is loaded. */
    memory() {
      if (worker === null && !queued) return null;
      const { phase, name, total } = this.status();
      const { wasmMB, gpuMB, growingMB } = meter ?? {};
      return { model: key, name, phase, device, fileMB: Math.round(total / 1e6), wasmMB, gpuMB, growingMB };
    },
    started: () => worker !== null || queued,
    ready: () => isReady,
    loading: () => (worker !== null || queued) && !isReady && !failed,
    /** Failed with no retry left: not loading any more (the next ask tries again). */
    gaveUp: () => failed && retryTimer === 0,
    /** Its download row; null until a download from the network is known (cached files only load). */
    model(): VoiceBarModel | null {
      if (download === null || download.cached) return null;
      const { loaded, total } = download;
      const name = speechModelName(download.name);
      if (isReady || loaded >= total) {
        const size = loaded > 0 ? loaded : total;
        return { name, loaded: size, total: size, done: isReady };
      }
      return { name, loaded, total, done: false };
    },
    async ask(message: Record<string, unknown>, transfer: Transferable[] = []): Promise<Reply> {
      start();
      // A model swapped out while this waited for it to load: wait for its replacement instead.
      await ready.catch((error: unknown) => {
        if (!(error instanceof Error) || error.message !== "closed") throw error;
        start();
        return ready;
      });
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
  // While the computer is wanted (by hand or by Automatic), the browser only stands in: the lightest.
  () => ({
    model: sttModel() === "computer" || wantsComputer.stt() ? "110m" : sttModel(),
    ceiling: storageCeiling,
  }),
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
// Kale's own voices, one at a time in one worker: the warm Kokoro (Automatic, and the phone's
// stand-in for your computer), or kale-tts-1-tiny when picked. Matcha is gone (Tim, 15 Nov).
/** The Kale voice to load: the one picked, or Automatic's while standing in for your computer. */
const kaleBuild = (): string => {
  const picked = replyVoice();
  return isKaleVoice(picked) ? picked : defaultReplyVoice();
};
/** What kaleVoice.worker loads for it: the model folder, the voice inside it, its speed. */
const kaleModel = () => {
  const build = kaleBuild();
  const small = SMALL_VOICES[build];
  return {
    model: small?.model,
    voice: modelVoice(build),
    speed: small?.speed ?? 1,
    expected: small?.bytes,
    cpuOnly: small?.cpuOnly === true,
  };
};
// WebGPU first on every device (Tim, 16 Nov), the CPU when it isn't there or errors (the worker
// falls back); a try that took the tab down leaves its marker, and that device stays on the CPU.
const gpu = gpuTrial("lalala", (since) => voiceLog("system", "webgpu.crashed", { since }));
// Phones stay on the CPU: WebGPU-first took Tim's iPhone tab down in a loop while the voice loaded
// (16 Nov, 2493e61), before the marker could keep it off.
let gpuFailedHere = false;
// After "Out of memory", the next tries start onnxruntime on one thread: a lighter start (logged).
let memoryTight = false;
const gpuTry = () => !isPhoneDevice() && !gpuFailedHere && gpu.allowed();
export const webGpuBenched = () => gpu.benched();
export const retryWebGpu = () => {
  gpu.reset();
  document.dispatchEvent(new Event("lalala:settings"));
};
const warm = modelWorker(
  "kale-kokoro",
  () => {
    liveVoice = kaleBuild();
    markLive(liveVoice);
    if (gpuTry() && !kaleModel().cpuOnly) gpu.begin();
    return new Worker(new URL("./kaleVoice.worker.ts", import.meta.url), { type: "module" });
  },
  () => ({
    ...kaleModel(),
    device: gpuTry() && !kaleModel().cpuOnly ? "gpu-if-available" : "wasm",
    ...(memoryTight ? { threads: 1 } : {}),
  }),
  {
    // Over once the first real sentence came back on WebGPU, or the model ended up on the CPU.
    message: (data) => {
      // WebGPU failed to load (caught): this page loads again at once, in a fresh worker on the CPU.
      if (data.type === "failed" && data.message.includes("webgpu-failed:")) {
        gpuFailedHere = true;
        voiceLog("system", "webgpu.failed", { message: data.message.slice(0, 300) });
        queueMicrotask(() => warm.start());
      }
      if (data.type === "failed" && OUT_OF_MEMORY.test(data.message)) memoryTight = true;
      if (data.type === "audio") gpu.passed();
      if (data.type === "stage" && data.stage === "backend" && data.device !== "webgpu") gpu.passed();
    },
    ended: () => gpu.passed(),
    smaller: () => {
      const build = kaleBuild();
      return build === TINY10_VOICE ? "kale-tts-1-nano" : null;
    },
  },
);
// A device that switches a model, or sends a task to the computer, frees the old one once its
// current utterance or sentence is done; the new one loads right away when the page has.
let earsModel = sttModel();
let voiceBuild = kokoroBuild();
let voicePick = replyVoice();
let warmBuild = kaleBuild();
let warmVoice = modelVoice(kaleBuild());
let retryEvery = autoRetrySeconds();
document.addEventListener("lalala:settings", () => {
  trackWhere();
  if (autoRetrySeconds() !== retryEvery) {
    retryEvery = autoRetrySeconds();
    for (const model of [ears, voice, warm]) model.scheduleRetry();
    // A computer that isn't answering is asked again at the new interval (or not at all when off).
    scheduleComputer();
    notify();
  }
  if (sttModel() !== earsModel) {
    earsModel = sttModel();
    ears.releaseWhenIdle();
    if (earsModel === "computer") void refreshComputerSpeech();
    else if (speechPrewarmed) startEars();
  }
  // Another voice inside the same model: the running worker swaps its voice file, since a second
  // copy of the model in a tab is what iOS ends it for (15 Nov).
  if (kaleBuild() === warmBuild && modelVoice(kaleBuild()) !== warmVoice) {
    warmVoice = modelVoice(kaleBuild());
    if (warm.started()) void warm.ask({ type: "voice", voice: warmVoice }).catch(() => {});
  }
  if (kokoroBuild() !== voiceBuild || replyVoice() !== voicePick) {
    if (kokoroBuild() !== voiceBuild) voice.releaseWhenIdle();
    // Another Kale model: the same worker frees the old one's session and loads the new one into the
    // memory it leaves, so a tab never holds two copies (a second copy is what iOS ends it for).
    if (kaleBuild() !== warmBuild && warm.started()) {
      liveVoice = kaleBuild();
      markLive(liveVoice);
      void warm.ask({ type: "model", ...kaleModel() }).catch(() => {});
    }
    warmBuild = kaleBuild();
    warmVoice = modelVoice(kaleBuild());
    voiceBuild = kokoroBuild();
    voicePick = replyVoice();
    if (voicePick === "computer") void refreshComputerSpeech();
    else if (speechPrewarmed) prewarmVoice();
  }
});

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
// While it isn't ready, this browser stands in with its lightest models (Parakeet 110M, Kale's Kokoro on
// a phone), kept loaded; the computer is asked again (never from a page with no route to it, like
// lalala.talk). Automatic tries the computer for hearing too, never gives up on it (backing off up to
// 5 min, again on every page open), uses this browser meanwhile, and keeps whichever path its own
// timings say is faster here. Automatic's voice is Kale's Kokoro, which only runs here.
const COMPUTER_LOADING_MS = 3_000;
const COMPUTER_BACKOFF_MAX_S = 300;
let computerState: ComputerSpeech | "checking" = "checking";
let computerTimer = 0;
let computerTries = 0;
// A healthy service is no proof its speech works (a wrong route still answers health): the stand-ins
// stay loaded and the backoff keeps growing until the computer has really answered, so a failing
// computer can't make a phone reload Parakeet every few seconds until the tab runs out of memory.
const standingIn = () => computerState !== "ready";

type Task = "stt" | "voice";
const computerAnswered: Record<Task, boolean> = { stt: false, voice: false };
type Where = "browser" | "computer";
const TIMINGS_KEY = "lalala:speech-timings";
/** Milliseconds of work per second of audio, per task and path, averaged over recent turns. */
let timings: Record<Task, Partial<Record<Where, number>>> = (() => {
  try {
    const stored = JSON.parse(localStorage.getItem(TIMINGS_KEY) ?? "{}") as Partial<typeof timings>;
    return { stt: stored.stt ?? {}, voice: stored.voice ?? {} };
  } catch {
    return { stt: {}, voice: {} };
  }
})();
export const speechTimings = () => timings;
function record(task: Task, where: Where, ms: number, audioMs: number) {
  ran[task] = true;
  if (audioMs < 300) return;
  const perSecond = ms / (audioMs / 1000);
  const before = timings[task][where];
  timings = {
    ...timings,
    [task]: { ...timings[task], [where]: before === undefined ? perSecond : before * 0.7 + perSecond * 0.3 },
  };
  try {
    localStorage.setItem(TIMINGS_KEY, JSON.stringify(timings));
  } catch {
    // No storage: measured again next time.
  }
  trackWhere();
  notify();
}
/** This browser measured clearly faster than the computer for a task: Automatic stays here. */
/** Automatic keeps a task in this browser once it measured clearly faster here than your computer. */
export const browserFaster = (task: Task) => {
  const { browser, computer } = timings[task];
  return browser !== undefined && computer !== undefined && browser < computer * 0.8;
};
const automatic = { stt: () => sttModel() === "auto", voice: () => replyVoicePick() === "auto" };
/**
 * Who stands in for your computer's voice (picked by hand): the same Kokoro voice in this browser on a
 * desktop, so a reply never changes voice with where it runs; Kale's Kokoro on a phone (Kokoro 82M there
 * ended tabs).
 */
const voiceStandIn = (): "kokoro" | "warm" => (isPhoneDevice() ? "warm" : "kokoro");
/** A task the computer should do, picked by hand or by Automatic. */
const wantsComputer = {
  stt: () =>
    sttModel() === "computer" || (automatic.stt() && computerState !== "absent" && !browserFaster("stt")),
  // Automatic's voice is Kale's Kokoro, which only runs here: it never moves to your computer's Kokoro.
  voice: () => replyVoice() === "computer",
};
const onComputer = {
  stt: () => wantsComputer.stt() && !standingIn(),
  voice: () => wantsComputer.voice() && !standingIn(),
};
/** Automatic or the computer is still getting the computer ready; this browser does the task meanwhile. */
export const tryingComputer = (task: Task) =>
  (task === "stt" ? wantsComputer.stt() : wantsComputer.voice()) &&
  computerState !== "ready" &&
  computerState !== "absent";
/** The computer's state, as this page last saw it; Settings show it. */
export const computerSpeechState = () => computerState;

/** Loads (or frees) this browser's stand-ins for the tasks the computer does or doesn't do now. */
function fitModels() {
  if (wantsComputer.stt()) {
    if (standingIn()) startEars();
    else if (computerAnswered.stt) ears.releaseWhenIdle();
  }
  if (wantsComputer.voice()) {
    if (standingIn()) voiceStandIn() === "kokoro" ? voice.start() : startWarmVoice();
    else if (computerAnswered.voice) {
      voice.releaseWhenIdle();
      warm.releaseWhenIdle();
    }
  }
}
let computerSince = Date.now();
/** When the computer's speech service went into its current state (Settings count up from it). */
export const computerSpeechSince = () => computerSince;

// Where each task runs now, and since when: Automatic's switches show in Settings, not only in logs.
const whereNow = (task: Task): Where => ((task === "stt" ? onComputer.stt() : onComputer.voice()) ? "computer" : "browser");
const runsAt: Record<Task, { where: Where; since: number | null }> = {
  stt: { where: "browser", since: null },
  voice: { where: "browser", since: null },
};
// A move counts as a switch only once the task has run somewhere; before that it is the first pick.
const ran: Record<Task, boolean> = { stt: false, voice: false };
function trackWhere() {
  for (const task of ["stt", "voice"] as const) {
    const where = whereNow(task);
    if (where === runsAt[task].where) continue;
    runsAt[task] = { where, since: ran[task] ? Date.now() : null };
    voiceLog("system", "speech.switched", { task, where, automatic: automatic[task]() });
  }
}
/** Where a task runs now and when it last moved there (null: it has run there since the page opened). */
export const speechRunsAt = (task: Task) => runsAt[task];

/** Still loading: asked again shortly. Not answering: at the retry interval, if retrying is on. */
function scheduleComputer() {
  window.clearTimeout(computerTimer);
  computerTimer = 0;
  const retry = autoRetrySeconds();
  const every =
    computerState === "loading" || computerState === "starting" ? COMPUTER_LOADING_MS / 1000
    : computerState === "down"
      ? Math.min((retry ?? 5) * 2 ** Math.min(computerTries, 8), COMPUTER_BACKOFF_MAX_S)
      : null;
  if (every !== null) computerTimer = window.setTimeout(() => void refreshComputerSpeech(), every * 1000);
}
function setComputer(state: ComputerSpeech) {
  const changed = state !== computerState;
  if (state !== "ready") computerAnswered.stt = computerAnswered.voice = false;
  computerTries = state === "down" ? computerTries + 1 : computerTries;
  if (changed) computerSince = Date.now();
  computerState = state;
  trackWhere();
  scheduleComputer();
  if (changed) {
    voiceLog("system", "speech.computer", { state });
    notify();
  }
  // Out of reach for good (lalala.talk): Automatic's browser models replace the light stand-ins.
  if (changed && state === "absent" && speechPrewarmed) {
    if (automatic.stt()) ears.releaseWhenIdle();
    startEars();
    prewarmVoice();
  }
  if (speechPrewarmed) fitModels();
}
/**
 * Asks the computer's speech service whether it can take a task now; with a task on the computer it
 * starts the service if it isn't running (`force`: Try again, even right after a failed start).
 */
export async function refreshComputerSpeech(force = false) {
  const wanted = sttModel() === "computer" || replyVoice() === "computer" || automatic.stt();
  setComputer(await checkComputerSpeech(force ? "force" : wanted ? "auto" : undefined));
}
let speechPrewarmed = false;
/** The computer did a task: now its stand-in can go. */
function computerWorked(task: Task) {
  computerTries = 0;
  if (computerAnswered[task]) return;
  computerAnswered[task] = true;
  if (speechPrewarmed) fitModels();
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
  // Before the computer has answered once, wait: it decides between the stand-in and the real model.
  if (earsOff || onComputer.stt() || (wantsComputer.stt() && computerState === "checking")) return;
  persistDownloads();
  ears.start();
};
export const releaseEars = () => ears.releaseWhenIdle();
/** Kokoro loads with the call while it is the reply voice; another reply voice frees it. */
export const startKokoro = () => {
  if (voiceOff) return;
  // Wanted on your computer: wait for its first answer, then fitModels loads the stand-in if needed.
  if (wantsComputer.voice()) {
    if (standingIn() && computerState !== "checking" && voiceStandIn() === "kokoro") voice.start();
    return;
  }
  if (replyVoice().startsWith("kokoro")) voice.start();
};
export const releaseKokoro = () => voice.releaseWhenIdle();
/** The same for Kale's warm voice, Kale's Kokoro. */
export const startWarmVoice = () => {
  if (voiceOff || onComputer.voice()) return;
  if (!crashKnown) {
    void crashChecked.then(startWarmVoice);
    return;
  }
  if (wantsComputer.voice() && voiceStandIn() === "kokoro") return;
  warm.start();
};
export const releaseWarmVoice = () => {
  // Standing in for the computer, Kale's Kokoro speaks: the call's player can't free it then.
  if (!(wantsComputer.voice() && standingIn() && voiceStandIn() === "warm")) warm.releaseWhenIdle();
};

/** 16 kHz PCM, transcribed by Parakeet. The buffer moves to its worker. */
export async function transcribe(pcm: Float32Array<ArrayBuffer>): Promise<string> {
  if (earsOff) return "";
  const audioMs = (pcm.length / 16_000) * 1000;
  const startedAt = performance.now();
  if (onComputer.stt()) {
    try {
      const text = await computerRoute().stt(wavOf(pcm));
      record("stt", "computer", performance.now() - startedAt, audioMs);
      computerWorked("stt");
      return text;
    } catch (error) {
      voiceLog("system", "speech.computer-down", { task: "stt", message: String(error) });
      setComputer("down");
    }
  }
  const browserAt = performance.now();
  const reply = await ears.ask({ type: "transcribe", pcm }, [pcm.buffer]);
  if (ears.ready()) record("stt", "browser", performance.now() - browserAt, audioMs);
  return reply.type === "text" ? reply.text : "";
}

/**
 * Silero VAD on the mic, in its own worker, loaded once for the page's life and before the other
 * models: on a phone a voice detector loaded after Kale's Kokoro got no WebAssembly memory and never
 * said ready (15 Nov), and a call without it heard no barge-in. A failed load is logged and retried.
 */
let vadWorker: Worker | null = null;
let vadMeter: WorkerMeter | null = null;
let vadReady = false;
let vadFailures = 0;
let vadListener: ((probability: number) => void) | null = null;
const VAD_RETRIES = 3;
// The models wait for the detector's first load (ready or failed), at most this long.
const VAD_FIRST_MS = 10_000;
let vadSettled: (() => void) | null = null;
function startVad() {
  if (vadWorker !== null) return;
  const startedAt = performance.now();
  const worker = new Worker(new URL("./vad.worker.ts", import.meta.url), { type: "module" });
  vadWorker = worker;
  if (vadFailures === 0 && vadSettled === null) {
    const settled = new Promise<void>((resolve) => {
      vadSettled = resolve;
      window.setTimeout(resolve, VAD_FIRST_MS);
    });
    modelTurn = modelTurn.then(() => settled);
  }
  const failed = (message: string) => {
    vadSettled?.();
    if (vadWorker !== worker) return;
    voiceLog("system", "speech.failed", { model: "vad", message, retries: vadFailures });
    worker.terminate();
    vadWorker = null;
    vadMeter = null;
    vadReady = false;
    vadFailures += 1;
    if (vadFailures <= VAD_RETRIES) window.setTimeout(startVad, 2_000 * vadFailures);
  };
  worker.onmessage = ({
    data,
  }: MessageEvent<{ type: string; p?: number; message?: string } | WorkerMeter>) => {
    if (data.type === "meter") {
      vadMeter = data as WorkerMeter;
      memoryMoment(null);
    } else if (data.type === "p") vadListener?.((data as { p?: number }).p ?? 0);
    else if (data.type === "ready") {
      vadSettled?.();
      vadReady = true;
      voiceLog("system", "speech.ready", { model: "vad", ms: Math.round(performance.now() - startedAt) });
    } else if (data.type === "failed") failed((data as { message?: string }).message ?? "");
  };
  worker.onerror = (event) => failed(event.message || "worker error");
  worker.postMessage({ type: "load" });
}

/**
 * The voice detector for one call: `listen` takes 512-sample windows of 16 kHz PCM and
 * `onProbability` gets each one's speech probability. Not ready (or failed), it hears nothing.
 */
export function openVad(onProbability: (probability: number) => void) {
  startVad();
  vadListener = onProbability;
  vadWorker?.postMessage({ type: "reset" });
  return {
    ready: () => vadReady && vadListener === onProbability,
    listen: (window: Float32Array<ArrayBuffer>) =>
      vadWorker?.postMessage({ type: "frame", pcm: window }, [window.buffer]),
    close: () => {
      if (vadListener === onProbability) vadListener = null;
    },
  };
}

/** One sentence from the computer's Kokoro, as 24 kHz PCM; null when the computer didn't answer. */
async function computerSpeak(text: string): Promise<Float32Array<ArrayBuffer> | null> {
  const startedAt = performance.now();
  try {
    // 16-bit little-endian 24 kHz PCM.
    const bytes = await computerRoute().tts(text);
    const view = new DataView(bytes, 0, bytes.byteLength - (bytes.byteLength % 2));
    const samples = new Float32Array(view.byteLength / 2);
    for (let i = 0; i < samples.length; i += 1) samples[i] = view.getInt16(i * 2, true) / 0x8000;
    record("voice", "computer", performance.now() - startedAt, (samples.length / 24_000) * 1000);
    computerWorked("voice");
    return samples;
  } catch (error) {
    voiceLog("system", "speech.computer-down", { task: "voice", message: String(error) });
    setComputer("down");
    return null;
  }
}

/** One sentence as 24 kHz PCM from Kokoro; it reads misaki's `[word](/phonemes/)` markup. */
export async function kokoroSpeak(text: string): Promise<Float32Array<ArrayBuffer>> {
  if (voiceOff) return new Float32Array(0);
  // The computer's Kokoro, and Kale's Kokoro standing in for it, read plain text: the markup keeps the word.
  const plain = () => text.replace(/\[([^\]]+)\]\(\/[^)]*\/\)/g, "$1");
  if (onComputer.voice()) {
    const samples = await computerSpeak(plain());
    if (samples !== null) return samples;
  }
  // Standing in for the computer on a phone, Kale's Kokoro speaks; on a desktop the same Kokoro, here.
  if (wantsComputer.voice() && voiceStandIn() === "warm") return (await warmSpeak(plain())).samples;
  const browserAt = performance.now();
  const reply = await voice.ask({ type: "speak", text });
  if (reply.type !== "audio") throw new Error("Kokoro returned no audio");
  record("voice", "browser", performance.now() - browserAt, (reply.samples.length / 24_000) * 1000);
  return reply.samples;
}

/** One sentence as 24 kHz PCM from Kale's warm voice, Kale's Kokoro, and how long it took. */
export async function warmSpeak(
  text: string,
): Promise<{ samples: Float32Array<ArrayBuffer>; timing: Record<string, number> }> {
  if (voiceOff) return { samples: new Float32Array(0), timing: {} };
  // Kale's Kokoro reads plain text: misaki's markup keeps the word.
  const plain = text.replace(/\[([^\]]+)\]\(\/[^)]*\/\)/g, "$1");
  const browserAt = performance.now();
  const reply = await warm.ask({ type: "speak", text: plain });
  if (reply.type === "audio")
    record("voice", "browser", performance.now() - browserAt, (reply.samples.length / 24_000) * 1000);
  if (reply.type !== "audio") throw new Error("The voice returned no audio");
  return { samples: reply.samples, timing: reply.timing ?? {} };
}

/**
 * Starts the speech models as the page opens, one after the other (Parakeet, then the reply voice),
 * so a call finds them ready. A voice the user's cards registered loads with the call instead.
 */
/** Automatic sends this task to your computer when it can (its voice is Kale's Kokoro, here). */
export const automaticTriesComputer = (task: Task) => task === "stt";
export function prewarm() {
  speechPrewarmed = true;
  startVad();
  startEars();
  prewarmVoice();
  if (sttModel() === "computer" || replyVoice() === "computer" || automatic.stt())
    void refreshComputerSpeech();
}
/** The reply voice's browser model; with the computer picked, fitModels decides once it has answered. */
function prewarmVoice() {
  const picked = replyVoice();
  if (isKaleVoice(picked)) startWarmVoice();
  else if (picked.startsWith("kokoro")) startKokoro();
}

/** What actually runs a task on this device right now, for Settings and the settings tab's readout. */
export type ActiveSpeech =
  | { readonly where: "computer"; readonly name: string }
  | { readonly where: "browser"; readonly status: ModelStatus }
  | { readonly where: "card"; readonly name: string };
export function activeSpeech(task: "stt" | "voice"): ActiveSpeech {
  if (task === "stt")
    return onComputer.stt()
      ? { where: "computer", name: "parakeet 0.6b mlx" }
      : { where: "browser", status: ears.status() };
  const picked = replyVoice();
  if (onComputer.voice()) return { where: "computer", name: "kokoro 82m mlx" };
  // Standing in for your computer: Kale's Kokoro on a phone, the same Kokoro here on a desktop.
  if (wantsComputer.voice())
    return { where: "browser", status: (voiceStandIn() === "warm" ? warm : voice).status() };
  if (isKaleVoice(picked)) return { where: "browser", status: warm.status() };
  if (picked.startsWith("kokoro")) return { where: "browser", status: voice.status() };
  return { where: "card", name: picked };
}

/** The models that hear and speak right now, in the session log whenever they change (the brain reads it). */
function logActive() {
  const describe = (task: Task) => {
    const active = activeSpeech(task);
    return active.where === "browser"
      ? { where: "browser", model: active.status.name, phase: active.status.phase }
      : { where: active.where, model: active.name };
  };
  const now = { stt: describe("stt"), voice: describe("voice"), automatic: { stt: automatic.stt(), voice: automatic.voice() } };
  const key = JSON.stringify(now);
  if (key === loggedActive) return;
  loggedActive = key;
  voiceLog("system", "speech.active", now);
}

/** What a task's browser model is doing, for Settings; null while the computer or a card voice has it. */
export function speechStatus(task: "stt" | "voice"): ModelStatus | null {
  if (task === "stt") return onComputer.stt() ? null : ears.status();
  const picked = replyVoice();
  if (onComputer.voice()) return null;
  if (wantsComputer.voice()) return (voiceStandIn() === "warm" ? warm : voice).status();
  if (isKaleVoice(picked)) return warm.status();
  if (picked.startsWith("kokoro")) return voice.status();
  return null;
}

/** A model is still downloading or loading; a reload now would throw that away (callGuard). */
export const speechLoading = (): boolean =>
  ears.loading() || voice.loading() || warm.loading();

/**
 * The models this call is downloading, for the bar's readout; empty while they only load from disk (or
 * before a worker has said which), null once all are ready.
 */
export function speechProgress(): ReadonlyArray<VoiceBarModel> | null {
  const loading = [ears, voice, warm].filter((model) => model.started() && !model.gaveUp());
  if (loading.every((model) => model.ready())) return null;
  return loading.map((model) => model.model()).filter((model) => model !== null);
}

export type { ComputerSpeech } from "./computerRoute";
let computerReason: string | null = null;
/** Why the computer's speech service isn't answering (from its log, or how this page reaches it). */
export const computerSpeechReason = () => computerReason;
/**
 * Whether the computer running T3 can take a speech task, through this app's server or (lalala.talk)
 * through the paired T3 Code; `start` starts its speech service when it isn't running.
 */
export async function checkComputerSpeech(start?: "auto" | "force"): Promise<ComputerSpeech> {
  const { state, reason } = await computerRoute().health(start);
  computerReason = reason;
  return state;
}

/** This browser has WebGPU with 16-bit floats (the 0.6B on the GPU) / any WebGPU (Kokoro on the GPU). */
export async function checkGpu(): Promise<{ f16: boolean; any: boolean }> {
  const gpu = (navigator as Navigator & {
    gpu?: { requestAdapter(): Promise<{ features?: { has(name: string): boolean } } | null> };
  }).gpu;
  const adapter = gpu ? await gpu.requestAdapter().catch(() => null) : null;
  return { f16: adapter?.features?.has("shader-f16") === true, any: adapter !== null };
}

// What each speech model holds, in every memory snapshot (memoryTrail): its file, and the WASM
// memory and WebGPU buffers its worker counted (wasmMeter).
registerMeter("models", () => {
  const models: unknown[] = [ears.memory(), voice.memory(), warm.memory()].filter(Boolean);
  if (vadWorker !== null)
    models.push({ model: "vad", phase: vadReady ? "ready" : "loading", wasmMB: vadMeter?.wasmMB });
  return models;
});
