import { useLayoutEffect, useRef, useSyncExternalStore } from "react";

import { CanvasCard } from "./CanvasCard";
import "./brainCards.css";

/**
 * Cards the brain made as files (lalala.talk, whose prebuilt page can't load new card code): their
 * HTML as it was read, kept in this browser so they stay without a link to T3 Code.
 */
export type BrainCard = {
  readonly title: string;
  readonly canvas?: string;
  readonly w: number;
  readonly h: number;
  readonly html: string;
};
type Cards = Readonly<Record<string, BrainCard>>;

const KEY = "lalala:brain-cards";
const EVENT = "lalala:brain-cards";

function read(): Cards {
  try {
    return (JSON.parse(localStorage.getItem(KEY) ?? "null") as Cards | null) ?? {};
  } catch {
    return {};
  }
}

let cards = read();

function write(next: Cards) {
  cards = next;
  try {
    localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    // Full or no storage: the card shows for this visit only.
  }
  document.dispatchEvent(new Event(EVENT));
}

const api = {
  put: (id: string, card: BrainCard) => write({ ...cards, [id]: card }),
  remove: (id: string) => {
    if (!(id in cards)) return;
    const { [id]: _, ...rest } = cards;
    write(rest);
  },
};
declare global {
  /** How the host (src/voice/brainCards.ts) adds and removes the brain's file cards. */
  var __lalalaCards: typeof api | undefined;
}
globalThis.__lalalaCards = api;

const subscribe = (listener: () => void) => {
  const onStorage = (event: StorageEvent) => {
    if (event.key !== KEY) return;
    cards = read();
    listener();
  };
  document.addEventListener(EVENT, listener);
  window.addEventListener("storage", onStorage);
  return () => {
    document.removeEventListener(EVENT, listener);
    window.removeEventListener("storage", onStorage);
  };
};

// Inline code and https libraries run; nothing reaches the network or the page (opaque origin).
const CSP =
  "default-src 'none'; script-src 'unsafe-inline' https:; style-src 'unsafe-inline' https:; " +
  "img-src data: blob: https:; font-src data: https:; media-src data: blob: https:";

/**
 * The brain's HTML in the card's colours and font, which the iframe would not inherit. They win on
 * the root (cards often say `html{color:inherit}`, which would be the browser's black serif there).
 */
function page(html: string, look: CSSStyleDeclaration) {
  return (
    `<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${CSP}">` +
    `<style>:root{color-scheme:${look.colorScheme || "normal"};color:${look.color} !important;` +
    `font-family:${look.fontFamily} !important;background:transparent !important;` +
    `font-size:${look.fontSize};line-height:1.4}body{margin:0}</style>` +
    html
  );
}

function CardFrame(props: { readonly title: string; readonly html: string }) {
  const ref = useRef<HTMLIFrameElement>(null);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- the iframe's document takes the card's computed colours, known only once it is in the DOM
  useLayoutEffect(() => {
    const frame = ref.current;
    if (frame) frame.srcdoc = page(props.html, getComputedStyle(frame));
  }, [props.html]);
  return <iframe ref={ref} title={props.title} sandbox="allow-scripts" data-lalala-brain-card="" />;
}

/** The brain's file cards, each on its canvas; the close button forgets one on this device. */
export function BrainCards() {
  const list = useSyncExternalStore(subscribe, () => cards);
  return Object.entries(list).map(([id, card]) => (
    <CanvasCard
      key={id}
      id={id}
      title={card.title}
      at={{ x: 40, y: 40, w: card.w, h: card.h }}
      onRemove={() => api.remove(id)}
      {...(card.canvas ? { canvas: card.canvas } : {})}
    >
      <CardFrame title={card.title} html={card.html} />
    </CanvasCard>
  ));
}
