// Tidy packs a big group about square, growing wide as well as tall, whatever size the group had:
// on 16 Nov the Voice group (49 cards, many auto-fit to 760×1600) had kept a 2520 px width from a
// resize, so every tidy stacked it into a 19,000 px column that squashed the mini-map.
// Run: node --experimental-strip-types --test scripts/tidy/check.test.mjs
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  AREA,
  CARD_GAP,
  GROUP_GAP,
  areaAround,
  spotInGroup,
  tidyLayout,
} from "../../src/voice/extras/tidyPack.ts";

// The Voice group's card sizes that day, rounded.
const VOICE = [
  [760, 1373], [760, 1600], [760, 1390], [1000, 963], [760, 1600], [961, 1196], [856, 671],
  [1100, 1000], [1100, 1000], [760, 1091], [760, 1250], [760, 1600], [760, 1600], [760, 1600],
  [760, 1600], [760, 1600], [760, 1600], [760, 1600], [919, 1600], [760, 1277], [554, 625],
  [961, 1600], [760, 824], [827, 1351], [760, 1600], [760, 704], [720, 900], [900, 808],
  [760, 796], [600, 760], [760, 613], [760, 936], [760, 1370], [640, 560], [640, 800],
  [957, 1600], [882, 715], [716, 635], [760, 1089], [630, 709], [864, 1600], [888, 1600],
  [760, 940], [625, 560], [607, 701], [760, 900], [760, 900], [608, 560], [704, 729],
].map(([w, h], i) => ({ id: `voice-${i}`, group: "Voice", w, h }));
const SMALL = [
  [760, 1600], [760, 1240], [760, 1600], [640, 800],
].map(([w, h], i) => ({ id: `small-${i}`, group: "Small", w, h }));
const LOOSE = [
  { id: "loose-0", w: 1120, h: 1740 },
  { id: "loose-1", w: 600, h: 400 },
];
const MAP = 16 / 10;
const cards = [...VOICE, ...SMALL, ...LOOSE];
// The old tidy took this, the width the Voice group had kept; it must no longer shape the group.
const kept = new Map([["Voice", { w: 2520, h: 19357 }]]);
const laid = tidyLayout(cards, MAP, { x: 0, y: 0 }, kept);

const apart = (a, b, gap) =>
  a.x + a.w + gap <= b.x + 0.5 ||
  b.x + b.w + gap <= a.x + 0.5 ||
  a.y + a.h + gap <= b.y + 0.5 ||
  b.y + b.h + gap <= a.y + 0.5;

test("each group's area is about square", () => {
  for (const name of ["Voice", "Small"]) {
    const { w, h } = laid[`group:${name}`];
    const ratio = Math.max(w / h, h / w);
    assert.ok(ratio <= 1.2 + 1e-9, `${name} is ${Math.round(w)}×${Math.round(h)}`);
  }
});

test("cards keep their size, sit inside their area and keep even gaps", () => {
  for (const card of cards) {
    const r = laid[card.id];
    assert.equal(r.w, card.w);
    assert.equal(r.h, card.h);
    if (card.group === undefined) continue;
    const area = laid[`group:${card.group}`];
    assert.ok(r.x >= area.x + AREA.pad - 0.5 && r.x + r.w <= area.x + area.w - AREA.pad + 0.5);
    assert.ok(r.y >= area.y + AREA.head - 0.5 && r.y + r.h <= area.y + area.h - AREA.pad + 0.5);
  }
  for (const [i, a] of cards.entries()) {
    for (const b of cards.slice(i + 1)) {
      if (a.group === undefined || a.group !== b.group) continue;
      assert.ok(apart(laid[a.id], laid[b.id], CARD_GAP), `${a.id} and ${b.id} overlap`);
    }
  }
  const blocks = [
    laid["group:Voice"],
    laid["group:Small"],
    ...LOOSE.map((c) => laid[c.id]),
  ];
  for (const [i, a] of blocks.entries()) {
    for (const b of blocks.slice(i + 1)) assert.ok(apart(a, b, GROUP_GAP));
  }
});

test("the whole canvas comes out near the mini-map's shape", () => {
  const boxes = Object.values(laid);
  const w = Math.max(...boxes.map((r) => r.x + r.w)) - Math.min(...boxes.map((r) => r.x));
  const h = Math.max(...boxes.map((r) => r.y + r.h)) - Math.min(...boxes.map((r) => r.y));
  const off = Math.max(w / h / MAP, MAP / (w / h));
  assert.ok(off <= 1.6, `the canvas is ${Math.round(w)}×${Math.round(h)}`);
});

// A card added to a group on a tidied canvas: on 19 Nov one added to "kale-tts-1, release" (these
// two cards) landed far off at the bottom left, as new cards in a group did. Placing kept a new
// card's own area 16 px clear of other groups', which tidy leaves only 240 px away, so a group with
// neighbours all round and no room inside had no spot beside it, and the card went below them all.
const ring = Array.from({ length: 9 }, (_, g) =>
  [[1100, 1800], [1300, 1600]].map(([w, h], i) => ({ id: `g${g}-${i}`, group: `G${g}`, w, h })),
).flat();
const tidied = tidyLayout(ring, MAP, { x: 0, y: 0 });
const ringAreas = [...new Set(ring.map((c) => c.group))].map((name) => ({ name, ...tidied[`group:${name}`] }));
// The group with the most neighbours close by: boxed in on every side it can be.
const crowded = ringAreas.toSorted(
  (a, b) =>
    ringAreas.filter((o) => !apart(b, o, GROUP_GAP + 1)).length -
    ringAreas.filter((o) => !apart(a, o, GROUP_GAP + 1)).length,
)[0];

const joins = (name, want) => {
  const mine = ring.filter((c) => c.group === name).map((c) => tidied[c.id]);
  const taken = ring.map((c) => tidied[c.id]);
  const others = ringAreas.filter((a) => a.name !== name);
  return { mine, taken, spot: spotInGroup(want, mine, tidied[`group:${name}`], taken, others) };
};

test("a new card in a group lands beside its group's cards, CARD_GAP from each", () => {
  // Fits between this group's cards and its neighbours' (336 px), not with its own area clear.
  const { mine, taken, spot } = joins(crowded.name, { w: 280, h: 900 });
  assert.equal(spot.w, 280);
  assert.equal(spot.h, 900);
  const beside = mine.some((c) => {
    const gapX = Math.max(c.x - (spot.x + spot.w), spot.x - (c.x + c.w));
    const gapY = Math.max(c.y - (spot.y + spot.h), spot.y - (c.y + c.h));
    return (Math.abs(gapX - CARD_GAP) < 0.5 && gapY < 0) || (Math.abs(gapY - CARD_GAP) < 0.5 && gapX < 0);
  });
  assert.ok(beside, `landed at ${Math.round(spot.x)},${Math.round(spot.y)}`);
  for (const t of taken) assert.ok(apart(spot, t, CARD_GAP), "it overlaps a card");
});

test("a new card that fits in its group's area takes that room and grows nothing", () => {
  const { spot } = joins(crowded.name, { w: 600, h: 150 });
  const area = tidied[`group:${crowded.name}`];
  const grown = areaAround([spot]);
  assert.ok(grown.x >= area.x - 0.5 && grown.y >= area.y - 0.5, "it grew the area");
  assert.ok(grown.x + grown.w <= area.x + area.w + 0.5 && grown.y + grown.h <= area.y + area.h + 0.5, "it grew the area");
});
