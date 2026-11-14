type Size = { readonly w: number; readonly h: number };
type Box = { readonly x: number; readonly y: number; readonly w: number; readonly h: number };
/** A card to tidy; cards with a `group` are packed together inside that group's area. */
export type TidyCard = {
  readonly id: string;
  readonly group?: string | undefined;
  readonly w: number;
  readonly h: number;
};

/** Space between cards of one group, and the much wider space between groups' areas. */
export const CARD_GAP = 16;
export const GROUP_GAP = 240;
/** A group's area around its cards (GroupAreas draws it): `pad` on three sides, `head` on top. */
export const AREA = { pad: 48, head: 200 } as const;

/** A group's area: its cards' box, grown by AREA. */
export const areaAround = (cards: readonly Box[]): Box => {
  const left = Math.min(...cards.map((r) => r.x));
  const top = Math.min(...cards.map((r) => r.y));
  const right = Math.max(...cards.map((r) => r.x + r.w));
  const bottom = Math.max(...cards.map((r) => r.y + r.h));
  return {
    x: left - AREA.pad,
    y: top - AREA.head,
    w: right - left + AREA.pad * 2,
    h: bottom - top + AREA.head + AREA.pad,
  };
};

/**
 * Bottom-left skyline packing: each size in turn goes as high as it can, then as far left, in a
 * strip `width` wide. Returns each size's spot and the packed box's size.
 */
function skyline(sizes: readonly Size[], width: number, gap: number) {
  const full = width + gap;
  let line = [{ x: 0, w: full, y: 0 }];
  const spots: { x: number; y: number }[] = [];
  let right = 0;
  let bottom = 0;
  for (const { w, h } of sizes) {
    const span = w + gap;
    let best = { x: 0, y: Infinity };
    for (const [i, start] of line.entries()) {
      if (start.x + span > full + 0.5) break;
      let y = 0;
      for (const seg of line.slice(i)) {
        if (seg.x >= start.x + span) break;
        y = Math.max(y, seg.y);
      }
      if (y < best.y) best = { x: start.x, y };
    }
    if (best.y === Infinity) best = { x: 0, y: Math.max(...line.map((s) => s.y)) };
    const { x, y } = best;
    const next: { x: number; w: number; y: number }[] = [];
    for (const seg of line) {
      const end = seg.x + seg.w;
      if (end <= x || seg.x >= x + span) next.push(seg);
      else {
        if (seg.x < x) next.push({ x: seg.x, w: x - seg.x, y: seg.y });
        if (end > x + span) next.push({ x: x + span, w: end - x - span, y: seg.y });
      }
    }
    next.push({ x, w: span, y: y + h + gap });
    next.sort((a, b) => a.x - b.x);
    line = next.reduce<typeof next>((merged, seg) => {
      const last = merged.at(-1);
      if (last && last.y === seg.y) merged[merged.length - 1] = { ...last, w: last.w + seg.w };
      else merged.push(seg);
      return merged;
    }, []);
    spots.push({ x, y });
    right = Math.max(right, x + w);
    bottom = Math.max(bottom, y + h);
  }
  return { spots, w: right, h: bottom };
}

type Item = Size & { readonly id: string };
const orders: ((a: Item, b: Item) => number)[] = [
  (a, b) => b.h - a.h || b.w - a.w || a.id.localeCompare(b.id),
  (a, b) => b.w - a.w || b.h - a.h || a.id.localeCompare(b.id),
  (a, b) => b.w * b.h - a.w * a.h || a.id.localeCompare(b.id),
];

/**
 * Packs `items` in whichever order and strip width needs the smallest frame of `aspect` (w / h)
 * around the result: the packed box fills that shape as fully as the sizes allow.
 */
function packToAspect<T extends Item>(items: readonly T[], aspect: number, gap: number) {
  const widest = Math.max(...items.map((s) => s.w));
  const area = items.reduce((sum, s) => sum + (s.w + gap) * (s.h + gap), 0);
  const ideal = Math.sqrt(area * aspect);
  let best = { w: 0, h: 0, placed: [] as { item: T; x: number; y: number }[] };
  let bestScore = Infinity;
  for (const order of orders) {
    const sorted = items.toSorted(order);
    const widths = new Set([widest]);
    for (let k = 0.6; k <= 1.8; k += 0.05) widths.add(Math.max(widest, Math.round(ideal * k)));
    let row = -gap;
    for (const s of sorted) widths.add(Math.max(widest, (row += s.w + gap)));
    for (const width of [...widths].toSorted((a, b) => a - b)) {
      const packed = skyline(sorted, width, gap);
      const score = Math.max(packed.w, packed.h * aspect) + (packed.w * packed.h) / 1e9;
      if (score < bestScore - 0.5) {
        const placed = sorted.map((item, i) => ({ item, ...packed.spots[i]! }));
        best = { w: packed.w, h: packed.h, placed };
        bestScore = score;
      }
    }
  }
  return best;
}

/** Packs `items` into a strip `width` wide (at least the widest), in whichever order is lowest. */
export function packInWidth<T extends Item>(items: readonly T[], width: number, gap = CARD_GAP) {
  const strip = Math.max(width, ...items.map((s) => s.w));
  let best = { w: 0, h: Infinity, placed: [] as { item: T; x: number; y: number }[] };
  for (const order of orders) {
    const sorted = items.toSorted(order);
    const packed = skyline(sorted, strip, gap);
    if (packed.h < best.h - 0.5) {
      best = {
        w: packed.w,
        h: packed.h,
        placed: sorted.map((item, i) => ({ item, ...packed.spots[i]! })),
      };
    }
  }
  return best;
}

/**
 * Where tidy puts each card, its size kept: each group packed into a block with room for its area
 * (at the size the user gave it in `sizes`, if he did), the blocks and ungrouped cards packed into one
 * rectangle of `aspect` (the mini-map's) with its top left at `origin`. Each group's area comes
 * back as `group:<name>`. Same cards, same result.
 */
export function tidyLayout(
  cards: readonly TidyCard[],
  aspect: number,
  origin: { readonly x: number; readonly y: number },
  sizes: ReadonlyMap<string, Size> = new Map(),
): Record<string, Box> {
  const groups = new Map<string, TidyCard[]>();
  for (const card of cards) {
    const key = card.group === undefined ? `card:${card.id}` : `group:${card.group}`;
    groups.set(key, [...(groups.get(key) ?? []), card]);
  }
  const packAll = (shape: number) =>
    packToAspect(
      [...groups].map(([id, list]) => {
        const framed = id.startsWith("group:");
        const set = framed ? sizes.get(id.slice("group:".length)) : undefined;
        const block = set
          ? packInWidth(list, set.w - AREA.pad * 2)
          : packToAspect(list, aspect * shape, CARD_GAP);
        const pad = framed ? { x: AREA.pad, y: AREA.head } : { x: 0, y: 0 };
        const more = framed ? { w: AREA.pad * 2, h: AREA.head + AREA.pad } : { w: 0, h: 0 };
        const w = Math.max(block.w + more.w, set?.w ?? 0);
        return { id, w, h: Math.max(block.h + more.h, set?.h ?? 0), block, pad, framed };
      }),
      aspect,
      GROUP_GAP,
    );
  // Blocks shaped like the whole rarely tile it: try each block shape, keep the tightest whole.
  const score = (whole: { w: number; h: number }) => Math.max(whole.w, whole.h * aspect);
  let best = packAll(1);
  for (const shape of [0.5, 0.75, 1.25, 1.5, 2, 2.5, 3]) {
    const whole = packAll(shape);
    if (score(whole) < score(best) - 0.5) best = whole;
  }
  const out: Record<string, Box> = {};
  for (const { item: group, x: gx, y: gy } of best.placed) {
    if (group.framed)
      out[group.id] = { x: origin.x + gx, y: origin.y + gy, w: group.w, h: group.h };
    for (const { item: card, x, y } of group.block.placed) {
      out[card.id] = {
        x: origin.x + gx + group.pad.x + x,
        y: origin.y + gy + group.pad.y + y,
        w: card.w,
        h: card.h,
      };
    }
  }
  return out;
}
