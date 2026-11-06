import { useSyncExternalStore } from "react";
import "./streamerMode.css";

// Shared by name with extras/StreamerToggle.tsx, which turns it on and off but may not import app code.
const STORE = "lalala:streamer";
const EVENT = "lalala:streamer";

const readStreamerMode = () => {
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

/** Streamer mode: thread titles and message text render scrambled and pixelated, app-wide. */
export const useStreamerMode = () => useSyncExternalStore(subscribe, readStreamerMode, () => false);

const GLYPHS = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
const SALT = Math.floor(Math.random() * 0x7fffffff);

/**
 * Each word becomes random characters of its length, seeded by the word and its place, so the
 * text keeps its shape, re-renders never flicker, and streamed text only changes its last word.
 */
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

function scrambleText(text: string): string {
  let place = 0;
  return text.replace(/\S+/g, (word) => scrambleWord(word, place++));
}

/** For text that leaves React, such as a system notification. */
export const streamerText = (text: string) => (readStreamerMode() ? scrambleText(text) : text);

export function useStreamerText(text: string): string;
export function useStreamerText(text: string | null | undefined): string | null | undefined;
export function useStreamerText(text: string | null | undefined) {
  const on = useStreamerMode();
  return on && text ? scrambleText(text) : text;
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

/** Content text (a title, a summary) that streamer mode scrambles and pixelates. */
export function StreamerText({ text }: { readonly text: string }) {
  if (!useStreamerMode()) return text;
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

/** The pixelate filter scrambled text is drawn through; mounted once while streamer mode is on. */
export function StreamerFilter() {
  if (!useStreamerMode()) return null;
  return (
    <svg aria-hidden width="0" height="0" style={{ position: "absolute" }}>
      <filter id="t3-streamer-pixelate" x="0" y="0" width="1" height="1">
        <feGaussianBlur in="SourceGraphic" stdDeviation="1.5" result="soft" />
        <feFlood x="2" y="2" width="1" height="1" />
        <feComposite width="5" height="5" />
        <feTile result="grid" />
        <feComposite in="soft" in2="grid" operator="in" />
        <feMorphology operator="dilate" radius="2" />
      </filter>
    </svg>
  );
}
