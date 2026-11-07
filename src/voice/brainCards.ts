import type { OrchestrationV2ProjectedTurnItem } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

import { voiceLog } from "./voiceLog";

/**
 * lalala.talk's cards: the brain writes `cards/<id>.html` in its project and puts
 * `[card id="…" title="…" size="WxH" canvas="…"]` in its reply (`[card remove id="…"]` takes one
 * off). The page reads the file over the T3 link and shows it (extras/BrainCards.tsx).
 */
const CARD_TAG = /\[card\b([^\]]*)\]\s*/gi;
// A tag still streaming in, so no half of it is ever spoken.
const OPEN_TAG = /\[card\b[^\]]*$/i;
const ATTRIBUTE = /(\w+)\s*=\s*"([^"]*)"/g;
const CARD_ID = /^[a-z0-9][a-z0-9-]{0,63}$/i;
const SIZE = /^(\d{2,4})\s*x\s*(\d{2,4})$/i;
const DEFAULT_SIZE = { w: 360, h: 280 };

type CardTag =
  | { readonly id: string; readonly remove: true }
  | {
      readonly id: string;
      readonly remove: false;
      readonly title: string;
      readonly canvas: string | undefined;
      readonly w: number;
      readonly h: number;
    };

function parseTag(body: string): CardTag | null {
  const attributes = Object.fromEntries(
    [...body.matchAll(ATTRIBUTE)].map(([, key, value]) => [key!.toLowerCase(), value!.trim()]),
  );
  const id = attributes.id ?? "";
  if (!CARD_ID.test(id)) return null;
  if (/^\s*remove\b/i.test(body)) return { id, remove: true };
  const size = SIZE.exec(attributes.size ?? "");
  const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));
  return {
    id,
    remove: false,
    title: attributes.title || id,
    canvas: attributes.canvas || undefined,
    w: size ? clamp(Number(size[1]), 160, 1200) : DEFAULT_SIZE.w,
    h: size ? clamp(Number(size[2]), 100, 900) : DEFAULT_SIZE.h,
  };
}

/** The reply without its card tags (never spoken), and the cards they name, in order. */
export function takeCards(text: string): { readonly text: string; readonly cards: CardTag[] } {
  const cards: CardTag[] = [];
  const clean = text
    .replace(CARD_TAG, (_, body: string) => {
      const card = parseTag(body);
      if (card) cards.push(card);
      return "";
    })
    .replace(OPEN_TAG, "");
  return { text: clean, cards };
}

// Per device and brain thread: the newest reply whose cards are applied, so a reload or a call
// never brings back a card the user closed, while a new device picks up the brain's cards.
const seenKey = (threadId: string) => `lalala:cards-seen:${threadId}`;
const readSeen = (threadId: string) => {
  try {
    return Number(localStorage.getItem(seenKey(threadId)) ?? 0) || 0;
  } catch {
    return 0;
  }
};

/** Applies the card tags of the brain's finished replies that this device has not applied yet. */
export function applyCardTags(
  threadId: string,
  items: ReadonlyArray<OrchestrationV2ProjectedTurnItem>,
  readFile: (relativePath: string) => Promise<string | null>,
) {
  const seen = readSeen(threadId);
  let newest = seen;
  const tags: CardTag[] = [];
  for (const { item, visibility } of items) {
    if (item.type !== "assistant_message" || visibility !== "local" || item.streaming) continue;
    if (item.parentItemId !== null) continue;
    const at = DateTime.toEpochMillis(item.updatedAt);
    if (at <= seen) continue;
    newest = Math.max(newest, at);
    tags.push(...takeCards(item.text).cards);
  }
  if (newest === seen) return;
  try {
    localStorage.setItem(seenKey(threadId), String(newest));
  } catch {
    // No storage: applied again next time, which only reloads the same cards.
  }
  // In order: a card closed after it was made stays closed.
  void tags.reduce((done, tag) => done.then(() => apply(tag, readFile)), Promise.resolve());
}

async function apply(tag: CardTag, readFile: (relativePath: string) => Promise<string | null>) {
  const cards = globalThis.__lalalaCards;
  if (tag.remove) return cards?.remove(tag.id);
  try {
    const html = await readFile(`cards/${tag.id}.html`);
    if (html === null) throw new Error(`cards/${tag.id}.html is missing or over 1 MB`);
    const { title, w, h, canvas } = tag;
    cards?.put(tag.id, { title, w, h, html, ...(canvas ? { canvas } : {}) });
    voiceLog("brain", "card", { id: tag.id });
  } catch (cause) {
    voiceLog("system", "error", { where: "card", id: tag.id, message: String(cause) });
  }
}
