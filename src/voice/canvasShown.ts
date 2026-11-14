/**
 * Work that would compete with the canvas coming in (the speech models' setup: downloads, worker
 * start-up, big buffers) waits until the page's boot screen has handed over (index.html sends
 * `lalala:canvas-shown`) and the page is idle. Without a boot screen (lalala.talk) only the idle.
 */
const waiting = new Set<() => void>();
let shown = typeof document === "undefined" || document.getElementById("lala-boot") === null;
if (!shown)
  window.addEventListener(
    "lalala:canvas-shown",
    () => {
      shown = true;
      for (const run of waiting) run();
      waiting.clear();
    },
    { once: true },
  );

/** Runs `then` once the canvas is shown and the page is idle; the returned function cancels it. */
export function afterCanvasShown(then: () => void): () => void {
  let idle = 0;
  let cancelled = false;
  const run = () => {
    if (cancelled) return;
    idle =
      typeof requestIdleCallback === "function"
        ? requestIdleCallback(then, { timeout: 2_000 })
        : window.setTimeout(then, 200);
  };
  if (shown) run();
  else waiting.add(run);
  return () => {
    cancelled = true;
    waiting.delete(run);
    if (typeof cancelIdleCallback === "function") cancelIdleCallback(idle);
    window.clearTimeout(idle);
  };
}
