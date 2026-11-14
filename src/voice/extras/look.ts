import { useSyncExternalStore } from "react";

/**
 * The theme ("look" in code), per device: one of LOOKS, set as `data-lala-look` on <html> so every look's CSS
 * (looks/*.css) restyles the canvas, cards, device bar and settings over the same markup. `?look=`
 * in the URL sets it too, so `?look=neon` always gets back. Imported by the page (settings) and the
 * extras bundle alike: both copies share the key and event.
 */
const LOOKS = [
  { id: "neon", name: "Cyberpunk (default)" },
  { id: "paper", name: "Paper notebook" },
  { id: "t3", name: "T3 Code" },
] as const;
export type LookId = (typeof LOOKS)[number]["id"];

const KEY = "lalala:look";
const EVENT = "lalala:look";
const DEFAULT: LookId = "neon";
const isLook = (value: unknown): value is LookId => LOOKS.some((look) => look.id === value);

function readLook(): LookId {
  try {
    const stored = localStorage.getItem(KEY);
    return isLook(stored) ? stored : DEFAULT;
  } catch {
    return DEFAULT;
  }
}

const apply = () => {
  document.documentElement.dataset.lalaLook = readLook();
};

export function setLook(look: LookId) {
  try {
    localStorage.setItem(KEY, look);
  } catch {
    // No storage: this tab shows it until reload.
  }
  document.documentElement.dataset.lalaLook = look;
  document.dispatchEvent(new Event(EVENT));
}

function subscribe(listener: () => void) {
  const onStorage = (event: StorageEvent) => {
    if (event.key !== KEY) return;
    apply();
    listener();
  };
  document.addEventListener(EVENT, listener);
  window.addEventListener("storage", onStorage);
  return () => {
    document.removeEventListener(EVENT, listener);
    window.removeEventListener("storage", onStorage);
  };
}

export const useLook = () => useSyncExternalStore(subscribe, readLook, () => DEFAULT);

const fromUrl = new URLSearchParams(window.location.search).get("look");
if (isLook(fromUrl)) setLook(fromUrl);
else apply();
// Another tab or the other copy of this module changed it.
window.addEventListener("storage", (event) => {
  if (event.key === KEY) apply();
});
