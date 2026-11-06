import { useLocation } from "@tanstack/react-router";
import { type CSSProperties, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";

import { ensureLocalApi } from "../localApi";
import { liftOverKeyboard } from "./keyboardLift";

// canvasStore lives in the separately built extras bundle; it announces changes with this event.
const subscribe = (listener: () => void) => {
  document.addEventListener("lalala:canvases", listener);
  return () => document.removeEventListener("lalala:canvases", listener);
};
const snapshot = () => globalThis.__lalalaCanvases?.snapshot() ?? null;

/**
 * The canvas's tab in the device bar's row: its name, which raises its list over the bar (switch,
 * New, Rename, Tidy, Delete). On /canvas; out of a call it is an empty, inert slot in the same spot,
 * like the rest of the row's call tabs. Follow lives in the settings.
 */
export function CanvasTabs(props: {
  readonly tabHost: HTMLElement;
  readonly panelHost: HTMLElement;
  readonly bar: HTMLElement;
  readonly live: boolean;
}) {
  const onCanvas = useLocation({ select: (location) => location.pathname === "/canvas" });
  const canvases = useSyncExternalStore(subscribe, snapshot, () => null);
  // Open: the list's right edge, px in from the frame's, so it rises over the name tab.
  const [openAt, setOpenAt] = useState<number | null>(null);
  const [renaming, setRenaming] = useState(false);
  const tabsRef = useRef<HTMLSpanElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const open = openAt !== null && props.live;
  const editing = renaming && open;
  const close = () => {
    setOpenAt(null);
    setRenaming(false);
  };

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- while the list is open: Esc or a tap outside closes it
  useEffect(() => {
    if (!open) return;
    // A click, not pointerdown: by then a rename field's blur has saved.
    const onClick = (event: MouseEvent) => {
      const target = event.target as Node;
      if (panelRef.current?.contains(target) || tabsRef.current?.contains(target)) return;
      setOpenAt(null);
      setRenaming(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setOpenAt(null);
      setRenaming(false);
    };
    document.addEventListener("click", onClick, true);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("click", onClick, true);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- the phone keyboard (visual viewport) lifts the bar over itself while a name is typed
  useEffect(() => (editing ? liftOverKeyboard(props.bar) : undefined), [editing, props.bar]);

  const api = globalThis.__lalalaCanvases;
  if (!onCanvas || canvases === null || api === undefined) return null;
  const current = canvases.list.find((canvas) => canvas.id === canvases.active);

  const toggle = () => {
    if (open) return close();
    const tabs = tabsRef.current;
    if (tabs === null) return;
    const frame = props.panelHost.getBoundingClientRect();
    setOpenAt(Math.max(0, Math.round(frame.right - tabs.getBoundingClientRect().right)));
  };

  const tabs = (
    <span ref={tabsRef} data-lalala-canvas-tabs="">
      <button
        type="button"
        data-lalala-canvas-name=""
        aria-hidden={!props.live}
        tabIndex={props.live ? undefined : -1}
        data-open={open ? "" : undefined}
        aria-expanded={open}
        aria-label={`Canvas: ${current?.name ?? "none"}. Switch, add, rename or delete canvases`}
        onClick={toggle}
      >
        <span>{current?.name ?? "No canvas"}</span>
      </button>
    </span>
  );

  const panel = !open ? null : (
    <div
      ref={panelRef}
      data-lalala-canvas-panel=""
      style={{ "--lalala-canvas-at": `${openAt}px` } as CSSProperties}
    >
      {canvases.list.length > 0 ? (
        <ul>
          {canvases.list.map((canvas) => (
            <li key={canvas.id} data-active={canvas.id === canvases.active ? "" : undefined}>
              {editing && canvas.id === current?.id ? (
                <input
                  aria-label="Canvas name"
                  autoFocus
                  defaultValue={canvas.name}
                  onBlur={(event) => {
                    api.rename(canvas.id, event.currentTarget.value);
                    setRenaming(false);
                  }}
                  onFocus={(event) => event.currentTarget.select()}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") event.currentTarget.blur();
                    if (event.key === "Escape") {
                      // Leaves the list open: Esc here only drops the edit.
                      event.stopPropagation();
                      event.currentTarget.value = canvas.name;
                      event.currentTarget.blur();
                    }
                  }}
                />
              ) : (
                <button
                  type="button"
                  aria-current={canvas.id === canvases.active}
                  onClick={() => {
                    api.select(canvas.id);
                    close();
                  }}
                >
                  <span>{canvas.name}</span>
                </button>
              )}
            </li>
          ))}
        </ul>
      ) : null}
      <div data-lalala-canvas-actions="">
        <button
          type="button"
          onClick={() => {
            api.create();
            setRenaming(true);
          }}
        >
          New
        </button>
        {current ? (
          <>
            <button type="button" onClick={() => setRenaming(true)}>
              Rename
            </button>
            <button
              type="button"
              onClick={() => {
                api.tidy();
                close();
              }}
            >
              Tidy
            </button>
            <button
              type="button"
              data-danger=""
              onClick={() => {
                close();
                void ensureLocalApi()
                  .dialogs.confirm(
                    `Delete the canvas "${current.name}" and its layout? Its cards stay in the code and can be put on another canvas.`,
                  )
                  .then((confirmed) => confirmed && api.remove(current.id));
              }}
            >
              Delete
            </button>
          </>
        ) : null}
      </div>
    </div>
  );

  return (
    <>
      {createPortal(tabs, props.tabHost)}
      {panel !== null ? createPortal(panel, props.panelHost) : null}
    </>
  );
}

/**
 * lalala mounts this in its top-left controls.
 * @public
 */
export function CanvasSwitcher() {
  return null;
}
