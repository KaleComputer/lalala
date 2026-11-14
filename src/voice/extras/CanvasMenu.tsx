import { useSyncExternalStore } from "react";
import {
  cardInfo,
  cardMark,
  getMarks,
  groupMark,
  removeMarked,
  restoreMarked,
  setPrivate,
  subscribeMarks,
} from "./canvasStore";
import { Hidden } from "./streamer";

/** What a menu is for: a card (by its id in code) or a group (by its label). */
export type MenuFor =
  | { readonly kind: "card"; readonly id: string }
  | { readonly kind: "group"; readonly label: string };
type Open = { readonly for: MenuFor; readonly x: number; readonly y: number };
type Undo = { readonly key: string; readonly name: string };

/** The one open menu and the last removal's undo, outside React: the surface opens them from its gestures. */
let open: Open | null = null;
let undo: Undo | null = null;
let undoTimer = 0;
const listeners = new Set<() => void>();
const emit = () => {
  for (const listener of listeners) listener();
};
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => void listeners.delete(listener);
};
const UNDO_MS = 8_000;

/** Opens the card's or group's menu at a point on the surface (px from its top left). */
export function openCanvasMenu(target: MenuFor, x: number, y: number) {
  open = { for: target, x, y };
  emit();
}
export function closeCanvasMenu() {
  if (open === null) return;
  open = null;
  emit();
}
export const isCanvasMenuOpen = () => open !== null;

function remove(key: string, name: string) {
  removeMarked(key);
  open = null;
  undo = { key, name };
  window.clearTimeout(undoTimer);
  undoTimer = window.setTimeout(() => {
    undo = null;
    emit();
  }, UNDO_MS);
  emit();
}

const Check = ({ on }: { readonly on: boolean }) => (
  <svg viewBox="0 0 24 24" aria-hidden="true" data-on={on ? "" : undefined}>
    {on ? <path d="m5 12.5 4.5 4.5L19 7.5" /> : null}
  </svg>
);

/**
 * A card's or group's menu (right-click or a long press on its header or headline): hide its
 * pictures in streamer mode, or take it off the canvas; and the undo after a removal. Settings ›
 * Canvas lists what was removed, to put it back later.
 */
export function CanvasMenu() {
  const state = useSyncExternalStore(subscribe, () => open);
  const lastUndo = useSyncExternalStore(subscribe, () => undo);
  const marks = useSyncExternalStore(subscribeMarks, getMarks);

  let menu = null;
  if (state !== null) {
    const target = state.for;
    const card = target.kind === "card" ? cardInfo(target.id) : undefined;
    const key = target.kind === "card" ? cardMark(target.id) : groupMark(target.label);
    const name = target.kind === "card" ? (card?.title ?? target.id) : target.label;
    const group = target.kind === "card" ? card?.group : target.label;
    const byGroup = group !== undefined && marks[groupMark(group)]?.private === true;
    const own = target.kind === "card" ? (marks[key]?.private ?? card?.private ?? false) : byGroup;
    const withGroup = target.kind === "card" && byGroup && !own;
    const togglePrivate = () => {
      if (target.kind === "group") setPrivate(key, own ? undefined : true);
      // Back to the card's own default: nothing stored.
      else setPrivate(key, !own === (card?.private ?? false) ? undefined : !own);
      closeCanvasMenu();
    };
    menu = (
      <div
        role="menu"
        aria-label={`${target.kind === "card" ? "Card" : "Group"} ${name}`}
        data-lalala-canvas-float=""
        data-lalala-canvas-menu=""
        style={{ left: `${state.x}px`, top: `${state.y}px` }}
        ref={(node) => {
          if (node === null) return;
          // Kept on screen: flipped left or up when it would run past an edge.
          const box = node.getBoundingClientRect();
          const parent = node.offsetParent?.getBoundingClientRect();
          if (!parent) return;
          if (box.right > parent.right - 8)
            node.style.left = `${Math.max(8, state.x - box.width)}px`;
          if (box.bottom > parent.bottom - 8)
            node.style.top = `${Math.max(8, state.y - box.height)}px`;
          node.querySelector<HTMLElement>("[role^=menuitem]:not(:disabled)")?.focus({
            preventScroll: true,
          });
        }}
        onKeyDown={(event) => {
          if (event.key === "Escape") closeCanvasMenu();
          if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
          event.preventDefault();
          const items = [
            ...event.currentTarget.querySelectorAll<HTMLElement>("[role^=menuitem]:not(:disabled)"),
          ];
          const at = items.indexOf(document.activeElement as HTMLElement);
          const step = event.key === "ArrowDown" ? 1 : -1;
          items[(at + step + items.length) % items.length]?.focus();
        }}
      >
        <p data-lalala-canvas-menu-name="">
          <Hidden text={name} name />
        </p>
        <button
          type="button"
          role="menuitemcheckbox"
          aria-checked={own || withGroup}
          disabled={withGroup}
          onClick={togglePrivate}
        >
          <Check on={own || withGroup} />
          <span>
            {withGroup ? "Hidden in streamer mode with its group" : "Hide in streamer mode"}
          </span>
        </button>
        <button type="button" role="menuitem" data-danger="" onClick={() => remove(key, name)}>
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M6 6l12 12M18 6L6 18" />
          </svg>
          <span>{target.kind === "card" ? "Remove card" : "Remove group and its cards"}</span>
        </button>
      </div>
    );
  }

  return (
    <>
      {menu}
      {lastUndo === null ? null : (
        <div role="status" data-lalala-canvas-float="" data-lalala-canvas-undo="">
          <span>
            Removed <Hidden text={lastUndo.name} name />
          </span>
          <button
            type="button"
            onClick={() => {
              restoreMarked(lastUndo.key);
              window.clearTimeout(undoTimer);
              undo = null;
              emit();
            }}
          >
            Undo
          </button>
        </div>
      )}
    </>
  );
}
