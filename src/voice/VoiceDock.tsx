import { useLocation } from "@tanstack/react-router";
import { type CSSProperties, useEffect, useEffectEvent, useState } from "react";

import { observeResize } from "~/lib/observeResize";
import { VoiceHost } from "./VoiceHost";
import { useVoiceOpen } from "./voiceOpen";

const COMPOSER = 'form[data-chat-composer-form="true"]';
const GAP_PX = 8;

/** Where a view's composer is: how far the bar must lift to clear it, and its column. */
type ComposerPlace = {
  readonly clearance: number;
  /** The composer's column (viewport px); null on views without one (the canvas). */
  readonly column: { readonly left: number; readonly width: number } | null;
};

const NONE: ComposerPlace = { clearance: 0, column: null };

const same = (a: ComposerPlace, b: ComposerPlace) =>
  a.clearance === b.clearance &&
  a.column?.left === b.column?.left &&
  a.column?.width === b.column?.width;

/**
 * The voice bar while it is shown, at the bottom of the main content on whatever view is open, so
 * the call survives navigation. On a thread it sits just above the composer, in its column.
 */
export function VoiceDock() {
  return useVoiceOpen() ? <OpenVoiceDock /> : null;
}

function OpenVoiceDock() {
  const pathname = useLocation({ select: (location) => location.pathname });
  const [place, setPlace] = useState<ComposerPlace>(NONE);
  const style: Record<string, string> = {};
  // Presence lifts its bar with --kb; its frame sits ~18px above the bar's own bottom.
  const lift = Math.max(0, place.clearance - 18);
  if (lift > 0) style["--kb"] = `${lift}px`;
  if (place.column !== null) {
    style["--lalala-col-left"] = `${place.column.left}px`;
    style["--lalala-col-width"] = `${place.column.width}px`;
  }
  return (
    <div
      data-lalala-dock=""
      data-lalala-column={place.column === null ? undefined : ""}
      // The bar's map square is the canvas's: reserved from the first paint, before the extras load.
      data-lalala-canvas={pathname === "/canvas" ? "" : undefined}
      style={style as CSSProperties}
    >
      {/* Each view mounts its own composer, or none. */}
      <ComposerPlaceProbe
        key={pathname}
        onChange={(next) => setPlace((current) => (same(current, next) ? current : next))}
      />
      <VoiceHost />
    </div>
  );
}

/**
 * Reports the composer's place. The column moves without the form resizing when anything around
 * it does (sidebar, thread panel, window, chat width), so every box from the form up is watched.
 */
function ComposerPlaceProbe({ onChange }: { readonly onChange: (place: ComposerPlace) => void }) {
  const report = useEffectEvent(onChange);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- follows the composer's box and the visual viewport (keyboard), which React does not own
  useEffect(() => {
    let observed: Element | null = null;
    let stopObserving = () => {};
    function measure() {
      const form = document.querySelector(COMPOSER);
      if (form !== observed) {
        stopObserving();
        stopObserving = form === null ? () => {} : observeResize(boxesUp(form), measure);
        observed = form;
      }
      if (form === null) return report(NONE);
      const viewport = window.visualViewport?.height ?? window.innerHeight;
      const rect = form.getBoundingClientRect();
      // The bar spans the composer's column, so a composer pinned to the bottom is under it.
      const pinned = rect.bottom > viewport - 80;
      report({
        clearance: pinned ? Math.ceil(viewport - rect.top) + GAP_PX : 0,
        column: rect.width > 0 ? { left: rect.left, width: rect.width } : null,
      });
    }
    // The composer mounts a moment after the route changes.
    const timers = [0, 400, 1_500].map((delay) => window.setTimeout(measure, delay));
    // A sidebar that slides with a transform settles the column when its transition ends.
    document.addEventListener("transitionend", measure);
    window.addEventListener("resize", measure);
    window.visualViewport?.addEventListener("resize", measure);
    return () => {
      for (const timer of timers) window.clearTimeout(timer);
      stopObserving();
      document.removeEventListener("transitionend", measure);
      window.removeEventListener("resize", measure);
      window.visualViewport?.removeEventListener("resize", measure);
    };
  }, []);

  return null;
}

const boxesUp = (element: Element): Element[] => {
  const boxes: Element[] = [];
  for (let at: Element | null = element; at !== null; at = at.parentElement) boxes.push(at);
  return boxes;
};
