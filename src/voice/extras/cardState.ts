import { type SetStateAction, useCallback, useState, useSyncExternalStore } from "react";
import { type CardState, linkCardState, scrollTops } from "./canvasStore";

/**
 * What each card had open (tab, round, version, sections) and how far its body was scrolled, kept
 * in localStorage so a reload opens every card where the user left it. What a card had open also
 * rides the shared canvas layout (canvasStore.ts), so every device shows it, newest change per key
 * winning; on lalala.talk it stays in this browser. Writes wait a moment after the last change and
 * go out at once when the page hides; nothing runs while nothing changes.
 */
const PREFIX = "lalala:card:";
const SCROLL = "lalala:card-scroll";
const WRITE_MS = 400;

type Memory = {
  readonly cards: Map<string, Record<string, unknown>>;
  readonly dirty: Set<string>;
  /** Keys changed here, per card, that the shared layout doesn't have yet. */
  unsent: Map<string, Set<string>>;
  listeners: Map<string, Set<() => void>>;
  /** The shared layout's state once read; null without one (yet). */
  shared: CardState | null;
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
  unsent: new Map(),
  listeners: new Map(),
  shared: null,
  timer: 0,
  listening: false,
});
// A memory made by a build from before card state was shared.
memory.unsent ??= new Map();
memory.listeners ??= new Map();
memory.shared ??= null;

const same = (a: unknown, b: unknown) => a === b || JSON.stringify(a) === JSON.stringify(b);

function markUnsent(card: string, key: string) {
  let keys = memory.unsent.get(card);
  if (keys === undefined) memory.unsent.set(card, (keys = new Set()));
  keys.add(key);
}

/** Keys this device kept that the shared layout has never had go to it, so the others get them. */
function seed(card: string, saved: Record<string, unknown>) {
  const shared = memory.shared?.[card];
  if (memory.shared === null) return;
  for (const key of Object.keys(saved)) {
    if (shared === undefined || !(key in shared)) markUnsent(card, key);
  }
}

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
    seed(card, saved);
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

const keepSoon = (card: string) => {
  memory.dirty.add(card);
  if (memory.timer === 0) memory.timer = window.setTimeout(flush, WRITE_MS);
};
const notify = (card: string) => {
  for (const listener of memory.listeners.get(card) ?? []) listener();
};

const sendSoon = linkCardState({
  unsent: () =>
    Object.fromEntries(
      [...memory.unsent].flatMap(([card, keys]) => {
        const saved = load(card);
        const values = [...keys].filter((key) => key in saved).map((key) => [key, saved[key]]);
        return values.length > 0 ? [[card, Object.fromEntries(values)]] : [];
      }),
    ),
  sent: (sent) => {
    for (const [card, values] of Object.entries(sent)) {
      const keys = memory.unsent.get(card);
      const saved = load(card);
      // Changed again while sending: still unsent.
      for (const [key, value] of Object.entries(values)) {
        if (saved[key] === value) keys?.delete(key);
      }
      if (keys?.size === 0) memory.unsent.delete(card);
    }
  },
  adopt: (state) => {
    const first = memory.shared === null;
    memory.shared = state;
    if (first) for (const [card, saved] of memory.cards) seed(card, saved);
    for (const [card, values] of Object.entries(state)) {
      const saved = load(card);
      const mine = memory.unsent.get(card);
      let changed = false;
      for (const [key, value] of Object.entries(values)) {
        if (mine?.has(key) || same(saved[key], value)) continue;
        saved[key] = value;
        changed = true;
      }
      if (changed) {
        keepSoon(card);
        notify(card);
      }
    }
    if (memory.unsent.size > 0) sendSoon();
  },
});

function remember(card: string, key: string, value: unknown) {
  const saved = load(card);
  if (saved[key] === value) return;
  saved[key] = value;
  keepSoon(card);
  markUnsent(card, key);
  sendSoon();
  notify(card);
}

function listen(card: string, listener: () => void) {
  let listeners = memory.listeners.get(card);
  if (listeners === undefined) memory.listeners.set(card, (listeners = new Set()));
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) memory.listeners.delete(card);
  };
}

/**
 * useState that a reload and every other device keep: `key` names the value inside `card`'s
 * memory. The value must be plain JSON. `keep` drops a saved value that no longer fits (a round or
 * version since removed).
 */
export function useCardState<T>(
  card: string,
  key: string,
  initial: T | (() => T),
  keep?: (saved: T) => boolean,
) {
  const [fallback] = useState(initial);
  const subscribe = useCallback((listener: () => void) => listen(card, listener), [card]);
  const pick = (stored: unknown) =>
    stored !== undefined && (keep === undefined || keep(stored as T)) ? (stored as T) : fallback;
  const stored = useSyncExternalStore(subscribe, () => load(card)[key]);
  const value = pick(stored);
  const set = (next: SetStateAction<T>) =>
    remember(
      card,
      key,
      typeof next === "function" ? (next as (was: T) => T)(pick(load(card)[key])) : next,
    );
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
