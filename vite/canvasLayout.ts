import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { stateDir } from "./stateDir.mjs";

/**
 * The canvas's card boxes and its canvases, one layout for every device (canvasStore.ts): each
 * save merges the cards and canvases it changed (a deleted canvas is `null`) and the newest write
 * wins. `at` orders writes so clients can skip what they have.
 */
type Rect = { x: number; y: number; w: number; h: number };
type Canvas = { name: string; cards: string[] } | null;
/** A card's or group's own choice (`card:<id>`, `group:<label>`): removed when, private or not. */
type Mark = { removed?: number; private?: boolean };
type Layout = {
  cards: Record<string, Rect>;
  canvases: Record<string, Canvas>;
  marks: Record<string, Mark>;
  at: number;
};

const layoutFile = () =>
  process.env.LALALA_CANVAS_FILE?.trim() || NodePath.join(stateDir(), "canvas.json");

const isRect = (value: unknown): value is Rect =>
  typeof value === "object" &&
  value !== null &&
  (["x", "y", "w", "h"] as const).every((key) =>
    Number.isFinite((value as Record<string, unknown>)[key]),
  );

const rects = (value: unknown): Record<string, Rect> =>
  typeof value === "object" && value !== null
    ? Object.fromEntries(Object.entries(value).filter(([, rect]) => isRect(rect)))
    : {};

const canvases = (value: unknown): Record<string, Canvas> =>
  typeof value === "object" && value !== null
    ? Object.fromEntries(
        Object.entries(value).flatMap(([id, canvas]: [string, unknown]): [string, Canvas][] => {
          if (canvas === null) return [[id, null]];
          const { name, cards } = (canvas ?? {}) as { name?: unknown; cards?: unknown };
          return typeof name === "string" && Array.isArray(cards)
            ? [[id, { name: name.slice(0, 80), cards: cards.filter((c) => typeof c === "string") }]]
            : [];
        }),
      )
    : {};

const marks = (value: unknown): Record<string, Mark> =>
  typeof value === "object" && value !== null
    ? Object.fromEntries(
        Object.entries(value).flatMap(([key, mark]: [string, unknown]): [string, Mark][] => {
          if (typeof mark !== "object" || mark === null || key.length > 200) return [];
          const { removed, private: hidden } = mark as { removed?: unknown; private?: unknown };
          return [
            [
              key,
              {
                ...(Number(removed) > 0 && { removed: Number(removed) }),
                ...(typeof hidden === "boolean" && { private: hidden }),
              },
            ],
          ];
        }),
      )
    : {};

export function readCanvasLayout(): Layout {
  try {
    const saved = JSON.parse(NodeFS.readFileSync(layoutFile(), "utf8")) as Partial<Layout>;
    return {
      cards: rects(saved.cards),
      canvases: canvases(saved.canvases),
      marks: marks(saved.marks),
      at: Number(saved.at) || 0,
    };
  } catch {
    return { cards: {}, canvases: {}, marks: {}, at: 0 };
  }
}

/**
 * Merges `patch` (card id to box), `canvasPatch` and `markPatch` (each mark whole) into the layout
 * and returns the result. `placed` are new cards a client found a spot for: the first one to arrive
 * keeps its spot.
 */
export function saveCanvasCards(
  patch: unknown,
  canvasPatch?: unknown,
  placed?: unknown,
  markPatch?: unknown,
): Layout {
  const current = readCanvasLayout();
  const next = {
    cards: { ...rects(placed), ...current.cards, ...rects(patch) },
    canvases: { ...current.canvases, ...canvases(canvasPatch) },
    marks: { ...current.marks, ...marks(markPatch) },
    at: Math.max(Date.now(), current.at + 1),
  };
  const file = layoutFile();
  NodeFS.mkdirSync(NodePath.dirname(file), { recursive: true });
  NodeFS.writeFileSync(`${file}.tmp`, JSON.stringify(next));
  NodeFS.renameSync(`${file}.tmp`, file);
  return next;
}
