/**
 * The canvas's camera and card boxes, kept outside React: gestures write here, and the surface,
 * each card and the mini-map apply changes straight to the DOM, once per frame, only on change.
 * A screen point is `world * z + (x, y)`, relative to the surface's top left.
 */
export type Camera = { readonly x: number; readonly y: number; readonly z: number };
export type Rect = {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
};
type Saved = { readonly camera: Camera; readonly cards: Readonly<Record<string, Rect>> };
/**
 * A canvas; `null` once deleted, so the delete syncs. Which cards it shows is in code (CanvasCard's
 * `canvas`); `cards` stays empty, kept only because the shared layout's format has it.
 */
export type CanvasInfo = { readonly name: string; readonly cards: readonly string[] };
type Canvases = Readonly<Record<string, CanvasInfo | null>>;
export type CanvasesSnapshot = {
  readonly active: string;
  readonly list: readonly (CanvasInfo & { readonly id: string })[];
};

/**
 * The first canvas, there until deleted even with no entry stored: cards without a `canvas` live
 * on it, at the boxes kept under their plain ids from before there were canvases.
 */
const MAIN = "main";
/** Where a card's box is kept: another canvas's boxes are `canvas/card`, beside Main's. */
export const boxKey = (canvas: string, card: string) =>
  canvas === MAIN ? card : `${canvas}/${card}`;

const STORE = "lalala:canvas";
const CANVASES = "lalala:canvases";
/** Per device: which canvas is open, and each other canvas's camera (Main's stays in STORE). */
const ACTIVE = "lalala:canvas-active";
const CAMERAS = "lalala:canvas-cameras";
const HOME: Camera = { x: 0, y: 0, z: 1 };
const MIN_ZOOM = 0.2;
const MAX_ZOOM = 4;
const MIN_CARD = { w: 160, h: 100 } as const;
/** Space left between a newly placed card and its neighbours. */
const GAP = 16;

function read(): Saved {
  try {
    const saved = JSON.parse(localStorage.getItem(STORE) ?? "null") as Partial<Saved> | null;
    return { camera: saved?.camera ?? HOME, cards: saved?.cards ?? {} };
  } catch {
    return { camera: HOME, cards: {} };
  }
}

function readJson<T>(key: string, empty: T): T {
  try {
    return (JSON.parse(localStorage.getItem(key) ?? "null") as T | null) ?? empty;
  } catch {
    return empty;
  }
}
const readCanvases = () => readJson<Canvases>(CANVASES, {});
const readCameras = () => readJson<Record<string, Camera>>(CAMERAS, {});
function writeJson(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // No storage: it loads from the shared layout again next time.
  }
}

/** Every canvas that exists, in order: Main first while it isn't deleted, then by age. */
function listOf(canvases: Canvases) {
  const main = canvases[MAIN] === null ? [] : [{ id: MAIN, ...(canvases[MAIN] ?? MAIN_INFO) }];
  const rest = Object.entries(canvases)
    .flatMap(([id, info]) => (info && id !== MAIN ? [{ id, ...info }] : []))
    .sort((a, b) => a.id.localeCompare(b.id));
  return [...main, ...rest];
}
const MAIN_INFO: CanvasInfo = { name: "Main", cards: [] };
const exists = (canvases: Canvases, id: string) => listOf(canvases).some((c) => c.id === id);
/** With no canvas left, `active` is "" and the surface is empty. */
const fallback = (canvases: Canvases) => listOf(canvases)[0]?.id ?? "";
const cameraOf = (canvas: string, saved = read()) =>
  canvas === MAIN ? saved.camera : (readCameras()[canvas] ?? HOME);

function fresh(): Live {
  const saved = read();
  const canvases = readCanvases();
  const active = readJson<string>(ACTIVE, MAIN);
  const canvas = exists(canvases, active) ? active : fallback(canvases);
  return { ...saved, camera: cameraOf(canvas, saved), scroll: {}, canvas, canvases };
}

/** The empty space between two boxes along whichever axis they're furthest apart. */
const apart = (a: Rect, b: Rect) =>
  Math.max(0, b.x - (a.x + a.w), a.x - (b.x + b.w), b.y - (a.y + a.h), a.y - (b.y + b.h));

/** Cards closer than this belong to one cluster. */
const LINK = 80;

/** For each box, whether it is in the biggest group of boxes linked within LINK of each other. */
function inMainCluster(boxes: readonly Rect[]): boolean[] {
  const group = boxes.map((_, i) => i);
  const root = (i: number): number => (group[i] === i ? i : root(group[i] ?? i));
  boxes.forEach((a, i) =>
    boxes.forEach((b, j) => {
      if (j > i && apart(a, b) <= LINK) group[root(i)] = root(j);
    }),
  );
  const sizes = new Map<number, number>();
  boxes.forEach((_, i) => sizes.set(root(i), (sizes.get(root(i)) ?? 0) + 1));
  let main = -1;
  for (const [r, size] of sizes) if (size > (sizes.get(main) ?? 0)) main = r;
  return boxes.map((_, i) => root(i) === main);
}

const inside = (rect: Rect, frame: Rect) =>
  rect.x >= frame.x &&
  rect.y >= frame.y &&
  rect.x + rect.w <= frame.x + frame.w &&
  rect.y + rect.h <= frame.y + frame.h;

/**
 * Where a card of `want`'s size goes: at least GAP clear of every box in `taken`, touching the
 * main cluster of `near` (the cards on the surface; `taken` when none are), fully inside `focus`
 * (what the user is looking at) if it can be, nearest its middle. `prefer` wins when it is such a spot.
 * Never on a box: with no free spot beside the cluster it goes right of everything.
 */
function place(
  want: Rect,
  taken: readonly Rect[],
  near: readonly Rect[],
  focus: Rect | undefined,
  prefer?: Rect,
): Rect {
  if (taken.length === 0) return prefer ?? want;
  const anchors = near.length > 0 ? near : taken;
  const main = inMainCluster(anchors);
  const cluster = anchors.filter((_, i) => main[i]);
  // Half a px of slack: saved boxes have fractional edges from drags.
  const fits = (rect: Rect) =>
    taken.every((other) => apart(rect, other) >= GAP - 0.5) &&
    cluster.some((other) => apart(rect, other) <= GAP * 2);
  const frame = focus ?? {
    x: Math.min(...cluster.map((r) => r.x)),
    y: Math.min(...cluster.map((r) => r.y)),
    w: Math.max(...cluster.map((r) => r.x + r.w)) - Math.min(...cluster.map((r) => r.x)),
    h: Math.max(...cluster.map((r) => r.y + r.h)) - Math.min(...cluster.map((r) => r.y)),
  };
  if (prefer !== undefined && fits(prefer) && inside(prefer, frame)) return prefer;
  const middle = { x: frame.x + frame.w / 2, y: frame.y + frame.h / 2 };
  let best: Rect | undefined;
  let bestHidden = Infinity;
  let bestDistance = Infinity;
  for (const other of cluster) {
    const { x, y, w, h } = other;
    for (const spot of [
      { ...want, x: x + w + GAP, y },
      { ...want, x: x + w + GAP, y: y + h - want.h },
      { ...want, x: x - want.w - GAP, y },
      { ...want, x: x - want.w - GAP, y: y + h - want.h },
      { ...want, x, y: y + h + GAP },
      { ...want, x: x + w - want.w, y: y + h + GAP },
      { ...want, x, y: y - want.h - GAP },
      { ...want, x: x + w - want.w, y: y - want.h - GAP },
    ]) {
      if (!fits(spot)) continue;
      const distance = Math.hypot(spot.x + spot.w / 2 - middle.x, spot.y + spot.h / 2 - middle.y);
      const hidden = inside(spot, frame) ? 0 : 1;
      if (hidden < bestHidden || (hidden === bestHidden && distance < bestDistance)) {
        best = spot;
        bestHidden = hidden;
        bestDistance = distance;
      }
    }
  }
  return (
    best ?? {
      ...want,
      x: Math.max(...taken.map((r) => r.x + r.w)) + GAP,
      y: Math.min(...cluster.map((r) => r.y)),
    }
  );
}

type Live = {
  /** The open canvas's camera. */
  camera: Camera;
  cards: Readonly<Record<string, Rect>>;
  scroll: Record<string, number>;
  canvas: string;
  canvases: Canvases;
};
declare global {
  var __lalalaCanvas: Live | undefined;
}
// One live layout for every extras build: a swapped-in bundle starts exactly where the last one
// was, not from localStorage, whose save may still be pending.
const live: Live = (globalThis.__lalalaCanvas ??= fresh());
// A layout kept by a build from before there were canvases.
live.canvases ??= readCanvases();
live.canvas ??= MAIN;
/** Each card body's scroll, so a swap or remount opens it where it was. */
export const scrollTops = live.scroll;
/** The surface's size in screen px; the mini-map's viewport frame. */
let view = { w: 0, h: 0 };
const mounted = new Set<string>();
const listeners = new Set<() => void>();
let frame = 0;
let saveTimer = 0;
/** Cards this tab moved, resized or placed since its last save; nothing else is written. */
const pending = new Set<string>();
let cameraMoved = false;

/**
 * Writes only this tab's own changes into what is stored: another tab on /canvas holds an older
 * layout in memory, and writing all of it would undo the user's moves there on the next reload.
 */
function save() {
  window.clearTimeout(saveTimer);
  saveTimer = 0;
  if (pending.size === 0 && !cameraMoved) return;
  try {
    const stored = read();
    const mine = Object.fromEntries(
      [...pending].flatMap((id) => (live.cards[id] ? [[id, live.cards[id]]] : [])),
    );
    localStorage.setItem(
      STORE,
      JSON.stringify({
        camera: cameraMoved && live.canvas === MAIN ? live.camera : stored.camera,
        cards: { ...stored.cards, ...mine },
      }),
    );
    if (cameraMoved && live.canvas !== MAIN) {
      localStorage.setItem(
        CAMERAS,
        JSON.stringify({ ...readCameras(), [live.canvas]: live.camera }),
      );
    }
  } catch {
    // Private mode or a full store: the layout just isn't remembered.
  }
  pending.clear();
  cameraMoved = false;
}

/**
 * How much card stays drawn: the cards on screen or within DRAW_MARGIN screens of it, nearest the
 * middle first, until their boxes add up to DRAW_SCREENS screens (always one). Every drawn card is
 * a layer at full sharpness whatever the zoom, so a full canvas zoomed out, all drawn, takes more
 * memory than a phone gives a page; the rest show as frames with their title (CanvasCard).
 */
const DRAW_SCREENS = 6;
const DRAW_MARGIN = 0.5;
let drawn: ReadonlySet<string> = new Set();

function pickDrawn() {
  const { x, y, z } = live.camera;
  const near = [...mounted]
    .flatMap((id) => {
      const rect = live.cards[id];
      if (rect === undefined) return [];
      // How far the card is from the screen's middle, in half screens: up to 1 is on screen.
      const far = Math.max(
        (Math.max(rect.x * z + x - view.w / 2, view.w / 2 - (rect.x + rect.w) * z - x, 0) * 2) /
          view.w,
        (Math.max(rect.y * z + y - view.h / 2, view.h / 2 - (rect.y + rect.h) * z - y, 0) * 2) /
          view.h,
      );
      return far > 1 + 2 * DRAW_MARGIN ? [] : [{ id, far, area: rect.w * rect.h }];
    })
    .toSorted((a, b) => Number(b.id === held) - Number(a.id === held) || a.far - b.far);
  let room = DRAW_SCREENS * view.w * view.h;
  const next = new Set<string>();
  for (const card of near) {
    if (next.size > 0 && card.area > room) continue;
    next.add(card.id);
    room -= card.area;
  }
  drawn = next;
}

/** Whether a card's content is drawn; every card is until the surface is measured. */
export const isDrawn = (id: string) => view.w === 0 || view.h === 0 || drawn.has(id);

function changed(persist = false) {
  if (frame === 0) {
    frame = window.requestAnimationFrame(() => {
      frame = 0;
      if (view.w > 0 && view.h > 0) pickDrawn();
      for (const listener of listeners) listener();
    });
  }
  if (!persist) return;
  window.clearTimeout(saveTimer);
  saveTimer = window.setTimeout(save, 400);
}

export const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => void listeners.delete(listener);
};
export const getCamera = () => live.camera;
export const getCards = () => live.cards;
export const getView = () => view;
export const isMounted = (id: string) => mounted.has(id);
const clampZoom = (z: number) => Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, z));

/**
 * Where the view may roam, in world px: the cards' box with up to half a view of void past it,
 * less while the cards barely overflow the view, and the view centred on them once they fit in
 * it. Undefined on an empty canvas or before the surface is measured: no edges then.
 */
export function reach(z = live.camera.z): Rect | undefined {
  const boxes = Object.entries(live.cards).flatMap(([id, rect]) => (mounted.has(id) ? [rect] : []));
  if (boxes.length === 0 || view.w === 0 || view.h === 0) return undefined;
  const left = Math.min(...boxes.map((r) => r.x));
  const top = Math.min(...boxes.map((r) => r.y));
  const right = Math.max(...boxes.map((r) => r.x + r.w));
  const bottom = Math.max(...boxes.map((r) => r.y + r.h));
  const span = (content: number, seen: number) =>
    Math.max(seen, Math.min(content + seen, 2 * content - seen));
  const w = span(right - left, view.w / z);
  const h = span(bottom - top, view.h / z);
  return { x: (left + right - w) / 2, y: (top + bottom - h) / 2, w, h };
}

export function setCamera(next: Camera) {
  const z = clampZoom(next.z);
  const room = reach(z);
  const keep = (at: number, start: number, size: number, seen: number) =>
    -Math.min(start + size - seen, Math.max(start, -at / z)) * z;
  live.camera = room
    ? {
        x: keep(next.x, room.x, room.w, view.w / z),
        y: keep(next.y, room.y, room.h, view.h / z),
        z,
      }
    : { ...next, z };
  cameraMoved = true;
  changed(true);
}

/** Zooms by `factor`, keeping the world point under the screen point (sx, sy) where it is. */
export function zoomAt(sx: number, sy: number, factor: number) {
  const { camera } = live;
  const z = clampZoom(camera.z * factor);
  const k = z / camera.z;
  setCamera({ x: sx - (sx - camera.x) * k, y: sy - (sy - camera.y) * k, z });
}

/** Centres the view on a world point. */
export function lookAt(wx: number, wy: number) {
  const { camera } = live;
  setCamera({ x: view.w / 2 - wx * camera.z, y: view.h / 2 - wy * camera.z, z: camera.z });
}

export function setCard(id: string, rect: Rect) {
  live.cards = {
    ...live.cards,
    [id]: {
      x: rect.x,
      y: rect.y,
      w: Math.max(MIN_CARD.w, rect.w),
      h: Math.max(MIN_CARD.h, rect.h),
    },
  };
  pending.add(id);
  unsynced.add(id);
  changed(true);
  schedulePush();
}

/** The card being dragged or resized: a shared update never moves it, and it is sent on release. */
export function holdCard(id: string | null) {
  held = id;
  if (id === null) schedulePush();
}

/**
 * Card boxes are one layout for every device, kept by the storage adapter (the app's server,
 * vite/canvasLayout.ts): each device sends the cards it changed, the newest write wins, and the
 * others pick it up within POLL_MS. The camera stays per device, in localStorage only. Without a
 * shared store (lalala.talk) the layout lives in this browser alone.
 */
const storage = () => {
  const adapter = globalThis.__lalalaAdapters?.storage;
  return adapter?.shared ? adapter : null;
};
const POLL_MS = 3_000;
type Shared = {
  readonly cards: Readonly<Record<string, Rect>>;
  readonly canvases?: Canvases;
  readonly at: number;
};
/** Cards changed here that the shared layout doesn't have yet. */
const unsynced = new Set<string>();
/**
 * New cards this tab placed: sent as `placed`, which the shared layout keeps only if no other tab
 * or device placed the card first, so every open canvas shows it at the first one's spot.
 */
const newlyPlaced = new Set<string>();
let held: string | null = null;
/** The shared layout's version this tab shows. */
let seen = 0;
let pushTimer = 0;
let pushing = false;

const boxesOf = (ids: Iterable<string>) =>
  Object.fromEntries([...ids].flatMap((id) => (live.cards[id] ? [[id, live.cards[id]]] : [])));
const sameRect = (a: Rect | undefined, b: Rect | undefined) =>
  a?.x === b?.x && a?.y === b?.y && a?.w === b?.w && a?.h === b?.h;
/** This tab's own boxes that nothing from outside may replace yet. */
const ownBoxes = () => boxesOf([...unsynced, ...pending, ...(held === null ? [] : [held])]);

/** Shows `cards` from the shared layout or another tab, keeping this tab's unsent boxes. */
function adoptCards(cards: Readonly<Record<string, Rect>>) {
  const next = { ...live.cards, ...cards, ...ownBoxes() };
  if (Object.keys(next).every((id) => sameRect(next[id], live.cards[id]))) return false;
  live.cards = next;
  changed();
  return true;
}

function applyShared(shared: Shared) {
  if (shared.at <= seen) return;
  seen = shared.at;
  adoptCanvases(shared.canvases ?? {});
  if (!adoptCards(shared.cards)) return;
  try {
    const stored = read();
    localStorage.setItem(
      STORE,
      JSON.stringify({
        camera: stored.camera,
        cards: { ...stored.cards, ...shared.cards, ...ownBoxes() },
      }),
    );
  } catch {
    // No storage: the shared layout loads again next time.
  }
}

function schedulePush() {
  window.clearTimeout(pushTimer);
  pushTimer = window.setTimeout(() => void push(), 400);
}

async function push(leaving = false) {
  window.clearTimeout(pushTimer);
  const store = storage();
  if (store === null || pushing || (unsynced.size === 0 && unsentCanvases.size === 0)) return;
  if (held !== null && !leaving) return;
  const sent = boxesOf([...unsynced].filter((id) => !newlyPlaced.has(id)));
  const sentPlaced = boxesOf([...unsynced].filter((id) => newlyPlaced.has(id)));
  const sentCanvases = Object.fromEntries(
    [...unsentCanvases].map((id) => [id, live.canvases[id] ?? null]),
  );
  pushing = true;
  try {
    const shared = (await store.write(
      "canvas",
      {
        cards: sent,
        ...(Object.keys(sentPlaced).length > 0 && { placed: sentPlaced }),
        ...(unsentCanvases.size > 0 && { canvases: sentCanvases }),
      },
      { leaving },
    )) as Shared | null;
    if (shared === null) return;
    for (const [id, rect] of Object.entries(sent)) if (live.cards[id] === rect) unsynced.delete(id);
    // Untouched since: the shared layout's box wins, whichever tab placed it.
    for (const [id, rect] of Object.entries(sentPlaced)) {
      newlyPlaced.delete(id);
      if (live.cards[id] !== rect) continue;
      unsynced.delete(id);
      pending.delete(id);
    }
    // A server from before canvases answers without them: they stay unsent until it has them.
    for (const [id, info] of Object.entries(sentCanvases)) {
      if (shared.canvases && id in shared.canvases && (live.canvases[id] ?? null) === info) {
        unsentCanvases.delete(id);
      }
    }
    applyShared(shared);
    if (unsynced.size > 0) schedulePush();
  } catch {
    // Server unreachable: the next poll sends it again.
  } finally {
    pushing = false;
  }
}

/** Reads the shared layout; the first read of an empty one seeds it with this device's cards. */
async function pull(first = false) {
  const store = storage();
  if (store === null) return;
  try {
    const shared = (await store.read("canvas")) as Shared | null;
    if (shared === null) return;
    if (first && shared.at === 0) {
      for (const id of Object.keys(live.cards)) unsynced.add(id);
      await push();
    } else {
      applyShared(shared);
    }
  } catch {
    // Server unreachable: this device keeps its own layout until it is back.
  }
}

const sync = () => {
  if (document.visibilityState !== "visible" || mounted.size === 0) return;
  void push().then(() => pull());
};

/** Canvases changed here that the shared layout doesn't have yet. */
const unsentCanvases = new Set<string>();
const CANVASES_EVENT = "lalala:canvases";

function snapshotOf(): CanvasesSnapshot {
  return { active: live.canvas, list: listOf(live.canvases) };
}
let snapshot = snapshotOf();

function canvasesChanged() {
  snapshot = snapshotOf();
  document.dispatchEvent(new Event(CANVASES_EVENT));
}
export const subscribeCanvases = (listener: () => void) => {
  document.addEventListener(CANVASES_EVENT, listener);
  return () => document.removeEventListener(CANVASES_EVENT, listener);
};
export const getCanvases = () => snapshot;

/** The canvas a card lives on: its `canvas` (an id or a name), or Main. */
export function homeOf(canvas: string | undefined, list: CanvasesSnapshot["list"]) {
  if (canvas === undefined) return MAIN;
  const wanted = canvas.trim().toLowerCase();
  return list.find((c) => c.id === canvas || c.name.toLowerCase() === wanted)?.id ?? canvas;
}

/** Shows canvases from the shared layout or another tab, keeping this tab's unsent edits. */
function adoptCanvases(incoming: Canvases) {
  const mine = Object.fromEntries([...unsentCanvases].map((id) => [id, live.canvases[id] ?? null]));
  const next = { ...live.canvases, ...incoming, ...mine };
  if (JSON.stringify(next) === JSON.stringify(live.canvases)) return;
  live.canvases = next;
  writeJson(CANVASES, next);
  canvasesChanged();
  if (!exists(next, live.canvas)) selectCanvas(fallback(next));
}

function editCanvas(id: string, info: CanvasInfo | null) {
  live.canvases = { ...live.canvases, [id]: info };
  unsentCanvases.add(id);
  writeJson(CANVASES, { ...readCanvases(), [id]: info });
  canvasesChanged();
  schedulePush();
}

/** Opens a canvas on this device, at the camera it had here. */
function selectCanvas(id: string) {
  const next = exists(live.canvases, id) ? id : fallback(live.canvases);
  if (next === live.canvas) return;
  save();
  live.canvas = next;
  live.camera = cameraOf(next);
  writeJson(ACTIVE, next);
  canvasesChanged();
  changed();
}

function createCanvas() {
  const id = `c${Date.now().toString(36)}`;
  editCanvas(id, { name: `Canvas ${snapshot.list.length + 1}`, cards: [] });
  selectCanvas(id);
}

function renameCanvas(id: string, name: string) {
  const info = snapshot.list.find((c) => c.id === id);
  const trimmed = name.trim();
  if (!info || trimmed === "" || trimmed === info.name) return;
  editCanvas(id, { name: trimmed, cards: info.cards });
}

/**
 * The canvas and its layout go for good (a new canvas gets a new id, so they never come back).
 * Its cards stay in code, unseen until a card names another canvas.
 */
function deleteCanvas(id: string) {
  if (!exists(live.canvases, id)) return;
  editCanvas(id, null);
  if (live.canvas === id) selectCanvas(fallback(live.canvases));
}

/** Each card in code: its `canvas` prop and title, so focus can find it on any canvas. */
const cardsInCode = new Map<
  string,
  { readonly canvas: string | undefined; readonly title: string }
>();
export function declareCard(id: string, canvas: string | undefined, title: string) {
  cardsInCode.set(id, { canvas, title });
}

/** Room the top bar and the device bar take over the surface, in screen px. */
const FOCUS_PAD = { top: 56, bottom: 120, side: 24 } as const;
const FOCUS_MS = 380;
const FOCUS_MAX_ZOOM = 1.25;
let focusFrame = 0;

/**
 * Pans and zooms to fit a card (its id or title), opening its canvas first. A short ease; any
 * camera move from elsewhere (the user's hand) stops it.
 */
function focusCard(name: string) {
  const wanted = name.trim().toLowerCase();
  const found = [...cardsInCode].find(
    ([id, card]) => id.toLowerCase() === wanted || card.title.toLowerCase() === wanted,
  );
  if (!found) return false;
  const [id, card] = found;
  selectCanvas(homeOf(card.canvas, listOf(live.canvases)));
  const key = boxKey(live.canvas, id);
  window.cancelAnimationFrame(focusFrame);
  let waited = 0;
  // A just-opened canvas mounts its cards (and a new card gets its box) a few frames later.
  const start = () => {
    const rect = live.cards[key];
    if (rect === undefined || !mounted.has(key) || view.w === 0) {
      if (++waited < 60) focusFrame = window.requestAnimationFrame(start);
      return;
    }
    const w = view.w - FOCUS_PAD.side * 2;
    const h = view.h - FOCUS_PAD.top - FOCUS_PAD.bottom;
    const z = clampZoom(Math.min(w / rect.w, h / rect.h, FOCUS_MAX_ZOOM));
    const to = {
      x: FOCUS_PAD.side + (w - rect.w * z) / 2 - rect.x * z,
      y: FOCUS_PAD.top + Math.max(0, (h - rect.h * z) / 2) - rect.y * z,
      z,
    };
    const from = live.camera;
    const began = performance.now();
    let mine = from;
    const step = () => {
      if (live.camera !== mine) return;
      const t = Math.min(1, (performance.now() - began) / FOCUS_MS);
      const k = 1 - (1 - t) ** 3;
      setCamera({
        x: from.x + (to.x - from.x) * k,
        y: from.y + (to.y - from.y) * k,
        z: from.z + (to.z - from.z) * k,
      });
      mine = live.camera;
      if (t < 1) focusFrame = window.requestAnimationFrame(step);
    };
    step();
  };
  start();
  return true;
}

/**
 * Repacks the open canvas's cards, sizes kept, so every gap between neighbours is GAP: rows in
 * reading order, each card left to right after the last and as high as the cards above allow.
 */
function tidyCanvas() {
  const cards = Object.entries(live.cards).flatMap(([key, rect]) =>
    mounted.has(key) && onCanvas(key, live.canvas) ? [{ key, rect }] : [],
  );
  if (cards.length === 0) return;
  const left = Math.min(...cards.map((c) => c.rect.x));
  const top = Math.min(...cards.map((c) => c.rect.y));
  const rows: (typeof cards)[] = [];
  for (const card of cards.toSorted((a, b) => a.rect.y - b.rect.y)) {
    const row = rows.at(-1);
    if (row && card.rect.y < Math.min(...row.map((c) => c.rect.y + c.rect.h))) row.push(card);
    else rows.push([card]);
  }
  const placed: Rect[] = [];
  for (const row of rows) {
    let x = left;
    for (const { key, rect } of row.toSorted((a, b) => a.rect.x - b.rect.x)) {
      const above = placed.filter((p) => p.x < x + rect.w && p.x + p.w > x);
      const y = above.length > 0 ? Math.max(...above.map((p) => p.y + p.h)) + GAP : top;
      const next = { ...rect, x, y };
      placed.push(next);
      setCard(key, next);
      x += rect.w + GAP;
    }
  }
}

/**
 * Whether the user is looking at a card (by id or title): the page is showing, the card is on their open
 * canvas and at least a third of it, or half the screen, is in view. The voice host plays an update
 * about a card they are looking at without the UPDATE takeover and its sound.
 */
function cardInView(name: string) {
  if (document.visibilityState !== "visible") return false;
  const wanted = name.trim().toLowerCase();
  const found = [...cardsInCode].find(
    ([id, card]) => id.toLowerCase() === wanted || card.title.toLowerCase() === wanted,
  );
  if (!found) return false;
  const key = boxKey(live.canvas, found[0]);
  const rect = live.cards[key];
  const seen = viewport();
  if (rect === undefined || !mounted.has(key) || seen === undefined) return false;
  const w = Math.min(rect.x + rect.w, seen.x + seen.w) - Math.max(rect.x, seen.x);
  const h = Math.min(rect.y + rect.h, seen.y + seen.h) - Math.max(rect.y, seen.y);
  const shown = Math.max(0, w) * Math.max(0, h);
  return shown >= (rect.w * rect.h) / 3 || shown >= (seen.w * seen.h) / 2;
}

/** What the top bar's canvas switcher and the voice host (outside this bundle) reach. */
const api = {
  snapshot: getCanvases,
  select: selectCanvas,
  create: createCanvas,
  rename: renameCanvas,
  remove: deleteCanvas,
  focus: focusCard,
  tidy: tidyCanvas,
  inView: cardInView,
};
export type CanvasesApi = typeof api;
declare global {
  var __lalalaCanvases: CanvasesApi | undefined;
}

/** Cards waiting for a box, placed together once the whole canvas has mounted. */
const unplaced = new Map<string, Rect>();

const onCanvas = (key: string, canvas: string) =>
  canvas === MAIN ? !key.includes("/") : key.startsWith(`${canvas}/`);
/**
 * Every saved box on the open canvas, on the surface here or not: another tab, device or build
 * may show cards this one hasn't mounted, and a new card must not land on them either.
 */
const canvasBoxes = (except: string) =>
  Object.entries(live.cards).flatMap(([key, rect]) =>
    key !== except && onCanvas(key, live.canvas) ? [rect] : [],
  );
/** What the user is looking at, in world px; unknown before the surface is measured. */
const viewport = (): Rect | undefined => {
  const { camera } = live;
  return view.w > 0 && view.h > 0
    ? {
        x: -camera.x / camera.z,
        y: -camera.y / camera.z,
        w: view.w / camera.z,
        h: view.h / camera.z,
      }
    : undefined;
};

let placing = false;

function placeNew() {
  placing = false;
  for (const [id, fallback] of unplaced) {
    if (mounted.has(id) && live.cards[id] === undefined) {
      const taken = canvasBoxes(id);
      const near = Object.entries(live.cards).flatMap(([key, rect]) =>
        key !== id && mounted.has(key) ? [rect] : [],
      );
      const view = viewport();
      // A new canvas's first card lands where the user is looking.
      const start =
        live.canvas !== MAIN && taken.length === 0 && view
          ? { ...fallback, x: view.x + 12, y: view.y + 56 }
          : fallback;
      setCard(id, place(start, taken, near, view, start));
      newlyPlaced.add(id);
    }
  }
  unplaced.clear();
}

/**
 * A card on the surface: its saved box, or the first time a free spot beside the other cards
 * (`fallback` if that is one); returns an unmount. Saved boxes never move; the user may overlap them.
 */
export function mountCard(id: string, fallback: Rect) {
  // Siblings mount in the same pass; place once they all have, so each sees the others, and once
  // the shared layout has answered, so a card another device already placed isn't placed again.
  if (!placing) {
    placing = true;
    void firstPull.then(placeNew);
  }
  if (live.cards[id] === undefined) unplaced.set(id, fallback);
  mounted.add(id);
  changed();
  return () => {
    mounted.delete(id);
    changed();
  };
}

export function setView(w: number, h: number) {
  if (w === view.w && h === view.h) return;
  view = { w, h };
  changed();
}

/** Another tab saved: show its cards here too, except ones this tab hasn't saved yet. */
function adopt(event: StorageEvent) {
  if (event.key === STORE && event.newValue !== null) adoptCards(read().cards);
  if (event.key === CANVASES && event.newValue !== null) adoptCanvases(readCanvases());
}

const leave = () => {
  save();
  void push(true);
};

const firstPull = typeof window === "undefined" ? Promise.resolve() : pull(true);

if (typeof window !== "undefined") {
  globalThis.__lalalaCanvases = api;
  canvasesChanged();
  const poll = storage() === null ? 0 : window.setInterval(sync, POLL_MS);
  window.addEventListener("pagehide", leave);
  window.addEventListener("storage", adopt);
  window.addEventListener("focus", sync);
  document.addEventListener("visibilitychange", sync);
  import.meta.hot?.dispose(() => {
    leave();
    window.clearInterval(poll);
    window.removeEventListener("pagehide", leave);
    window.removeEventListener("storage", adopt);
    window.removeEventListener("focus", sync);
    document.removeEventListener("visibilitychange", sync);
  });
}
