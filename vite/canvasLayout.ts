import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { stateDir } from "./stateDir.mjs";

/**
 * The canvas's card boxes and its canvases, one layout for every device (canvasStore.ts): each
 * save merges the cards and canvases it changed (a deleted canvas is `null`) and the newest write
 * wins. `at` orders writes so clients can skip what they have. `state` is what each card had open
 * (cardState.ts), merged per card and key.
 */
type Rect = { x: number; y: number; w: number; h: number };
type Canvas = { name: string; cards: string[] } | null;
/** A card's or group's own choice (`card:<id>`, `group:<label>`): removed when, private or not. */
type Mark = { removed?: number; private?: boolean };
type State = Record<string, unknown>;
type CardState = Record<string, State>;
/** Cross-device Follow target: the latest canvas switch or card focus from any device. */
export type FollowSignal = {
  canvas: string;
  card?: string;
  at: number;
  by?: string;
};
/** A built-in card template instance spawned on a canvas; `null` once removed, so removal syncs. */
export type TemplateInstance = {
  id: string;
  template: "todo" | "chat" | "image-gen" | "video-gen";
  title: string;
  canvas?: string;
  w: number;
  h: number;
  createdAt: number;
  config?: Record<string, unknown>;
};
type Templates = Record<string, TemplateInstance | null>;
type Layout = {
  cards: Record<string, Rect>;
  canvases: Record<string, Canvas>;
  marks: Record<string, Mark>;
  state: CardState;
  templates: Templates;
  follow?: FollowSignal;
  at: number;
};
/** A tab, a round, a filter: anything bigger is a card keeping data, which belongs in its own file. */
const MAX_VALUE = 16 * 1024;
const MAX_TEMPLATE_CONFIG = 8 * 1024;
const TEMPLATE_IDS = new Set(["todo", "chat", "image-gen", "video-gen"]);
const TEMPLATE_CARD_ID = /^[a-z0-9][a-z0-9-]{0,63}$/i;
const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

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

const cardState = (value: unknown): CardState =>
  typeof value === "object" && value !== null
    ? Object.fromEntries(
        Object.entries(value).flatMap(([card, keys]: [string, unknown]): [string, State][] =>
          typeof keys === "object" && keys !== null && !Array.isArray(keys) && card.length <= 200
            ? [
                [
                  card,
                  Object.fromEntries(
                    Object.entries(keys).filter(
                      ([key, kept]) =>
                        key.length <= 200 &&
                        kept !== undefined &&
                        (JSON.stringify(kept)?.length ?? Infinity) <= MAX_VALUE,
                    ),
                  ),
                ],
              ]
            : [],
        ),
      )
    : {};

const parseFollow = (value: unknown): FollowSignal | undefined => {
  if (typeof value !== "object" || value === null) return undefined;
  const raw = value as { canvas?: unknown; card?: unknown; at?: unknown; by?: unknown };
  if (typeof raw.canvas !== "string" || raw.canvas === "" || raw.canvas.length > 80) return undefined;
  const at = Number(raw.at);
  if (!Number.isFinite(at) || at <= 0) return undefined;
  return {
    canvas: raw.canvas,
    ...(typeof raw.card === "string" && raw.card !== "" && raw.card.length <= 200
      ? { card: raw.card }
      : {}),
    at,
    ...(typeof raw.by === "string" && raw.by !== "" && raw.by.length <= 64 ? { by: raw.by } : {}),
  };
};

const parseTemplates = (value: unknown): Templates =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? Object.fromEntries(
        Object.entries(value).flatMap(([id, raw]: [string, unknown]): [string, TemplateInstance | null][] => {
          if (!TEMPLATE_CARD_ID.test(id)) return [];
          if (raw === null) return [[id, null]];
          if (typeof raw !== "object" || Array.isArray(raw)) return [];
          const entry = raw as Record<string, unknown>;
          if (typeof entry.template !== "string" || !TEMPLATE_IDS.has(entry.template)) return [];
          const title =
            typeof entry.title === "string" && entry.title.trim() !== ""
              ? entry.title.trim().slice(0, 80)
              : entry.template;
          const canvas =
            typeof entry.canvas === "string" && entry.canvas.trim() !== ""
              ? entry.canvas.trim().slice(0, 80)
              : undefined;
          const w = clamp(Number.isFinite(entry.w) ? Number(entry.w) : 360, 160, 1200);
          const h = clamp(Number.isFinite(entry.h) ? Number(entry.h) : 420, 100, 900);
          const createdAt =
            Number.isFinite(entry.createdAt) && Number(entry.createdAt) >= 0
              ? Number(entry.createdAt)
              : 0;
          let config: Record<string, unknown> | undefined;
          if (
            typeof entry.config === "object" &&
            entry.config !== null &&
            !Array.isArray(entry.config) &&
            (JSON.stringify(entry.config)?.length ?? Infinity) <= MAX_TEMPLATE_CONFIG
          ) {
            config = entry.config as Record<string, unknown>;
          }
          return [
            [
              id,
              {
                id,
                template: entry.template as TemplateInstance["template"],
                title,
                ...(canvas ? { canvas } : {}),
                w,
                h,
                createdAt,
                ...(config ? { config } : {}),
              },
            ],
          ];
        }),
      )
    : {};

export function readCanvasLayout(): Layout {
  try {
    const saved = JSON.parse(NodeFS.readFileSync(layoutFile(), "utf8")) as Partial<Layout>;
    const follow = parseFollow(saved.follow);
    return {
      cards: rects(saved.cards),
      canvases: canvases(saved.canvases),
      marks: marks(saved.marks),
      state: cardState(saved.state),
      templates: parseTemplates(saved.templates),
      ...(follow ? { follow } : {}),
      at: Number(saved.at) || 0,
    };
  } catch {
    return { cards: {}, canvases: {}, marks: {}, state: {}, templates: {}, at: 0 };
  }
}

/**
 * Merges `patch` (card id to box), `canvasPatch`, `markPatch` (each mark whole), `statePatch`
 * (per card and key), `followPatch` (newest cross-device Follow target) and `templatePatch`
 * (spawned template instances and `null` tombstones) into the layout and returns the result.
 * `placed` are new cards a client found a spot for: the first one to arrive keeps its spot.
 */
export function saveCanvasCards(
  patch: unknown,
  canvasPatch?: unknown,
  placed?: unknown,
  markPatch?: unknown,
  statePatch?: unknown,
  followPatch?: unknown,
  templatePatch?: unknown,
): Layout {
  const current = readCanvasLayout();
  const state = { ...current.state };
  for (const [card, keys] of Object.entries(cardState(statePatch))) {
    state[card] = { ...state[card], ...keys };
  }
  const incomingFollow = parseFollow(followPatch);
  const follow =
    incomingFollow && (!current.follow || incomingFollow.at >= current.follow.at)
      ? incomingFollow
      : current.follow;
  const next: Layout = {
    cards: { ...rects(placed), ...current.cards, ...rects(patch) },
    canvases: { ...current.canvases, ...canvases(canvasPatch) },
    marks: { ...current.marks, ...marks(markPatch) },
    state,
    templates: { ...current.templates, ...parseTemplates(templatePatch) },
    ...(follow ? { follow } : {}),
    at: Math.max(Date.now(), current.at + 1),
  };
  const file = layoutFile();
  NodeFS.mkdirSync(NodePath.dirname(file), { recursive: true });
  NodeFS.writeFileSync(`${file}.tmp`, JSON.stringify(next));
  NodeFS.renameSync(`${file}.tmp`, file);
  return next;
}
