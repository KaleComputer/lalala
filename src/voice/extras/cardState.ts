import { type SetStateAction, useState } from "react";
import { scrollTops } from "./canvasStore";

/**
 * What each card had open (tab, round, version, sections) and how far its body was scrolled, kept
 * in localStorage so a reload opens every card where the user left it. Writes wait a moment after the
 * last change and go out at once when the page hides; nothing runs while nothing changes.
 */
const PREFIX = "lalala:card:";
const SCROLL = "lalala:card-scroll";
const WRITE_MS = 400;

type Memory = {
  readonly cards: Map<string, Record<string, unknown>>;
  readonly dirty: Set<string>;
  timer: number;
  listening: boolean;
};
declare global {
  var __lalalaCardState: Memory | undefined;
}
// Shared by every extras build, so a swapped-in bundle reads what the last one hasn't written yet.
const memory: Memory = (globalThis.__lalalaCardState ??= {
  cards: new Map(),
  dirty: new Set(),
  timer: 0,
  listening: false,
});

function load(card: string) {
  let saved = memory.cards.get(card);
  if (saved === undefined) {
    try {
      const parsed: unknown = JSON.parse(localStorage.getItem(PREFIX + card) ?? "{}");
      saved =
        parsed !== null && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
    } catch {
      saved = {};
    }
    memory.cards.set(card, saved);
  }
  return saved;
}

function flush() {
  window.clearTimeout(memory.timer);
  memory.timer = 0;
  try {
    for (const card of memory.dirty) {
      localStorage.setItem(PREFIX + card, JSON.stringify(memory.cards.get(card) ?? {}));
    }
    const scrolled = Object.fromEntries(Object.entries(scrollTops).filter(([, top]) => top > 0));
    localStorage.setItem(SCROLL, JSON.stringify(scrolled));
  } catch {
    // Private mode or a full store: the cards just open fresh next time.
  }
  memory.dirty.clear();
}

function remember(card: string, key: string, value: unknown) {
  const saved = load(card);
  if (saved[key] === value) return;
  saved[key] = value;
  memory.dirty.add(card);
  if (memory.timer === 0) memory.timer = window.setTimeout(flush, WRITE_MS);
}

/**
 * useState that a reload keeps: `key` names the value inside `card`'s memory. The value must be
 * plain JSON. `keep` drops a saved value that no longer fits (a round or version since removed).
 */
export function useCardState<T>(
  card: string,
  key: string,
  initial: T | (() => T),
  keep?: (saved: T) => boolean,
) {
  const [value, setValue] = useState<T>(() => {
    const saved = load(card);
    if (key in saved && (keep === undefined || keep(saved[key] as T))) return saved[key] as T;
    return typeof initial === "function" ? (initial as () => T)() : initial;
  });
  const set = (next: SetStateAction<T>) =>
    setValue((was) => {
      const now = typeof next === "function" ? (next as (was: T) => T)(was) : next;
      remember(card, key, now);
      return now;
    });
  return [value, set] as const;
}

/**
 * Brings a card body back to `top` once its content is tall enough (pictures and lists can mount
 * after the card does); stops at the first touch, wheel or key so it never fights the user.
 */
export function holdScroll(body: HTMLElement, top: number) {
  const content = body.firstElementChild;
  if (top <= 0 || content === null || body.scrollTop >= top - 1) return () => {};
  // oxlint-disable-next-line t3code/no-raw-resize-observer -- extras import only React and this folder; this sets scrollTop, no React state
  const watch = new ResizeObserver(() => {
    if (body.closest("[data-lalala-card-off]") !== null) return;
    body.scrollTop = top;
    if (body.scrollTop >= top - 1) done();
  });
  const done = () => {
    watch.disconnect();
    for (const name of GIVE_UP) body.removeEventListener(name, done);
  };
  for (const name of GIVE_UP) body.addEventListener(name, done, { passive: true });
  watch.observe(content);
  return done;
}
const GIVE_UP = ["pointerdown", "wheel", "touchstart", "keydown"] as const;

if (typeof window !== "undefined" && !memory.listening) {
  memory.listening = true;
  try {
    const saved: unknown = JSON.parse(localStorage.getItem(SCROLL) ?? "{}");
    if (saved !== null && typeof saved === "object") {
      for (const [key, top] of Object.entries(saved)) {
        if (typeof top === "number" && scrollTops[key] === undefined) scrollTops[key] = top;
      }
    }
  } catch {
    // Nothing kept: every card opens at its top.
  }
  window.addEventListener("pagehide", flush);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") flush();
  });
}
