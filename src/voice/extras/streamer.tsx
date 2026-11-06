import { useSyncExternalStore } from "react";
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

export const useStreamer = () => useSyncExternalStore(subscribe, read, () => false);

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

/** The text's words and the spaces between, each word with its scrambled stand-in. */
function splitWords(text: string) {
  const parts: { part: string; at: number; fake: string | null }[] = [];
  let at = 0;
  let place = 0;
  for (const part of text.split(/(\s+)/)) {
    const isWord = part !== "" && !/^\s/.test(part);
    parts.push({ part, at, fake: isWord ? scrambleWord(part, place++) : null });
    at += part.length;
  }
  return parts;
}

/** Content text streamer mode scrambles word by word and pixelates (streamer.css). */
export function Hidden({ text }: { readonly text: string }) {
  if (!useStreamer()) return text;
  const parts = splitWords(text);
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
