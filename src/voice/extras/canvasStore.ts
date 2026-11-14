import { AREA, GROUP_GAP, areaAround, packInWidth, tidyLayout } from "./tidyPack";

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
/** Far enough out to see a big canvas whole; past the cards is void, see `reach`. */
const MIN_ZOOM = 0.05;
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

/** Boxes closer than this belong to one cluster: a group's cards, or groups as tidy spaces them. */
const LINK = GROUP_GAP * 2;

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

const boundsOf = (boxes: readonly Rect[]): Rect => {
  const x = Math.min(...boxes.map((r) => r.x));
  const y = Math.min(...boxes.map((r) => r.y));
  return {
    x,
    y,
    w: Math.max(...boxes.map((r) => r.x + r.w)) - x,
    h: Math.max(...boxes.map((r) => r.y + r.h)) - y,
  };
};

type Placing = {
  /** Boxes it stays `gap` clear of. */
  readonly taken: readonly Rect[];
  /** What it goes beside (the main cluster of these, else of `taken`), `gap` away. */
  readonly near: readonly Rect[];
  /** Other groups' areas: `around` the new box stays `clear` of them. */
  readonly avoid?: readonly Rect[];
  /** What the new box adds to its group's area; itself when it has no group. */
  readonly around?: (rect: Rect) => Rect;
  readonly gap?: number;
  readonly clear?: number;
  /** the user's view: a spot in it wins, nearest its middle. */
  readonly focus?: Rect | undefined;
  readonly prefer?: Rect | undefined;
  /** `prefer` wins whenever it is clear, beside the others or not. */
  readonly exact?: boolean;
  /** The mini-map's shape: without `focus`, the spot that keeps the whole nearest it wins. */
  readonly aspect?: number;
};

/**
 * Where a box of `want`'s size goes: clear of everything, beside the main cluster of `near`,
 * inside `focus` if it can be, else growing the cluster least for its shape (so beside it before
 * below it), nearest the middle; `prefer` wins when it is such a spot. With none free it goes below
 * everything, at left.
 */
function place(want: Rect, opts: Placing): Rect {
  const { taken, near, avoid = [], around = (r: Rect) => r, gap = GAP, clear = GAP } = opts;
  const { focus, prefer, exact = false, aspect = 4 / 3 } = opts;
  // Half a px of slack: saved boxes have fractional edges from drags.
  const free = (rect: Rect) =>
    taken.every((other) => apart(rect, other) >= gap - 0.5) &&
    avoid.every((area) => apart(around(rect), area) >= clear - 0.5);
  if (prefer !== undefined && exact && free(prefer)) return prefer;
  if (taken.length === 0 && avoid.length === 0) return prefer ?? want;
  const anchors = near.length > 0 ? near : [...taken, ...avoid];
  const main = inMainCluster(anchors);
  const cluster = anchors.filter((_, i) => main[i]);
  const fits = (rect: Rect) => free(rect) && cluster.some((other) => apart(rect, other) <= gap * 2);
  const frame = focus ?? boundsOf(cluster);
  if (prefer !== undefined && fits(prefer) && inside(prefer, frame)) return prefer;
  const middle = { x: frame.x + frame.w / 2, y: frame.y + frame.h / 2 };
  const fit = (rect: Rect) => {
    const whole = boundsOf([frame, rect]);
    return focus ? 0 : Math.max(whole.w, whole.h * aspect);
  };
  let best: Rect | undefined;
  let bestScore = [Infinity, Infinity, Infinity];
  for (const other of cluster) {
    const { x, y, w, h } = other;
    for (const spot of [
      { ...want, x: x + w + gap, y },
      { ...want, x: x + w + gap, y: y + h - want.h },
      { ...want, x: x - want.w - gap, y },
      { ...want, x: x - want.w - gap, y: y + h - want.h },
      { ...want, x, y: y + h + gap },
      { ...want, x: x + w - want.w, y: y + h + gap },
      { ...want, x, y: y - want.h - gap },
      { ...want, x: x + w - want.w, y: y - want.h - gap },
    ]) {
      if (!fits(spot)) continue;
      const distance = Math.hypot(spot.x + spot.w / 2 - middle.x, spot.y + spot.h / 2 - middle.y);
      const score = [inside(spot, frame) ? 0 : 1, fit(spot), distance];
      const i = score.findIndex((v, k) => v !== bestScore[k]);
      if (i >= 0 && score[i]! < bestScore[i]!) {
        best = spot;
        bestScore = score;
      }
    }
  }
  if (best) return best;
  const below = {
    ...want,
    x: boundsOf(cluster).x,
    y: Math.max(...[...taken, ...avoid].map((r) => r.y + r.h)),
  };
  return { ...below, y: below.y + clear + (below.y - around(below).y) };
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
/** A swapped-in build: the page already shows the live layout. */
const swapped = globalThis.__lalalaCanvas !== undefined;
const live: Live = (globalThis.__lalalaCanvas ??= fresh());
// A layout kept by a build from before there were canvases.
live.canvases ??= readCanvases();
live.canvas ??= MAIN;
/** Each card body's scroll, so a swap or remount opens it where it was. */
export const scrollTops = live.scroll;
declare global {
  var __lalalaCanvasSurface:
    | {
        mounted: Set<string>;
        listeners: Set<() => void>;
        inCode: CardsInCode;
        view: { readonly w: number; readonly h: number };
      }
    | undefined;
}
// A hot update runs a second copy of this module beside the first, on the same live layout: they
// share which cards are up, what code declares and who redraws, or the cards one copy mounted
// would sit still while the other copy's surface moves the camera, and focus would wait on a
// size only the first copy's surface measured.
const surface = (globalThis.__lalalaCanvasSurface ??= {
  mounted: new Set(),
  listeners: new Set(),
  inCode: new Map(),
  view: { w: 0, h: 0 },
});
const { mounted, listeners } = surface;
/** The surface's size in screen px; the mini-map's viewport frame. A copy from before it was shared
 * never writes it here, so a new one starts from what the surface shows. */
const surfaceEl =
  typeof document === "undefined"
    ? null
    : document.querySelector<HTMLElement>("[data-lalala-surface]");
surface.view ??= { w: surfaceEl?.clientWidth ?? 0, h: surfaceEl?.clientHeight ?? 0 };
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
 * Every card on screen is drawn; one past the edge starts within DRAW_ENTER screens and stops past
 * DRAW_LEAVE, farther ones are frames with their title. WebKit keeps each card layer at full
 * sharpness and a phone kills the page past ~1 GB, so only LAYER_SCREENS of them get a layer.
 */
const DRAW_ENTER = 0.5;
const DRAW_LEAVE = 1;
const LAYER_SCREENS = 6;
let drawn: ReadonlySet<string> = new Set();
let layered: ReadonlySet<string> = new Set();
/** The card last touched: it gets a layer first, so its list scrolls however far out. */
let touched: string | null = null;

function pickDrawn() {
  const { x, y, z } = live.camera;
  const nextDrawn = new Set<string>();
  const near: { id: string; rank: number; area: number }[] = [];
  for (const id of mounted) {
    const rect = live.cards[id];
    if (rect === undefined) continue;
    // How far the card is from the screen's middle, in half screens: up to 1 touches the screen.
    const far = Math.max(
      (Math.max(
        rect.x * z + x - surface.view.w / 2,
        surface.view.w / 2 - (rect.x + rect.w) * z - x,
        0,
      ) *
        2) /
        surface.view.w,
      (Math.max(
        rect.y * z + y - surface.view.h / 2,
        surface.view.h / 2 - (rect.y + rect.h) * z - y,
        0,
      ) *
        2) /
        surface.view.h,
    );
    if (id !== held && far > 1 + 2 * (drawn.has(id) ? DRAW_LEAVE : DRAW_ENTER)) continue;
    nextDrawn.add(id);
    // A card keeps its layer until it is half a screen farther out than one without.
    const rank = id === held || id === touched ? -1 : far - (layered.has(id) ? 1 : 0);
    near.push({ id, rank, area: rect.w * rect.h });
  }
  near.sort((a, b) => a.rank - b.rank);
  let room = LAYER_SCREENS * surface.view.w * surface.view.h;
  const nextLayered = new Set<string>();
  for (const card of near) {
    if (nextLayered.size > 0 && card.area > room) continue;
    nextLayered.add(card.id);
    room -= card.area;
  }
  drawn = nextDrawn;
  layered = nextLayered;
}

const measured = () => surface.view.w > 0 && surface.view.h > 0;
/** Whether a card's content is drawn; every card is until the surface is measured. */
export const isDrawn = (id: string) => !measured() || drawn.has(id);
/** Whether a drawn card has its own layer (and a scrolling body) or is painted flat. */
export const isLayered = (id: string) => !measured() || layered.has(id);

let selected: string | null = null;
/** The card or group (its groupKey) a tap picked: only its resize corner shows and works. */
export const getSelected = () => selected;
export function select(key: string | null) {
  if (selected === key) return;
  selected = key;
  changed();
}

export function touchCard(id: string) {
  if (touched === id) return;
  touched = id;
  changed();
}

function changed(persist = false) {
  if (frame === 0) {
    frame = window.requestAnimationFrame(() => {
      frame = 0;
      if (measured()) pickDrawn();
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
export const getView = () => surface.view;
export const isMounted = (id: string) => mounted.has(id);
const clampZoom = (z: number) => Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, z));

/** Screen px of the cards a zoom keeps in view; any more and it would move off the pointer. */
const ZOOM_KEEP = 48;

/**
 * Where the view may roam, in world px: wherever it keeps `keep` screen px of the cards and group
 * areas in view on each axis (half the view by default), or all of them while they are smaller.
 * Undefined on an empty canvas or before the surface is measured: no edges then.
 */
function reach(z: number, keep?: number): Rect | undefined {
  const content = contentBox();
  if (content === undefined || surface.view.w === 0 || surface.view.h === 0) return undefined;
  const axis = (start: number, size: number, seen: number) => {
    const kept = Math.min(size, (keep ?? (seen * z) / 2) / z);
    return { from: start - seen + kept, size: size + 2 * (seen - kept) };
  };
  const x = axis(content.x, content.w, surface.view.w / z);
  const y = axis(content.y, content.h, surface.view.h / z);
  return { x: x.from, y: y.from, w: x.size, h: y.size };
}

/** The box around the cards on the surface and their group areas: the mini-map's frame. */
export function contentBox(): Rect | undefined {
  const boxes = [
    ...Object.entries(live.cards).flatMap(([id, rect]) => (mounted.has(id) ? [rect] : [])),
    ...groupAreas().map((area) => area.rect),
  ];
  if (boxes.length === 0) return undefined;
  const left = Math.min(...boxes.map((r) => r.x));
  const top = Math.min(...boxes.map((r) => r.y));
  const right = Math.max(...boxes.map((r) => r.x + r.w));
  const bottom = Math.max(...boxes.map((r) => r.y + r.h));
  return { x: left, y: top, w: right - left, h: bottom - top };
}

/**
 * Moves the camera within `reach`. A pan never pulls the view back from past its edges (a zoom may
 * leave it there), only stops it going further; `zooming` keeps just ZOOM_KEEP px of the cards.
 */
export function setCamera(next: Camera, zooming = false) {
  const z = clampZoom(next.z);
  const loose = reach(z, ZOOM_KEEP);
  const room = zooming ? loose : reach(z);
  const before = live.camera;
  const between = (at: number, low: number, high: number) => Math.min(high, Math.max(low, at));
  // The view's top or left edge in world px, kept between the room's edges on one axis.
  const keep = (at: number, was: number, start: number, size: number, seen: number) => {
    let low = start;
    let high = start + size - seen;
    if (before.z === z && !zooming) {
      low = Math.min(low, was);
      high = Math.max(high, was);
    }
    return -between(-at / z, low, high) * z;
  };
  live.camera =
    room && loose
      ? {
          x: keep(
            next.x,
            between(-before.x / z, loose.x, loose.x + loose.w - surface.view.w / z),
            room.x,
            room.w,
            surface.view.w / z,
          ),
          y: keep(
            next.y,
            between(-before.y / z, loose.y, loose.y + loose.h - surface.view.h / z),
            room.y,
            room.h,
            surface.view.h / z,
          ),
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
  setCamera({ x: sx - (sx - camera.x) * k, y: sy - (sy - camera.y) * k, z }, true);
}

/** Centres the view on a world point. */
export function lookAt(wx: number, wy: number) {
  const { camera } = live;
  setCamera({
    x: surface.view.w / 2 - wx * camera.z,
    y: surface.view.h / 2 - wy * camera.z,
    z: camera.z,
  });
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
  if (!unsynced.has(id)) bases.set(id, seen === 0 ? UNKNOWN : sharedCards[id]);
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
/** Changed before this tab saw the shared layout (offline): kept whatever the layout says. */
const UNKNOWN = Symbol("unknown");
/**
 * For each unsent card, the shared box it was changed from. If the shared box moves on before this
 * tab sends its own (another device, or a tidy elsewhere), the newer one wins and this is dropped:
 * a tab that slept or lost the server mid-send never puts an old layout back.
 */
const bases = new Map<string, Rect | typeof UNKNOWN | undefined>();
/** The last shared layout this tab applied. */
let sharedCards: Readonly<Record<string, Rect>> = {};
/**
 * New cards this tab placed: sent as `placed`, which the shared layout keeps only if no other tab
 * or device placed the card first, so every open canvas shows it at the first one's spot.
 */
const newlyPlaced = new Set<string>();
let held: string | null = null;
/** The shared layout's version this tab shows. */
let seen = 0;
/** When this tab last heard from the shared layout; boxes unsent for longer are checked first. */
let lastExchange = 0;
const STALE_MS = 2 * POLL_MS;
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
  sharedCards = shared.cards;
  for (const id of unsynced) {
    const base = bases.get(id);
    if (id === held || base === UNKNOWN || sameRect(shared.cards[id], base)) continue;
    unsynced.delete(id);
    pending.delete(id);
    newlyPlaced.delete(id);
    bases.delete(id);
  }
  adoptCanvases(shared.canvases ?? {});
  adoptCards(shared.cards);
  // Always, not only on a change here: the next load starts from this layout, not an older one.
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
  const idle = () =>
    store === null || pushing || (unsynced.size === 0 && unsentCanvases.size === 0);
  if (store === null || idle()) return;
  if (held !== null && !leaving) return;
  // Boxes kept through a sleep or a lost server may be older than the shared layout: read it first
  // so newer boxes win over them (applyShared drops them). A page leaving can't wait for that.
  if (Date.now() - lastExchange > STALE_MS) {
    if (leaving) return;
    await pull();
    if (idle() || Date.now() - lastExchange > STALE_MS) return;
  }
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
    lastExchange = Date.now();
    // Changed again while sending: what the shared layout now has is this tab's own last box.
    for (const [id, rect] of Object.entries(sent)) {
      if (live.cards[id] === rect) {
        unsynced.delete(id);
        bases.delete(id);
      } else {
        bases.set(id, shared.cards[id]);
      }
    }
    // Untouched since: the shared layout's box wins, whichever tab placed it.
    for (const [id, rect] of Object.entries(sentPlaced)) {
      newlyPlaced.delete(id);
      if (live.cards[id] !== rect) {
        bases.set(id, rect);
        continue;
      }
      unsynced.delete(id);
      pending.delete(id);
      bases.delete(id);
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
    lastExchange = Date.now();
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
  // Going away: send now, while what this tab has is still fresh.
  if (document.visibilityState === "hidden") void push(true);
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

/** Each card in code: its `canvas`, title and tidy group, so focus can find it on any canvas. */
type CardsInCode = Map<
  string,
  {
    readonly canvas: string | undefined;
    readonly title: string;
    readonly group: string | undefined;
  }
>;
const cardsInCode: CardsInCode = surface.inCode;
export function declareCard(id: string, canvas: string | undefined, title: string, group?: string) {
  cardsInCode.set(id, { canvas, title, group });
}
/** The card id a box key on the open canvas stands for. */
const cardOf = (key: string) => (live.canvas === MAIN ? key : key.slice(live.canvas.length + 1));

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
    if (rect === undefined || !mounted.has(key) || surface.view.w === 0) {
      if (++waited < 60) focusFrame = window.requestAnimationFrame(start);
      return;
    }
    const w = surface.view.w - FOCUS_PAD.side * 2;
    const h = surface.view.h - FOCUS_PAD.top - FOCUS_PAD.bottom;
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

/** The mini-map's shape (w / h), which tidy fills; the surface's while the map isn't showing. */
function mapAspect() {
  const map = document.querySelector<HTMLElement>("[data-lalala-map] canvas");
  if (map && map.clientWidth > 0 && map.clientHeight > 0) return map.clientWidth / map.clientHeight;
  return measured() ? surface.view.w / surface.view.h : 4 / 3;
}

/** The open canvas's cards on the surface here, each with its group. */
const surfaceCards = () =>
  Object.entries(live.cards).flatMap(([id, rect]) =>
    mounted.has(id) && onCanvas(id, live.canvas)
      ? [{ id, rect, group: cardsInCode.get(cardOf(id))?.group }]
      : [],
  );

/** Where a group's own box is kept: the size the user gave it, beside the cards' boxes. */
export const groupKey = (label: string) => boxKey(live.canvas, `group:${label}`);
const union = (a: Rect, b: Rect): Rect => {
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  return { x, y, w: Math.max(a.x + a.w, b.x + b.w) - x, h: Math.max(a.y + a.h, b.y + b.h) - y };
};

/** The open canvas's cards on the surface, by group. */
function cardsByGroup() {
  const groups = new Map<string, { id: string; rect: Rect }[]>();
  for (const { id, rect, group } of surfaceCards()) {
    if (group !== undefined) groups.set(group, [...(groups.get(group) ?? []), { id, rect }]);
  }
  return groups;
}

/**
 * Each group's area on the open canvas (GroupAreas draws them): the size the user gave it, grown to
 * take in its cards wherever they are; none for a group with no card on the surface.
 */
export function groupAreas() {
  return [...cardsByGroup()].map(([label, cards]) => {
    const around = areaAround(cards.map((c) => c.rect));
    const own = live.cards[groupKey(label)];
    return { label, rect: own ? union(own, around) : around };
  });
}

/** A group as it was when a finger took it: dragging moves or resizes it from this. */
export type GroupGrab = {
  readonly label: string;
  readonly area: Rect;
  readonly own: Rect | undefined;
  readonly cards: readonly { readonly id: string; readonly rect: Rect }[];
};

/**
 * The group whose bottom-right corner (up to `reach` screen px inside it, at any zoom) or headline
 * strip is under the screen point, corners first. Cards above it are the caller's to rule out.
 */
/** How far past a group's edge (screen px) a press still takes its border. */
const GROUP_EDGE = 6;
export function groupAt(sx: number, sy: number, reach: number) {
  const { x, y, z } = live.camera;
  const groups = cardsByGroup();
  const areas = groupAreas();
  const grab = (label: string, area: Rect): GroupGrab => ({
    label,
    area,
    own: live.cards[groupKey(label)],
    cards: groups.get(label) ?? [],
  });
  for (const { label, rect } of areas) {
    const dx = sx - (x + (rect.x + rect.w) * z);
    const dy = sy - (y + (rect.y + rect.h) * z);
    // Inside the group (its drawn corner) and on its border; never past its edge.
    if (dx <= GROUP_EDGE && dy <= GROUP_EDGE && dx >= -reach && dy >= -reach) {
      return { part: "corner" as const, grab: grab(label, rect) };
    }
  }
  for (const { label, rect } of areas) {
    const left = x + rect.x * z;
    const top = y + rect.y * z;
    const strip = Math.max(AREA.head * z, reach);
    if (sx >= left && sx <= left + rect.w * z && sy >= top && sy <= top + strip) {
      return { part: "head" as const, grab: grab(label, rect) };
    }
  }
  return undefined;
}

/** Moves a group and its cards by (dx, dy) world px from where they were when grabbed. */
export function moveGroup(grab: GroupGrab, dx: number, dy: number) {
  for (const { id, rect } of grab.cards) setCard(id, { ...rect, x: rect.x + dx, y: rect.y + dy });
  if (grab.own)
    setCard(groupKey(grab.label), { ...grab.own, x: grab.own.x + dx, y: grab.own.y + dy });
}

/**
 * Gives a group the size (w, h) world px, its top left kept, and reflows its cards inside it; it
 * never gets narrower than its widest card or shorter than its cards. Tidy keeps that size.
 */
export function resizeGroup(grab: GroupGrab, w: number, h: number) {
  const { area } = grab;
  const packed = packInWidth(
    grab.cards.map(({ id, rect }) => ({ id, w: rect.w, h: rect.h })),
    w - AREA.pad * 2,
  );
  for (const { item, x, y } of packed.placed) {
    setCard(item.id, { x: area.x + AREA.pad + x, y: area.y + AREA.head + y, w: item.w, h: item.h });
  }
  setCard(groupKey(grab.label), {
    x: area.x,
    y: area.y,
    w: Math.max(w, packed.w + AREA.pad * 2),
    h: Math.max(h, packed.h + AREA.head + AREA.pad),
  });
}

/** The group being dragged: the shared layout never moves it under the finger. */
export const holdGroup = (grab: GroupGrab | null) =>
  holdCard(grab === null ? null : groupKey(grab.label));

/**
 * Repacks the open canvas's cards, sizes kept, into one rectangle shaped like the mini-map, cards
 * of one `group` side by side in their area (at the size the user gave it), centred on the world's
 * origin. The same cards always give the same layout. The view keeps its zoom and follows the card
 * nearest the screen's middle, so that card stays where it was on screen.
 */
function tidyCanvas() {
  const cards = surfaceCards();
  if (cards.length === 0) return;
  const screen = viewport();
  const middle = screen && { x: screen.x + screen.w / 2, y: screen.y + screen.h / 2 };
  const distance = (r: Rect) =>
    middle ? Math.hypot(r.x + r.w / 2 - middle.x, r.y + r.h / 2 - middle.y) : 0;
  const anchor = cards.toSorted((a, b) => distance(a.rect) - distance(b.rect))[0];
  const sizes = new Map<string, { w: number; h: number }>();
  for (const label of cardsByGroup().keys()) {
    const own = live.cards[groupKey(label)];
    if (own) sizes.set(label, { w: own.w, h: own.h });
  }
  const laid = tidyLayout(
    cards.map(({ id, rect, group }) => ({ id, group, w: rect.w, h: rect.h })),
    mapAspect(),
    { x: 0, y: 0 },
    sizes,
  );
  // Centred on the world's origin: the group areas and the cards outside any group.
  const ungrouped = new Set(cards.flatMap((c) => (c.group === undefined ? [c.id] : [])));
  const edges = Object.entries(laid).flatMap(([key, r]) =>
    key.startsWith("group:") || ungrouped.has(key) ? [r] : [],
  );
  const dx = -(Math.min(...edges.map((r) => r.x)) + Math.max(...edges.map((r) => r.x + r.w))) / 2;
  const dy = -(Math.min(...edges.map((r) => r.y)) + Math.max(...edges.map((r) => r.y + r.h))) / 2;
  for (const [key, r] of Object.entries(laid)) {
    const group = key.startsWith("group:") ? key.slice("group:".length) : undefined;
    if (group !== undefined && !sizes.has(group)) continue;
    const id = group === undefined ? key : groupKey(group);
    const rect = { ...r, x: r.x + dx, y: r.y + dy };
    if (!sameRect(rect, live.cards[id])) setCard(id, rect);
  }
  const moved = anchor && live.cards[anchor.id];
  if (!moved || !middle) return;
  const { x, y, z } = live.camera;
  setCamera({ x: x - (moved.x - anchor.rect.x) * z, y: y - (moved.y - anchor.rect.y) * z, z });
}

/**
 * Repacks one group on the open canvas (its name, any case), as tidy would and at the size the user gave
 * it, its area's top left kept; nothing else moves. False when no such group has a card here.
 */
function tidyGroup(name: string) {
  const plain = (s: string) =>
    s
      .replace(/[’‘]/g, "'")
      .trim()
      .toLowerCase();
  const wanted = plain(name);
  const groups = cardsByGroup();
  const labels = [...groups.keys()];
  const label =
    labels.find((l) => plain(l) === wanted) ??
    (wanted === "" ? undefined : labels.find((l) => plain(l).startsWith(wanted)));
  const cards = label === undefined ? undefined : groups.get(label);
  const area = groupAreas().find((a) => a.label === label)?.rect;
  if (label === undefined || !cards || !area) return false;
  const own = live.cards[groupKey(label)];
  const laid = tidyLayout(
    cards.map(({ id, rect }) => ({ id, group: label, w: rect.w, h: rect.h })),
    mapAspect(),
    { x: 0, y: 0 },
    own ? new Map([[label, { w: own.w, h: own.h }]]) : undefined,
  );
  const packed = laid[`group:${label}`]!;
  const dx = area.x - packed.x;
  const dy = area.y - packed.y;
  for (const { id } of cards) {
    const r = laid[id]!;
    const rect = { ...r, x: r.x + dx, y: r.y + dy };
    if (!sameRect(rect, live.cards[id])) setCard(id, rect);
  }
  if (own) setCard(groupKey(label), { ...packed, x: area.x, y: area.y });
  return true;
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
  tidyGroup,
  inView: cardInView,
};
export type CanvasesApi = typeof api;
declare global {
  var __lalalaCanvases: CanvasesApi | undefined;
}

/** Cards waiting for a box, placed together once the whole canvas has mounted. */
const unplaced = new Map<string, { readonly rect: Rect; readonly exact: boolean }>();

const onCanvas = (key: string, canvas: string) =>
  canvas === MAIN ? !key.includes("/") : key.startsWith(`${canvas}/`);
/**
 * Every saved box of a card in code on the open canvas, on the surface here or not: another tab or
 * device may show cards this one hasn't mounted, and a new card must not land on them either.
 * Boxes of cards no longer in code stay in the shared layout unseen; they don't push new cards away.
 */
const canvasBoxes = (except: string) =>
  Object.entries(live.cards).flatMap(([key, rect]) =>
    key !== except &&
    onCanvas(key, live.canvas) &&
    (mounted.has(key) || cardsInCode.has(cardOf(key)))
      ? [rect]
      : [],
  );
/** What the user is looking at, in world px; unknown before the surface is measured. */
const viewport = (): Rect | undefined => {
  const { camera } = live;
  return surface.view.w > 0 && surface.view.h > 0
    ? {
        x: -camera.x / camera.z,
        y: -camera.y / camera.z,
        w: surface.view.w / camera.z,
        h: surface.view.h / camera.z,
      }
    : undefined;
};

let placing = false;

function placeNew() {
  placing = false;
  const waiting = [...unplaced].filter(([id]) => mounted.has(id) && live.cards[id] === undefined);
  const groupOf = (id: string) => cardsInCode.get(cardOf(id))?.group;
  const blocks = () => [
    ...surfaceCards().flatMap((c) => (c.group === undefined ? [c.rect] : [])),
    ...groupAreas().map((a) => a.rect),
  ];
  // A group new to the canvas lands whole, its area packed as tidy would and put beside the
  // others like one big card, so its frame never reaches into another group's.
  const newGroups = new Map<string, { id: string; w: number; h: number }[]>();
  // A grouped card always lands with its group: `exact` only places a card that has none.
  for (const [id, { rect }] of waiting) {
    const group = groupOf(id);
    if (group === undefined || surfaceCards().some((c) => c.group === group)) continue;
    newGroups.set(group, [...(newGroups.get(group) ?? []), { id, w: rect.w, h: rect.h }]);
  }
  for (const [group, cards] of newGroups) {
    const laid = tidyLayout(
      cards.map((c) => ({ ...c, group })),
      mapAspect(),
      { x: 0, y: 0 },
    );
    const area = laid[`group:${group}`]!;
    const at = place(area, {
      taken: canvasBoxes(""),
      near: blocks(),
      avoid: groupAreas().map((a) => a.rect),
      gap: GROUP_GAP,
      clear: GROUP_GAP,
      aspect: mapAspect(),
    });
    for (const { id } of cards) {
      const r = laid[id]!;
      setCard(id, { ...r, x: r.x + at.x - area.x, y: r.y + at.y - area.y });
      newlyPlaced.add(id);
    }
  }
  for (const [id, { rect: fallback, exact: pinned }] of waiting) {
    if (live.cards[id] !== undefined) continue;
    const taken = canvasBoxes(id);
    // A card of a group lands among its group's cards, its area clear of the other groups'.
    const group = groupOf(id);
    const exact = pinned && group === undefined;
    const siblings = surfaceCards().filter((c) => c.id !== id && c.group === group);
    const own = group !== undefined && siblings.length > 0;
    const avoid = groupAreas().flatMap((area) => (area.label === group ? [] : [area.rect]));
    const view = own ? undefined : viewport();
    // A new canvas's first card lands where the user is looking.
    const start =
      live.canvas !== MAIN && taken.length === 0 && view
        ? { ...fallback, x: view.x + 12, y: view.y + 56 }
        : fallback;
    setCard(
      id,
      place(start, {
        taken,
        near: own ? siblings.map((c) => c.rect) : blocks(),
        avoid,
        ...(group !== undefined && { around: (r: Rect) => areaAround([r]) }),
        focus: view,
        prefer: exact ? fallback : own ? undefined : start,
        exact,
        aspect: mapAspect(),
      }),
    );
    newlyPlaced.add(id);
  }
  unplaced.clear();
}

/**
 * A card on the surface: its saved box, or the first time a free spot beside the other cards
 * (`fallback` if that is one, or when `exact` and it overlaps nothing); returns an unmount. Saved
 * boxes never move; the user may overlap them.
 */
export function mountCard(id: string, fallback: Rect, exact = false) {
  // Siblings mount in the same pass; place once they all have, so each sees the others, and once
  // the shared layout has answered, so a card another device already placed isn't placed again.
  if (!placing) {
    placing = true;
    void firstPull.then(placeNew);
  }
  if (live.cards[id] === undefined) unplaced.set(id, { rect: fallback, exact });
  mounted.add(id);
  changed();
  return () => {
    mounted.delete(id);
    changed();
  };
}

export function setView(w: number, h: number) {
  if (w === surface.view.w && h === surface.view.h) return;
  surface.view = { w, h };
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

/**
 * Settles once the shared layout has answered (or failed to). Until then the surface hides the
 * cards: what this device kept may be an older layout, and it shouldn't flash up on a reload.
 */
let layoutReady = typeof window === "undefined" || swapped;
export const isLayoutReady = () => layoutReady;
const firstPull = layoutReady
  ? Promise.resolve()
  : pull(true).finally(() => {
      layoutReady = true;
      changed();
    });

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
