import { useSyncExternalStore } from "react";
import { REDACT_FONT_FACE } from "./redactFont";
import "./streamer.css";

// The app's side is ../streamerMode.tsx, which this folder may not import: same key, event and scramble.
const STORE = "lalala:streamer";
const EVENT = "lalala:streamer";

const read = () => {
  try {
    return localStorage.getItem(STORE) === "on";
  } catch {
    return false;
  }
};

function subscribe(onChange: () => void) {
  window.addEventListener("storage", onChange);
  window.addEventListener(EVENT, onChange);
  return () => {
    window.removeEventListener("storage", onChange);
    window.removeEventListener(EVENT, onChange);
  };
}

/** On: the canvas redacts every card's body (streamer.css) and the brain's HTML cards (BrainCards). */
export const useStreamer = () => useSyncExternalStore(subscribe, read, () => false);

// One root attribute drives the redaction CSS on both hosts, whichever React tree is mounted.
const mark = () => document.documentElement.toggleAttribute("data-lalala-streamer", read());
if (typeof document !== "undefined") {
  const face = document.createElement("style");
  face.textContent = REDACT_FONT_FACE;
  document.head.append(face);
  mark();
  subscribe(mark);
}

const GLYPHS = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
const SALT = Math.floor(Math.random() * 0x7fffffff);

function scrambleWord(word: string, place: number): string {
  let seed = (2166136261 ^ (SALT + place)) >>> 0;
  for (let i = 0; i < word.length; i++) seed = Math.imul(seed ^ word.charCodeAt(i), 16777619);
  let out = "";
  for (let i = 0; i < word.length; i++) {
    seed ^= seed << 13;
    seed ^= seed >>> 17;
    seed ^= seed << 5;
    out += GLYPHS[(seed >>> 0) % GLYPHS.length];
  }
  return out;
}

// Names inside otherwise generic labels ("Needs the user", "the user's pick", "Cleo’s test").
const NAME = /^the user\b|Pietrusky|^Cleo/;

/** The text's words and the spaces between, each (or each name) word with its scrambled stand-in. */
function splitWords(text: string, nameOnly: boolean) {
  const parts: { part: string; at: number; fake: string | null }[] = [];
  let at = 0;
  let place = 0;
  for (const part of text.split(/(\s+)/)) {
    const isWord = part !== "" && !/^\s/.test(part) && (!nameOnly || NAME.test(part));
    parts.push({ part, at, fake: isWord ? scrambleWord(part, place++) : null });
    at += part.length;
  }
  return parts;
}

/** A label drawn outside React (a group's headline on its canvas): only its names scrambled. */
export const hiddenName = (text: string) =>
  read()
    ? splitWords(text, true)
        .map(({ part, fake }) => fake ?? part)
        .join("")
    : text;

export { read as isStreamer, subscribe as subscribeStreamer };

/** Content text streamer mode scrambles word by word and pixelates (streamer.css); `name`: only the user's name. */
export function Hidden({ text, name = false }: { readonly text: string; readonly name?: boolean }) {
  if (!useStreamer()) return text;
  const parts = splitWords(text, name);
  // Each scrambled word sits over its real word's invisible box, so lines wrap exactly as before.
  return (
    <span data-streamer-words="">
      {parts.map(({ part, at, fake }) =>
        fake === null ? (
          part
        ) : (
          <span key={at} data-streamer-word="">
            <span data-streamer-ghost="">{part}</span>
            <span data-streamer-mask="" aria-hidden>
              {fake}
            </span>
          </span>
        ),
      )}
    </span>
  );
}
