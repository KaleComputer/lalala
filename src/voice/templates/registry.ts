/**
 * Built-in card templates (Todo list, Quick Chat, Image Gen, Video Gen): metadata, instance
 * creation, sanitization, prompt builders, and thin runtime bridges onto the canvas's existing
 * `__lalalaSendTyped`, `__lalalaLog`, and `cards/<id>.data.json` patterns.
 *
 * Pure TypeScript (no React or DOM-only imports at module scope) so the canvas UI, brain card tag
 * parser, layout persistence, and Node unit tests all share one source of truth.
 */

export const TEMPLATE_IDS = ["todo", "chat", "image-gen", "video-gen"] as const;
export type TemplateId = (typeof TEMPLATE_IDS)[number];
export type TemplateCategory = "productivity" | "conversation" | "media";

export type TemplateSize = {
  readonly w: number;
  readonly h: number;
};

export type TemplateMeta = {
  readonly id: TemplateId;
  readonly name: string;
  readonly shortLabel: string;
  readonly description: string;
  readonly category: TemplateCategory;
  readonly defaultTitle: string;
  readonly defaultSize: TemplateSize;
  readonly aliases: readonly string[];
  readonly voiceHints: readonly string[];
};

export type TemplateInstance = {
  readonly id: string;
  readonly template: TemplateId;
  readonly title: string;
  readonly canvas?: string;
  readonly w: number;
  readonly h: number;
  readonly createdAt: number;
  readonly config?: Readonly<Record<string, unknown>>;
};

export type CreateTemplateOptions = {
  readonly id?: string;
  readonly title?: string;
  readonly canvas?: string;
  readonly w?: number;
  readonly h?: number;
  readonly existingIds?: Iterable<string>;
  readonly config?: Readonly<Record<string, unknown>>;
  readonly now?: number;
};

export type BrainDispatchResult = {
  readonly ok: boolean;
  readonly via: "typed" | "log";
  readonly message: string;
};

export const IMAGE_ASPECTS = ["1:1", "16:9", "9:16", "4:3"] as const;
export type ImageAspect = (typeof IMAGE_ASPECTS)[number];

export const IMAGE_STYLES = [
  { value: "auto", label: "Auto" },
  { value: "photo", label: "Photoreal" },
  { value: "illustration", label: "Illustration" },
  { value: "3d", label: "3D Render" },
  { value: "minimal", label: "Minimal" },
] as const;
export type ImageStyle = (typeof IMAGE_STYLES)[number]["value"];

export const VIDEO_ASPECTS = ["16:9", "9:16", "1:1"] as const;
export type VideoAspect = (typeof VIDEO_ASPECTS)[number];

export const VIDEO_DURATIONS = ["5s", "8s", "10s"] as const;
export type VideoDuration = (typeof VIDEO_DURATIONS)[number];

export const VIDEO_MOTIONS = [
  { value: "subtle", label: "Subtle" },
  { value: "balanced", label: "Balanced" },
  { value: "dynamic", label: "Dynamic" },
] as const;
export type VideoMotion = (typeof VIDEO_MOTIONS)[number]["value"];

export const CARD_TEMPLATES: readonly TemplateMeta[] = [
  {
    id: "todo",
    name: "Todo list",
    shortLabel: "Todo",
    description: "Check off tasks locally or pull today's list from the brain.",
    category: "productivity",
    defaultTitle: "Todo",
    defaultSize: { w: 360, h: 420 },
    aliases: ["todo", "todos", "todo-list", "todolist", "tasks", "task-list", "checklist"],
    voiceHints: ["make a todo list", "open today's todos", "add a task list"],
  },
  {
    id: "chat",
    name: "Quick Chat",
    shortLabel: "Chat",
    description: "Type quick prompts straight to the voice brain with history.",
    category: "conversation",
    defaultTitle: "Quick Chat",
    defaultSize: { w: 380, h: 440 },
    aliases: ["chat", "quick-chat", "quickchat", "prompt", "ask"],
    voiceHints: ["open quick chat", "add a chat card"],
  },
  {
    id: "image-gen",
    name: "Image Gen",
    shortLabel: "Image Gen",
    description: "Compose image prompts with aspect and style, then send to the brain.",
    category: "media",
    defaultTitle: "Image Gen",
    defaultSize: { w: 400, h: 480 },
    aliases: ["image-gen", "imagegen", "image", "images", "art", "picture"],
    voiceHints: ["open image gen", "spawn an image generator"],
  },
  {
    id: "video-gen",
    name: "Video Gen",
    shortLabel: "Video Gen",
    description: "Draft video shots with duration, aspect, and camera motion.",
    category: "media",
    defaultTitle: "Video Gen",
    defaultSize: { w: 420, h: 500 },
    aliases: ["video-gen", "videogen", "video", "videos", "clip", "clips"],
    voiceHints: ["open video gen", "spawn a video generator"],
  },
];

export const TEMPLATE_BY_ID: Readonly<Record<TemplateId, TemplateMeta>> = Object.fromEntries(
  CARD_TEMPLATES.map((template) => [template.id, template]),
) as Readonly<Record<TemplateId, TemplateMeta>>;

const CARD_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/i;
const MAX_CONFIG_BYTES = 8 * 1024;
const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

export function isTemplateId(value: unknown): value is TemplateId {
  return typeof value === "string" && value in TEMPLATE_BY_ID;
}

export function getTemplate(id: string): TemplateMeta | undefined {
  return isTemplateId(id) ? TEMPLATE_BY_ID[id] : undefined;
}

export function resolveTemplateId(input: string): TemplateId | undefined {
  const normalized = input
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/g, "-");
  if (normalized === "") return undefined;
  if (isTemplateId(normalized)) return normalized;
  for (const template of CARD_TEMPLATES) {
    if (
      template.aliases.includes(normalized) ||
      template.name.toLowerCase().replace(/[\s_]+/g, "-") === normalized
    ) {
      return template.id;
    }
  }
  return undefined;
}

/** Normalizes an arbitrary string into a safe card id (`[a-z0-9-]`, max 64 chars). */
export function sanitizeCardId(raw: string): string {
  const cleaned = raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
  return cleaned;
}

/** Picks a collision-free card id for a newly spawned template instance. */
export function nextTemplateCardId(
  templateId: TemplateId,
  existingIds: Iterable<string> = [],
  preferredId?: string,
): string {
  const taken = new Set<string>();
  for (const id of existingIds) taken.add(id.toLowerCase());
  const base = sanitizeCardId(preferredId ?? "") || templateId;
  if (!taken.has(base)) return base;
  for (let index = 2; index < 10_000; index += 1) {
    const suffix = `-${index}`;
    const candidate = `${base.slice(0, 64 - suffix.length)}${suffix}`;
    if (!taken.has(candidate)) return candidate;
  }
  return `${base.slice(0, 50)}-${Date.now().toString(36)}`;
}

function sanitizeConfig(value: unknown): Readonly<Record<string, unknown>> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  try {
    const raw = JSON.stringify(value);
    if (raw === undefined || raw.length > MAX_CONFIG_BYTES) return undefined;
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

export function createTemplateInstance(
  templateId: TemplateId,
  options: CreateTemplateOptions = {},
): TemplateInstance {
  const meta = TEMPLATE_BY_ID[templateId];
  const id = nextTemplateCardId(templateId, options.existingIds, options.id);
  const title = (options.title?.trim() || meta.defaultTitle).slice(0, 80);
  const canvas = options.canvas?.trim() ? options.canvas.trim().slice(0, 80) : undefined;
  const w = clamp(
    Number.isFinite(options.w) ? Number(options.w) : meta.defaultSize.w,
    160,
    1200,
  );
  const h = clamp(
    Number.isFinite(options.h) ? Number(options.h) : meta.defaultSize.h,
    100,
    900,
  );
  const config = sanitizeConfig(options.config);
  return {
    id,
    template: templateId,
    title,
    ...(canvas ? { canvas } : {}),
    w,
    h,
    createdAt: Number.isFinite(options.now) ? Number(options.now) : Date.now(),
    ...(config ? { config } : {}),
  };
}

/** Validates a persisted template instance from storage or the shared canvas layout. */
export function sanitizeTemplateInstance(value: unknown): TemplateInstance | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  if (typeof raw.id !== "string" || !CARD_ID_PATTERN.test(raw.id)) return null;
  if (!isTemplateId(raw.template)) return null;
  const meta = TEMPLATE_BY_ID[raw.template];
  const title =
    typeof raw.title === "string" && raw.title.trim() !== ""
      ? raw.title.trim().slice(0, 80)
      : meta.defaultTitle;
  const canvas =
    typeof raw.canvas === "string" && raw.canvas.trim() !== ""
      ? raw.canvas.trim().slice(0, 80)
      : undefined;
  const w = clamp(Number.isFinite(raw.w) ? Number(raw.w) : meta.defaultSize.w, 160, 1200);
  const h = clamp(Number.isFinite(raw.h) ? Number(raw.h) : meta.defaultSize.h, 100, 900);
  const createdAt = Number.isFinite(raw.createdAt) && Number(raw.createdAt) >= 0 ? Number(raw.createdAt) : 0;
  const config = sanitizeConfig(raw.config);
  return {
    id: raw.id,
    template: raw.template,
    title,
    ...(canvas ? { canvas } : {}),
    w,
    h,
    createdAt,
    ...(config ? { config } : {}),
  };
}

export function sanitizeTemplates(
  value: unknown,
): Record<string, TemplateInstance | null> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return {};
  const result: Record<string, TemplateInstance | null> = {};
  for (const [id, entry] of Object.entries(value)) {
    if (!CARD_ID_PATTERN.test(id)) continue;
    if (entry === null) {
      result[id] = null;
      continue;
    }
    const parsed = sanitizeTemplateInstance({
      ...(typeof entry === "object" && entry !== null ? entry : {}),
      id,
    });
    if (parsed !== null) result[id] = parsed;
  }
  return result;
}

export function buildTodoSyncPrompt(options: {
  readonly cardId: string;
  readonly title: string;
  readonly openItems: readonly string[];
}): string {
  const summary =
    options.openItems.length > 0
      ? `Current open items (${options.openItems.length}): ${options.openItems.slice(0, 8).join("; ")}.`
      : "The list is currently empty.";
  return (
    `Update the "${options.title}" todo card (id: ${options.cardId}). ${summary} ` +
    `Write updated items as JSON to cards/${options.cardId}.data.json ` +
    `with shape {"items":[{"id":"...","text":"...","done":false}]} so the card refreshes cleanly.`
  );
}

export function buildChatPrompt(options: {
  readonly cardId: string;
  readonly title: string;
  readonly message: string;
}): string {
  return `[from card "${options.title}" (id: ${options.cardId})] ${options.message.trim()}`;
}

export function buildImageGenPrompt(options: {
  readonly cardId: string;
  readonly title: string;
  readonly prompt: string;
  readonly aspect: ImageAspect;
  readonly style: ImageStyle;
}): string {
  const styleNote = options.style === "auto" ? "" : `, style: ${options.style}`;
  return (
    `Generate an image for card "${options.title}" (id: ${options.cardId}). ` +
    `Prompt: "${options.prompt.trim()}" (aspect ${options.aspect}${styleNote}). ` +
    `Save the finished image URL or data URL into cards/${options.cardId}.data.json ` +
    `under {"images":[{"url":"...","prompt":"...","at":${Date.now()}}]}`
  );
}

export function buildVideoGenPrompt(options: {
  readonly cardId: string;
  readonly title: string;
  readonly prompt: string;
  readonly aspect: VideoAspect;
  readonly duration: VideoDuration;
  readonly motion: VideoMotion;
}): string {
  return (
    `Generate a ${options.duration} video clip for card "${options.title}" (id: ${options.cardId}). ` +
    `Prompt: "${options.prompt.trim()}" (aspect ${options.aspect}, motion: ${options.motion}). ` +
    `Save the finished clip URL into cards/${options.cardId}.data.json ` +
    `under {"videos":[{"url":"...","prompt":"...","at":${Date.now()}}]}`
  );
}

/** Mirrors `window.lalala.log(what, data)` for React template cards. */
export function logTemplateEvent(cardId: string, what: string, data: unknown = null): void {
  const log = (
    globalThis as {
      __lalalaLog?: (who: "system", type: string, data?: Record<string, unknown>) => void;
    }
  ).__lalalaLog;
  log?.("system", "card.log", { id: cardId, what, data });
}

/** Mirrors `window.lalala.data()` by reading `cards/<id>.data.json` through the host adapter. */
export async function readTemplateCardData<T = unknown>(cardId: string): Promise<T | null> {
  const adapters = (
    globalThis as {
      __lalalaAdapters?: {
        readonly readFile?: (path: string) => Promise<string | null>;
        readonly harness?: { readonly readFile?: (path: string) => Promise<string | null> };
      };
    }
  ).__lalalaAdapters;
  const read = adapters?.harness?.readFile ?? adapters?.readFile;
  if (!read) return null;
  try {
    const raw = await read(`cards/${cardId}.data.json`);
    if (raw === null || raw.trim() === "") return null;
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

/**
 * Sends a prompt straight to the voice brain via `globalThis.__lalalaSendTyped`, logging the
 * interaction to the session log just like `window.lalala.log`. Falls back gracefully offline.
 */
export async function dispatchTemplatePrompt(
  prompt: string,
  meta: {
    readonly cardId: string;
    readonly template: TemplateId;
    readonly action: string;
    readonly data?: unknown;
  },
): Promise<BrainDispatchResult> {
  const trimmed = prompt.trim();
  if (trimmed === "") {
    return { ok: false, via: "log", message: "Enter a prompt first." };
  }
  logTemplateEvent(meta.cardId, `${meta.template}.${meta.action}`, {
    prompt: trimmed,
    ...(meta.data === undefined ? {} : { data: meta.data }),
  });
  const sendTyped = (
    globalThis as { __lalalaSendTyped?: (text: string) => Promise<boolean> }
  ).__lalalaSendTyped;
  if (typeof sendTyped !== "function") {
    return { ok: false, via: "log", message: "Saved locally (connect a brain to run)." };
  }
  try {
    const sent = await sendTyped(trimmed);
    return sent
      ? { ok: true, via: "typed", message: "Sent to brain." }
      : { ok: false, via: "typed", message: "Brain is offline — saved locally." };
  } catch {
    return { ok: false, via: "typed", message: "Couldn't reach brain — saved locally." };
  }
}
