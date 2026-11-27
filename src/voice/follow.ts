/**
 * Follow mode, per device: when on, the canvas automatically pans and zooms to newly added or
 * updated cards (even with voice off), and follows `[focus: <card id>]` / `[about: <card id>]`
 * tags from the brain.
 */
const KEY = "lalala:follow";
const EVENT = "lalala:follow";
const SETTINGS_KEY = "lalala:settings";
const SETTINGS_EVENT = "lalala:settings";

/** Whether the Follow feature is enabled in Settings → Labs (`labs.followButton`). */
export function isFollowLabEnabled(): boolean {
  try {
    const raw = JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? "null") as {
      labs?: { followButton?: unknown };
    } | null;
    return raw?.labs?.followButton === true;
  } catch {
    return false;
  }
}

/**
 * Effective Follow state on this device: always false while the Follow Labs gate is off, so a
 * previously stored `lalala:follow = "1"` never hijacks the viewport invisibly.
 */
export function isFollowing(): boolean {
  if (!isFollowLabEnabled()) return false;
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
  if (typeof document !== "undefined") document.dispatchEvent(new Event(EVENT));
}

export const subscribeFollow = (listener: () => void) => {
  const onStorage = (event: StorageEvent) => {
    if (event.key === KEY || event.key === SETTINGS_KEY) listener();
  };
  document.addEventListener(EVENT, listener);
  document.addEventListener(SETTINGS_EVENT, listener);
  window.addEventListener("storage", onStorage);
  return () => {
    document.removeEventListener(EVENT, listener);
    document.removeEventListener(SETTINGS_EVENT, listener);
    window.removeEventListener("storage", onStorage);
  };
};

/** Explicit follow voice commands: "follow"/"follow me" -> true, "stop following"/"unfollow" -> false. */
export function followCommand(text: string): boolean | undefined {
  const words = text.toLowerCase().match(/[a-z']+/g) ?? [];
  const said = words.join(" ");
  if (/\b(stop following|unfollow|don't follow|follow off|turn off follow|turn follow off|disable follow)\b/.test(said)) {
    return false;
  }
  if (
    /^(please )?(follow|follow me|follow along|follow canvas|follow the canvas|follow on|turn on follow|turn follow on|start following|enable follow)( please)?$/.test(
      said,
    )
  ) {
    return true;
  }
  return undefined;
}

const FOCUS_TAG = /\[focus:\s*([^\]]*)\]\s*/gi;
const ABOUT_TAG = /\[about:\s*([^\]]*)\]\s*/gi;

/** Splits a focus target like `open-questions#item-id` into its card name and optional item id or label. */
export function parseFocusTarget(target: string): {
  readonly card: string;
  readonly item: string | null;
} {
  const clean = target.replace(/[`"']/g, "").trim();
  const hash = clean.indexOf("#");
  if (hash < 0) return { card: clean, item: null };
  const card = clean.slice(0, hash).trim();
  const item = clean.slice(hash + 1).trim();
  return { card, item: item === "" ? null : item };
}

/** The reply without its focus tags (never spoken), and the card targets they name (optionally `card#item`), in order. */
export function takeFocus(text: string): { readonly text: string; readonly cards: string[] } {
  const cards: string[] = [];
  const clean = text.replace(FOCUS_TAG, (_, id: string) => {
    const { card, item } = parseFocusTarget(id);
    if (card !== "") cards.push(item === null ? card : `${card}#${item}`);
    return "";
  });
  return { text: clean, cards };
}

/** Card ids named by `[about: <card id>]` tags in a reply, in order. */
export function takeAboutCards(text: string): string[] {
  const cards: string[] = [];
  for (const match of text.matchAll(ABOUT_TAG)) {
    const card = (match[1] ?? "").replace(/[`"']/g, "").trim();
    if (card !== "") cards.push(card);
  }
  return cards;
}

const normStem = (value: string) => value.toLowerCase().replace(/[^a-z0-9]+/g, "");

/**
 * Matches an updated card file path (e.g. `/@fs/.../cards/NeedsTim.tsx` or `releaseVideoSlides/slides.json`)
 * against known cards (`id` and `title`), returning the best matching card id or null.
 */
export function matchCardByModulePath(
  modulePath: string,
  cards: Iterable<{ readonly id: string; readonly title: string }>,
): string | null {
  const clean = modulePath.split("?")[0] ?? modulePath;
  const segments = clean.split("/").filter(Boolean);
  const file = segments.at(-1) ?? "";
  const stem = file.replace(/\.[^.]+$/, "");
  if (stem === "" || stem === "index") return null;
  const parent = segments.length >= 2 ? segments.at(-2)! : "";
  const candidates = [stem, stem.replace(/data$/i, ""), parent]
    .map(normStem)
    .filter((part) => part.length >= 3);
  if (candidates.length === 0) return null;

  let best: string | null = null;
  let bestScore = 0;
  for (const card of cards) {
    const idNorm = normStem(card.id);
    const titleNorm = normStem(card.title);
    for (const candidate of candidates) {
      let score = 0;
      if (candidate === idNorm || candidate === titleNorm) score = 3;
      else if (idNorm.length >= 3 && (candidate.includes(idNorm) || idNorm.includes(candidate))) score = 2;
      else if (titleNorm.length >= 4 && (candidate.includes(titleNorm) || titleNorm.includes(candidate))) score = 1;
      if (score > bestScore) {
        bestScore = score;
        best = card.id;
      }
    }
  }
  return best;
}
