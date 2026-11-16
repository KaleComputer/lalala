// Tidy packs a big group about square, growing wide as well as tall, whatever size the group had:
// on 16 Nov the Voice group (49 cards, many auto-fit to 760×1600) had kept a 2520 px width from a
// resize, so every tidy stacked it into a 19,000 px column that squashed the mini-map.
// Run: node --experimental-strip-types --test scripts/tidy/check.test.mjs
import assert from "node:assert/strict";
import { test } from "node:test";

import { AREA, CARD_GAP, GROUP_GAP, tidyLayout } from "../../src/voice/extras/tidyPack.ts";

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
