import { useLocation } from "@tanstack/react-router";
import {
  type CSSProperties,
  type MouseEvent as ReactMouseEvent,
  useEffect,
  useEffectEvent,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { createPortal } from "react-dom";

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
  // "closing" plays the hologram back (list, then beam) before the list unmounts.
  const [closing, setClosing] = useState(false);
  const [renaming, setRenaming] = useState(false);
  // Delete asks inside the list, on the canvas it was pressed for, even if the open one changes meanwhile.
  const [deleting, setDeleting] = useState<{ readonly id: string; readonly name: string } | null>(
    null,
  );
  const confirmId = useId();
  const deleteRef = useRef<HTMLButtonElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  // Opened from the keyboard: focus starts on the open canvas's row.
  const [byKey, setByKey] = useState(false);
  const tabsRef = useRef<HTMLSpanElement>(null);
  const tabRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const open = openAt !== null && !closing;
  const phase = openAt === null ? "closed" : closing ? "closing" : "open";
  const editing = renaming && open;
  const hide = () => {
    setRenaming(false);
    setDeleting(null);
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) setOpenAt(null);
    else setClosing(true);
  };
  // Focus inside the list goes back to the tab, never to the page.
  const close = () => {
    if (panelRef.current?.contains(document.activeElement)) tabRef.current?.focus();
    hide();
  };
  const hideOnEvent = useEffectEvent(hide);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- while the list is open: Esc, a tap outside or another bar panel opening closes it
  useEffect(() => {
    if (!open) return;
    // A click, not pointerdown: by then a rename field's blur has saved.
    const onClick = (event: MouseEvent) => {
      const target = event.target as Node;
      if (panelRef.current?.contains(target) || tabsRef.current?.contains(target)) return;
      hideOnEvent();
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      if (panelRef.current?.contains(document.activeElement)) tabRef.current?.focus();
      hideOnEvent();
    };
    const onPanel = (event: Event) => {
      if ((event as CustomEvent<string>).detail !== "canvas") hideOnEvent();
    };
    document.addEventListener("click", onClick, true);
    document.addEventListener("keydown", onKey);
    document.addEventListener("lalala:panel", onPanel);
    return () => {
      document.removeEventListener("click", onClick, true);
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("lalala:panel", onPanel);
    };
  }, [open]);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- the phone keyboard (visual viewport) lifts the bar over itself while a name is typed
  useEffect(() => (editing ? liftOverKeyboard(props.bar) : undefined), [editing, props.bar]);

  // Backing out with Cancel hands focus back to DELETE, as it came from there.
  const refocusDelete = useRef(false);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- focus moves between DELETE and the confirmation's safe action as one replaces the other
  useLayoutEffect(() => {
    if (deleting !== null) cancelRef.current?.focus({ preventScroll: true });
    else if (refocusDelete.current) deleteRef.current?.focus({ preventScroll: true });
    refocusDelete.current = false;
  }, [deleting]);
  const cancelDelete = () => {
    refocusDelete.current = true;
    setDeleting(null);
  };

  const api = globalThis.__lalalaCanvases;
  if (!onCanvas) return null;
  // The tab is in the row from the bar's first frame; only its list waits for the extras bundle's store.
  const current = canvases?.list.find((canvas) => canvas.id === canvases.active);

  const toggle = (event: ReactMouseEvent) => {
    if (open) return close();
    const tabs = tabsRef.current;
    if (tabs === null || canvases === null || api === undefined) return;
    setByKey(event.detail === 0);
    const frame = props.panelHost.getBoundingClientRect();
    setClosing(false);
    setOpenAt(Math.max(0, Math.round(frame.right - tabs.getBoundingClientRect().right)));
    // One bar panel at a time: the input field closes.
    document.dispatchEvent(new CustomEvent("lalala:panel", { detail: "canvas" }));
  };

  const tabs = (
    <span ref={tabsRef} data-lalala-canvas-tabs="">
      <button
        ref={tabRef}
        type="button"
        data-lalala-canvas-name=""
        data-lalala-tab=""
        data-open={open ? "" : undefined}
        data-state={phase}
        aria-expanded={open}
        aria-label={`Canvases (${current?.name ?? "none"})`}
        onClick={toggle}
      >
        <i aria-hidden="true" />
        <b
          data-lalala-beam=""
          aria-hidden="true"
          onAnimationEnd={(event) => {
            if (event.animationName !== "lalala-beam-down" || !closing) return;
            setClosing(false);
            setOpenAt(null);
          }}
        />
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path d="M12 3 2 8l10 5 10-5-10-5Z" />
          <path d="m2 13 10 5 10-5" />
          <path d="m2 18 10 5 10-5" />
        </svg>
      </button>
    </span>
  );

  const panel = openAt === null || canvases === null || api === undefined ? null : (
    <div
      ref={panelRef}
      data-lalala-canvas-panel=""
      data-state={phase}
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
      {deleting !== null ? (
        <>
          <p id={confirmId} data-lalala-canvas-confirm="">
            Delete the canvas{" "}
            <b>
              “<StreamerText text={deleting.name} />”
            </b>{" "}
            and its layout? Its cards stay in the code.
          </p>
          <div
            data-lalala-canvas-actions=""
            role="group"
            aria-labelledby={confirmId}
            onKeyDown={(event) => {
              if (event.key !== "Escape") return;
              // Esc backs out of the delete only; the list stays open.
              event.stopPropagation();
              cancelDelete();
            }}
          >
            <button ref={cancelRef} type="button" onClick={cancelDelete}>
              Cancel
            </button>
            <button
              type="button"
              data-danger=""
              onClick={() => {
                api.remove(deleting.id);
                close();
              }}
            >
              Delete
            </button>
          </div>
        </>
      ) : (
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
                ref={deleteRef}
                type="button"
                data-danger=""
                onClick={() => {
                  setRenaming(false);
                  setDeleting({ id: current.id, name: current.name });
                }}
              >
                Delete
              </button>
            </>
          ) : null}
        </div>
      )}
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
