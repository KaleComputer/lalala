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

// The page is cross-origin isolated (COEP require-corp, for multi-threaded speech), so a card's
// picture, media, classic script or stylesheet from another site loads only if that site sends
// Cross-Origin-Resource-Policy. These CDNs do; anything else goes through lalala.talk's /x/ proxy
// (site/api/x.mjs). Module scripts, fonts and fetches are CORS loads and need no proxy.
const CORP_HOSTS = [
  "cdn.jsdelivr.net",
  "unpkg.com",
  "cdnjs.cloudflare.com",
  "code.jquery.com",
  "fonts.googleapis.com",
  "fonts.gstatic.com",
  "images.unsplash.com",
];

/** An outside https address as its /x/ proxy address; kept self-contained, it runs in the card too. */
function viaProxy(raw: string, origin: string, corpHosts: readonly string[]): string {
  const value = raw.trim();
  if (!/^(https:)?\/\//i.test(value)) return raw;
  try {
    const url = new URL(value.startsWith("//") ? `https:${value}` : value);
    if (url.origin === origin || corpHosts.includes(url.hostname)) return raw;
    return `${origin}/x/${url.host}${url.pathname}${url.search}`;
  } catch {
    return raw;
  }
}

/** Rewrites the outside addresses in a card's markup and styles to go through the proxy. */
function isolated(html: string, origin: string): string {
  const proxy = (raw: string) => viaProxy(raw, origin, CORP_HOSTS);
  const css = (text: string) =>
    text
      .replace(/url\(\s*(['"]?)([^'")]+?)\1\s*\)/gi, (_, q, raw) => `url(${q}${proxy(raw)}${q})`)
      .replace(/@import\s+(['"])([^'"]+)\1/gi, (_, q, raw) => `@import ${q}${proxy(raw)}${q}`);
  const doc = new DOMParser().parseFromString(html, "text/html");
  for (const el of doc.querySelectorAll("img, source, video, audio, track, input, script:not([type=module])")) {
    const src = el.getAttribute("src");
    if (src) el.setAttribute("src", proxy(src));
  }
  for (const el of doc.querySelectorAll("[srcset]")) {
    const srcset = el.getAttribute("srcset") ?? "";
    el.setAttribute("srcset", srcset.replace(/(^|,)\s*(\S+)/g, (_, sep, url) => `${sep} ${proxy(url)}`));
  }
  for (const el of doc.querySelectorAll("video[poster]")) el.setAttribute("poster", proxy(el.getAttribute("poster") ?? ""));
  for (const el of doc.querySelectorAll("link[href]")) {
    if (el.getAttribute("rel")?.includes("modulepreload")) continue;
    el.setAttribute("href", proxy(el.getAttribute("href") ?? ""));
  }
  for (const el of doc.querySelectorAll("image, feImage")) {
    for (const name of ["href", "xlink:href"]) {
      const href = el.getAttribute(name);
      if (href) el.setAttribute(name, proxy(href));
    }
  }
  for (const el of doc.querySelectorAll("style")) el.textContent = css(el.textContent ?? "");
  for (const el of doc.querySelectorAll("[style]")) el.setAttribute("style", css(el.getAttribute("style") ?? ""));
  // Pictures and media a script adds later: a blocked one retries once through the proxy.
  const retry = doc.createElement("script");
  retry.textContent =
    `addEventListener("error",function(e){var t=e.target,s=t&&t.getAttribute&&t.getAttribute("src");` +
    `if(!s||!/^(IMG|AUDIO|VIDEO|SOURCE)$/.test(t.tagName))return;var p=(${viaProxy.toString()})(s,` +
    `${JSON.stringify(origin)},${JSON.stringify(CORP_HOSTS)});if(p!==s)t.setAttribute("src",p)},true);`;
  doc.head.prepend(retry);
  return doc.documentElement.outerHTML;
}

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
    (crossOriginIsolated ? isolated(html, location.origin) : html)
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
