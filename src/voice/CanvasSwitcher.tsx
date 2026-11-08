import { useLocation } from "@tanstack/react-router";
import {
  type CSSProperties,
  type MouseEvent as ReactMouseEvent,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { createPortal } from "react-dom";

import { ensureLocalApi } from "../localApi";
import { liftOverKeyboard } from "./keyboardLift";
import { StreamerText } from "./streamerMode";

// canvasStore lives in the separately built extras bundle; it announces changes with this event.
const subscribe = (listener: () => void) => {
  document.addEventListener("lalala:canvases", listener);
  return () => document.removeEventListener("lalala:canvases", listener);
};
const snapshot = () => globalThis.__lalalaCanvases?.snapshot() ?? null;

/**
 * The canvas's tab in the device bar's row: a stacked-layers icon, which raises its list over the bar
 * (switch, New, Rename, Tidy, Delete). On /canvas, live in and out of a
 * call and offline too, like the gear. Follow lives in the settings.
 */
export function CanvasTabs(props: {
  readonly tabHost: HTMLElement;
  readonly panelHost: HTMLElement;
  readonly bar: HTMLElement;
}) {
  const onCanvas = useLocation({ select: (location) => location.pathname === "/canvas" });
  const canvases = useSyncExternalStore(subscribe, snapshot, () => null);
  // Open: the list's right edge, px in from the frame's, so it rises over the name tab.
  const [openAt, setOpenAt] = useState<number | null>(null);
  const [renaming, setRenaming] = useState(false);
  // Opened from the keyboard: focus starts on the open canvas's row.
  const [byKey, setByKey] = useState(false);
  const tabsRef = useRef<HTMLSpanElement>(null);
  const tabRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const open = openAt !== null;
  const editing = renaming && open;
  // Focus inside the list goes back to the tab, never to the page.
  const close = () => {
    if (panelRef.current?.contains(document.activeElement)) tabRef.current?.focus();
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
      if (panelRef.current?.contains(document.activeElement)) tabRef.current?.focus();
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

  const toggle = (event: ReactMouseEvent) => {
    if (open) return close();
    const tabs = tabsRef.current;
    if (tabs === null) return;
    setByKey(event.detail === 0);
    const frame = props.panelHost.getBoundingClientRect();
    setOpenAt(Math.max(0, Math.round(frame.right - tabs.getBoundingClientRect().right)));
  };

  const tabs = (
    <span ref={tabsRef} data-lalala-canvas-tabs="">
      <button
        ref={tabRef}
        type="button"
        data-lalala-canvas-name=""
        data-lalala-tab=""
        data-open={open ? "" : undefined}
        aria-expanded={open}
        aria-label={`Canvases (${current?.name ?? "none"})`}
        onClick={toggle}
      >
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path d="M12 3 2 8l10 5 10-5-10-5Z" />
          <path d="m2 13 10 5 10-5" />
          <path d="m2 18 10 5 10-5" />
        </svg>
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
                    // Finished from the keyboard: the row that replaces the field takes focus.
                    if (event.key === "Enter" || event.key === "Escape") setByKey(true);
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
                  autoFocus={byKey && canvas.id === canvases.active}
                  onClick={() => {
                    api.select(canvas.id);
                    close();
                  }}
                >
                  {canvas.id === canvases.active ? (
                    <svg viewBox="0 0 24 24" aria-hidden="true">
                      <path d="m4 12.5 5 5L20 6.5" />
                    </svg>
                  ) : null}
                  <span>
                    <StreamerText text={canvas.name} />
                  </span>
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
