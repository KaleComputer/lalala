import { useLayoutEffect, useRef } from "react";
import { getCamera, getSelected, getView, groupAreas, groupKey, subscribe } from "./canvasStore";
import { AREA } from "./tidyPack";

/**
 * Each card group's area behind the cards: a faint panel, its name as a headline (drag it to move
 * the group) and a resize corner. One screen-sized canvas, redrawn only when the camera or a card
 * moves, so the areas cost no layers however big they are.
 */
export function GroupAreas() {
  const ref = useRef<HTMLCanvasElement>(null);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- draws the camera and card boxes from canvasStore, outside React
  useLayoutEffect(() => {
    const canvas = ref.current;
    const context = canvas?.getContext("2d");
    if (!canvas || !context) return;
    let lastCamera: unknown;
    let lastView: unknown;
    let lastSelected: unknown;
    let lastAreas = "";
    const draw = () => {
      const camera = getCamera();
      const view = getView();
      const selected = getSelected();
      // The areas, not the card boxes: cards mounting on a fresh load change them, not the boxes.
      const areas = groupAreas();
      const signature = JSON.stringify(areas);
      if (
        camera === lastCamera &&
        view === lastView &&
        selected === lastSelected &&
        signature === lastAreas
      ) {
        return;
      }
      lastCamera = camera;
      lastView = view;
      lastSelected = selected;
      lastAreas = signature;
      const ratio = window.devicePixelRatio || 1;
      const width = Math.round(view.w * ratio);
      const height = Math.round(view.h * ratio);
      if (canvas.width !== width) canvas.width = width;
      if (canvas.height !== height) canvas.height = height;
      context.setTransform(1, 0, 0, 1, 0, 0);
      context.clearRect(0, 0, width, height);
      const { x, y, z } = camera;
      context.setTransform(ratio * z, 0, 0, ratio * z, ratio * x, ratio * y);
      const style = getComputedStyle(canvas);
      const accent = style.getPropertyValue("--lala-accent").trim() || "#3dff8f";
      const font = style.getPropertyValue("--lala-font").trim() || "sans-serif";
      const seen = { x: -x / z, y: -y / z, w: view.w / z, h: view.h / z };
      for (const { label, rect } of areas) {
        if (
          rect.x > seen.x + seen.w ||
          rect.y > seen.y + seen.h ||
          rect.x + rect.w < seen.x ||
          rect.y + rect.h < seen.y
        ) {
          continue;
        }
        const radius = Math.min(48, rect.w / 4, rect.h / 4);
        context.save();
        context.beginPath();
        context.roundRect(rect.x, rect.y, rect.w, rect.h, radius);
        context.fillStyle = accent;
        context.globalAlpha = 0.04;
        context.fill();
        context.globalAlpha = 0.28;
        context.lineWidth = 2 / z;
        context.strokeStyle = accent;
        context.stroke();
        context.globalAlpha = 0.85;
        context.fillStyle = accent;
        context.font = `700 ${AREA.head * 0.5}px ${font}`;
        context.textBaseline = "alphabetic";
        const at = { x: rect.x + AREA.pad, y: rect.y + AREA.head * 0.68 };
        context.fillText(label.toUpperCase(), at.x, at.y, rect.w - AREA.pad * 2);
        // The resize corner, only on the selected group, the same size on screen at any zoom.
        if (groupKey(label) !== selected) {
          context.restore();
          continue;
        }
        const inset = 10 / z;
        const arm = 26 / z;
        const right = rect.x + rect.w - inset;
        const bottom = rect.y + rect.h - inset;
        context.beginPath();
        context.moveTo(right - arm, bottom);
        context.lineTo(right, bottom);
        context.lineTo(right, bottom - arm);
        context.globalAlpha = 0.6;
        context.lineWidth = 3 / z;
        context.strokeStyle = accent;
        context.stroke();
        context.restore();
      }
    };
    draw();
    return subscribe(draw);
  }, []);

  return <canvas ref={ref} data-lalala-group-areas="" aria-hidden="true" />;
}
