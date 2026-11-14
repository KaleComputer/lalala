import { type Rect, cardsHere, groupAreas, setCard } from "./canvasStore";
import { CARD_GAP, areaAround } from "./tidyPack";

/**
 * Swapping cards by dragging one over another: held over a card for DWELL_MS, the other card glides
 * into the dragged one's old slot and anything the swap lands on steps aside; on release the dragged
 * card takes the other's slot. Only cards of one group (or two ungrouped ones) swap, so groups stay
 * whole.
 */
const DWELL_MS = 150;
/** Matches canvasSurface.css's glide transition, plus a frame. */
const GLIDE_MS = 240;
const SLACK = 0.5;

const apart = (a: Rect, b: Rect) =>
  Math.max(0, b.x - (a.x + a.w), a.x - (b.x + b.w), b.y - (a.y + a.h), a.y - (b.y + b.h));
const overlap = (a: Rect, b: Rect) =>
  Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x)) *
  Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));

/**
 * The boxes a swap of `dragged` and `target` gives: the two trade top-left corners, and each other
 * card a swapped one now crowds (closer than `gap`, and closer than it was to what sat in that slot)
 * moves to the nearest spot clear of everything. Pushed cards never push others: no chain reactions.
 * `fixed` boxes never move and stay `gap` clear of `around` each moved card.
 */
export function swapLayout(opts: {
  readonly dragged: string;
  readonly target: string;
  readonly boxes: ReadonlyMap<string, Rect>;
  readonly fixed: readonly Rect[];
  readonly around?: (rect: Rect) => Rect;
  readonly gap?: number;
}): Map<string, Rect> {
  const { dragged, target, boxes, fixed, around = (r: Rect) => r, gap = CARD_GAP } = opts;
  const from = boxes.get(dragged);
  const to = boxes.get(target);
  if (!from || !to) return new Map();
  let landing = { ...from, x: to.x, y: to.y };
  let back = { ...to, x: from.x, y: from.y };
  // Neighbours of different sizes would land on each other: they trade places in their row (or
  // column) instead, first one at the pair's start, the other after it with the gap they had.
  if (apart(landing, back) < gap - SLACK) {
    const across = Math.abs(to.x - from.x) >= Math.abs(to.y - from.y);
    const [axis, size] = across ? (["x", "w"] as const) : (["y", "h"] as const);
    const [first, second] = to[axis] > from[axis] ? [from, to] : [to, from];
    const between = Math.max(gap, second[axis] - (first[axis] + first[size]));
    if (first === from) {
      back = { ...back, [axis]: from[axis] };
      landing = { ...landing, [axis]: from[axis] + to[size] + between };
    } else {
      landing = { ...landing, [axis]: to[axis] };
      back = { ...back, [axis]: to[axis] + from[size] + between };
    }
  }
  const out = new Map<string, Rect>([
    [dragged, landing],
    [target, back],
  ]);
  const slots: readonly (readonly [Rect, Rect])[] = [
    [landing, to],
    [back, from],
  ];
  const crowded = (r: Rect) =>
    slots.flatMap(([now, was]) => (apart(r, now) < Math.min(gap, apart(r, was)) - SLACK ? [now] : []));
  const pushed = [...boxes]
    .filter(([id, r]) => id !== dragged && id !== target && crowded(r).length > 0)
    .sort(([, a], [, b]) => a.y - b.y || a.x - b.x);
  for (const [id, r] of pushed) {
    const others = [...boxes].flatMap(([other, box]) => (other === id ? [] : [out.get(other) ?? box]));
    const free = (c: Rect) =>
      others.every((o) => apart(c, o) >= gap - SLACK) &&
      fixed.every((f) => apart(around(c), f) >= gap - SLACK);
    const hits = crowded(r);
    // Just clear of what landed on it first (right, down, left, up), then past any other box.
    const spots: Rect[] = [
      { ...r, x: Math.max(...hits.map((h) => h.x + h.w)) + gap },
      { ...r, y: Math.max(...hits.map((h) => h.y + h.h)) + gap },
      { ...r, x: Math.min(...hits.map((h) => h.x)) - r.w - gap },
      { ...r, y: Math.min(...hits.map((h) => h.y)) - r.h - gap },
    ];
    for (const o of [...others, ...fixed]) {
      spots.push(
        { ...r, x: o.x + o.w + gap },
        { ...r, y: o.y + o.h + gap },
        { ...r, x: o.x - r.w - gap },
        { ...r, y: o.y - r.h - gap },
        { ...r, x: o.x + o.w + gap, y: o.y },
        { ...r, x: o.x, y: o.y + o.h + gap },
      );
    }
    let best: Rect | undefined;
    let nearest = Infinity;
    for (const spot of spots) {
      const distance = Math.hypot(spot.x - r.x, spot.y - r.y);
      if (distance < nearest && free(spot)) [best, nearest] = [spot, distance];
    }
    out.set(id, best ?? { ...r, y: Math.max(...[...others, ...fixed].map((o) => o.y + o.h)) + gap });
  }
  return out;
}

type Drag = {
  readonly id: string;
  /** Every card that may take part, where it was when the drag began. */
  readonly origins: ReadonlyMap<string, Rect>;
  readonly fixed: readonly Rect[];
  readonly around: ((rect: Rect) => Rect) | undefined;
  /** The card the swap shows, and the one the pointer is waiting on. */
  target: string | null;
  waiting: string | null;
  timer: number;
  /** Cards the preview moved (not the dragged one), and where the dragged one lands. */
  moved: ReadonlySet<string>;
  landing: Rect | undefined;
};
let drag: Drag | null = null;

const glideTimers = new Map<string, number>();
/** Lets the cards' next box changes ease in (canvasSurface.css); off again once they have. */
function glide(ids: Iterable<string>) {
  for (const id of ids) {
    const card = document.querySelector<HTMLElement>(`[data-lalala-card="${CSS.escape(id)}"]`);
    if (!card) continue;
    card.setAttribute("data-lalala-card-glide", "");
    window.clearTimeout(glideTimers.get(id));
    glideTimers.set(
      id,
      window.setTimeout(() => {
        glideTimers.delete(id);
        card.removeAttribute("data-lalala-card-glide");
      }, GLIDE_MS),
    );
  }
}
/** A pan or pinch moves every card at once: none of them may lag behind it. */
export function stopGlides() {
  for (const [id, timer] of glideTimers) {
    window.clearTimeout(timer);
    document
      .querySelector(`[data-lalala-card="${CSS.escape(id)}"]`)
      ?.removeAttribute("data-lalala-card-glide");
  }
  glideTimers.clear();
}

/** A card's header was taken: the cards it may swap with, as they are now. */
export function startSwap(id: string) {
  endSwap(false);
  stopGlides();
  const here = cardsHere();
  const group = here.find((c) => c.id === id)?.group;
  const origins = new Map(here.flatMap((c) => (c.group === group ? [[c.id, c.rect] as const] : [])));
  if (!origins.has(id)) return;
  const areas = groupAreas();
  drag = {
    id,
    origins,
    // Ungrouped cards stay out of every group's area; a group's cards keep its area off the rest.
    fixed:
      group === undefined
        ? areas.map((a) => a.rect)
        : [
            ...areas.flatMap((a) => (a.label === group ? [] : [a.rect])),
            ...here.flatMap((c) => (c.group === undefined ? [c.rect] : [])),
          ],
    around: group === undefined ? undefined : (r: Rect) => areaAround([r]),
    target: null,
    waiting: null,
    timer: 0,
    moved: new Set(),
    landing: undefined,
  };
}

/**
 * The card under the dragged one: the pointer over its middle, or covering half of the smaller of
 * the two. Judged by where cards were when the drag began, so a card the preview moved away still
 * counts where it was.
 */
function under(rect: Rect, point: { readonly x: number; readonly y: number }) {
  if (drag === null) return null;
  let best: string | null = null;
  let score = 0;
  for (const [id, r] of drag.origins) {
    if (id === drag.id) continue;
    const middle =
      point.x >= r.x + r.w / 4 &&
      point.x <= r.x + (r.w * 3) / 4 &&
      point.y >= r.y + r.h / 4 &&
      point.y <= r.y + (r.h * 3) / 4;
    const shared = overlap(rect, r);
    if (!middle && shared < Math.min(rect.w * rect.h, r.w * r.h) / 2) continue;
    const s = shared + (middle ? 1e12 : 0);
    if (s > score) [best, score] = [id, s];
  }
  return best;
}

function show(target: string | null) {
  if (drag === null) return;
  const { id, origins, fixed, around } = drag;
  const layout =
    target === null
      ? new Map<string, Rect>()
      : swapLayout({ dragged: id, target, boxes: origins, fixed, ...(around && { around }) });
  const moving = new Set([...drag.moved, ...layout.keys()]);
  moving.delete(id);
  glide(moving);
  for (const card of moving) {
    const rect = layout.get(card) ?? origins.get(card);
    if (rect) setCard(card, rect);
  }
  drag.target = target;
  drag.moved = new Set([...layout.keys()].filter((card) => card !== id));
  drag.landing = layout.get(id);
}

/** The dragged card is at `rect` with the pointer at `point` (world px). */
export function hoverSwap(rect: Rect, point: { readonly x: number; readonly y: number }) {
  if (drag === null) return;
  const next = under(rect, point);
  if (next === drag.waiting) return;
  drag.waiting = next;
  window.clearTimeout(drag.timer);
  if (next === drag.target) return;
  drag.timer = window.setTimeout(() => show(next), DWELL_MS);
}

/** The drag ended: dropped (`commit`) it takes the swapped slot, cancelled everything goes back. */
export function endSwap(commit: boolean) {
  if (drag === null) return;
  const current = drag;
  window.clearTimeout(current.timer);
  if (commit && current.landing) {
    glide([current.id]);
    setCard(current.id, current.landing);
  } else if (!commit) {
    show(null);
  }
  drag = null;
}
