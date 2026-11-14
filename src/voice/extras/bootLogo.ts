import { LOGO, runLogo } from "./asciiLogo";

/** The boot screen's type (index.html's #lala-boot): 7px monospace, one line per 7px. */
const FONT = "700 7px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace";
const LINE = 7;

/**
 * The boot screen's logo (index.html). Where the browser can, it turns in a worker on an
 * OffscreenCanvas (logoWorker.ts), so nothing the page loads can make it stutter; elsewhere the DOM
 * version (runLogo) in `pre`. It glitches while `#lala-boot` has `is-failed` and stops once the
 * boot screen is gone.
 */
export function startBootLogo(boot: HTMLElement, pre: HTMLElement) {
  const failed = () => boot.classList.contains("is-failed");
  const fallback = () => runLogo(pre, () => !boot.isConnected, failed);
  if (typeof OffscreenCanvas === "undefined" || !("transferControlToOffscreen" in HTMLCanvasElement.prototype)) {
    fallback();
    return;
  }

  const scale = Math.max(1, Math.round(devicePixelRatio || 1));
  const measure = document.createElement("canvas").getContext("2d");
  if (measure === null) {
    fallback();
    return;
  }
  measure.font = FONT;
  const cell = { w: Math.round(measure.measureText("M").width * scale), h: LINE * scale };
  const canvas = document.createElement("canvas");
  canvas.width = cell.w * LOGO.cols;
  canvas.height = cell.h * LOGO.rows;
  canvas.style.cssText = `display:block;width:${canvas.width / scale}px;height:${canvas.height / scale}px`;
  canvas.setAttribute("aria-hidden", "true");

  let worker: Worker;
  try {
    worker = new Worker(new URL("./logoWorker.ts", import.meta.url), { type: "module" });
  } catch {
    fallback();
    return;
  }
  const offscreen = canvas.transferControlToOffscreen();
  pre.replaceWith(canvas);
  let stopped = false;
  const stop = () => {
    if (stopped) return;
    stopped = true;
    watch.disconnect();
    worker.terminate();
  };
  worker.addEventListener("error", (event) => {
    event.preventDefault();
    stop();
    if (!boot.isConnected) return;
    canvas.replaceWith(pre);
    fallback();
  });
  worker.postMessage(
    {
      type: "start",
      canvas: offscreen,
      font: FONT,
      cell,
      scale,
      still: matchMedia("(prefers-reduced-motion: reduce)").matches,
      glitch: failed(),
    },
    [offscreen],
  );

  let glitching = failed();
  const watch = new MutationObserver(() => {
    if (!boot.isConnected) return stop();
    if (failed() === glitching) return;
    glitching = failed();
    worker.postMessage({ type: "glitch", on: glitching });
  });
  watch.observe(boot, { attributes: true, attributeFilter: ["class"] });
  if (boot.parentNode) watch.observe(boot.parentNode, { childList: true });
}
