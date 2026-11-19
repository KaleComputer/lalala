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

type Placed<T> = { w: number; h: number; placed: { item: T; x: number; y: number }[] };

/**
 * Packs `items` in each order into strips of many widths around `ideal`, and keeps the packing
 * `score` (w, h) rates lowest.
 */
function packBest<T extends Item>(
  items: readonly T[],
  gap: number,
  ideal: number,
  score: (w: number, h: number) => number,
): Placed<T> {
  const widest = Math.max(...items.map((s) => s.w));
  let best: Placed<T> = { w: 0, h: 0, placed: [] };
  let bestScore = Infinity;
  for (const order of orders) {
    const sorted = items.toSorted(order);
    const widths = new Set([widest]);
    for (let k = 0.6; k <= 1.8; k += 0.05) widths.add(Math.max(widest, Math.round(ideal * k)));
    let row = -gap;
    for (const s of sorted) widths.add(Math.max(widest, (row += s.w + gap)));
    for (const width of [...widths].toSorted((a, b) => a - b)) {
      const packed = skyline(sorted, width, gap);
      const rated = score(packed.w, packed.h);
      if (rated < bestScore - 0.5) {
        const placed = sorted.map((item, i) => ({ item, ...packed.spots[i]! }));
        best = { w: packed.w, h: packed.h, placed };
        bestScore = rated;
      }
    }
  }
  return best;
}

const packedArea = (items: readonly Item[], gap: number) =>
  items.reduce((sum, s) => sum + (s.w + gap) * (s.h + gap), 0);

/**
 * Packs `items` so the smallest frame of `aspect` (w / h) around them is as small as it can be:
 * the packed box fills that shape as fully as the sizes allow.
 */
function packToAspect<T extends Item>(items: readonly T[], aspect: number, gap: number) {
  return packBest(
    items,
    gap,
    Math.sqrt(packedArea(items, gap) * aspect),
    (w, h) => Math.max(w, h * aspect) + (w * h) / 1e9,
  );
}

/** How far from square (either way) a group's area may get when that packs it tighter. */
export const GROUP_SLACK = 1.2;

/**
 * Packs a group's cards so its area (cards plus AREA) is about square, within GROUP_SLACK, and as
 * small as it can be in that range: a big group grows wide as well as tall.
 */
function packGroup<T extends Item>(items: readonly T[]) {
  const slack = Math.log(GROUP_SLACK);
  return packBest(items, CARD_GAP, Math.sqrt(packedArea(items, CARD_GAP)), (w, h) => {
    const fw = w + AREA.pad * 2;
    const fh = h + AREA.head + AREA.pad;
    const off = Math.max(0, Math.abs(Math.log(fw / fh)) - slack);
    // Out of the square range always loses to in range, whatever the size.
    return off * 1e13 + fw * fh;
  });
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
 * Where tidy puts each card, its size kept: each group packed about square with room for its area,
 * the groups and ungrouped cards packed into one rectangle of `aspect` (the mini-map's) with its
 * top left at `origin`. Each group's area comes back as `group:<name>`. Same cards, same result.
 */
export function tidyLayout(
  cards: readonly TidyCard[],
  aspect: number,
  origin: { readonly x: number; readonly y: number },
): Record<string, Box> {
  const groups = new Map<string, TidyCard[]>();
  for (const card of cards) {
    const key = card.group === undefined ? `card:${card.id}` : `group:${card.group}`;
    groups.set(key, [...(groups.get(key) ?? []), card]);
  }
  const blocks = [...groups].map(([id, list]) => {
    const framed = id.startsWith("group:");
    const block = framed ? packGroup(list) : packToAspect(list, aspect, CARD_GAP);
    const pad = framed ? { x: AREA.pad, y: AREA.head } : { x: 0, y: 0 };
    const more = framed ? { w: AREA.pad * 2, h: AREA.head + AREA.pad } : { w: 0, h: 0 };
    return { id, w: block.w + more.w, h: block.h + more.h, block, pad, framed };
  });
  const whole = packToAspect(blocks, aspect, GROUP_GAP);
  const out: Record<string, Box> = {};
  for (const { item: group, x: gx, y: gy } of whole.placed) {
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

/** The empty space between two boxes along whichever axis they're furthest apart. */
const apart = (a: Box, b: Box) =>
  Math.max(0, b.x - (a.x + a.w), a.x - (b.x + b.w), b.y - (a.y + a.h), a.y - (b.y + b.h));
const union = (a: Box, b: Box): Box => {
  const x = Math.min(a.x, b.x);
  const y = Math.min(a.y, b.y);
  return { x, y, w: Math.max(a.x + a.w, b.x + b.w) - x, h: Math.max(a.y + a.h, b.y + b.h) - y };
};
/** Side by side or stacked, CARD_GAP apart, sharing some of that edge. */
const beside = (a: Box, b: Box) => {
  const near = (gap: number) => Math.abs(gap - CARD_GAP) < 0.5;
  const across = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
  const along = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
  return (
    (across > 0 && (near(b.x - (a.x + a.w)) || near(a.x - (b.x + b.w)))) ||
    (along > 0 && (near(b.y - (a.y + a.h)) || near(a.y - (b.y + b.h))))
  );
};

/**
 * Where a new card of `want`'s size joins its group: CARD_GAP beside one of the group's `cards`,
 * CARD_GAP clear of every `taken` box, inside the group's `area` when it fits, else growing it the
 * way tidy shapes a group (about square, then smallest). A spot whose grown area keeps GROUP_GAP
 * from the other groups' areas (`others`) beats one that doesn't; touching one comes last. With
 * nothing free beside its cards it takes the free spot nearest them, beside whatever is there.
 */
export function spotInGroup(
  want: Size,
  cards: readonly Box[],
  area: Box,
  taken: readonly Box[],
  others: readonly Box[],
): Box {
  const { w, h } = want;
  const middle = {
    x: (Math.min(...cards.map((c) => c.x)) + Math.max(...cards.map((c) => c.x + c.w))) / 2,
    y: (Math.min(...cards.map((c) => c.y)) + Math.max(...cards.map((c) => c.y + c.h))) / 2,
  };
  const slack = Math.log(GROUP_SLACK);
  const search = (from: readonly Box[], rate: (spot: Box) => number[]) => {
    const xs = new Set<number>();
    const ys = new Set<number>();
    for (const c of from) {
      for (const x of [c.x, c.x + c.w - w, c.x + c.w + CARD_GAP, c.x - w - CARD_GAP]) xs.add(x);
      for (const y of [c.y, c.y + c.h - h, c.y + c.h + CARD_GAP, c.y - h - CARD_GAP]) ys.add(y);
    }
    let best: Box | undefined;
    let bestScore = [Infinity];
    for (const x of xs) {
      for (const y of ys) {
        const spot = { x, y, w, h };
        // Half a px of slack: saved boxes have fractional edges from drags.
        if (!from.some((c) => beside(spot, c))) continue;
        if (taken.some((t) => apart(spot, t) < CARD_GAP - 0.5)) continue;
        const score = rate(spot);
        const i = score.findIndex((v, k) => !(Math.abs(v - (bestScore[k] ?? Infinity)) <= 0.5));
        if (i >= 0 && score[i]! < (bestScore[i] ?? Infinity)) {
          best = spot;
          bestScore = score;
        }
      }
    }
    return best;
  };
  const distance = (spot: Box) =>
    Math.hypot(spot.x + w / 2 - middle.x, spot.y + h / 2 - middle.y);
  const clash = (spot: Box) => {
    const grown = union(area, areaAround([spot]));
    const room = Math.min(Infinity, ...others.map((o) => apart(grown, o)));
    return { grown, tier: room >= GROUP_GAP - 0.5 ? 0 : room > 0 ? 1 : 2 };
  };
  return (
    search(cards, (spot) => {
      const { grown, tier } = clash(spot);
      const off = Math.max(0, Math.abs(Math.log(grown.w / grown.h)) - slack);
      return [tier, off * 1e13 + grown.w * grown.h, distance(spot)];
    }) ??
    search([...cards, ...taken], (spot) => [clash(spot).tier, distance(spot)]) ?? {
      ...want,
      x: Math.max(...[...cards, ...taken].map((c) => c.x + c.w)) + CARD_GAP,
      y: Math.min(...cards.map((c) => c.y)),
    }
  );
}
