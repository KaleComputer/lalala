import { Button } from "@ui-sdk/react/button";
import {
  Menu,
  MenuCheckboxItem,
  MenuContent,
  MenuGroup,
  MenuGroupLabel,
  MenuItem,
} from "@ui-sdk/react/menu";
import { useSyncExternalStore } from "react";
import {
  cardInfo,
  cardMark,
  getCards,
  getMarks,
  groupMark,
  growsWithContent,
  removeMarked,
  restoreMarked,
  setGrowsWithContent,
  setPrivate,
  subscribe as subscribeCards,
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

/** Opens the card's or group's menu at a point in the window (client px). */
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
 * Canvas lists what was removed, to put it back later. One menu for the whole surface, never one per card.
 */
export function CanvasMenu() {
  const state = useSyncExternalStore(subscribe, () => open);
  const lastUndo = useSyncExternalStore(subscribe, () => undo);
  const marks = useSyncExternalStore(subscribeMarks, getMarks);
  // Re-reads the card's box, so the switch shows a resize made while the menu is open.
  useSyncExternalStore(subscribeCards, getCards);

  let content = null;
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
    content = (
      <MenuGroup>
        <MenuGroupLabel data-lalala-canvas-menu-name="">
          <Hidden text={name} name />
        </MenuGroupLabel>
        <MenuCheckboxItem
          value="private"
          checked={own || withGroup}
          disabled={withGroup}
          onCheckedChange={togglePrivate}
        >
          <Check on={own || withGroup} />
          <span>
            {withGroup ? "Hidden in streamer mode with its group" : "Hide in streamer mode"}
          </span>
        </MenuCheckboxItem>
        {target.kind === "card" ? (
          <MenuCheckboxItem
            value="grow"
            checked={growsWithContent(target.id)}
            onCheckedChange={() => {
              setGrowsWithContent(target.id, !growsWithContent(target.id));
              closeCanvasMenu();
            }}
          >
            <Check on={growsWithContent(target.id)} />
            <span>Grow with its content</span>
          </MenuCheckboxItem>
        ) : null}
        <MenuItem
          value="remove"
          destructive
          data-danger=""
          data-agent-confirm={
            target.kind === "card"
              ? `Takes the card “${name}” off the canvas`
              : `Takes the group “${name}” and its cards off the canvas`
          }
          onSelect={() => remove(key, name)}
        >
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <path d="M6 6l12 12M18 6L6 18" />
          </svg>
          <span>{target.kind === "card" ? "Remove card" : "Remove group and its cards"}</span>
        </MenuItem>
      </MenuGroup>
    );
  }

  return (
    <>
      {/* Presses outside reach the canvas, as before: they close the menu and still pan. */}
      <Menu
        open={state !== null}
        modal={false}
        onOpenChange={(next) => {
          if (!next) closeCanvasMenu();
        }}
      >
        <MenuContent
          anchor={state === null ? null : { x: state.x, y: state.y }}
          side="bottom"
          align="start"
          sideOffset={0}
          collisionPadding={8}
          finalFocus="none"
          data-lalala-canvas-float=""
          data-lalala-canvas-menu=""
        >
          {content}
        </MenuContent>
      </Menu>
      {lastUndo === null ? null : (
        <div role="status" data-lalala-canvas-float="" data-lalala-canvas-undo="">
          <span>
            Removed <Hidden text={lastUndo.name} name />
          </span>
          <Button
            aria-label={`Undo removing ${lastUndo.name}`}
            onClick={() => {
              restoreMarked(lastUndo.key);
              window.clearTimeout(undoTimer);
              undo = null;
              emit();
            }}
          >
            Undo
          </Button>
        </div>
      )}
    </>
  );
}
