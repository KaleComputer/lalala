import { useEffect } from "react";
import {
  type Rect,
  getCamera,
  getCards,
  getView,
  isMounted,
  lookAt,
  reach,
  subscribe,
} from "./canvasStore";

/** The device bar's map square (VoiceBar); it announces itself with this event when it mounts or goes. */
const SLOT = "[data-t3voice-map]";
const BAR_EVENT = "t3voice:bar";
const PAD = 40;

type Bounds = { x: number; y: number; w: number; h: number };

const union = (rects: readonly Rect[]): Bounds => {
  const left = Math.min(...rects.map((r) => r.x)) - PAD;
  const top = Math.min(...rects.map((r) => r.y)) - PAD;
  const right = Math.max(...rects.map((r) => r.x + r.w)) + PAD;
  const bottom = Math.max(...rects.map((r) => r.y + r.h)) + PAD;
  return { x: left, y: top, w: right - left, h: bottom - top };
};

function viewRect(): Rect {
  const { x, y, z } = getCamera();
  const view = getView();
  return { x: -x / z, y: -y / z, w: view.w / z, h: view.h / z };
}

/**
 * The canvas's mini-map in the device bar: the cards as dim boxes and the view lit; a tap or
 * drag there moves the view. Redrawn only when the camera or a card changes.
 */
export function CanvasMap() {
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- draws into the device bar's DOM (outside this tree) and follows it mounting and unmounting
  useEffect(() => {
    let detach = () => {};
    const attach = () => {
      detach();
      detach = () => {};
      const slot = document.querySelector<HTMLElement>(SLOT);
      if (slot !== null) detach = drawInto(slot);
    };
    attach();
    document.addEventListener(BAR_EVENT, attach);
    return () => {
      document.removeEventListener(BAR_EVENT, attach);
      detach();
    };
  }, []);
  return null;
}

function drawInto(slot: HTMLElement) {
  const canvas = document.createElement("canvas");
  canvas.setAttribute("aria-label", "Canvas map");
  slot.append(canvas);
  const context = canvas.getContext("2d");
  const colours = getComputedStyle(slot);
  const hud = colours.getPropertyValue("--hud").trim() || "#3dff8f";
  const dim = colours.getPropertyValue("--hud-3").trim() || "rgba(61, 255, 143, 0.34)";
  const tint = colours.getPropertyValue("--hud-4").trim() || "rgba(61, 255, 143, 0.13)";
  // Frozen while a finger is down, so the map doesn't slide under it.
  let held: Bounds | null = null;
  let bounds: Bounds = { x: 0, y: 0, w: 1, h: 1 };
  let fit = { scale: 1, dx: 0, dy: 0 };

  const draw = () => {
    if (context === null) return;
    const width = canvas.clientWidth;
    const height = canvas.clientHeight;
    const ratio = window.devicePixelRatio || 1;
    if (canvas.width !== Math.round(width * ratio)) canvas.width = Math.round(width * ratio);
    if (canvas.height !== Math.round(height * ratio)) canvas.height = Math.round(height * ratio);
    const cards = Object.entries(getCards())
      .filter(([id]) => isMounted(id))
      .map(([, rect]) => rect);
    const view = viewRect();
    // The view's reach, not where it is: the frame stays put as the view moves. The view is in it
    // except from a camera saved before there were edges, until the first pan.
    const room = reach();
    bounds = held ?? union(room ? [room, view] : [view]);
    const scale = Math.min(width / bounds.w, height / bounds.h);
    fit = {
      scale,
      dx: (width - bounds.w * scale) / 2 - bounds.x * scale,
      dy: (height - bounds.h * scale) / 2 - bounds.y * scale,
    };
    const box = (r: Rect) =>
      [
        r.x * fit.scale + fit.dx,
        r.y * fit.scale + fit.dy,
        r.w * fit.scale,
        r.h * fit.scale,
      ] as const;
    context.setTransform(ratio, 0, 0, ratio, 0, 0);
    context.clearRect(0, 0, width, height);
    context.fillStyle = dim;
    for (const card of cards) context.fillRect(...box(card));
    // The view by light, no outline: a faint fill, and the cards in it lit.
    const [x, y, w, h] = box(view);
    context.save();
    context.beginPath();
    context.rect(x, y, w, h);
    context.clip();
    context.fillStyle = tint;
    context.fillRect(x, y, w, h);
    context.fillStyle = hud;
    context.globalAlpha = 0.75;
    for (const card of cards) context.fillRect(...box(card));
    context.restore();
  };

  const go = (event: PointerEvent) => {
    const box = canvas.getBoundingClientRect();
    lookAt(
      (event.clientX - box.left - fit.dx) / fit.scale,
      (event.clientY - box.top - fit.dy) / fit.scale,
    );
  };
  const down = (event: PointerEvent) => {
    event.preventDefault();
    canvas.setPointerCapture(event.pointerId);
    held = bounds;
    go(event);
  };
  const move = (event: PointerEvent) => {
    if (held !== null) go(event);
  };
  const up = () => {
    held = null;
    draw();
  };

  draw();
  const unsubscribe = subscribe(draw);
  // oxlint-disable-next-line t3code/no-raw-resize-observer -- extras import only React and this folder; this writes no React state
  const resize = new ResizeObserver(draw);
  resize.observe(canvas);
  canvas.addEventListener("pointerdown", down);
  canvas.addEventListener("pointermove", move);
  canvas.addEventListener("pointerup", up);
  canvas.addEventListener("pointercancel", up);
  return () => {
    unsubscribe();
    resize.disconnect();
    canvas.remove();
  };
}
