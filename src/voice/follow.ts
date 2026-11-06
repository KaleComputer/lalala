/**
 * Follow mode, per device: while on, `[focus: <card id>]` in the brain's replies moves the canvas
 * to that card. Off, only a turn where the user asked to be shown something moves it.
 */
const KEY = "t3voice:follow";
const EVENT = "t3voice:follow";

export function isFollowing(): boolean {
  try {
    return localStorage.getItem(KEY) === "1";
  } catch {
    return false;
  }
}

export function setFollowing(on: boolean) {
  try {
    localStorage.setItem(KEY, on ? "1" : "0");
  } catch {
    // No storage: follow stays off.
  }
  document.dispatchEvent(new Event(EVENT));
}

export const subscribeFollow = (listener: () => void) => {
  document.addEventListener(EVENT, listener);
  return () => document.removeEventListener(EVENT, listener);
};

/** "follow", "follow me" turn it on; "stop following", "unfollow" turn it off; else undefined. */
export function followCommand(text: string): boolean | undefined {
  const words = text.toLowerCase().match(/[a-z']+/g) ?? [];
  const said = words.join(" ");
  if (/\b(stop following|unfollow|don't follow|follow off)\b/.test(said)) return false;
  if (words.length <= 4 && /\bfollow(ing)?\b/.test(said)) return true;
  return undefined;
}

/** The user asked to see something this turn, so its focus tag applies even with follow off. */
export const asksToSee = (text: string) =>
  /\b(show|take me to|zoom|highlight|go to|jump to|where is|where's|find)\b/i.test(text);

const FOCUS_TAG = /\[focus:\s*([^\]]*)\]\s*/gi;

/** The reply without its focus tags (never spoken), and the card ids they name, in order. */
export function takeFocus(text: string): { readonly text: string; readonly cards: string[] } {
  const cards: string[] = [];
  const clean = text.replace(FOCUS_TAG, (_, id: string) => {
    const card = id.replace(/[`"']/g, "").trim();
    if (card !== "") cards.push(card);
    return "";
  });
  return { text: clean, cards };
}
