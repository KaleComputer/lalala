import { type ReactNode, useLayoutEffect, useRef } from "react";
import {
  type Rect,
  getCamera,
  getCards,
  holdCard,
  setCamera,
  setCard,
  setView,
  subscribe,
  zoomAt,
} from "./canvasStore";
import "./canvasSurface.css";

type Point = { x: number; y: number };
type Gesture =
  | { kind: "pan"; from: Point; camera: { x: number; y: number } }
  | { kind: "pinch"; distance: number; mid: Point; camera: { x: number; y: number; z: number } }
  | { kind: "move" | "resize"; id: string; from: Point; rect: Rect };

/** Text is re-rasterised at the new scale once a zoom has been still this long. */
const SETTLE_MS = 180;

const wheelPixels = (event: WheelEvent, delta: number) =>
  event.deltaMode === 1 ? delta * 16 : event.deltaMode === 2 ? delta * 400 : delta;

/**
 * The canvas: a surface that pans (up to the cards' edges, see `reach`) and zooms under the fixed
 * corner. One finger or the mouse drags empty space, two fingers pinch and pan, a trackpad pinches
 * (ctrl+wheel or Safari's gesture events) and scrolls; a card's header moves it and its corner
 * resizes it.
 */
export function CanvasSurface({ children }: { readonly children: ReactNode }) {
  const surfaceRef = useRef<HTMLDivElement>(null);
  const worldRef = useRef<HTMLDivElement>(null);

  // Before paint: a swapped-in build must show the saved camera on its very first frame.
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- pointer, wheel and Safari gesture input drive the camera outside React
  useLayoutEffect(() => {
    const surface = surfaceRef.current;
    const world = worldRef.current;
    if (surface === null || world === null) return;

    let settle = 0;
    let lastZ = getCamera().z;
    const apply = () => {
      const { x, y, z } = getCamera();
      world.style.transform = `translate(${x}px, ${y}px) scale(${z})`;
      if (z === lastZ) return;
      lastZ = z;
      world.style.willChange = "transform";
      window.clearTimeout(settle);
      settle = window.setTimeout(() => (world.style.willChange = ""), SETTLE_MS);
    };
    apply();
    const unsubscribe = subscribe(apply);

    const measure = () => setView(surface.clientWidth, surface.clientHeight);
    measure();
    // oxlint-disable-next-line t3code/no-raw-resize-observer -- extras import only React and this folder; this writes no React state
    const resize = new ResizeObserver(measure);
    resize.observe(surface);

    const pointers = new Map<number, Point>();
    /** Each pointer's type and what it first touched, to rebuild the gesture after a prune. */
    const starts = new Map<number, { type: string; target: Element | null }>();
    let gesture: Gesture | null = null;
    let lastPointerType = "mouse";
    let safariGesture: { scale: number } | null = null;
    // The card touched last is drawn over the others.
    let top = 0;

    const local = (event: { clientX: number; clientY: number }): Point => {
      const box = surface.getBoundingClientRect();
      return { x: event.clientX - box.left, y: event.clientY - box.top };
    };
    const pair = () => {
      const [a, b] = [...pointers.values()];
      if (a === undefined || b === undefined) return null;
      return {
        distance: Math.hypot(a.x - b.x, a.y - b.y) || 1,
        mid: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 },
      };
    };
    const startPinch = () => {
      const both = pair();
      if (both !== null) gesture = { kind: "pinch", ...both, camera: getCamera() };
    };
    const startPan = (from: Point) => {
      const { x, y } = getCamera();
      gesture = { kind: "pan", from, camera: { x, y } };
    };
    const capture = (id: number) => {
      try {
        surface.setPointerCapture(id);
      } catch {
        // The pointer is already gone.
      }
    };

    /** One pointer alone: pan empty space, move or resize a card from its header or corner. */
    const begin = (pointerId: number): boolean => {
      const at = pointers.get(pointerId);
      const target = starts.get(pointerId)?.target ?? null;
      if (at === undefined) return false;
      const card = target?.closest<HTMLElement>("[data-lalala-card]");
      const id = card?.dataset.lalalaCard;
      if (card && id) {
        const grip = target?.closest("[data-lalala-card-grip]");
        const corner = target?.closest("[data-lalala-card-resize]");
        const rect = getCards()[id];
        // Anywhere else in a card: its own taps and scrolling.
        if (!(grip || corner) || !rect) return false;
        capture(pointerId);
        gesture = { kind: corner ? "resize" : "move", id, from: at, rect };
        holdCard(id);
        return true;
      }
      capture(pointerId);
      startPan(at);
      return true;
    };

    const forget = (pointerId: number) => {
      starts.delete(pointerId);
      return pointers.delete(pointerId);
    };

    const clear = () => {
      pointers.clear();
      starts.clear();
      gesture = null;
      holdCard(null);
    };

    /**
     * Safari's edge swipe (back, forward, overscroll) can swallow a finger with no pointerup or
     * pointercancel; left in `pointers`, every later finger would pinch. The live touches are the
     * truth: touch pointers not under one are gone, and a gesture they were part of starts over.
     */
    const prune = (touches: TouchList) => {
      const live = [...touches].map((touch) => local(touch));
      let pruned = false;
      for (const [pointerId, at] of pointers) {
        if (starts.get(pointerId)?.type !== "touch") continue;
        if (live.some((touch) => Math.hypot(touch.x - at.x, touch.y - at.y) < 48)) continue;
        forget(pointerId);
        pruned = true;
      }
      if (!pruned) return;
      gesture = null;
      holdCard(null);
      if (pointers.size >= 2) return startPinch();
      const rest = [...pointers.keys()][0];
      if (rest === undefined) return;
      try {
        surface.releasePointerCapture(rest);
      } catch {
        // Not captured.
      }
      begin(rest);
    };

    const down = (event: PointerEvent) => {
      lastPointerType = event.pointerType;
      if (event.pointerType === "mouse" && event.button !== 0) return;
      const target = event.target instanceof Element ? event.target : null;
      const card = target?.closest<HTMLElement>("[data-lalala-card]");
      // A mouse has one pointer: anything still held from before is stale.
      if (event.pointerType === "mouse") clear();
      pointers.set(event.pointerId, local(event));
      starts.set(event.pointerId, { type: event.pointerType, target });
      if (card) card.style.zIndex = String(++top);

      if (pointers.size >= 2) {
        // A second finger anywhere, even on a card, makes it a pinch; the first one stops what it did.
        for (const pointer of pointers.keys()) capture(pointer);
        startPinch();
        event.preventDefault();
        return;
      }
      // A mouse drag must not start selecting the cards' text; a header drag never does.
      if (begin(event.pointerId) && (event.pointerType === "mouse" || card)) event.preventDefault();
    };

    const move = (event: PointerEvent) => {
      if (!pointers.has(event.pointerId)) return;
      const at = local(event);
      pointers.set(event.pointerId, at);
      if (gesture === null) return;
      if (gesture.kind === "pan") {
        const x = gesture.camera.x + at.x - gesture.from.x;
        const y = gesture.camera.y + at.y - gesture.from.y;
        setCamera({ ...getCamera(), x, y });
        // Held at an edge: dragging back moves the view at once, not after the overshoot.
        const camera = getCamera();
        if (camera.x !== x || camera.y !== y) startPan(at);
      } else if (gesture.kind === "pinch") {
        const both = pair();
        if (both === null) return;
        const start = gesture.camera;
        const z = start.z * (both.distance / gesture.distance);
        // The world point under the fingers' first midpoint follows their midpoint.
        const wx = (gesture.mid.x - start.x) / start.z;
        const wy = (gesture.mid.y - start.y) / start.z;
        setCamera({ x: both.mid.x - wx * z, y: both.mid.y - wy * z, z });
        // Clamped zoom: keep the pinch anchored to where it ended up.
        const camera = getCamera();
        if (camera.z !== z) {
          gesture = { kind: "pinch", ...both, camera };
        }
      } else {
        const { z } = getCamera();
        const dx = (at.x - gesture.from.x) / z;
        const dy = (at.y - gesture.from.y) / z;
        const { rect } = gesture;
        setCard(
          gesture.id,
          gesture.kind === "move"
            ? { ...rect, x: rect.x + dx, y: rect.y + dy }
            : { ...rect, w: rect.w + dx, h: rect.h + dy },
        );
      }
    };

    const up = (event: PointerEvent) => {
      // Only the surface's own capture ending: a card's button hands its capture to the surface.
      if (event.type === "lostpointercapture" && event.target !== surface) return;
      if (!forget(event.pointerId)) return;
      if (gesture?.kind === "pinch") {
        // One finger left on the glass carries on panning.
        const rest = [...pointers.values()][0];
        if (rest === undefined) gesture = null;
        else startPan(rest);
      } else if (pointers.size === 0) {
        gesture = null;
      }
      if (pointers.size === 0) holdCard(null);
    };

    // Two fingers in a card's scrolling list are a pinch, not a scroll.
    const touchMove = (event: TouchEvent) => {
      if (event.touches.length >= 2 && event.cancelable) event.preventDefault();
    };
    const touchStart = (event: TouchEvent) => {
      prune(event.touches);
      // A finger landing on the screen's edge outside a card would start Safari's back swipe.
      const touch = event.changedTouches[0];
      const outsideCards =
        event.target instanceof Element && !event.target.closest("[data-lalala-card]");
      const edge =
        touch !== undefined && (touch.clientX < 16 || touch.clientX > window.innerWidth - 16);
      if (edge && outsideCards && event.cancelable) event.preventDefault();
    };
    const touchEnd = (event: TouchEvent) => prune(event.touches);
    const hidden = () => {
      if (document.visibilityState === "hidden") clear();
    };

    // No rubber band and no white space past the page's edge while the canvas is open.
    const root = document.documentElement;
    const before = [root.style.overscrollBehavior, document.body.style.overscrollBehavior];
    root.style.overscrollBehavior = "none";
    document.body.style.overscrollBehavior = "none";

    const wheel = (event: WheelEvent) => {
      const inBody =
        event.target instanceof Element && event.target.closest("[data-lalala-card-body]");
      if (event.ctrlKey) {
        // A trackpad pinch (or ctrl + mouse wheel); never the page's zoom.
        event.preventDefault();
        if (safariGesture !== null) return;
        const at = local(event);
        const delta = Math.max(-50, Math.min(50, wheelPixels(event, event.deltaY)));
        zoomAt(at.x, at.y, Math.exp(-delta * 0.01));
        return;
      }
      // A card's list scrolls itself; anywhere else scrolling pans.
      if (inBody) return;
      event.preventDefault();
      const camera = getCamera();
      setCamera({
        ...camera,
        x: camera.x - wheelPixels(event, event.deltaX),
        y: camera.y - wheelPixels(event, event.deltaY),
      });
    };

    // Safari: its pinch is a gesture event and zooms the page unless prevented. On a phone the
    // pointers pinch; on a Mac trackpad these are the pinch.
    type SafariGestureEvent = Event & { scale: number; clientX: number; clientY: number };
    const gestureStart = (event: Event) => {
      event.preventDefault();
      if (lastPointerType === "touch") return;
      safariGesture = { scale: 1 };
    };
    const gestureChange = (event: Event) => {
      event.preventDefault();
      if (safariGesture === null) return;
      const { scale } = event as SafariGestureEvent;
      const at = local(event as SafariGestureEvent);
      zoomAt(at.x, at.y, scale / safariGesture.scale);
      safariGesture.scale = scale;
    };
    const gestureEnd = (event: Event) => {
      event.preventDefault();
      safariGesture = null;
    };

    surface.addEventListener("pointerdown", down);
    surface.addEventListener("pointermove", move);
    surface.addEventListener("pointerup", up);
    surface.addEventListener("pointercancel", up);
    surface.addEventListener("lostpointercapture", up);
    surface.addEventListener("touchstart", touchStart, { passive: false });
    surface.addEventListener("touchmove", touchMove, { passive: false });
    surface.addEventListener("touchend", touchEnd);
    surface.addEventListener("touchcancel", touchEnd);
    document.addEventListener("visibilitychange", hidden);
    window.addEventListener("blur", clear);
    surface.addEventListener("wheel", wheel, { passive: false });
    document.addEventListener("gesturestart", gestureStart);
    document.addEventListener("gesturechange", gestureChange);
    document.addEventListener("gestureend", gestureEnd);
    return () => {
      unsubscribe();
      resize.disconnect();
      window.clearTimeout(settle);
      surface.removeEventListener("pointerdown", down);
      surface.removeEventListener("pointermove", move);
      surface.removeEventListener("pointerup", up);
      surface.removeEventListener("pointercancel", up);
      surface.removeEventListener("lostpointercapture", up);
      surface.removeEventListener("touchstart", touchStart);
      surface.removeEventListener("touchmove", touchMove);
      surface.removeEventListener("touchend", touchEnd);
      surface.removeEventListener("touchcancel", touchEnd);
      document.removeEventListener("visibilitychange", hidden);
      window.removeEventListener("blur", clear);
      [root.style.overscrollBehavior, document.body.style.overscrollBehavior] = before as [
        string,
        string,
      ];
      surface.removeEventListener("wheel", wheel);
      document.removeEventListener("gesturestart", gestureStart);
      document.removeEventListener("gesturechange", gestureChange);
      document.removeEventListener("gestureend", gestureEnd);
    };
  }, []);

  return (
    <div ref={surfaceRef} data-lalala-surface="">
      <div ref={worldRef} data-lalala-world="">
        {children}
      </div>
    </div>
  );
}
