import { type ReactNode, useLayoutEffect, useRef } from "react";
import {
  type Rect,
  getCamera,
  getCards,
  getSelected,
  groupAreas,
  groupKey,
  select,
  holdCard,
  isLayoutReady,
  setCamera,
  setCard,
  setView,
  subscribe,
  touchCard,
  zoomAt,
  groupAt,
  holdGroup,
  moveGroup,
  resizeGroup,
  type GroupGrab,
} from "./canvasStore";
import { GroupAreas } from "./GroupAreas";
import "./canvasSurface.css";

type Point = { x: number; y: number };
type Gesture =
  | { kind: "pan"; from: Point; camera: { x: number; y: number } }
  | { kind: "pinch"; distance: number; mid: Point; camera: { x: number; y: number; z: number } }
  | { kind: "move" | "resize"; id: string; from: Point; rect: Rect }
  | { kind: "group"; part: "head" | "corner"; grab: GroupGrab; from: Point };

/** A zoom redraws the cards sharp at its new scale once it has been still this long; shorter, and
 * quick zooming in and out would redraw between every move. */
const SETTLE_MS = 400;

/** How far (screen px, at any zoom) past a card's bottom-right corner a press still resizes it. */
const CORNER_REACH = 64;
/** A group's corner takes presses this far (screen px) inside it, over its drawn corner mark. */
const GROUP_CORNER = 48;

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
    let frame = 0;
    let sharpZ = getCamera().z;
    const sharpen = () => {
      surface.toggleAttribute("data-lalala-waiting", !isLayoutReady());
      const { z } = getCamera();
      if (z === sharpZ) return;
      window.clearTimeout(settle);
      settle = window.setTimeout(() => {
        sharpZ = getCamera().z;
        // A card's layer keeps the scale it was drawn at; dropping it for one frame redraws it sharp.
        world.dataset.lalalaSharpen = "";
        frame = requestAnimationFrame(() => {
          frame = requestAnimationFrame(() => delete world.dataset.lalalaSharpen);
        });
      }, SETTLE_MS);
    };
    const unsubscribe = subscribe(sharpen);
    sharpen();

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

    /**
     * The selected card, when a press outside it lands in its corner reach. A card's
     * header and a drawn card's content keep their own drags and taps; empty space, a group area,
     * a card's frame and a card not drawn give way.
     */
    const cornerAt = (at: Point, target: Element | null): HTMLElement | undefined => {
      if (target?.closest("[data-lalala-card-grip], [data-lalala-card-resize]")) return;
      const over = target?.closest("[data-lalala-card]");
      if (
        over &&
        !over.hasAttribute("data-lalala-card-off") &&
        target?.closest("[data-lalala-card-body]")
      ) {
        return;
      }
      const { x, y, z } = getCamera();
      const cards = getCards();
      let best: HTMLElement | undefined;
      let nearest = Infinity;
      const picked = getSelected();
      for (const card of world.querySelectorAll<HTMLElement>(":scope > [data-lalala-card]")) {
        if (card.dataset.lalalaCard !== picked) continue;
        const rect = cards[picked];
        if (!rect) continue;
        const dx = at.x - (x + (rect.x + rect.w) * z);
        const dy = at.y - (y + (rect.y + rect.h) * z);
        if (dx > CORNER_REACH || dy > CORNER_REACH || (dx < 0 && dy < 0)) continue;
        if (dx < -Math.min(CORNER_REACH, rect.w * z) || dy < -Math.min(CORNER_REACH, rect.h * z)) {
          continue;
        }
        const distance = Math.hypot(dx, dy);
        if (distance < nearest) [best, nearest] = [card, distance];
      }
      return best;
    };
    /** A group's headline, or the selected group's corner, under a press that no card takes. */
    const groupUnder = (at: Point, target: Element | null) => {
      if (target?.closest("[data-lalala-card]")) return undefined;
      const group = groupAt(at.x, at.y, GROUP_CORNER);
      if (group?.part === "corner" && groupKey(group.grab.label) !== getSelected())
        return undefined;
      return group;
    };
    /**
     * A press picks what its resize corner is for: the card under it, or the group whose area or
     * corner reach it lands in; anywhere else drops the pick.
     */
    const pick = (at: Point, target: Element | null) => {
      const card = target?.closest<HTMLElement>("[data-lalala-card]")?.dataset.lalalaCard;
      if (card) return select(card);
      const group = groupUnder(at, target);
      if (group) return select(groupKey(group.grab.label));
      const { x, y, z } = getCamera();
      const wx = (at.x - x) / z;
      const wy = (at.y - y) / z;
      const area = groupAreas().find(
        ({ rect }) =>
          wx >= rect.x && wx <= rect.x + rect.w && wy >= rect.y && wy <= rect.y + rect.h,
      );
      select(area ? groupKey(area.label) : null);
    };
    /**
     * A card's corner under the press, unless it lands past a group's edge by its corner: there
     * the group's corner wins (zoomed out, an edge card's corner is a few px from the group's).
     */
    const cardCornerAt = (at: Point, target: Element | null) => {
      const group = groupUnder(at, target);
      if (group?.part === "corner") {
        const { x, y, z } = getCamera();
        const { area } = group.grab;
        if (at.x > x + (area.x + area.w) * z || at.y > y + (area.y + area.h) * z) return undefined;
      }
      return cornerAt(at, target);
    };
    let hoverCursor = "";
    const hover = (event: PointerEvent) => {
      const target = event.target instanceof Element ? event.target : null;
      const at = local(event);
      const part = cardCornerAt(at, target) ? "corner" : groupUnder(at, target)?.part;
      const cursor = part === "corner" ? "nwse-resize" : part === "head" ? "grab" : "";
      if (cursor === hoverCursor) return;
      hoverCursor = cursor;
      surface.style.cursor = cursor;
    };

    /** One pointer alone: pan empty space, move or resize a card from its header or corner. */
    const begin = (pointerId: number): boolean => {
      const at = pointers.get(pointerId);
      const target = starts.get(pointerId)?.target ?? null;
      if (at === undefined) return false;
      const card = target?.closest<HTMLElement>("[data-lalala-card]");
      const id = card?.dataset.lalalaCard;
      if (card && id) {
        // The header's thread button is a tap, not a handle.
        const grip =
          target?.closest("[data-lalala-card-grip]") &&
          !target.closest("[data-lalala-card-thread]");
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
      // A group's headline moves it with its cards; its corner resizes it.
      const group = groupUnder(at, target);
      if (group) {
        gesture = { kind: "group", ...group, from: at };
        holdGroup(group.grab);
        return true;
      }
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
      const at = local(event);
      const pressed = event.target instanceof Element ? event.target : null;
      // Pressed in a card's corner reach: as if on its corner.
      const target =
        cardCornerAt(at, pressed)?.querySelector("[data-lalala-card-resize]") ?? pressed;
      const card = target?.closest<HTMLElement>("[data-lalala-card]");
      // A mouse has one pointer: anything still held from before is stale.
      if (event.pointerType === "mouse") clear();
      pointers.set(event.pointerId, at);
      starts.set(event.pointerId, { type: event.pointerType, target });
      if (card) card.style.zIndex = String(++top);
      if (card?.dataset.lalalaCard) touchCard(card.dataset.lalalaCard);

      if (pointers.size === 1) pick(at, target);
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
      if (pointers.size === 0 && event.pointerType === "mouse") hover(event);
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
        setCamera({ x: both.mid.x - wx * z, y: both.mid.y - wy * z, z }, true);
        // Clamped zoom: keep the pinch anchored to where it ended up.
        const camera = getCamera();
        if (camera.z !== z) {
          gesture = { kind: "pinch", ...both, camera };
        }
      } else if (gesture.kind === "group") {
        const { z } = getCamera();
        const dx = (at.x - gesture.from.x) / z;
        const dy = (at.y - gesture.from.y) / z;
        const { grab } = gesture;
        if (gesture.part === "head") moveGroup(grab, dx, dy);
        else resizeGroup(grab, grab.area.w + dx, grab.area.h + dy);
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
      cancelAnimationFrame(frame);
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
      <GroupAreas />
      <div ref={worldRef} data-lalala-world="">
        {children}
      </div>
    </div>
  );
}
