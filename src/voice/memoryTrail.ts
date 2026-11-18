import { canvasMemory } from "./extras/canvasStore";
import { hearVoiceLog, logPage, voiceLog } from "./voiceLog";

/**
 * What this page holds in memory, since iOS ends a tab over it without a word (no error, no
 * pagehide) and Safari reports none of it (no performance.memory). Our own accounting: each
 * speech model's file, WASM memory and WebGPU buffers (wasmMeter), the call's audio, the cards'
 * layers, images and canvases, and measureUserAgentSpecificMemory where a browser has it.
 *
 * A snapshot goes to the session log as `mem` when it changed (checked every 15 s while the page
 * shows, and as soon as a worker's memory moved) and at moments that matter (a model loading or
 * freed, a reply speaking, a call starting). Each one, with the last events logged, is also kept in
 * localStorage, where a page that dies keeps it: the next load logs it once as `tab.killed`.
 */
type Read = () => unknown;
const meters = new Map<string, Read>();
/** Adds a part of the page to every snapshot; the returned function takes it out again. */
export function registerMeter(name: string, read: Read): () => void {
  meters.set(name, read);
  return () => {
    if (meters.get(name) === read) meters.delete(name);
  };
}

const TRAIL = "lalala:trail:";
const LAST_KILL = "lalala:last-kill";
const pageLock = (page: string) => `lalala:trail-page:${page}`;
const TICK_MS = 15_000;
/** An unchanged snapshot is logged again this often, so the log shows the page was still alive. */
const HEARTBEAT_MS = 5 * 60_000;
/** Moments closer together than this log one snapshot, after the last of them. */
const MOMENT_GAP_MS = 3_000;
const UA_EVERY_MS = 5 * 60_000;
const RECENT = 12;
/** Events that change what the page holds: each logs a snapshot (at most one per MOMENT_GAP_MS). */
const MOMENTS = new Set([
  "session.start",
  "session.end",
  "mic.open",
  "speech.load",
  "speech.ready",
  "speech.failed",
  "speech.released",
  "webgpu.failed",
  "say",
  "playback.end",
  "playback.stop",
  "utterance",
  "page.visibility",
]);

const storage = (action: (store: Storage) => void) => {
  try {
    action(localStorage);
  } catch {
    // Private mode or storage off: no trail survives this page.
  }
};

const bornAt = Date.now();
/** The last events logged: type, when, and how many came in a row (a download's progress). */
const recent: Array<[string, number, number]> = [];
let inCall = false;
let hiddenAt: number | null = null;
let ua: { MB: number; at: number } | null = null;
let uaMeasuring = false;
let snap: Record<string, unknown> = {};
let loggedKey = "";
let loggedAt = 0;
let momentTimer = 0;
let momentReason: string | null = null;
let lastMomentAt = 0;
/** After pagehide: the page ended on purpose, so nothing writes the trail again. */
let gone = false;

const round = (bytes: number) => Math.round(bytes / 1e6);
/** What counts as a change worth a log line: not the clock, the JS heap's jitter or the zoom. */
const changeKey = ({ upS: _up, uaAgoS: _ago, uaMB: _ua, heapMB: _heap, cards, ...rest }: Record<string, unknown>) => {
  const { zoom: _zoom, ...counts } = (cards ?? {}) as Record<string, unknown>;
  return JSON.stringify({ ...rest, cards: counts });
};

/** Decoded images and canvases on the page (4 bytes a pixel), and how many elements there are. */
function domMemory() {
  let images = 0;
  for (const image of document.images)
    if (image.complete) images += image.naturalWidth * image.naturalHeight * 4;
  let canvases = 0;
  const canvasList = document.getElementsByTagName("canvas");
  for (const canvas of canvasList) canvases += canvas.width * canvas.height * 4;
  return {
    nodes: Math.round(document.getElementsByTagName("*").length / 100) * 100,
    images: document.images.length,
    imgMB: round(images),
    canvases: canvasList.length,
    canvasMB: round(canvases),
    videos: document.getElementsByTagName("video").length,
  };
}

function take(): Record<string, unknown> {
  const parts: Record<string, unknown> = {};
  for (const [name, read] of meters) {
    try {
      parts[name] = read();
    } catch {
      // One part that can't say leaves the rest.
    }
  }
  let cards: ReturnType<typeof canvasMemory> | null = null;
  try {
    cards = canvasMemory();
  } catch {
    // No canvas on this page.
  }
  const dom = domMemory();
  let estimate = (cards?.layerMB ?? 0) + dom.imgMB + dom.canvasMB;
  for (const model of (parts.models as Array<Record<string, number | undefined>> | undefined) ?? [])
    estimate += (model.wasmMB ?? model.fileMB ?? 0) + (model.gpuMB ?? 0);
  estimate += (parts.audio as { MB?: number } | undefined)?.MB ?? 0;
  const heap = (performance as Performance & { memory?: { usedJSHeapSize: number } }).memory;
  return {
    estMB: Math.round(estimate),
    ...parts,
    cards,
    dom,
    ...(heap ? { heapMB: round(heap.usedJSHeapSize) } : {}),
    ...(ua ? { uaMB: ua.MB, uaAgoS: Math.round((Date.now() - ua.at) / 1000) } : {}),
    call: inCall,
    visible: document.visibilityState === "visible",
    upS: Math.round((Date.now() - bornAt) / 1000),
    dpr: devicePixelRatio,
    view: [innerWidth, innerHeight],
  };
}

/** The snapshot and the last events, where the next load finds them if this page dies. */
function keep() {
  if (gone) return;
  const now = Date.now();
  storage((store) =>
    store.setItem(
      TRAIL + logPage,
      JSON.stringify({
        t: new Date(now).toISOString(),
        ...(hiddenAt !== null ? { hiddenAt: new Date(hiddenAt).toISOString() } : {}),
        snap,
        // Milliseconds before `t`, and a count for a run of the same event.
        last: recent.map(([type, at, times]) => (times > 1 ? [type, at - now, times] : [type, at - now])),
      }),
    ),
  );
}
let keepQueued = false;
const keepSoon = () => {
  if (keepQueued) return;
  keepQueued = true;
  queueMicrotask(() => {
    keepQueued = false;
    keep();
  });
};

function logSnapshot(reason: string) {
  snap = take();
  loggedKey = changeKey(snap);
  loggedAt = Date.now();
  lastMomentAt = loggedAt;
  voiceLog("system", "mem", { reason, ...snap });
  keep();
}

/**
 * Something that changes memory just happened (a worker's meter moved, a model loaded): the
 * snapshot is kept at once and logged when it changed, or always with a reason.
 */
export function memoryMoment(reason: string | null) {
  if (typeof document === "undefined") return;
  if (reason === null) {
    snap = take();
    keep();
    if (changeKey(snap) === loggedKey) return;
    reason = "meter";
  }
  momentReason = momentReason === null || momentReason === "meter" ? reason : momentReason;
  const wait = lastMomentAt + MOMENT_GAP_MS - Date.now();
  if (wait <= 0 && momentTimer === 0) {
    logSnapshot(momentReason);
    momentReason = null;
    return;
  }
  momentTimer ||= window.setTimeout(() => {
    momentTimer = 0;
    logSnapshot(momentReason ?? "meter");
    momentReason = null;
  }, Math.max(0, wait));
}

function measureUa() {
  const measure = (
    performance as Performance & {
      measureUserAgentSpecificMemory?: () => Promise<{ bytes: number }>;
    }
  ).measureUserAgentSpecificMemory;
  if (!measure || !crossOriginIsolated || uaMeasuring) return;
  if (ua !== null && Date.now() - ua.at < UA_EVERY_MS) return;
  uaMeasuring = true;
  measure
    .call(performance)
    .then((result) => {
      ua = { MB: round(result.bytes), at: Date.now() };
    })
    .catch(() => {})
    .finally(() => {
      uaMeasuring = false;
    });
}

function tick() {
  if (document.visibilityState !== "visible") return;
  measureUa();
  snap = take();
  if (changeKey(snap) !== loggedKey) logSnapshot("changed");
  else if (Date.now() - loggedAt >= HEARTBEAT_MS) logSnapshot("alive");
  else keep();
}

export type TabKill = {
  readonly at: string;
  readonly page: string;
  readonly hidden: boolean;
  readonly estMB: number | null;
  readonly last: string | null;
};
/** The last tab.killed this browser logged, for Settings' dev line. */
export function lastTabKill(): TabKill | null {
  let kill: TabKill | null = null;
  storage((store) => {
    kill = JSON.parse(store.getItem(LAST_KILL) ?? "null") as TabKill | null;
  });
  return kill;
}
/** What the page holds by its own count now, for Settings' dev line. */
export const memoryNow = () => {
  const now = take();
  return { estMB: now.estMB as number, models: now.models };
};

/** Trails other pages left behind with no pagehide: logged once each, unless that page still lives. */
async function checkLastExit() {
  const found: Array<[string, string]> = [];
  storage((store) => {
    for (let index = 0; index < store.length; index += 1) {
      const key = store.key(index);
      if (key?.startsWith(TRAIL) && key !== TRAIL + logPage) found.push([key, store.getItem(key) ?? ""]);
    }
  });
  if (found.length === 0) return;
  const held = new Set(
    ((await navigator.locks?.query().catch(() => null))?.held ?? []).map((lock) => lock.name),
  );
  for (const [key, text] of found) {
    const page = key.slice(TRAIL.length);
    if (held.has(pageLock(page))) continue;
    let trail: { t?: string; hiddenAt?: string; snap?: Record<string, unknown>; last?: Array<[string, number, number?]> };
    try {
      trail = JSON.parse(text) as typeof trail;
    } catch {
      trail = {};
    }
    // Without Web Locks, a trail fresher than two ticks may be another tab that is still open.
    if (!navigator.locks && trail.t && Date.now() - Date.parse(trail.t) < TICK_MS * 2) continue;
    storage((store) => store.removeItem(key));
    const lastEvent = trail.last?.at(-1)?.[0] ?? null;
    voiceLog("system", "tab.killed", {
      deadPage: page,
      lastSeen: trail.t ?? null,
      lastSeenAgoS: trail.t ? Math.round((Date.now() - Date.parse(trail.t)) / 1000) : null,
      // In front it is iOS's memory limit; behind, iOS reclaiming the tab or the app being closed.
      while: trail.hiddenAt ? "hidden" : "visible",
      ...(trail.hiddenAt ? { hiddenAt: trail.hiddenAt } : {}),
      lastEvent,
      last: trail.last ?? [],
      snap: trail.snap ?? null,
    });
    const kill: TabKill = {
      at: trail.t ?? new Date().toISOString(),
      page,
      hidden: Boolean(trail.hiddenAt),
      estMB: typeof trail.snap?.estMB === "number" ? trail.snap.estMB : null,
      last: lastEvent,
    };
    storage((store) => store.setItem(LAST_KILL, JSON.stringify(kill)));
  }
}

// One trail per page: an edit here reloads the page rather than starting a second one.
import.meta.hot?.decline();
if (typeof window !== "undefined") {
  // Held for this page's life: the browser frees it only when the page is gone, so a trail whose
  // lock is still held belongs to another open tab, not a dead one.
  void navigator.locks?.request(pageLock(logPage), () => new Promise<never>(() => {}));
  hearVoiceLog((type) => {
    if (type === "mem") return;
    if (type === "session.start") inCall = true;
    else if (type === "session.end") inCall = false;
    const previous = recent.at(-1);
    if (previous?.[0] === type) {
      previous[1] = Date.now();
      previous[2] += 1;
    } else recent.push([type, Date.now(), 1]);
    if (recent.length > RECENT) recent.shift();
    if (MOMENTS.has(type)) queueMicrotask(() => memoryMoment(type));
    else keepSoon();
  });
  void (navigator.locks?.request("lalala:trail-check", checkLastExit) ?? checkLastExit()).catch(
    () => {},
  );
  window.setInterval(tick, TICK_MS);
  document.addEventListener("visibilitychange", () => {
    hiddenAt = document.visibilityState === "hidden" ? Date.now() : null;
    keep();
  });
  // A page ending on purpose (reload, navigation, closing) leaves no trail; one put in the
  // back-forward cache leaves it again when it comes back.
  window.addEventListener("pagehide", () => {
    gone = true;
    storage((store) => store.removeItem(TRAIL + logPage));
  });
  window.addEventListener("pageshow", (event) => {
    gone = false;
    if (event.persisted) keep();
  });
}
