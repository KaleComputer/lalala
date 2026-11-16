/**
 * The page's side of the away inbox: what the harness keeps (src/t3/bridge.ts), marks sent back to
 * it, the brain's line about it, and heard marks from playback: an item is heard once every sentence
 * the brain said about it played to the end in a call (player.ts's HEARD_EVENT).
 */
import { bridgeState, useBridge } from "../../t3/bridge";
import { HEARD_EVENT } from "../player";
import { syncedSettings, useSyncedSettings } from "../settingsStore";
import { type InboxChange, type InboxItem, unreadItems } from "./capture";

const ROUTE = "/__lalala/t3/inbox";
const PRESENT_EVERY_MS = 60_000;
const TAG_ITEMS = 6;
const TAG_CHARS = 120;

export const useAwayInbox = () => useSyncedSettings().labs.awayInbox;
export const useInbox = () => useBridge((state) => state.inbox);

function send(change: InboxChange | { readonly call: true }) {
  const harness = globalThis.__lalalaAdapters?.harness;
  if (harness) return void harness.inbox?.(change).catch(() => undefined);
  void fetch(ROUTE, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(change),
  }).catch(() => undefined);
}

export const markInbox = (change: InboxChange) => send(change);

let presentAt = 0;
/** The user is in a call: the app's digest waits for a new two hours away. */
export function reportPresent() {
  if (!syncedSettings().labs.awayInbox || Date.now() - presentAt < PRESENT_EVERY_MS) return;
  presentAt = Date.now();
  send({ call: true });
}

// The first message of a call carries the unread items in full; later ones only their ids.
let listedThisCall = false;
export function inboxCallStarted() {
  listedThisCall = false;
  forgetSpoken();
  reportPresent();
}

/**
 * The line before the canvas tag (brief.ts): `[inbox: 2 unread · k3f9a Lead: … · x81bq …]` on the
 * call's first message, `[inbox: 2 unread · k3f9a, x81bq]` after. Empty when off or nothing waits.
 */
export function inboxTag(): string {
  if (!syncedSettings().labs.awayInbox) return "";
  const unread = unreadItems(bridgeState().inbox).toReversed();
  if (unread.length === 0) return "";
  const clip = (text: string) =>
    text.length > TAG_CHARS ? `${text.slice(0, TAG_CHARS - 1).trimEnd()}…` : text;
  const shown = unread.slice(0, TAG_ITEMS);
  const more = unread.length > TAG_ITEMS ? ` · ${unread.length - TAG_ITEMS} older` : "";
  const list = listedThisCall
    ? shown.map((item) => item.id).join(", ")
    : shown
        .map((item) => {
          const said = item.summary.startsWith(`${item.from}:`) ? item.summary : `${item.from}: ${item.summary}`;
          return `${item.id} ${clip(said).replace(/[[\]]/g, "")}`;
        })
        .join(" · ");
  listedThisCall = true;
  return `[inbox: ${unread.length} unread · ${list}${more}]\n`;
}

/** The brain's `[heard: k3f9a]` (never spoken). A bare `[heard]` is capture's business. */
const HEARD_TAG = /\[heard:\s*([^\]]*)\]/gi;
/** Every `[heard…]` tag, for the speech to leave out. */
export const ANY_HEARD_TAG = /\s*\[heard(?::[^\]]*)?\]\s*/gi;

/** Inbox ids a finished reply speaks for: the result its own run took in, and the ones it names. */
function idsFor(replyId: string, named: ReadonlyArray<string>): string[] {
  const items: ReadonlyArray<InboxItem> = bridgeState().inbox.items;
  return items
    .filter((item) => !item.heard && (item.replyId === replyId || named.includes(item.id)))
    .map((item) => item.id);
}

type Pending = { left: string[]; named: string[] | null };
// Per reply in this call: the sentences still to play, and (once it has arrived whole) the ids it names.
const pending = new Map<string, Pending>();

/** A sentence of reply `replyId` went to the player (`spoken`, as it will be said). */
export function trackSpoken(replyId: string, spoken: string) {
  if (spoken === "" || !syncedSettings().labs.awayInbox) return;
  const entry = pending.get(replyId) ?? { left: [], named: null };
  entry.left.push(spoken);
  pending.set(replyId, entry);
}

/** Reply `replyId` has arrived whole: once its sentences have played, what it spoke for is heard. */
export function replyFinished(replyId: string, text: string) {
  const entry = pending.get(replyId);
  if (!entry) return;
  entry.named = [...text.matchAll(HEARD_TAG)]
    .flatMap((match) => (match[1] ?? "").split(/[\s,]+/))
    .map((id) => id.replace(/[`"]/g, "").trim())
    .filter((id) => id !== "");
  settle(replyId, entry);
}

function settle(replyId: string, entry: Pending) {
  if (entry.named === null || entry.left.length > 0) return;
  pending.delete(replyId);
  const ids = idsFor(replyId, entry.named);
  if (ids.length > 0) markInbox({ heard: ids });
}

/** A call ended: what hadn't played by then wasn't heard. */
export function forgetSpoken() {
  pending.clear();
}

if (typeof document !== "undefined") {
  document.addEventListener(HEARD_EVENT, (event) => {
    // Each played sentence counts once, for the oldest reply still waiting on that text.
    for (const text of (event as CustomEvent<string[]>).detail) {
      for (const entry of pending.values()) {
        const at = entry.left.indexOf(text);
        if (at < 0) continue;
        entry.left.splice(at, 1);
        break;
      }
    }
    for (const [replyId, entry] of pending) settle(replyId, entry);
  });
}
